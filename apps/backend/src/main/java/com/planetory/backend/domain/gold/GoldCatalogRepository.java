package com.planetory.backend.domain.gold;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import com.planetory.backend.domain.gold.GoldCatalogViews.Bundle;
import com.planetory.backend.domain.gold.GoldCatalogViews.Candidate;
import com.planetory.backend.domain.gold.GoldCatalogViews.LightCurveSegment;
import com.planetory.backend.domain.gold.GoldCatalogViews.Periodogram;

/**
 * Gold 카탈로그 읽기 전용 조회 [S15P21C206-134].
 *
 * <p>배열·JSONB 중심이라 JPA가 아니라 JdbcClient를 쓴다(build.gradle 방침). 쓰기 메서드는
 * 두지 않는다. 적재는 배치 역할이 담당하며 앱 역할에는 DB 권한 자체가 없다(V2).
 */
@Repository
public class GoldCatalogRepository implements ApplicationRunner {
    private static final Logger log = LoggerFactory.getLogger(GoldCatalogRepository.class);

    /**
     * DB의 JSONB를 읽는 전용 매퍼다. HTTP 직렬화 설정과 분리해 둔다. Gold의 manifest·모델은
     * 배치가 쓴 고정 계약이므로 응답 표현 규칙이 바뀌어도 해석이 흔들리면 안 된다.
     *
     * <p>현재 이 프로젝트에는 애플리케이션 전역 {@code ObjectMapper} 빈이 없다
     * ({@code spring-boot-starter-json} 미포함). 전역 빈이 생기더라도 위 이유로 주입받지 않는다.
     */
    private static final ObjectMapper JSONB = new ObjectMapper();

    private final JdbcClient jdbc;
    private final GoldReadCache cache;

    public GoldCatalogRepository(JdbcClient jdbc, ObjectProvider<GoldReadCache> cache) {
        this.jdbc = jdbc;
        this.cache = cache.getIfAvailable();
    }

    @Override
    public void run(ApplicationArguments args) {
        if (cache == null) return;
        long started = System.nanoTime();
        int attempted = 0;
        for (long ticId : cache.selectedTics()) {
            if (!cache.available()) break;
            attempted++;
            try {
                preloadSelectedTic(ticId);
            } catch (RuntimeException ex) {
                log.warn("TIC {} 기동 시 Gold 사전 적재 실패, PostgreSQL 조회를 유지합니다", ticId, ex);
            }
        }
        log.info("Gold 기동 사전 적재 종료: 시도 {}/{}개, 소요 {}ms", attempted,
                cache.selectedTics().size(), (System.nanoTime() - started) / 1_000_000);
    }

    /** 시작 시와 Publisher의 판 전환 알림에서 현재 판만 적재한다. */
    public void preloadSelectedTic(long ticId) {
        if (cache == null || !cache.selectedTics().contains(ticId)) return;
        findCurrentBundle(ticId).ifPresent(bundle -> {
            List<LightCurveSegment> segments = loadSegments(bundle.manifest().segmentIds());
            Optional<Periodogram> periodogram = loadPeriodogram(bundle.id());
            if (segments.size() != bundle.manifest().segmentIds().size()
                    || periodogram.isEmpty() || !isCurrent(ticId, bundle.id())) {
                log.warn("TIC {} 판 {}의 사전 적재를 건너뜁니다: Gold가 불완전하거나 current가 바뀌었습니다", ticId, bundle.id());
                return;
            }
            cache.warm(bundle, segments, periodogram.orElseThrow());
        });
    }

    /** 지금 공개 중인 판. 분석 진입과 후속 요청은 이 값을 요청의 {@code bundleId}와 대조한다. */
    public Optional<Bundle> findCurrentBundle(long ticId) {
        return jdbc.sql("""
                        SELECT id, tic_id, bundle_version, status, manifest,
                               fold_reference_time_btjd, base_days, published_at
                          FROM publication_bundles
                         WHERE tic_id = :ticId AND status = 'current'
                        """)
                .param("ticId", ticId)
                .query(this::toBundle)
                .optional();
    }

