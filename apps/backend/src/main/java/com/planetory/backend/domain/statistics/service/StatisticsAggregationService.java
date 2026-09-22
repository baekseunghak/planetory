package com.planetory.backend.domain.statistics.service;

import com.planetory.backend.domain.statistics.dto.StatisticsDtos.BlockStatus;
import com.planetory.backend.domain.statistics.dto.StatisticsDtos.MetricStatus;
import com.planetory.backend.domain.statistics.service.StatisticsSnapshotService.Baseline;
import com.planetory.backend.domain.statistics.service.StatisticsSnapshotService.ComparisonSnapshot;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;
import static com.planetory.backend.domain.statistics.dto.StatisticsDtos.ZONE;

@Service
@RequiredArgsConstructor
public class StatisticsAggregationService {
    public static final long LOCK = 178_20260922L;
    private final JdbcClient jdbc;
    private final JsonMapper json;

    public enum Result { CREATED, ALREADY_EXISTS, BUSY, HISTORICAL_SOURCE_UNAVAILABLE, FUTURE_CUTOFF_NOT_ALLOWED }

    // 하나의 DB에서 MV/일별 잡을 함께 직렬화한다. API 요청에는 이 잠금이나 쓰기가 없다.
    private boolean lock() {
        jdbc.sql("SET LOCAL statement_timeout='8min'").update();
        return jdbc.sql("SELECT pg_try_advisory_xact_lock(?)").param(LOCK).query(Boolean.class).single();
    }

    @Transactional
    public Result refresh() {
        if (!lock()) return Result.BUSY;
        jdbc.sql("REFRESH MATERIALIZED VIEW " + (GlobalStatisticsService.populated(jdbc) ? "CONCURRENTLY " : "")
                + "global_stats").update();
        return Result.CREATED;
    }

    @Transactional(isolation = Isolation.REPEATABLE_READ)
    public Result snapshot(LocalDate cutoffDate) {
        if (!lock()) return Result.BUSY;
        var observed = jdbc.sql("SELECT transaction_timestamp()").query(OffsetDateTime.class).single();
        LocalDate today = observed.atZoneSameInstant(ZONE).toLocalDate();
        LocalDate cutoff = cutoffDate == null ? today : cutoffDate;
        if (cutoff.isAfter(today)) return Result.FUTURE_CUTOFF_NOT_ALLOWED;
        LocalDate date = cutoff.minusDays(1);
        if (jdbc.sql("SELECT EXISTS(SELECT 1 FROM stats_snapshots WHERE snapshot_date=? AND scope='global' AND round_id IS NULL)")
                .param(date).query(Boolean.class).single()) return Result.ALREADY_EXISTS;
        if (!cutoff.equals(today)) return Result.HISTORICAL_SOURCE_UNAVAILABLE;

        var end = cutoff.atStartOfDay(ZONE).toOffsetDateTime();
        var start = cutoff.minusDays(90).atStartOfDay(ZONE).toOffsetDateTime();
        Map<String, Baseline> metrics = new LinkedHashMap<>();
        var count = new long[1];
        // 원천별 분자/분모는 177과 같은 SQL. PostgreSQL numeric에서 정렬 후 가운데 두 값을 평균한다.
        // percentile_cont(double precision)의 이진 부동소수점 변환을 피한다.
        jdbc.sql("""
                WITH cohort AS MATERIALIZED (
                    SELECT DISTINCT s.user_id FROM submissions s JOIN users u ON u.id=s.user_id AND u.status='active'
                    WHERE s.created_at>=:cohortStart AND s.created_at<:asOf AND u.created_at<:asOf
                ), member_metrics AS (
                """ + ComparisonMetricQuery.COHORT_SQL + """
                ), metric_values AS (
                    SELECT v.* FROM member_metrics m
                    CROSS JOIN LATERAL (VALUES
                        ('firstMatchAccuracy',100::numeric*m.agreed/nullif(m.graded,0)),
                        ('submissionsPerStar',m.submissions::numeric/nullif(m.stars,0)),
                        ('harmonicRecognitionRate',100::numeric*m.harmonic/nullif(m.recognized,0)),
                        ('evidencePerSubmission',m.evidence::numeric/nullif(m.candidates,0))) v(key,value)
                ), ordered AS (
                    SELECT k.key,k.unit,array_agg(v.value ORDER BY v.value) FILTER (WHERE v.value IS NOT NULL) AS values,
                        count(v.value)::integer AS sample_count
                    FROM (VALUES ('firstMatchAccuracy','PERCENT'),('submissionsPerStar','SUBMISSIONS_PER_STAR'),
                        ('harmonicRecognitionRate','PERCENT'),('evidencePerSubmission','CHECKS_PER_SUBMISSION')) k(key,unit)
                    LEFT JOIN metric_values v ON v.key=k.key GROUP BY k.key,k.unit
                )
                SELECT key,unit,sample_count,(SELECT count(*) FROM cohort) AS cohort_count,
                    (values[(sample_count+1)/2]+values[(sample_count+2)/2])/2 AS median FROM ordered
                """).param("asOf", end).param("cohortStart", start).query((r, n) -> {
                    long samples = r.getLong("sample_count");
                    count[0] = r.getLong("cohort_count");
                    metrics.put(r.getString("key"), new Baseline(r.getString("unit"), r.getBigDecimal("median"), samples,
                            samples == 0 ? MetricStatus.NO_SAMPLE : MetricStatus.AVAILABLE,
                            samples == 0 ? "ZERO_DENOMINATOR" : null));
                    return true;
                }).list();
        var generated = jdbc.sql("SELECT clock_timestamp()").query(OffsetDateTime.class).single();
        var snapshot = new ComparisonSnapshot(BlockStatus.READY, end.toInstant(), observed.toInstant(), generated.toInstant(),
                date, start.toInstant(), end.toInstant(), count[0], metrics);
        int inserted = jdbc.sql("INSERT INTO stats_snapshots(snapshot_date,scope,round_id,metrics) VALUES (?,'global',NULL,?::jsonb) "
                + "ON CONFLICT (snapshot_date,scope,round_id) DO NOTHING")
                .param(date).param(json.writeValueAsString(snapshot)).update();
        return inserted == 1 ? Result.CREATED : Result.ALREADY_EXISTS;
    }
}
