package com.planetory.backend.domain.statistics.service;

import com.planetory.backend.domain.statistics.dto.StatisticsDtos.Metric;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** 현재 읽기 스냅샷의 누적 산식. asOf 필터만으로 과거 원천을 재현하는 함수가 아니다. */
@Repository
@RequiredArgsConstructor
public class ComparisonMetricQuery {
    private final JdbcClient jdbc;
    public static final List<String> KEYS = List.of("firstMatchAccuracy", "submissionsPerStar",
            "harmonicRecognitionRate", "evidencePerSubmission");
    public static final String SQL = """
            WITH members AS (SELECT id FROM users WHERE status='active' AND (id=:memberId OR :memberId=0)),
            submissions_before AS (
                SELECT s.id,s.user_id,s.tic_id,s.matched_candidate_id,s.match_result,s.created_at,
                    s.submission_kind,s.user_judgment,s.evidence_checks
                FROM submissions s JOIN members m ON m.id=s.user_id WHERE s.created_at<:asOf
            ), first_matches AS (
                SELECT DISTINCT ON (user_id,matched_candidate_id) * FROM submissions_before
                WHERE match_result IN ('matched','matched_harmonic')
                ORDER BY user_id,matched_candidate_id,created_at,id
            ), graded AS (
                SELECT f.user_id,count(*) AS denominator,
                    count(*) FILTER (WHERE (d.planet_truth='planet' AND f.user_judgment='LIKELY_PLANET')
                        OR (d.planet_truth='not_planet' AND f.user_judgment='UNLIKELY_PLANET')) AS numerator
                FROM first_matches f JOIN candidate_dispositions d ON d.candidate_id=f.matched_candidate_id
                WHERE d.answer_class='graded' GROUP BY f.user_id
            ), activity AS (
                SELECT user_id,count(*) AS submissions,count(DISTINCT tic_id) AS stars,
                    count(*) FILTER (WHERE submission_kind='candidate') AS candidates,
                    sum(CASE WHEN submission_kind='candidate' THEN
                        (SELECT count(DISTINCT e) FROM jsonb_array_elements_text(
                            CASE WHEN jsonb_typeof(evidence_checks)='array' THEN evidence_checks ELSE '[]'::jsonb END) e
                         WHERE e IN ('oddeven','secondary','ushape')) ELSE 0 END) AS evidence
                FROM submissions_before GROUP BY user_id
            ), recognition AS (
                SELECT a.user_id,count(*) AS total,
                    count(*) FILTER (WHERE s.match_result='matched_harmonic') AS harmonic
                FROM user_candidate_achievements a JOIN members m ON m.id=a.user_id
                JOIN submissions s ON s.id=a.recognized_submission_id AND s.user_id=a.user_id
                WHERE a.recognized_at<:asOf GROUP BY a.user_id
            )
            SELECT m.id,coalesce(g.numerator,0) AS agreed,coalesce(g.denominator,0) AS graded,
                coalesce(t.submissions,0) AS submissions,coalesce(t.stars,0) AS stars,
                coalesce(t.candidates,0) AS candidates,coalesce(t.evidence,0) AS evidence,
                coalesce(r.total,0) AS recognized,coalesce(r.harmonic,0) AS harmonic
            FROM members m LEFT JOIN graded g ON g.user_id=m.id LEFT JOIN activity t ON t.user_id=m.id
                LEFT JOIN recognition r ON r.user_id=m.id ORDER BY m.id
            """;

    public record MemberMetrics(long memberId, Map<String, Metric> metrics) {}

    public List<MemberMetrics> read(long memberId, OffsetDateTime asOf) {
        return jdbc.sql(SQL).param("memberId", memberId).param("asOf", asOf).query((r, n) -> {
            Map<String, Metric> values = new LinkedHashMap<>();
            values.put("firstMatchAccuracy", Metric.ratio("PERCENT", r.getLong("agreed"), r.getLong("graded")));
            values.put("submissionsPerStar", Metric.ratio("SUBMISSIONS_PER_STAR", r.getLong("submissions"), r.getLong("stars")));
            values.put("harmonicRecognitionRate", Metric.ratio("PERCENT", r.getLong("harmonic"), r.getLong("recognized")));
            values.put("evidencePerSubmission", Metric.ratio("CHECKS_PER_SUBMISSION", r.getLong("evidence"), r.getLong("candidates")));
            return new MemberMetrics(r.getLong("id"), values);
        }).list();
    }
}
