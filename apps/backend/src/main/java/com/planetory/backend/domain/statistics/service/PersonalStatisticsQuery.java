package com.planetory.backend.domain.statistics.service;

import com.planetory.backend.domain.PublicAnalysisVisibility;
import com.planetory.backend.domain.statistics.dto.StatisticsDtos.Metric;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
@RequiredArgsConstructor
public class PersonalStatisticsQuery {
    private final JdbcClient jdbc;
    private static final String OPEN_BOARD = """
            (p.tic_id IS NULL OR EXISTS(SELECT 1 FROM stars star WHERE star.tic_id=p.tic_id
                AND star.service_status='published'
                AND EXISTS(SELECT 1 FROM star_unlocks u WHERE u.tic_id=star.tic_id)))
            """;

    public Map<String, Metric> activity(long member) {
        return jdbc.sql("""
                SELECT count(*) AS submissions,count(DISTINCT tic_id) AS started,
                    count(DISTINCT (created_at AT TIME ZONE 'Asia/Seoul')::date) AS days
                FROM submissions WHERE user_id=?
                """).param(member).query((r,n) -> Map.of("submissionCount",Metric.count("SUBMISSIONS",r.getLong("submissions")),
                        "startedStarCount",Metric.count("STARS",r.getLong("started")),
                        "activeDays",Metric.count("DAYS",r.getLong("days")))).single();
    }

    public record Week(LocalDate weekStart, LocalDate weekEnd, boolean partial, long submissionCount) {}
    public List<Week> weeks(long member, LocalDate currentWeek) {
        return jdbc.sql("""
                SELECT w::date AS week_start,count(s.id) AS submissions
                FROM generate_series(CAST(:start AS date),CAST(:end AS date),interval '1 week') w
                LEFT JOIN submissions s ON s.user_id=:member
                    AND s.created_at >= (w::timestamp AT TIME ZONE 'Asia/Seoul')
                    AND s.created_at < ((w::timestamp + interval '1 week') AT TIME ZONE 'Asia/Seoul')
                GROUP BY w ORDER BY w
                """).param("start",currentWeek.minusWeeks(7)).param("end",currentWeek).param("member",member)
                .query((r,n)-> {
                    LocalDate week=r.getObject("week_start",LocalDate.class);
                    return new Week(week,week.plusWeeks(1),week.equals(currentWeek),r.getLong("submissions"));
                }).list();
    }

    public Map<String, Metric> judgmentDistribution(long member, boolean published) {
        String source = published ? """
                SELECT DISTINCT ON (s.matched_candidate_id) s.user_judgment
                FROM published_analyses pa JOIN posts p ON p.id=pa.post_id
                JOIN analysis_histories h ON h.id=pa.history_id JOIN submissions s ON s.id=h.submission_id
                WHERE s.user_id=:member AND pa.user_id=:member AND %s AND %s
                ORDER BY s.matched_candidate_id,s.created_at DESC,s.id DESC
                """.formatted(PublicAnalysisVisibility.VISIBLE,OPEN_BOARD)
                : "SELECT user_judgment FROM submissions WHERE user_id=:member AND submission_kind='candidate'";
        return jdbc.sql("SELECT user_judgment,count(*) AS count FROM ("+source+") votes GROUP BY user_judgment")
                .param("member",member).query((r,n)->Map.entry(r.getString("user_judgment"),r.getLong("count")))
                .list().stream().collect(java.util.stream.Collectors.collectingAndThen(
                        java.util.stream.Collectors.toMap(Map.Entry::getKey,Map.Entry::getValue),counts->{
                            long total=counts.values().stream().mapToLong(Long::longValue).sum();
                            Map<String,Metric> result=new LinkedHashMap<>();
                            for(String key:List.of("LIKELY_PLANET","UNLIKELY_PLANET","UNSURE"))
                                result.put(key,Metric.ratio("PERCENT",counts.getOrDefault(key,0L),total));
                            return result;
                        }));
    }

    public Map<String, Metric> judgmentAccuracy(long member) {
        return jdbc.sql("""
                WITH first_matches AS (
                    SELECT DISTINCT ON (matched_candidate_id) * FROM submissions
                    WHERE user_id=? AND match_result IN ('matched','matched_harmonic')
                    ORDER BY matched_candidate_id,created_at,id
                )
                SELECT f.user_judgment,count(*) AS total,count(*) FILTER(WHERE
                    (d.planet_truth='planet' AND f.user_judgment='LIKELY_PLANET') OR
                    (d.planet_truth='not_planet' AND f.user_judgment='UNLIKELY_PLANET')) AS agreed
                FROM first_matches f JOIN candidate_dispositions d ON d.candidate_id=f.matched_candidate_id
                WHERE d.answer_class='graded' GROUP BY f.user_judgment
                """).param(member).query((r,n)->Map.entry(r.getString("user_judgment"),
                        Metric.ratio("PERCENT",r.getLong("agreed"),r.getLong("total"))))
                .list().stream().collect(java.util.stream.Collectors.collectingAndThen(
                        java.util.stream.Collectors.toMap(Map.Entry::getKey,Map.Entry::getValue),values->{
                            Map<String,Metric> result=new LinkedHashMap<>();
                            for(String key:List.of("LIKELY_PLANET","UNLIKELY_PLANET"))
                                result.put(key,values.getOrDefault(key,Metric.ratio("PERCENT",0,0)));
                            return result;
                        }));
    }

