-- 튜토리얼 5종 전환 [S15P21C206-272]
--
-- load-payload로 tutorial.json의 5개 별을 current로 올린 뒤, 소유자 계정으로 service-db 안에서 실행한다(README
-- 「튜토리얼 5종」). tutorial_stars는 앱 계정이 읽기만 한다. 기본은 모의 실행이다.
--
--   -v apply=1 을 주면 COMMIT, 없으면 ROLLBACK
--
--   1. 5개 별이 튜토리얼로 쓸 수 있는지 본다(공개, current 판·주기도, 활성 후보, 후보마다 처분).
--   2. 옛 1번 별 위의 회원 기록을 지운다: 알림(성과·옛 1번을 가리키는 것), 제출·분석 기록·스냅샷·성과와 그 성과로 열린 별. 옛 1번은 목업 곡선을
--      올린 임시 seed라 과학적으로 틀린 기록이다(2026-09-26 사용자 승인). 성과로 열린 별에 다른 기록이 이어져
--      있으면 외래 키가 막아 전체가 rollback된다.
--   3. 옛 1번을 받은 회원을 새 1번으로 옮긴다. 배치 좌표는 발견 순번으로만 정해지므로(PersonalSpiralGalaxyLayout)
--      star_unlocks 행의 tic만 바꾼다. 진행도는 처음부터다. 새 1번은 가입 때만 지급되므로 옮기지 않으면
--      기존 회원의 튜토리얼이 영구히 잠긴다.
--   4. 옛 1번 별의 목업 판(bundle_version 'mock-')을 지우고 별을 숨긴다. 더미 별의 목업 판은 건드리지 않는다.
--   5. tutorial_stars 1~5를 채우고, 기록이 바뀐 회원의 지도 버전을 올린다(SkyService.bumpVersion과 같은 식).
--
-- 다시 돌려도 된다. 1번이 이미 새 별이면 2~4는 대상이 없다.
\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif

BEGIN;
-- 가입(1번 조회)과 튜토리얼 진행이 전환 도중의 1번을 읽지 않게 끝날 때까지 막는다. 짧은 트랜잭션이다.
LOCK TABLE tutorial_stars IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE switch_targets(seq SMALLINT PRIMARY KEY, tic_id BIGINT NOT NULL, intent TEXT NOT NULL) ON COMMIT DROP;
INSERT INTO switch_targets VALUES
    (1, 149603524, 'deep_confirmed'), (2, 307210830, 'shallow_confirmed'), (3, 279569718, 'fp'),
    (4, 300871545, 'deep_fp'), (5, 278956474, 'multi_fp');

DO $$
DECLARE bad TEXT;
BEGIN
    SELECT string_agg(t.seq || ':' || t.tic_id, ', ' ORDER BY t.seq) INTO bad FROM switch_targets t
     WHERE NOT EXISTS (SELECT 1 FROM stars s WHERE s.tic_id = t.tic_id AND s.service_status = 'published')
        OR NOT EXISTS (SELECT 1 FROM publication_bundles b JOIN periodograms p ON p.bundle_id = b.id
                        WHERE b.tic_id = t.tic_id AND b.status = 'current')
        OR NOT EXISTS (SELECT 1 FROM candidates c WHERE c.tic_id = t.tic_id AND c.status = 'active')
        OR EXISTS (SELECT 1 FROM candidates c WHERE c.tic_id = t.tic_id AND c.status = 'active'
                      AND NOT EXISTS (SELECT 1 FROM candidate_dispositions d WHERE d.candidate_id = c.id));
    IF bad IS NOT NULL THEN
        RAISE EXCEPTION '튜토리얼로 쓸 수 없는 별이 있다: %. load-payload를 먼저 돌린다.', bad;
    END IF;
END $$;

CREATE TEMP TABLE old_first ON COMMIT DROP AS
    SELECT tic_id FROM tutorial_stars WHERE seq = 1 AND tic_id <> (SELECT tic_id FROM switch_targets WHERE seq = 1);
CREATE TEMP TABLE moved ON COMMIT DROP AS
    SELECT user_id FROM star_unlocks WHERE unlock_reason = 'tutorial' AND tic_id IN (SELECT tic_id FROM old_first);
CREATE TEMP TABLE old_submissions ON COMMIT DROP AS
    SELECT id, user_id FROM submissions WHERE tic_id IN (SELECT tic_id FROM old_first);
CREATE TEMP TABLE old_histories ON COMMIT DROP AS
    SELECT id FROM analysis_histories
     WHERE tic_id IN (SELECT tic_id FROM old_first) OR submission_id IN (SELECT id FROM old_submissions);
