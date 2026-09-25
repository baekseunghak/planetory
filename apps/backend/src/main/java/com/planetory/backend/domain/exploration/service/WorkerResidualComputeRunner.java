package com.planetory.backend.domain.exploration.service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Function;
import java.util.stream.Collectors;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.DisposableBean;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import com.planetory.backend.domain.exploration.service.ResidualJobStore.Failure;
import com.planetory.backend.domain.exploration.service.ResidualJobStore.Job;
import com.planetory.backend.domain.gold.GoldCatalogRepository;
import com.planetory.backend.domain.gold.GoldCatalogViews.Bundle;
import com.planetory.backend.domain.gold.GoldCatalogViews.Candidate;
import com.planetory.backend.domain.gold.GoldCatalogViews.LightCurveSegment;
import com.planetory.backend.domain.gold.GoldCatalogViews.Periodogram;

/**
 * Python Worker로 잔차 → 주기도를 계산하는 실행기 [S15P21C206-88].
 *
 * <p>계약은 {@code contracts/derived-compute/README.md}다. current Gold로 요청을 조립하고
 * {@code POST /internal/v1/derived-compute}를 두 번 부른 뒤, <b>채택 직전에 판이 아직 current인지</b>
 * 다시 본다. Worker는 DB·Redis를 모르므로 이 확인은 여기서만 한다.
 *
 * <p>{@code planetory.residual.worker-url}이 비어 있으면 빈으로 뜨지 않는다. 그때 요청은 지금처럼
 * 503 「준비되지 않았습니다」다(S15P21C206-249).
 *
 * <p>자동 재시도는 하지 않는다. 실패는 {@code retryable}을 붙여 끝내고 재시도는 7.1절 재요청(새 작업,
 * attempt 1)이다. 한 작업 안에서 attempt를 올려 다시 계산하는 것은 임대 만료 복구(S15P21C206-90)다.
 */
@Slf4j
@Component
@ConditionalOnExpression("!'${planetory.residual.worker-url:}'.isBlank()")
class WorkerResidualComputeRunner implements ResidualComputeRunner, DisposableBean {

    static final String PATH = "/internal/v1/derived-compute";
    private static final String SCHEMA_VERSION = "1.0";
    /** 사용자에게는 내부 오류 코드를 보이지 않는다. 화면은 retryable로 할 일을 정한다(7.2절). */
    private static final String COMPUTE_ERROR = "COMPUTE_ERROR";
    private static final String STAGE_RESIDUAL = "RESIDUAL";
    private static final String STAGE_PERIODOGRAM = "PERIODOGRAM";
    private static final String STAGE_BUNDLE_ARCHIVED = "BUNDLE_ARCHIVED";
    /** Gold의 transit_model(JSONB)은 Jackson 2 노드다. Worker 요청은 앱의 Jackson 3로 쓴다. */
    private static final ObjectMapper GOLD_JSON = new ObjectMapper();

    private final ResidualJobStore store;
    private final GoldCatalogRepository gold;
    private final JsonMapper json;
    private final Clock clock;
    private final URI endpoint;
    private final Duration timeout;
    private final HttpClient http;
    /** 동시 계산 수만큼만 돈다. 대기열 상한은 저장소가 이미 걸렀다. */
    private final ExecutorService workers;

    WorkerResidualComputeRunner(ResidualJobStore store, GoldCatalogRepository gold, JsonMapper json, Clock clock,
                                ResidualJobProperties properties,
                                @Value("${planetory.residual.worker-url}") String workerUrl,
                                @Value("${planetory.residual.operation-timeout-seconds:120}") long timeoutSeconds) {
        this.store = store;
        this.gold = gold;
        this.json = json;
        this.clock = clock;
        this.endpoint = URI.create(workerUrl.replaceAll("/+$", "") + PATH);
        this.timeout = Duration.ofSeconds(timeoutSeconds);
        this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        this.workers = Executors.newFixedThreadPool(properties.maxRunning(),
                Thread.ofPlatform().name("residual-worker-", 0).daemon().factory());
    }

    @Override
    public void start(Job job) {
        // 제출이 거절되면 예외가 그대로 올라가고 서비스가 START_FAILED로 끝낸다.
        workers.execute(() -> run(job));
    }

    @Override
    public void destroy() {
        workers.shutdownNow();
    }

