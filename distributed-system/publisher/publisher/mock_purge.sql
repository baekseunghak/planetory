-- 목업 Gold 삭제 [S15P21C206-262]
--
-- mock_source가 붙인 표식(bundle_version·binning_revision의 'mock-')으로만 지운다. 운영 Gold는
-- 건드리지 않는다. 소유자 계정으로 service-db 안에서 실행한다(README). 기본은 모의 실행이다.
--
--   -v apply=1 을 주면 COMMIT, 없으면 ROLLBACK
--
-- 회원이 목업 판·후보를 참조하면(제출·게시글·공개 분석·성과) 지우지 않고 멈춘다. 그 기록을
-- 지울지는 사람이 정한다. 외래 키가 NO ACTION이라 억지로 지우면 어차피 실패한다.
\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply 0
\endif

BEGIN;

CREATE TEMP TABLE mock_bundles ON COMMIT DROP AS
    SELECT id, tic_id FROM publication_bundles WHERE bundle_version LIKE 'mock-%';
CREATE TEMP TABLE mock_candidates ON COMMIT DROP AS
    SELECT id FROM candidates WHERE updated_bundle_id IN (SELECT id FROM mock_bundles);

DO $$
DECLARE refs TEXT;
BEGIN
    SELECT string_agg(name || '=' || n, ', ') INTO refs FROM (
        SELECT 'submissions' AS name, count(*) AS n FROM submissions
         WHERE bundle_id IN (SELECT id FROM mock_bundles)
            OR matched_candidate_id IN (SELECT id FROM mock_candidates)
            OR detail_target_candidate_id IN (SELECT id FROM mock_candidates)
        UNION ALL SELECT 'posts', count(*) FROM posts WHERE candidate_id IN (SELECT id FROM mock_candidates)
        UNION ALL SELECT 'published_analyses', count(*) FROM published_analyses
         WHERE candidate_id IN (SELECT id FROM mock_candidates)
        UNION ALL SELECT 'user_candidate_achievements', count(*) FROM user_candidate_achievements
         WHERE candidate_id IN (SELECT id FROM mock_candidates)
    ) r WHERE n > 0;
    IF refs IS NOT NULL THEN
        RAISE EXCEPTION '회원 기록이 목업을 참조한다: %. 지우지 않았다.', refs;
    END IF;
END $$;

SELECT (SELECT count(*) FROM mock_bundles) AS bundles,
       (SELECT count(*) FROM mock_candidates) AS candidates,
       (SELECT count(*) FROM light_curve_segments WHERE binning_revision LIKE 'mock-%') AS segments;

-- 판 전환 때 V23 트리거가 남긴 알림 흔적. 재개 사건은 판 id가 사건 키에 들어 있다.
DELETE FROM notification_outbox WHERE event_key IN
    (SELECT 'reopen:' || tic_id || ':' || id FROM mock_bundles);
DELETE FROM notification_events WHERE event_key IN
    (SELECT 'reopen:' || tic_id || ':' || id FROM mock_bundles);
DELETE FROM notification_candidate_changes WHERE bundle_id IN (SELECT id FROM mock_bundles);
DELETE FROM candidate_status_history
 WHERE bundle_id IN (SELECT id FROM mock_bundles) OR candidate_id IN (SELECT id FROM mock_candidates);
DELETE FROM candidates WHERE id IN (SELECT id FROM mock_candidates);
DELETE FROM periodograms WHERE bundle_id IN (SELECT id FROM mock_bundles);
DELETE FROM publication_bundles WHERE id IN (SELECT id FROM mock_bundles);
DELETE FROM light_curve_segments WHERE binning_revision LIKE 'mock-%';

\if :apply
COMMIT;
\echo 목업을 지웠다.
\else
ROLLBACK;
\echo 모의 실행이다. 위 개수만큼 지워진다. 실제로 지우려면 -v apply=1
\endif