CREATE TEMP TABLE old_achievements ON COMMIT DROP AS
    SELECT id, user_id FROM user_candidate_achievements
     WHERE recognized_submission_id IN (SELECT id FROM old_submissions)
        OR candidate_id IN (SELECT id FROM candidates WHERE tic_id IN (SELECT tic_id FROM old_first));
CREATE TEMP TABLE achievement_unlocks ON COMMIT DROP AS
    SELECT user_id, tic_id FROM star_unlocks WHERE trigger_achievement_id IN (SELECT id FROM old_achievements);
CREATE TEMP TABLE old_mock_bundles ON COMMIT DROP AS
    SELECT id, tic_id FROM publication_bundles
     WHERE tic_id IN (SELECT tic_id FROM old_first) AND bundle_version LIKE 'mock-%';
CREATE TEMP TABLE old_mock_candidates ON COMMIT DROP AS
    SELECT id FROM candidates WHERE updated_bundle_id IN (SELECT id FROM old_mock_bundles);

DO $$
DECLARE other TEXT;
BEGIN
    -- 튜토리얼 말고 다른 이유로 옛 1번을 연 회원이 있으면 옮길 규칙이 없다. 사람이 정한다.
    SELECT string_agg(DISTINCT unlock_reason, ', ') INTO other FROM star_unlocks
     WHERE tic_id IN (SELECT tic_id FROM old_first) AND unlock_reason <> 'tutorial';
    IF other IS NOT NULL THEN
        RAISE EXCEPTION '옛 1번 별을 튜토리얼이 아닌 이유(%)로 연 회원이 있다. 멈췄다.', other;
    END IF;
    IF EXISTS (SELECT 1 FROM star_unlocks WHERE tic_id = (SELECT tic_id FROM switch_targets WHERE seq = 1)
                AND user_id IN (SELECT user_id FROM moved)) THEN
        RAISE EXCEPTION '새 1번 별을 이미 연 회원이 있어 옮길 수 없다. 멈췄다.';
    END IF;
    IF EXISTS (SELECT 1 FROM posts WHERE tic_id IN (SELECT tic_id FROM old_first)
                  OR candidate_id IN (SELECT id FROM old_mock_candidates))
       OR EXISTS (SELECT 1 FROM published_analyses WHERE history_id IN (SELECT id FROM old_histories)) THEN
        RAISE EXCEPTION '옛 1번 별에 게시글이나 공개 분석이 있다. 지울지는 사람이 정한다. 멈췄다.';
    END IF;
END $$;

SELECT (SELECT tic_id FROM old_first) AS old_first_tic,
       (SELECT count(*) FROM moved) AS moved_members,
       (SELECT count(*) FROM old_submissions) AS submissions,
       (SELECT count(*) FROM old_histories) AS histories,
       (SELECT count(*) FROM old_achievements) AS achievements,
       (SELECT count(*) FROM achievement_unlocks) AS achievement_unlocks,
       (SELECT count(*) FROM old_mock_bundles) AS mock_bundles,
       (SELECT count(*) FROM old_mock_candidates) AS mock_candidates,
       (SELECT count(*) FROM notification_outbox
         WHERE event_key IN (SELECT 'achievement:' || id FROM old_achievements)
            OR payload->>'ticId' IN (SELECT tic_id::text FROM old_first)) AS outbox,
       (SELECT count(*) FROM notifications
         WHERE event_key IN (SELECT 'achievement:' || id FROM old_achievements)
            OR payload->>'ticId' IN (SELECT tic_id::text FROM old_first)) AS notifications;

-- 2. 회원 기록. 순서는 탈퇴 정리(V24 cleanup_withdrawn_member)와 같다. 알림을 먼저 지운다. 성과·재개 알림의
-- payload ticId가 옛 1번을 가리켜, 남기면 전환 뒤 눌렀을 때 STAR_LOCKED가 난다(!226 강재민 리뷰).
DELETE FROM notification_outbox
 WHERE event_key IN (SELECT 'achievement:' || id FROM old_achievements)
    OR payload->>'ticId' IN (SELECT tic_id::text FROM old_first);
DELETE FROM notifications
 WHERE event_key IN (SELECT 'achievement:' || id FROM old_achievements)
    OR payload->>'ticId' IN (SELECT tic_id::text FROM old_first);