    public Metric retryRecognition(long member) {
        return jdbc.sql("""
                WITH first_matches AS (
                    SELECT DISTINCT ON (matched_candidate_id) id,matched_candidate_id,response_snapshot,created_at
                    FROM submissions WHERE user_id=? AND match_result IN ('matched','matched_harmonic')
                    ORDER BY matched_candidate_id,created_at,id
                ), retries AS (
                    SELECT f.response_snapshot FROM first_matches f JOIN user_candidate_achievements a
                        ON a.candidate_id=f.matched_candidate_id AND a.user_id=?
                    JOIN submissions s ON s.id=a.recognized_submission_id
                    WHERE (s.created_at,s.id)>(f.created_at,f.id)
                )
                SELECT count(*) FILTER(WHERE response_snapshot #>> '{signal,answerClass}'='graded'
                    AND response_snapshot #>> '{judgment,evaluation}' IN ('DISAGREES','UNSURE')) AS recognized,
                    count(*) FILTER(WHERE response_snapshot #>> '{signal,answerClass}' IS NULL OR
                        (response_snapshot #>> '{signal,answerClass}'='graded' AND
                            coalesce(response_snapshot #>> '{judgment,evaluation}','') NOT IN ('AGREES','DISAGREES','UNSURE')))
                        AS missing FROM retries
                """).params(member,member).query((r,n)->r.getLong("missing")>0
                        ? Metric.unavailable("SIGNALS","MISSING_BASIS") : Metric.count("SIGNALS",r.getLong("recognized"))).single();
    }

    public record Evidence(String key, long useCount, Metric accuracy, long excludedCount) {}
    public List<Evidence> evidence(long member) {
        return jdbc.sql("""
                WITH selected AS (
                    SELECT DISTINCT s.id,e.key,s.response_snapshot
                    FROM submissions s CROSS JOIN LATERAL jsonb_array_elements_text(
                        CASE WHEN jsonb_typeof(evidence_checks)='array' THEN evidence_checks ELSE '[]'::jsonb END) e(key)
                    WHERE s.user_id=? AND s.submission_kind='candidate' AND e.key IN ('oddeven','secondary','ushape')
                )
                SELECT keys.key,count(s.id) AS uses,
                    count(s.id) FILTER(WHERE s.response_snapshot #>> '{signal,answerClass}'='graded'
                        AND s.response_snapshot #>> '{judgment,evaluation}' IN ('AGREES','DISAGREES','UNSURE')) AS graded,
                    count(s.id) FILTER(WHERE s.response_snapshot #>> '{signal,answerClass}'='graded'
                        AND s.response_snapshot #>> '{judgment,evaluation}'='AGREES') AS agreed
                FROM (VALUES ('oddeven'),('secondary'),('ushape')) keys(key)
                LEFT JOIN selected s ON s.key=keys.key GROUP BY keys.key ORDER BY keys.key
                """).param(member).query((r,n)->new Evidence(r.getString("key"),r.getLong("uses"),
                        Metric.ratio("PERCENT",r.getLong("agreed"),r.getLong("graded")),
                        r.getLong("uses")-r.getLong("graded"))).list();
    }

    public Map<String, Metric> community(long member) {
        long posts=jdbc.sql("SELECT count(*) FROM posts p WHERE p.user_id=? AND p.kind='user' AND p.status='visible' AND "+OPEN_BOARD)
                .param(member).query(Long.class).single();
        long comments=jdbc.sql("SELECT count(*) FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.user_id=? "
                +"AND c.status='visible' AND p.status='visible' AND "+OPEN_BOARD).param(member).query(Long.class).single();
        long unpublished=jdbc.sql("""
                SELECT count(DISTINCT c.id) FROM analysis_histories h JOIN submissions s ON s.id=h.submission_id
                JOIN candidates c ON ('c-'||c.id)=s.response_snapshot #>> '{match,candidateId}' AND c.tic_id=h.tic_id
                JOIN stars star ON star.tic_id=h.tic_id AND star.service_status='published'
                WHERE h.user_id=:member AND s.user_id=:member AND s.tic_id=h.tic_id
                    AND s.response_snapshot #>> '{signal,answerClass}'='analysis'
                    AND s.response_snapshot #>> '{match,status}' IN ('matched','matched_harmonic','duplicate')
                    AND EXISTS(SELECT 1 FROM star_unlocks u WHERE u.tic_id=star.tic_id)
                    AND NOT EXISTS(SELECT 1 FROM published_analyses pa WHERE pa.history_id=h.id)
                    AND NOT EXISTS(SELECT 1 FROM posts p WHERE p.kind='system_thread' AND p.candidate_id=c.id AND p.status<>'visible')
                """).param("member",member).query(Long.class).single();
        return Map.of("postCount",Metric.count("POSTS",posts),"commentCount",Metric.count("COMMENTS",comments),
                "unpublishedSignalCount",Metric.count("SIGNALS",unpublished));
    }
}
