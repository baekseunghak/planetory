-- 전체 집계와 일별 비식별 비교 기준선 [S15P21C206-178]. V20 다음에 적용한다.
CREATE UNIQUE INDEX uq_stats_snapshot_scope_date
    ON stats_snapshots(snapshot_date, scope, round_id) NULLS NOT DISTINCT;

CREATE MATERIALIZED VIEW global_stats AS
WITH active_members AS MATERIALIZED (SELECT id FROM users WHERE status='active'),
s AS MATERIALIZED (
    SELECT s.id,s.user_id,s.tic_id,s.created_at,s.match_result,s.matched_candidate_id,s.user_judgment
    FROM submissions s JOIN active_members u ON u.id=s.user_id
),
unlocks AS MATERIALIZED (
    SELECT su.* FROM star_unlocks su JOIN active_members u ON u.id=su.user_id
),
progress AS MATERIALIZED (
    SELECT p.* FROM user_star_progress p JOIN active_members u ON u.id=p.user_id
),
achievements AS MATERIALIZED (
    SELECT a.* FROM user_candidate_achievements a JOIN active_members u ON u.id=a.user_id
),
first_matches AS (
    SELECT DISTINCT ON (user_id,matched_candidate_id) user_id,matched_candidate_id,user_judgment
    FROM s WHERE match_result IN ('matched','matched_harmonic')
    ORDER BY user_id,matched_candidate_id,created_at,id
),
graded AS MATERIALIZED (
    SELECT f.*, (d.planet_truth='planet' AND f.user_judgment='LIKELY_PLANET')
        OR (d.planet_truth='not_planet' AND f.user_judgment='UNLIKELY_PLANET') AS agrees
    FROM first_matches f JOIN candidate_dispositions d ON d.candidate_id=f.matched_candidate_id
    WHERE d.answer_class='graded'
),
public_votes AS MATERIALIZED (
    -- PublicAnalysisVisibility.VISIBLE와 같은 유효 집합에서 대표를 선택한다.
    SELECT DISTINCT ON (s.user_id,pa.candidate_id)
        s.user_id,pa.candidate_id,s.tic_id,s.user_judgment
    FROM published_analyses pa JOIN posts p ON p.id=pa.post_id
    JOIN analysis_histories h ON h.id=pa.history_id JOIN s ON s.id=h.submission_id
    WHERE pa.unpublished_at IS NULL AND pa.hidden_at IS NULL
      AND p.kind='system_thread' AND p.status='visible'
    ORDER BY s.user_id,pa.candidate_id,s.created_at DESC,s.id DESC
),
counts(key,unit,numerator,denominator,scale) AS (
    SELECT 'discoveredStars','STAR',count(*),NULL::bigint,1 FROM unlocks UNION ALL
    SELECT 'uniqueDiscoveredStars','STAR',count(DISTINCT tic_id),NULL,1 FROM unlocks UNION ALL
    SELECT 'startedStars','STAR',count(DISTINCT (user_id,tic_id)),NULL,1 FROM s UNION ALL
    SELECT 'currentCompletedStars','STAR',count(*),NULL,1 FROM progress WHERE progress_stage='completed' UNION ALL
    SELECT 'uniqueCurrentCompletedStars','STAR',count(DISTINCT tic_id),NULL,1 FROM progress WHERE progress_stage='completed' UNION ALL
    SELECT 'recognizedSignals','ACHIEVEMENT',count(*),NULL,1 FROM achievements UNION ALL
    SELECT 'confirmedAchievements','ACHIEVEMENT',count(*),NULL,1 FROM achievements WHERE achievement_type='confirmed' UNION ALL
    SELECT 'unconfirmedAchievements','ACHIEVEMENT',count(*),NULL,1 FROM achievements WHERE achievement_type='unconfirmed' UNION ALL
    SELECT 'fpAchievements','ACHIEVEMENT',count(*),NULL,1 FROM achievements WHERE achievement_type='fp' UNION ALL
    SELECT 'uniqueRecognizedSignals','SIGNAL',count(DISTINCT candidate_id),NULL,1 FROM achievements UNION ALL
    SELECT 'uniqueConfirmedSignals','SIGNAL',count(DISTINCT a.candidate_id),NULL,1 FROM achievements a JOIN candidate_dispositions d ON d.candidate_id=a.candidate_id WHERE d.disposition='confirmed' UNION ALL
    SELECT 'uniqueFpSignals','SIGNAL',count(DISTINCT a.candidate_id),NULL,1 FROM achievements a JOIN candidate_dispositions d ON d.candidate_id=a.candidate_id WHERE d.disposition='fp' UNION ALL
    SELECT 'uniqueUnconfirmedSignals','SIGNAL',count(DISTINCT a.candidate_id),NULL,1 FROM achievements a JOIN candidate_dispositions d ON d.candidate_id=a.candidate_id WHERE d.disposition IN ('pc','none') UNION ALL
    SELECT 'firstMatchAccuracy','PERCENT',count(*) FILTER (WHERE agrees),count(*),100 FROM graded UNION ALL
    SELECT 'publicLikelyPlanet','PARTICIPATION',count(*) FILTER (WHERE user_judgment='LIKELY_PLANET'),NULL,1 FROM public_votes UNION ALL
    SELECT 'publicUnlikelyPlanet','PARTICIPATION',count(*) FILTER (WHERE user_judgment='UNLIKELY_PLANET'),NULL,1 FROM public_votes UNION ALL
    SELECT 'publicUnsure','PARTICIPATION',count(*) FILTER (WHERE user_judgment='UNSURE'),NULL,1 FROM public_votes UNION ALL
    SELECT 'publicLikelyPlanetRate','PERCENT',count(*) FILTER (WHERE user_judgment='LIKELY_PLANET'),count(*),100 FROM public_votes UNION ALL
    SELECT 'publicUnlikelyPlanetRate','PERCENT',count(*) FILTER (WHERE user_judgment='UNLIKELY_PLANET'),count(*),100 FROM public_votes UNION ALL
    SELECT 'publicUnsureRate','PERCENT',count(*) FILTER (WHERE user_judgment='UNSURE'),count(*),100 FROM public_votes UNION ALL
    SELECT 'publicParticipations','PARTICIPATION',count(*),NULL,1 FROM public_votes UNION ALL
    SELECT 'aiAttemptUnknown','PARTICIPATION',count(*),NULL,1 FROM public_votes
),
metric_values AS MATERIALIZED (
    SELECT jsonb_object_agg(key,jsonb_build_object('unit',unit,
        'value',CASE WHEN denominator IS NULL THEN numerator::numeric ELSE numerator::numeric*scale/nullif(denominator,0) END,
        'numerator',numerator,'denominator',denominator,
        'status',CASE WHEN denominator=0 THEN 'NO_SAMPLE' ELSE 'AVAILABLE' END,
        'reason',CASE WHEN key='aiAttemptUnknown' THEN 'AI_ATTEMPT_UNKNOWN' WHEN denominator=0 THEN 'ZERO_DENOMINATOR' END)) AS metrics FROM counts
),
weekly AS (
    SELECT w.week::date AS week_start,count(s.id) AS submissions
    FROM generate_series(date_trunc('week',statement_timestamp() AT TIME ZONE 'Asia/Seoul')-interval '7 weeks',
        date_trunc('week',statement_timestamp() AT TIME ZONE 'Asia/Seoul'),interval '1 week') w(week)
    LEFT JOIN s ON s.created_at>=w.week AT TIME ZONE 'Asia/Seoul'
        AND s.created_at<(w.week+interval '1 week') AT TIME ZONE 'Asia/Seoul'
    GROUP BY w.week
),
top_stars AS (
    SELECT p.tic_id,count(*) AS count FROM posts p
    JOIN stars st ON st.tic_id=p.tic_id AND st.service_status='published'
    WHERE p.board='star' AND p.status='visible'
        AND EXISTS (SELECT 1 FROM unlocks u WHERE u.tic_id=p.tic_id)
        AND (p.kind='system_thread' OR EXISTS (SELECT 1 FROM active_members u WHERE u.id=p.user_id))
    GROUP BY p.tic_id ORDER BY count DESC,p.tic_id LIMIT 5
),
sectors AS (
    SELECT d.sector,count(*) AS denominator,count(*) FILTER (WHERE p.progress_stage='completed') AS numerator
    FROM (SELECT DISTINCT sector,tic_id FROM observation_datasets) d
    JOIN unlocks u ON u.tic_id=d.tic_id
    LEFT JOIN progress p ON p.user_id=u.user_id AND p.tic_id=u.tic_id
    GROUP BY d.sector
),
rounds AS (
    SELECT r.id,r.round_no,count(DISTINCT p.user_id) AS members,count(p.user_id) AS participations,
        count(*) FILTER (WHERE p.user_judgment='LIKELY_PLANET') AS likely,
        count(*) FILTER (WHERE p.user_judgment='UNLIKELY_PLANET') AS unlikely,
        count(*) FILTER (WHERE p.user_judgment='UNSURE') AS unsure
    FROM challenge_rounds r LEFT JOIN public_votes p ON p.tic_id=r.target_tic_id
    WHERE r.status='active' GROUP BY r.id,r.round_no
),
payload AS MATERIALIZED (
    SELECT m.metrics,
        coalesce((SELECT jsonb_agg(jsonb_build_object('weekStart',week_start,'submissions',submissions,
            'partial',week_start=date_trunc('week',statement_timestamp() AT TIME ZONE 'Asia/Seoul')::date)
            ORDER BY week_start) FROM weekly),'[]') AS weekly_submissions,
        coalesce((SELECT jsonb_agg(jsonb_build_object('ticId',tic_id::text,'postCount',count)
            ORDER BY count DESC,tic_id) FROM top_stars),'[]') AS most_posts_stars,
        coalesce((SELECT jsonb_agg(jsonb_build_object('sector',sector,'unit','PERCENT',
            'numerator',numerator,'denominator',denominator,'value',100.0*numerator/nullif(denominator,0),
            'status',CASE WHEN denominator=0 THEN 'NO_SAMPLE' ELSE 'AVAILABLE' END) ORDER BY sector) FROM sectors),'[]') AS sector_completion,
        coalesce((SELECT jsonb_agg(jsonb_build_object('roundId',id::text,'roundNo',round_no,
            'participantCount',members,'participationCount',participations,
            'likelyPlanet',likely,'unlikelyPlanet',unlikely,'unsure',unsure) ORDER BY round_no) FROM rounds),'[]') AS challenges
    FROM metric_values m
)
SELECT 1 AS singleton,statement_timestamp() AS as_of,clock_timestamp() AS generated_at,
    jsonb_build_object('metrics',metrics,'weeklySubmissions',weekly_submissions,
        'mostPostsStars',most_posts_stars,'sectorCompletion',sector_completion,'challenges',challenges,
        'aiJudgmentBands',jsonb_build_object('status','NO_SAMPLE','reason','AI_ATTEMPT_UNKNOWN','items','[]'::jsonb)) AS payload
