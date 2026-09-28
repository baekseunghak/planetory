-- 챌린지 회차 하나에 대상 별 여러 개 [S15P21C206-283]. V29 다음에 적용한다.
-- IRREVERSIBLE: global_stats(V21)를 지우고 rounds만 바꾼 같은 정의로 다시 만든다. 운영 뷰는 한 번도 채운 적이 없다(ispopulated false, 2026-09-27). 새 테이블의 앱 쓰기 권한 회수는 생성과 같은 트랜잭션이다. 이미지를 되돌려도 옛 앱은 대표 대상만 읽어 그대로 동작하며, 옛 V21 정의가 필요하면 이 버전 뒤 DROP·재생성으로 되돌린다.
--
-- challenge_rounds.target_tic_id는 대표(첫) 대상으로 그대로 두고, 나머지 대상을 새 테이블에 넣는다.
-- 대상을 읽는 쪽은 둘을 합친 challenge_round_targets 뷰만 본다. 기존 회차 INSERT, V9의 공개 검사,
-- 이 마이그레이션 전의 앱은 그대로 동작한다(옛 앱은 대표 대상만 본다).

CREATE TABLE challenge_round_extra_targets (
    round_id BIGINT NOT NULL,
    tic_id BIGINT NOT NULL,
    CONSTRAINT pk_challenge_round_extra_targets PRIMARY KEY (round_id, tic_id),
    CONSTRAINT fk_challenge_round_extra_targets_round_id FOREIGN KEY (round_id) REFERENCES challenge_rounds(id),
    CONSTRAINT fk_challenge_round_extra_targets_tic_id FOREIGN KEY (tic_id) REFERENCES stars(tic_id)
);

COMMENT ON COLUMN challenge_round_extra_targets.round_id IS '회차';
COMMENT ON COLUMN challenge_round_extra_targets.tic_id IS '대표 대상(challenge_rounds.target_tic_id) 밖의 추가 대상 별';

-- 대표 대상과 같은 규칙(V9): 넣거나 바꿀 때만 공개 별인지 본다. 나중에 숨겨져도 회차 수정은 막지 않는다.
CREATE TRIGGER trg_challenge_round_extra_targets_published
    BEFORE INSERT OR UPDATE OF tic_id ON challenge_round_extra_targets
    FOR EACH ROW EXECUTE FUNCTION exploration_target_must_be_published('tic_id');

-- 회차의 모든 대상. 대표 대상이 is_primary이고, 추가 대상이 대표와 같으면 한 번만 나온다.
CREATE VIEW challenge_round_targets AS
SELECT r.id AS round_id, r.target_tic_id AS tic_id, true AS is_primary
  FROM challenge_rounds r
UNION ALL
SELECT e.round_id, e.tic_id, false
  FROM challenge_round_extra_targets e
  JOIN challenge_rounds r ON r.id = e.round_id
 WHERE e.tic_id <> r.target_tic_id;

COMMENT ON VIEW challenge_round_targets IS '챌린지 회차의 모든 대상 별(대표 + 추가)';

-- 앱은 운영이 설정한 회차를 읽기만 한다(V5의 challenge_rounds와 같다).
DO $$
BEGIN
    EXECUTE format('GRANT SELECT ON %I.challenge_round_extra_targets, %I.challenge_round_targets TO planetory_app',
        current_schema(), current_schema());
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I.challenge_round_extra_targets FROM planetory_app',
        current_schema());
END $$;

-- 전체 통계(V21)의 회차 참여를 모든 대상 별로 넓힌다. 정의를 바꿀 수 없어 다시 만든다. 아래는
-- V21과 같고 rounds만 다르다. 운영은 이 시점까지 한 번도 채우지 않았다(ispopulated false, 2026-09-27).
DROP MATERIALIZED VIEW global_stats;

CREATE MATERIALIZED VIEW global_stats AS
WITH active_members AS MATERIALIZED (SELECT id FROM users WHERE status='active'),
s AS MATERIALIZED (
    SELECT s.id,s.user_id,s.tic_id,s.created_at,s.match_result,s.matched_candidate_id,s.user_judgment
    FROM submissions s JOIN active_members u ON u.id=s.user_id
),
unlocks AS MATERIALIZED (
    -- V1의 UNIQUE (user_id, tic_id)가 회원별 동일 별의 재발견 행을 차단한다.
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
    -- 정책: active 회차 대상 별 전부의 전 기간 공개 대표 참여(회원×신호)를 센다. 회원은 여러 대상에 참여해도 한 명이다.
    SELECT r.id,r.round_no,count(DISTINCT p.user_id) AS members,count(p.user_id) AS participations,
        count(*) FILTER (WHERE p.user_judgment='LIKELY_PLANET') AS likely,
        count(*) FILTER (WHERE p.user_judgment='UNLIKELY_PLANET') AS unlikely,
        count(*) FILTER (WHERE p.user_judgment='UNSURE') AS unsure
    FROM challenge_rounds r
    LEFT JOIN challenge_round_targets t ON t.round_id=r.id
    LEFT JOIN public_votes p ON p.tic_id=t.tic_id
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

-- DROP으로 사라진 V21의 뷰 권한을 다시 준다.
DO $$
BEGIN
    EXECUTE format('GRANT SELECT ON %I.global_stats TO planetory_app, planetory_stats_job', current_schema());
    EXECUTE format('GRANT MAINTAIN ON %I.global_stats TO planetory_stats_job', current_schema());
END $$;