    private void run(Job job) {
        // 예상하지 못한 예외도 그 단계의 실패로 적는다. 화면과 로그가 어느 계산에서 멈췄는지 알아야 한다.
        String[] stage = {STAGE_RESIDUAL};
        try {
            compute(job, stage);
        } catch (Stop stop) {
            log.warn("잔차 작업 {}(attempt {})이 {}에서 멈췄습니다: {}", job.jobId(), job.attempt(),
                    stop.failure.stage(), stop.detail);
            store.fail(job.jobId(), job.attempt(), stop.failure);
        } catch (RuntimeException e) {
            // 적재 계약 위반, 읽을 수 없는 응답, 코드 결함이다. 작업을 QUEUED·계산 중으로 남기지 않는다.
            log.error("잔차 작업 {}(attempt {})을 {}에서 계산하지 못했습니다.", job.jobId(), job.attempt(), stage[0], e);
            store.fail(job.jobId(), job.attempt(), new Failure(stage[0], COMPUTE_ERROR,
                    "계산하지 못했습니다.", false));
        }
    }

    private void compute(Job job, String[] stage) {
        Inputs inputs = load(job);
        int attempt = job.attempt();

        store.advance(job.jobId(), attempt, ResidualJobStore.RESIDUAL_CALCULATING);
        JsonNode residual = call(residualRequest(job, inputs), STAGE_RESIDUAL);
        Map<Long, Float[]> residualFlux = residualFlux(residual, inputs.segments());
        ensureCurrent(job, inputs.bundle());
        store.advance(job.jobId(), attempt, ResidualJobStore.RESIDUAL_READY);

        stage[0] = STAGE_PERIODOGRAM;
        store.advance(job.jobId(), attempt, ResidualJobStore.PERIODOGRAM_CALCULATING);
        JsonNode periodogram = call(periodogramRequest(job, inputs, residual), STAGE_PERIODOGRAM);
        Float[] power = power(periodogram, inputs.periodogram());
        ensureCurrent(job, inputs.bundle());
        store.complete(job.jobId(), attempt,
                new ResidualJobStore.Result(OffsetDateTime.now(clock), residualFlux, power));
    }

    /** 요청 때 검증한 목표를 다시 읽는다. 그 사이 판이 바뀌었거나 후보가 사라졌으면 계산하지 않는다. */
    private Inputs load(Job job) {
        long bundleId = ExplorationIds.parse(job.target().bundleId(), ExplorationIds.BUNDLE).orElseThrow();
        Bundle bundle = gold.findBundle(bundleId).orElseThrow(() -> bundleChanged("판이 없습니다"));
        ensureCurrent(job, bundle);

        Set<Long> removed = job.target().removedCandidateIds().stream()
                .map(id -> ExplorationIds.parse(id, ExplorationIds.CANDIDATE).orElseThrow())
                .collect(Collectors.toSet());
        Map<Long, Candidate> byId = gold.findCandidates(job.ticId()).stream()
                .filter(candidate -> removed.contains(candidate.id()))
                .collect(Collectors.toMap(Candidate::id, Function.identity()));
        if (byId.size() != removed.size()) {
            throw new Stop(new Failure(STAGE_RESIDUAL, "CANDIDATE_NOT_FOUND",
                    "제거할 후보를 찾지 못했습니다. 최신 정보를 다시 불러와 주세요.", false), "후보 누락 " + removed);
        }
        // 계약 2절 정렬: 세그먼트는 (sector, binning_revision, segment_id), 후보는 id 오름차순.
        List<LightCurveSegment> segments = gold.findSegments(job.ticId(), bundle.manifest().segmentIds()).stream()
                .sorted(Comparator.comparingInt((LightCurveSegment s) -> s.sector())
                        .thenComparing(LightCurveSegment::binningRevision)
                        .thenComparingLong(LightCurveSegment::id))
                .toList();
        List<Candidate> candidates = byId.values().stream().sorted(Comparator.comparingLong(Candidate::id)).toList();
        Periodogram periodogram = gold.findPeriodogram(job.ticId(), bundle.id())
                .orElseThrow(() -> new IllegalStateException(job.target().bundleId() + "의 원본 주기도가 없습니다."));
        return new Inputs(bundle, segments, candidates, periodogram);
    }

    private void ensureCurrent(Job job, Bundle bundle) {
        boolean current = gold.findCurrentBundle(job.ticId()).map(found -> found.id() == bundle.id()).orElse(false);
        if (!current) {
            throw bundleChanged("current가 아닙니다");
        }
    }

    private static Stop bundleChanged(String detail) {
        // 화면은 폴링 헤더로 먼저 알아채고 최신 판을 다시 부른다(D-5). 이 실패는 그 뒤의 안전망이다.
        return new Stop(new Failure(STAGE_BUNDLE_ARCHIVED, "BUNDLE_CHANGED",
                "새 판이 공개되어 계산을 멈췄습니다. 최신 판을 다시 불러와 주세요.", false), detail);
    }

