package com.planetory.backend.domain.gold;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
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
public class GoldCatalogRepository {

    /**
     * DB의 JSONB를 읽는 전용 매퍼다. HTTP 직렬화 설정과 분리해 둔다. Gold의 manifest·모델은
     * 배치가 쓴 고정 계약이므로 응답 표현 규칙이 바뀌어도 해석이 흔들리면 안 된다.
     *
     * <p>현재 이 프로젝트에는 애플리케이션 전역 {@code ObjectMapper} 빈이 없다
     * ({@code spring-boot-starter-json} 미포함). 전역 빈이 생기더라도 위 이유로 주입받지 않는다.
     */
    private static final ObjectMapper JSONB = new ObjectMapper();

    private final JdbcClient jdbc;

    public GoldCatalogRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** 지금 공개 중인 판. 분석 진입은 이 값을 한 번 읽어 {@code bundleId}를 끝까지 고정한다. */
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
     * 판을 id로 읽는다. 교체돼 {@code archived}가 된 판도 보존 기간 안이면 그대로 반환한다.
     *
     * <p>세션이 구판을 계속 쓰기 위한 조회가 아니다. 진행 중 분석은 판 변경을 감지하면 최신 판으로
     * 다시 불러오며 archived 판의 계산 결과를 채택하지 않는다(D-16·D-17, 2026-09-15). 이 메서드는
     * 요청이 들고 온 {@code bundleId}가 현재 판과 같은지 검증하거나(`BUNDLE_CHANGED`),
     * 제출 당시 판을 기록·재현할 때 쓴다.
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
    public List<LightCurveSegment> findSegments(Collection<Long> segmentIds) {
        if (segmentIds.isEmpty()) {
            return List.of();
        }
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

    public Optional<Periodogram> findPeriodogram(long bundleId) {
        return jdbc.sql("""
                        SELECT bundle_id, period_min_days, period_max_days, n_periods, power
                          FROM periodograms
                         WHERE bundle_id = :bundleId
                        """)
                .param("bundleId", bundleId)
                .query(this::toPeriodogram)
                .optional();
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
                floatArray(rs, "flux"),
                rs.getBigDecimal("flux_scatter"),
                readJson(rs.getString("gaps")));
    }

    private Periodogram toPeriodogram(ResultSet rs, int rowNum) throws SQLException {
        return new Periodogram(
                rs.getLong("bundle_id"),
                rs.getBigDecimal("period_min_days"),
                rs.getBigDecimal("period_max_days"),
                rs.getInt("n_periods"),
                floatArray(rs, "power"));
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

    /** 결측을 null로 보존한다. {@code getArray().getArray()}는 Float[]를 주므로 그대로 쓴다. */
    private static Float[] floatArray(ResultSet rs, String column) throws SQLException {
        java.sql.Array array = rs.getArray(column);
        return array == null ? null : (Float[]) array.getArray();
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