DELETE FROM post_history_attachments WHERE history_id IN (SELECT id FROM old_histories);
DELETE FROM comment_history_attachments WHERE history_id IN (SELECT id FROM old_histories);
DELETE FROM star_unlocks su USING achievement_unlocks a WHERE su.user_id = a.user_id AND su.tic_id = a.tic_id;
DELETE FROM user_star_progress p USING achievement_unlocks a WHERE p.user_id = a.user_id AND p.tic_id = a.tic_id;
DELETE FROM user_candidate_achievements WHERE id IN (SELECT id FROM old_achievements);
DELETE FROM analysis_snapshots WHERE history_id IN (SELECT id FROM old_histories);
DELETE FROM analysis_histories WHERE id IN (SELECT id FROM old_histories);
DELETE FROM submissions WHERE id IN (SELECT id FROM old_submissions);

-- 3. 회원을 새 1번으로 옮긴다.
DELETE FROM user_star_progress
 WHERE tic_id IN (SELECT tic_id FROM old_first) AND user_id IN (SELECT user_id FROM moved);
UPDATE star_unlocks SET tic_id = (SELECT tic_id FROM switch_targets WHERE seq = 1)
 WHERE unlock_reason = 'tutorial' AND tic_id IN (SELECT tic_id FROM old_first);
INSERT INTO user_star_progress(user_id, tic_id)
    SELECT user_id, (SELECT tic_id FROM switch_targets WHERE seq = 1) FROM moved
    ON CONFLICT (user_id, tic_id) DO NOTHING;
-- star_unlocks의 tic을 바꾼 것은 INSERT가 아니라 board_open 트리거가 돌지 않는다.
UPDATE stars s SET board_open = true
 WHERE s.tic_id IN (SELECT tic_id FROM switch_targets) AND NOT s.board_open
   AND EXISTS (SELECT 1 FROM star_unlocks u WHERE u.tic_id = s.tic_id);

-- 4. 옛 1번 별의 목업 판. mock_purge.sql과 같은 순서를 이 별에만 적용한다.
DELETE FROM notification_outbox WHERE event_key IN (SELECT 'reopen:' || tic_id || ':' || id FROM old_mock_bundles);
DELETE FROM notification_events WHERE event_key IN (SELECT 'reopen:' || tic_id || ':' || id FROM old_mock_bundles);
DELETE FROM notification_candidate_changes WHERE bundle_id IN (SELECT id FROM old_mock_bundles);
DELETE FROM candidate_status_history
 WHERE bundle_id IN (SELECT id FROM old_mock_bundles) OR candidate_id IN (SELECT id FROM old_mock_candidates);
DELETE FROM nasa_planet_info WHERE candidate_id IN (SELECT id FROM old_mock_candidates);
DELETE FROM candidate_dispositions WHERE candidate_id IN (SELECT id FROM old_mock_candidates);
DELETE FROM external_signal_references WHERE candidate_id IN (SELECT id FROM old_mock_candidates);
DELETE FROM ai_evaluations WHERE candidate_id IN (SELECT id FROM old_mock_candidates);
DELETE FROM candidates WHERE id IN (SELECT id FROM old_mock_candidates);
DELETE FROM periodograms WHERE bundle_id IN (SELECT id FROM old_mock_bundles);
DELETE FROM publication_bundles WHERE id IN (SELECT id FROM old_mock_bundles);
DELETE FROM light_curve_segments
 WHERE tic_id IN (SELECT tic_id FROM old_first) AND binning_revision LIKE 'mock-%';
DELETE FROM observation_datasets
 WHERE tic_id IN (SELECT tic_id FROM old_first) AND source_version LIKE 'mock-%';
UPDATE stars SET service_status = 'hidden' WHERE tic_id IN (SELECT tic_id FROM old_first);

-- 5. 튜토리얼 1~5. 트리거가 공개된 별만 받는다.
INSERT INTO tutorial_stars(seq, tic_id, intent, active)
    SELECT seq, tic_id, intent, true FROM switch_targets
    ON CONFLICT (seq) DO UPDATE SET tic_id = EXCLUDED.tic_id, intent = EXCLUDED.intent, active = true
     WHERE (tutorial_stars.tic_id, tutorial_stars.intent, tutorial_stars.active)
           IS DISTINCT FROM (EXCLUDED.tic_id, EXCLUDED.intent, true);
INSERT INTO member_sky_revisions(user_id, revision, updated_at)
    SELECT user_id, 1, CURRENT_TIMESTAMP FROM (SELECT user_id FROM moved UNION SELECT user_id FROM achievement_unlocks) m
    ON CONFLICT (user_id) DO UPDATE SET revision = member_sky_revisions.revision + 1, updated_at = CURRENT_TIMESTAMP;

SELECT seq, tic_id, intent, active FROM tutorial_stars ORDER BY seq;

\if :apply
COMMIT;
\echo 튜토리얼을 전환했다.
\else
ROLLBACK;
\echo 모의 실행이다. 위 개수만큼 바뀐다. 실제로 적용하려면 -v apply=1
\endif
