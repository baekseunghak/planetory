package com.planetory.backend.domain.exploration.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import static com.planetory.backend.domain.exploration.service.NasaPlanetInfo.Measurement;
import static com.planetory.backend.domain.exploration.service.NasaPlanetInfo.Planet;

/** 고정 NASA TAP 호스트에 TIC 숫자만 넣어 작은 PS 기본 해 목록을 조회한다. */
@Component
class NasaTapClient {

    private static final URI NASA_SYNC = URI.create("https://exoplanetarchive.ipac.caltech.edu/TAP/sync");
    private static final int MAX_BYTES = 256 * 1024;
    private static final int MAX_ROWS = 64;
    private static final String COLUMNS = "tic_id,hostname,pl_name,default_flag,soltype,pl_controv_flag,"
            + "pl_refname,pl_orbper,pl_orbpererr1,pl_orbpererr2,pl_orbperlim,"
            + "pl_rade,pl_radeerr1,pl_radeerr2,pl_radelim,"
            + "pl_masse,pl_masseerr1,pl_masseerr2,pl_masselim,"
            + "discoverymethod,disc_year,disc_refname";

    private final URI endpoint;
    private final HttpClient http;
    private final Duration timeout;
    private final Semaphore permits;
    private final ObjectMapper json = new ObjectMapper();

    @Autowired
    NasaTapClient(@Value("${planetory.nasa.connect-timeout:3s}") Duration connectTimeout,
                  @Value("${planetory.nasa.request-timeout:6s}") Duration requestTimeout,
                  @Value("${planetory.nasa.max-concurrent:2}") int maxConcurrent) {
        this(NASA_SYNC, connectTimeout, requestTimeout, maxConcurrent);
    }

    /** 테스트 HTTP fixture만 로컬 URI를 넣는다. 서비스 설정에는 호스트 변경 변수가 없다. */
    NasaTapClient(URI endpoint, Duration connectTimeout, Duration requestTimeout, int maxConcurrent) {
        if (connectTimeout.isZero() || connectTimeout.isNegative() || connectTimeout.compareTo(Duration.ofSeconds(5)) > 0
                || requestTimeout.isZero() || requestTimeout.isNegative() || requestTimeout.compareTo(Duration.ofSeconds(10)) > 0
                || maxConcurrent < 1 || maxConcurrent > 8) {
            throw new IllegalArgumentException("NASA timeout/concurrency setting is out of range");
        }
        this.endpoint = endpoint;
        this.timeout = requestTimeout;
        this.permits = new Semaphore(maxConcurrent);
        this.http = HttpClient.newBuilder().connectTimeout(connectTimeout)
                .followRedirects(HttpClient.Redirect.NEVER).build();
    }

    Duration leaseDuration() {
        // 각 시도는 연결·헤더·본문에 같은 요청 마감을 적용한다. 3초는 재시도 간 200ms와 저장 여유다.
        return timeout.multipliedBy(2).plusSeconds(3);
    }

