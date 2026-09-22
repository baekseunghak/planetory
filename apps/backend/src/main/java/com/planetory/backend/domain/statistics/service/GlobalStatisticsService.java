package com.planetory.backend.domain.statistics.service;

import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.domain.statistics.dto.StatisticsDtos.BlockStatus;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import static com.planetory.backend.domain.statistics.dto.StatisticsDtos.*;

@Service
@RequiredArgsConstructor
public class GlobalStatisticsService {
    private final JdbcClient jdbc;
    private final MemberService members;
    private final JsonMapper json;
    private final Clock clock;
    private final StatisticsSnapshotService snapshots;

    public record GlobalBlock(BlockStatus status, Instant asOf, Instant generatedAt, String reason, JsonNode data) {}
    public record Statistics(String policyVersion, String timeZone, GlobalBlock global, StatisticsSnapshotService.ComparisonSnapshot comparison) {}

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Statistics read(long memberId) {
        members.requireActive(memberId);
        return new Statistics(POLICY_VERSION, ZONE.getId(), current(), snapshots.latest());
    }

    GlobalBlock current() {
        if (!populated(jdbc)) return new GlobalBlock(BlockStatus.UNAVAILABLE, null, null, "AGGREGATE_NOT_READY", null);
        return jdbc.sql("SELECT as_of,generated_at,payload::text FROM global_stats").query((r,n) -> {
            Instant asOf=r.getObject(1,OffsetDateTime.class).toInstant();
            boolean stale=!clock.instant().isBefore(asOf.plusSeconds(600));
            return new GlobalBlock(stale?BlockStatus.STALE:BlockStatus.READY,asOf,
                    r.getObject(2,OffsetDateTime.class).toInstant(),stale?"REFRESH_DELAYED":null,json.readTree(r.getString(3)));
        }).single();
    }

    static boolean populated(JdbcClient jdbc) {
        return jdbc.sql("SELECT ispopulated FROM pg_matviews WHERE schemaname=current_schema() AND matviewname='global_stats'")
                .query(Boolean.class).single();
    }
}