    private Map<String, Object> common(Job job, Inputs inputs, String operation) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("schema_version", SCHEMA_VERSION);
        body.put("operation", operation);
        body.put("job_id", job.jobId());
        body.put("attempt", job.attempt());
        body.put("publication_bundle_id", job.target().bundleId());
        body.put("tic_id", String.valueOf(job.ticId()));
        body.put("fold_reference_time_btjd", inputs.bundle().foldReferenceTimeBtjd());
        body.put("residual_model_version", job.target().residualModelVersion());
        body.put("periodogram_config_version", job.target().periodogramConfigVersion());
        return body;
    }

    private Map<String, Object> residualRequest(Job job, Inputs inputs) {
        Map<String, Object> body = common(job, inputs, "residual");
        body.put("curve_segments", inputs.segments().stream().map(segment -> {
            Map<String, Object> out = segmentFields(segment);
            out.put("flux", flux(segment.flux()));
            return out;
        }).toList());
        body.put("removed_candidates", inputs.candidates().stream().map(candidate -> {
            @SuppressWarnings("unchecked")
            Map<String, Object> model = GOLD_JSON.convertValue(candidate.transitModel(), LinkedHashMap.class);
            // Gold 값에는 candidate_id가 빠져 있을 수 있다. 계약은 c-<id>로 일치해야 한다.
            model.put("candidate_id", ExplorationIds.candidate(candidate.id()));
            return Map.of("candidate_id", ExplorationIds.candidate(candidate.id()), "transit_model", model);
        }).toList());
        return body;
    }

    private Map<String, Object> periodogramRequest(Job job, Inputs inputs, JsonNode residual) {
        Map<String, Object> body = common(job, inputs, "periodogram");
        body.put("removed_candidate_ids", job.target().removedCandidateIds());
        Map<String, JsonNode> fluxById = new LinkedHashMap<>();
        residual.get("residual_segments").forEach(segment -> fluxById.put(segment.get("segment_id").asString(),
                segment.get("flux")));
        body.put("residual_segments", inputs.segments().stream().map(segment -> {
            Map<String, Object> out = segmentFields(segment);
            out.put("flux", fluxById.get(ExplorationIds.segment(segment.id())));
            return out;
        }).toList());
        // 원본 주기도와 같은 격자다. 범위·점 수는 DB 열이 정본이고 manifest에서는 간격 규칙만 읽는다(계약 3.3절).
        Periodogram original = inputs.periodogram();
        body.put("period_grid", Map.of(
                "min_days", original.periodMinDays().doubleValue(),
                "max_days", original.periodMaxDays().doubleValue(),
                "count", original.nPeriods(),
                "spacing", inputs.bundle().manifest().periodGrid().get("spacing").asText()));
        return body;
    }

    private static Map<String, Object> segmentFields(LightCurveSegment segment) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("segment_id", ExplorationIds.segment(segment.id()));
        out.put("sector", (int) segment.sector());
        out.put("binning_revision", segment.binningRevision());
        out.put("start_btjd", segment.startBtjd());
        out.put("bin_minutes", segment.binMinutes().doubleValue());
        out.put("n_points", segment.nPoints());
        return out;
    }

    /** float32 값을 그대로 보낸다. Float로 쓰면 짧은 십진 표현이 되어 DB 값과 달라진다(131 비교 기준). */
    private static List<Double> flux(Float[] values) {
        List<Double> out = new ArrayList<>(values.length);
        for (Float value : values) {
            out.add(value == null ? null : value.doubleValue());
        }
        return out;
    }

    /**
     * 한 번 부른다. 성공한 {@code result}만 돌려주고 나머지는 모두 {@link Stop}이다.
     *
     * <p>응답의 상관 필드가 요청과 하나라도 다르면 채택하지 않는다(계약 4절).
     */
    private JsonNode call(Map<String, Object> body, String stage) {
        HttpResponse<String> response;
        try {
            HttpRequest request = HttpRequest.newBuilder(endpoint).timeout(timeout)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build();
            response = http.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (HttpTimeoutException e) {
            throw retryable(stage, "compute_timeout " + timeout);
        } catch (IOException e) {
            throw retryable(stage, "worker_unavailable " + e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw retryable(stage, "worker_unavailable interrupted");
        }
        if (response.statusCode() == 503) {
            throw retryable(stage, "worker_unavailable busy");
        }
        if (response.statusCode() != 200) {
            throw failed(stage, "HTTP " + response.statusCode() + " " + response.body());
        }
        JsonNode answer = json.readTree(response.body());
        for (String key : List.of("schema_version", "operation", "job_id", "publication_bundle_id", "tic_id")) {
            if (!body.get(key).equals(answer.path(key).asString(null))) {
                throw failed(stage, "상관 필드 불일치 " + key);
            }
        }
        List<String> removed = new ArrayList<>();
        answer.path("removed_candidate_ids").forEach(id -> removed.add(id.asString()));
        List<String> expected = "residual".equals(body.get("operation"))
                ? ((List<?>) body.get("removed_candidates")).stream()
                        .map(candidate -> (String) ((Map<?, ?>) candidate).get("candidate_id")).toList()
                : castList(body.get("removed_candidate_ids"));
        if (answer.path("attempt").asInt(-1) != (int) body.get("attempt") || !removed.equals(expected)) {
            throw failed(stage, "상관 필드 불일치 attempt/removed_candidate_ids");
        }
        if (!answer.path("ok").asBoolean(false)) {
            // Worker 오류는 모두 재시도해도 같은 결과다(계약 4절 표). 원인은 로그에만 남긴다.
            JsonNode error = answer.path("error");
            throw failed(stage, error.path("code").asString("?") + " " + error.path("field").asString("")
                    + " " + error.path("message").asString(""));
        }
        log.info("잔차 작업 {} {} 완료, runtime {}", body.get("job_id"), stage, answer.path("runtime"));
        return answer.path("result");
    }

    @SuppressWarnings("unchecked")
    private static List<String> castList(Object value) {
        return (List<String>) value;
    }

    private static Map<Long, Float[]> residualFlux(JsonNode result, List<LightCurveSegment> segments) {
        Map<String, JsonNode> byId = new LinkedHashMap<>();
        result.path("residual_segments").forEach(segment -> byId.put(segment.path("segment_id").asString(""), segment));
        Map<Long, Float[]> out = new LinkedHashMap<>();
        for (LightCurveSegment segment : segments) {
            JsonNode found = byId.get(ExplorationIds.segment(segment.id()));
            JsonNode flux = found == null ? null : found.path("flux");
            if (flux == null || !flux.isArray() || flux.size() != segment.nPoints()) {
                throw failed(STAGE_RESIDUAL, ExplorationIds.segment(segment.id()) + " 잔차 점 수 불일치");
            }
            Float[] values = new Float[flux.size()];
            for (int i = 0; i < values.length; i++) {
                values[i] = flux.get(i).isNull() ? null : number(flux.get(i), STAGE_RESIDUAL);
            }
            out.put(segment.id(), values);
        }
        return out;
    }

    private static Float[] power(JsonNode result, Periodogram original) {
        JsonNode power = result.path("power");
        if (!power.isArray() || power.size() != original.nPeriods()) {
            throw failed(STAGE_PERIODOGRAM, "주기도 점 수 불일치 " + power.size() + " != " + original.nPeriods());
        }
        Float[] values = new Float[power.size()];
        for (int i = 0; i < values.length; i++) {
            values[i] = number(power.get(i), STAGE_PERIODOGRAM);
        }
        return values;
    }

    /** 신뢰 경계라 값을 확인한다. asDouble()은 숫자가 아닌 값을 조용히 0으로 바꾼다. */
    private static float number(JsonNode value, String stage) {
        if (!value.isNumber() || !Double.isFinite(value.asDouble())) {
            throw failed(stage, "숫자가 아닌 결과 값 " + value);
        }
        return (float) value.asDouble();
    }

    private static Stop retryable(String stage, String detail) {
        return new Stop(new Failure(stage, COMPUTE_ERROR,
                "계산 서버가 응답하지 않았습니다. 잠시 후 다시 시도해 주세요.", true), detail);
    }

    private static Stop failed(String stage, String detail) {
        return new Stop(new Failure(stage, COMPUTE_ERROR, "계산하지 못했습니다.", false), detail);
    }

    private record Inputs(Bundle bundle, List<LightCurveSegment> segments, List<Candidate> candidates,
                          Periodogram periodogram) {
    }

    /** 작업을 이 실패로 끝낸다. {@code detail}은 로그에만 남는다. */
    private static final class Stop extends RuntimeException {
        private final Failure failure;
        private final String detail;

        Stop(Failure failure, String detail) {
            super(detail, null, false, false);
            this.failure = failure;
            this.detail = detail;
        }
    }
}
