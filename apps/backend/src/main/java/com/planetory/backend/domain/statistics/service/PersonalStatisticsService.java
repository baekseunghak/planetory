package com.planetory.backend.domain.statistics.service;

import com.planetory.backend.domain.exploration.service.ExplorationSummaryService;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.domain.statistics.dto.StatisticsDtos.*;
import com.planetory.backend.domain.statistics.service.StatisticsSnapshotService.ComparisonSnapshot;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.TemporalAdjusters;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import static com.planetory.backend.domain.statistics.dto.StatisticsDtos.*;

@Service
@RequiredArgsConstructor
public class PersonalStatisticsService {
    private final MemberService members;
    private final ExplorationSummaryService summaries;
    private final ComparisonMetricQuery common;
    private final PersonalStatisticsQuery query;
    private final StatisticsSnapshotService snapshots;
    private final JdbcClient jdbc;
    private final Clock clock;

    public record Current(BlockStatus status, Instant asOf, Instant generatedAt, Instant periodStart,
            Instant periodEnd, Map<String, Metric> metrics, Map<String, Metric> achievementByType,
            Map<String, Metric> gradeDistribution, Map<String, Metric> judgmentDistribution,
            Map<String, Metric> judgmentAccuracy, Map<String, Metric> publicJudgmentDistribution,
            List<PersonalStatisticsQuery.Week> weeks, List<PersonalStatisticsQuery.Evidence> evidence,
            String nextGoal) {}
    public record ComparisonValue(Metric myValue, BigDecimal median, Long sampleCount,
            MetricStatus status, String reason) {}
    public record Comparison(BlockStatus status, String unavailableReason, Instant asOf, Instant sourceObservedAt,
            Instant generatedAt, LocalDate snapshotDate, Instant cohortStart, Instant cohortEnd,
            Long cohortMemberCount, Boolean inCohort, Map<String, ComparisonValue> metrics) {}
    public record Response(String policyVersion, String timeZone, Current current, Comparison comparison) {}

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Response read(long memberId) {
        var member=members.requireActive(memberId);
        Instant asOf=jdbc.sql("SELECT transaction_timestamp()").query(OffsetDateTime.class).single().toInstant();
        var summary=summaries.achievementSummary(memberId);
        Map<String,Metric> metrics=new LinkedHashMap<>(common.read(memberId,asOf.atOffset(ZoneOffset.UTC)).getFirst().metrics());
        metrics.putAll(query.activity(memberId));
        metrics.put("discoveredStarCount",Metric.count("STARS",summary.discoveredStarCount()));
        metrics.put("completedStarCount",Metric.count("STARS",summary.completedStarCount()));
        metrics.put("recognizedTotal",Metric.count("SIGNALS",summary.recognizedTotal()));
        metrics.put("retryRecognitionCount",query.retryRecognition(memberId));
        metrics.putAll(query.community(memberId));
        var weekStart=asOf.atZone(ZONE).toLocalDate().with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY));
        var weeks=query.weeks(memberId,weekStart);
        var evidence=query.evidence(memberId);
        var judgments=query.judgmentDistribution(memberId,false);
        var accuracy=query.judgmentAccuracy(memberId);
        var publicJudgments=query.judgmentDistribution(memberId,true);
        var snapshot=snapshots.latest();
        var comparison=compare(member.getCreatedAt(),snapshot);
        Current current=new Current(BlockStatus.READY,asOf,clock.instant(),member.getCreatedAt(),asOf,metrics,
                counts(summary.byType(),"SIGNALS"),counts(summary.gradeDistribution(),"STARS"),
                judgments,accuracy,publicJudgments,weeks,evidence,
                metrics.get("submissionCount").value().signum()==0 ? "별을 선택해 첫 탐사 기록을 남겨 보세요."
                        : "최근 탐사 기록과 선택한 근거를 함께 살펴보세요.");
        return new Response(POLICY_VERSION,ZONE.getId(),current,comparison);
    }

    private Comparison compare(Instant joinedAt, ComparisonSnapshot snapshot) {
        Map<String,ComparisonValue> values=new LinkedHashMap<>();
        boolean available=snapshot.status()!=BlockStatus.UNAVAILABLE;
        for(String key:ComparisonMetricQuery.KEYS) {
            var baseline=snapshot.metrics().get(key);
            String unit=switch(key) {
                case "submissionsPerStar" -> "SUBMISSIONS_PER_STAR";
                case "evidencePerSubmission" -> "CHECKS_PER_SUBMISSION";
                default -> "PERCENT";
            };
            Metric mine=Metric.unavailable(unit,available ? "HISTORICAL_SOURCE_UNAVAILABLE" : "AGGREGATE_NOT_READY");
            if(available && !joinedAt.isBefore(snapshot.cohortEnd()))
                mine=new Metric(unit,null,null,null,MetricStatus.NOT_APPLICABLE,"JOINED_AFTER_CUTOFF");
            values.put(key,new ComparisonValue(mine,baseline==null?null:baseline.median(),
                    baseline==null?null:baseline.sampleCount(),baseline==null?MetricStatus.UNAVAILABLE:baseline.status(),
                    baseline==null?"AGGREGATE_NOT_READY":baseline.reason()));
        }
        // 과거 모수 회원 명단도 저장하지 않는다. 현재 원천으로 과거 포함 여부를 추정하지 않는다.
        return new Comparison(snapshot.status(),available?null:"AGGREGATE_NOT_READY",snapshot.asOf(),
                snapshot.sourceObservedAt(),snapshot.generatedAt(),snapshot.snapshotDate(),snapshot.cohortStart(),
                snapshot.cohortEnd(),snapshot.cohortMemberCount(),
                available && !joinedAt.isBefore(snapshot.cohortEnd()) ? false : null,values);
    }

    private static Map<String,Metric> counts(Map<String,Long> source,String unit) {
        Map<String,Metric> result=new LinkedHashMap<>();
        source.forEach((key,value)->result.put(key,Metric.count(unit,value)));
        return result;
    }
}