    /**
     * 과거 제출 재현용 조회. 진행 중 세션·재시도는 {@link #findCurrentBundle(long)}을 쓴다.
     * 판이 교체돼 {@code archived}가 돼도 제출 참조용 Bundle 행은 id로 조회한다.
     */
    public Optional<Bundle> findBundle(long bundleId) {
        return jdbc.sql("""
                        SELECT id, tic_id, bundle_version, status, manifest,
                               fold_reference_time_btjd, base_days, published_at
                          FROM publication_bundles
                         WHERE id = :bundleId
                        """)
                .param("bundleId", bundleId)
                .query(this::toBundle)
                .optional();
    }

    /**
     * 판이 참조하는 곡선 세그먼트. 호출자는 {@link GoldManifest#segmentIds()}를 그대로 넘긴다.
     * 섹터가 아니라 id로 읽어야 revision이 섞이지 않는다.
     */
    public List<LightCurveSegment> findSegments(long ticId, Collection<Long> segmentIds) {
        if (segmentIds.isEmpty()) {
            return List.of();
        }
        if (cache != null && cache.selected(ticId)) {
            List<LightCurveSegment> hit = cache.segments(segmentIds);
            if (hit != null) return hit;
        }
        List<LightCurveSegment> segments = loadSegments(segmentIds);
        if (cache != null && cache.selected(ticId)) cache.refillSegments(segmentIds, segments);
        return segments;
    }

    private List<LightCurveSegment> loadSegments(Collection<Long> segmentIds) {
        return jdbc.sql("""
                        SELECT id, tic_id, sector, binning_revision, start_btjd, bin_minutes,
                               n_points, flux, flux_scatter, gaps
                          FROM light_curve_segments
                         WHERE id = ANY (:ids)
                         ORDER BY sector, start_btjd
                        """)
                .param("ids", segmentIds.toArray(Long[]::new))
                .query(this::toSegment)
                .list();
    }

    public Optional<Periodogram> findPeriodogram(long ticId, long bundleId) {
        boolean selectedCurrent = cache != null && cache.selected(ticId) && isCurrent(ticId, bundleId);
        if (selectedCurrent) {
            Periodogram hit = cache.periodogram(bundleId);
            if (hit != null) return Optional.of(hit);
        }
        Optional<Periodogram> periodogram = loadPeriodogram(bundleId);
        if (selectedCurrent) periodogram.ifPresent(value -> cache.refillPeriodogram(bundleId, value));
        return periodogram;
    }

    private Optional<Periodogram> loadPeriodogram(long bundleId) {
        return jdbc.sql("""
                        SELECT bundle_id, period_min_days, period_max_days, n_periods, power
                          FROM periodograms
                         WHERE bundle_id = :bundleId
                        """)
                .param("bundleId", bundleId)
                .query(this::toPeriodogram)
                .optional();
    }

    private boolean isCurrent(long ticId, long bundleId) {
        return jdbc.sql("SELECT 1 FROM publication_bundles"
                        + " WHERE id = :bundleId AND tic_id = :ticId AND status = 'current'")
                .param("bundleId", bundleId).param("ticId", ticId)
                .query(Integer.class).optional().isPresent();
    }

    /**
     * 그 별의 후보 목록. 매칭은 {@code active}이고 제거 조합에 없는 후보만 대상으로 한다.
     * 은퇴한 후보도 과거 제출 재현에 필요하므로 여기서 걸러내지 않는다.
     */
    public List<Candidate> findCandidates(long ticId) {
        return jdbc.sql("""
                        SELECT id, tic_id, status, updated_bundle_id, removal_step, period_days,
                               epoch_btjd, duration_hours, depth_ppm, bls_power, transit_model,
                               discoverable, is_confirmed
                          FROM candidates
                         WHERE tic_id = :ticId
                         ORDER BY removal_step, id
                        """)
                .param("ticId", ticId)
                .query(this::toCandidate)
                .list();
    }

    private Bundle toBundle(ResultSet rs, int rowNum) throws SQLException {
        return new Bundle(
                rs.getLong("id"),
                rs.getLong("tic_id"),
                rs.getString("bundle_version"),
                enumOf(Bundle.Status.class, rs.getString("status")),
                readManifest(rs.getString("manifest")),
                rs.getDouble("fold_reference_time_btjd"),
                rs.getBigDecimal("base_days"),
                rs.getObject("published_at", java.time.OffsetDateTime.class));
    }

