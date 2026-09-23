package com.planetory.backend.domain.statistics.service;

import com.planetory.backend.domain.statistics.dto.StatisticsDtos.BlockStatus;
import com.planetory.backend.domain.statistics.dto.StatisticsDtos.MetricStatus;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;
import static com.planetory.backend.domain.statistics.dto.StatisticsDtos.ZONE;

/** 비식별 성공 기준선만 읽는다. 본인 값은 177의 인증 경로에서 결합한다. */
@Service
@RequiredArgsConstructor
public class StatisticsSnapshotService {
    private final JdbcClient jdbc;
    private final JsonMapper json;
    private final Clock clock;
    @Value("${planetory.statistics.min-public-cohort:10}") private int minPublicCohort;

    public record Baseline(String unit, BigDecimal median, long sampleCount, MetricStatus status, String reason) {}
    public record ComparisonSnapshot(BlockStatus status, Instant asOf, Instant sourceObservedAt, Instant generatedAt,
            LocalDate snapshotDate, Instant cohortStart, Instant cohortEnd, Long cohortMemberCount,
            Map<String, Baseline> metrics) {}

    @Transactional(readOnly = true)
    public ComparisonSnapshot latest() {
        return jdbc.sql("SELECT metrics::text FROM stats_snapshots WHERE scope='global' AND round_id IS NULL "
                + "ORDER BY snapshot_date DESC LIMIT 1")
                .query(String.class).optional().map(value -> {
                    var saved = json.readValue(value, ComparisonSnapshot.class);
                    if (saved.cohortMemberCount() == null || saved.cohortMemberCount() < minPublicCohort) return unavailable();
                    var status = saved.snapshotDate().isBefore(LocalDate.now(clock.withZone(ZONE)).minusDays(1))
                            ? BlockStatus.STALE : saved.status();
                    return new ComparisonSnapshot(status, saved.asOf(), saved.sourceObservedAt(), saved.generatedAt(),
                            saved.snapshotDate(), saved.cohortStart(), saved.cohortEnd(), saved.cohortMemberCount(), saved.metrics());
                }).orElseGet(StatisticsSnapshotService::unavailable);
    }

    public static ComparisonSnapshot unavailable() {
        return new ComparisonSnapshot(BlockStatus.UNAVAILABLE, null, null, null, null, null, null, null, Map.of());
    }
}