    List<Planet> fetch(long ticId) throws FetchFailure {
        if (ticId <= 0) {
            throw new IllegalArgumentException("TIC must be positive");
        }
        if (!permits.tryAcquire()) {
            throw new FetchFailure("busy");
        }
        try {
            // 외부 입력은 long으로 검증된 TIC뿐이다. 테이블·열·호스트·ADQL 구조는 상수다.
            String query = "select top 65 " + COLUMNS + " from ps where tic_id='TIC " + ticId
                    + "' and default_flag=1";
            URI uri = URI.create(endpoint + "?query="
                    + URLEncoder.encode(query, StandardCharsets.UTF_8) + "&format=json");
            HttpRequest request = HttpRequest.newBuilder(uri).GET().timeout(timeout).build();
            for (int attempt = 0; attempt < 2; attempt++) {
                try {
                    long deadline = System.nanoTime() + timeout.toNanos();
                    HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
                    try (InputStream body = response.body()) {
                        int status = response.statusCode();
                        if (status == 200) {
                            byte[] bytes = boundedRead(body, deadline);
                            if (bytes.length > MAX_BYTES) {
                                throw new FetchFailure("invalid_response");
                            }
                            return parse(bytes, ticId);
                        }
                        if (status != 429 && status < 500) {
                            throw new FetchFailure("invalid_response");
                        }
                        if (attempt == 1) {
                            throw new FetchFailure(status == 429 ? "rate_limited" : "upstream_error");
                        }
                    }
                } catch (FetchFailure failure) {
                    if (attempt == 1 || !("timeout".equals(failure.code())
                            || "upstream_error".equals(failure.code()))) {
                        throw failure;
                    }
                } catch (HttpTimeoutException timeoutFailure) {
                    if (attempt == 1) {
                        throw new FetchFailure("timeout");
                    }
                } catch (IOException transportFailure) {
                    if (attempt == 1) {
                        throw new FetchFailure("upstream_error");
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new FetchFailure("interrupted");
                }
                try {
                    Thread.sleep(200);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new FetchFailure("interrupted");
                }
            }
            throw new FetchFailure("upstream_error");
        } finally {
            permits.release();
        }
    }

    /** BodyHandlers.ofInputStream은 헤더 수신 후 본문 읽기까지 timeout을 보장하지 않아 별도 마감한다. */
    private byte[] boundedRead(InputStream body, long deadline) throws FetchFailure {
        ExecutorService reader = Executors.newVirtualThreadPerTaskExecutor();
        var read = reader.submit(() -> body.readNBytes(MAX_BYTES + 1));
        try {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) {
                throw new FetchFailure("timeout");
            }
            return read.get(remaining, TimeUnit.NANOSECONDS);
        } catch (TimeoutException timeoutFailure) {
            throw new FetchFailure("timeout");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new FetchFailure("interrupted");
        } catch (ExecutionException readFailure) {
            throw new FetchFailure("upstream_error");
        } finally {
            read.cancel(true);
            reader.shutdownNow();
        }
    }

    private List<Planet> parse(byte[] body, long ticId) throws FetchFailure {
        try {
            JsonNode root = json.readTree(body);
            if (!root.isArray() || root.size() > MAX_ROWS) {
                throw new FetchFailure("invalid_response");
            }
            List<Planet> planets = new ArrayList<>();
            for (JsonNode row : root) {
                String sourceTic = string(row, "tic_id");
                String name = string(row, "pl_name");
                if (!"TIC ".concat(Long.toString(ticId)).equals(sourceTic)
                        || name == null || name.isBlank() || integer(row, "default_flag") != 1) {
                    throw new FetchFailure("invalid_response");
                }
                String reference = string(row, "pl_refname");
                planets.add(new Planet("ps", name, string(row, "hostname"), sourceTic,
                        string(row, "soltype"), controversial(row),
                        measure(row, "pl_orbper", "days", reference),
                        measure(row, "pl_rade", "earth_radius", reference),
                        measure(row, "pl_masse", "earth_mass", reference),
                        string(row, "discoverymethod"), integer(row, "disc_year"),
                        string(row, "disc_refname")));
            }
            return planets;
        } catch (FetchFailure failure) {
            throw failure;
        } catch (Exception invalidJsonOrNumber) {
            throw new FetchFailure("invalid_response");
        }
    }

    private static Measurement measure(JsonNode row, String column, String unit, String reference) {
        Integer limit = integer(row, column + "lim");
        if (limit != null && limit != -1 && limit != 0 && limit != 1) {
            throw new IllegalArgumentException("invalid measurement limit");
        }
        return new Measurement(decimal(row, column), decimal(row, column + "err1"),
                decimal(row, column + "err2"), limit, unit, reference);
    }

    private static String string(JsonNode row, String column) {
        JsonNode value = row.get(column);
        return value == null || value.isNull() ? null : value.asText();
    }

    private static BigDecimal decimal(JsonNode row, String column) {
        JsonNode value = row.get(column);
        return value == null || value.isNull() ? null : new BigDecimal(value.asText()).stripTrailingZeros();
    }

    private static Integer integer(JsonNode row, String column) {
        JsonNode value = row.get(column);
        return value == null || value.isNull() ? null : Integer.valueOf(value.asText());
    }

    private static Boolean controversial(JsonNode row) {
        Integer flag = integer(row, "pl_controv_flag");
        if (flag != null && flag != 0 && flag != 1) {
            throw new IllegalArgumentException("invalid controversy flag");
        }
        return flag == null ? null : flag == 1;
    }

    static final class FetchFailure extends Exception {
        private final String code;

        FetchFailure(String code) {
            super(code);
            this.code = code;
        }

        String code() {
            return code;
        }
    }
}