    private LightCurveSegment toSegment(ResultSet rs, int rowNum) throws SQLException {
        return new LightCurveSegment(
                rs.getLong("id"),
                rs.getLong("tic_id"),
                rs.getShort("sector"),
                rs.getString("binning_revision"),
                rs.getDouble("start_btjd"),
                rs.getBigDecimal("bin_minutes"),
                rs.getInt("n_points"),
                floatArray(rs, "flux", true),
                rs.getBigDecimal("flux_scatter"),
                readJson(rs.getString("gaps")));
    }

    private Periodogram toPeriodogram(ResultSet rs, int rowNum) throws SQLException {
        return new Periodogram(
                rs.getLong("bundle_id"),
                rs.getBigDecimal("period_min_days"),
                rs.getBigDecimal("period_max_days"),
                rs.getInt("n_periods"),
                floatArray(rs, "power", false));
    }

    private Candidate toCandidate(ResultSet rs, int rowNum) throws SQLException {
        return new Candidate(
                rs.getLong("id"),
                rs.getLong("tic_id"),
                enumOf(Candidate.Status.class, rs.getString("status")),
                rs.getLong("updated_bundle_id"),
                rs.getShort("removal_step"),
                rs.getBigDecimal("period_days"),
                rs.getBigDecimal("epoch_btjd"),
                rs.getBigDecimal("duration_hours"),
                rs.getBigDecimal("depth_ppm"),
                rs.getBigDecimal("bls_power"),
                readJson(rs.getString("transit_model")),
                rs.getBoolean("discoverable"),
                rs.getBoolean("is_confirmed"));
    }

    /** Gold 배열을 읽는다. {@code getArray().getArray()}는 Float[]를 주므로 그대로 쓴다. */
    private static Float[] floatArray(ResultSet rs, String column, boolean nullAllowed)
            throws SQLException {
        java.sql.Array array = rs.getArray(column);
        return array == null ? null
                : requireContractValues(column, (Float[]) array.getArray(), nullAllowed);
    }

    /**
     * 조회한 Gold 배열이 계약 안의 값인지 확인한다 [S15P21C206-117, S15P21C206-140].
     *
     * <p>곡선은 유한수 또는 NULL(빈 bin), 주기도는 격자 전 점에 값이 있어야 하므로 유한수만 담는다.
     * NaN은 제안된 배열 checksum에서 NULL과 같은 바이트({@code 0x7FC00000})라 checksum으로는 가려낼
     * 수 없다. V10 CHECK가 적재를 막으므로 여기까지 왔다면 계약이 어긋난 것이다.
     *
     * @param nullAllowed 곡선의 빈 bin처럼 계약이 NULL을 허용하는 배열인지
     */
    static Float[] requireContractValues(String column, Float[] values, boolean nullAllowed) {
        for (int i = 0; i < values.length; i++) {
            Float value = values[i];
            boolean valid = value == null ? nullAllowed : Float.isFinite(value);
            if (!valid) {
                throw new IllegalStateException(column + "[" + i + "]가 " + value
                        + "입니다. 곡선은 유한수 또는 NULL, 주기도는 유한수만 담으므로 계약이 어긋난 적재입니다.");
            }
        }
        return values;
    }

    private static <E extends Enum<E>> E enumOf(Class<E> type, String value) {
        return Enum.valueOf(type, value.toUpperCase(Locale.ROOT));
    }

    private GoldManifest readManifest(String json) {
        try {
            return JSONB.readValue(json, GoldManifest.class);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("manifest를 읽을 수 없습니다. V3 CHECK가 형태를 보장하므로 "
                    + "여기까지 왔다면 계약이 어긋난 것입니다: " + json, e);
        }
    }

    private JsonNode readJson(String json) {
        try {
            return json == null ? null : JSONB.readTree(json);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("JSONB 열을 읽을 수 없습니다: " + json, e);
        }
    }
}