FROM payload WITH NO DATA;

CREATE UNIQUE INDEX uq_global_stats_singleton ON global_stats(singleton);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='planetory_stats_job') THEN
        CREATE ROLE planetory_stats_job NOLOGIN;
    END IF;
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO planetory_stats_job',current_schema());
    EXECUTE format('GRANT SELECT ON %I.global_stats, %I.stats_snapshots TO planetory_app, planetory_stats_job',
        current_schema(),current_schema());
    EXECUTE format('GRANT MAINTAIN ON %I.global_stats TO planetory_stats_job',current_schema());
    EXECUTE format('GRANT INSERT ON %I.stats_snapshots TO planetory_stats_job',current_schema());
    EXECUTE format('GRANT USAGE ON SEQUENCE %s TO planetory_stats_job',pg_get_serial_sequence('stats_snapshots','id'));
    EXECUTE format('REVOKE USAGE, SELECT ON SEQUENCE %s FROM planetory_app',pg_get_serial_sequence('stats_snapshots','id'));
    EXECUTE format('GRANT SELECT ON %I.users, %I.submissions, %I.user_candidate_achievements, %I.candidate_dispositions TO planetory_stats_job',
        current_schema(),current_schema(),current_schema(),current_schema());
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I.stats_snapshots FROM planetory_app',current_schema());
END $$;
