-- 회원 탈퇴: 전역 게시판 공개와 개인 발견 기록을 분리하고, 정리 작업 권한을 함수로 제한한다.
-- IRREVERSIBLE: 이 버전에서 새로 만든 SECURITY DEFINER 함수의 PUBLIC 기본 EXECUTE만 회수한다. 회원 삭제 함수를 임의 호출하지 못하게 하며 기존 함수 권한은 바꾸지 않는다.
ALTER TABLE stars ADD COLUMN board_open BOOLEAN NOT NULL DEFAULT false;
UPDATE stars s SET board_open=true WHERE EXISTS (SELECT 1 FROM star_unlocks u WHERE u.tic_id=s.tic_id);

CREATE FUNCTION mark_star_board_open() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT AS $$
BEGIN
    UPDATE stars SET board_open=true WHERE tic_id=NEW.tic_id AND NOT board_open;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mark_star_board_open() FROM PUBLIC;
CREATE TRIGGER star_board_open_on_unlock AFTER INSERT ON star_unlocks
FOR EACH ROW EXECUTE FUNCTION mark_star_board_open();

ALTER TABLE posts ADD COLUMN author_withdrawn_at TIMESTAMPTZ;
ALTER TABLE comments ADD COLUMN author_withdrawn_at TIMESTAMPTZ;
ALTER TABLE published_analyses ADD COLUMN withdrawn_at TIMESTAMPTZ;
INSERT INTO users(id,provider,provider_user_id,nickname,status)
VALUES(-1,'internal','withdrawn-author','탈퇴한 회원','withdrawn');

CREATE TABLE withdrawal_requests (
    id UUID PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE,
    policy_version TEXT NOT NULL,
    receipt_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('READY','PROCESSING','COMPLETED','FAILED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    effective_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    CHECK (completed_at IS NULL OR effective_at IS NOT NULL)
);

-- 모든 개인 History·Submission·관계의 FK를 한 트랜잭션 안에서 정리한다.
CREATE FUNCTION cleanup_withdrawn_member(member BIGINT) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT AS $$
DECLARE withdrawn_time TIMESTAMPTZ;
BEGIN
    SELECT withdrawn_at INTO withdrawn_time FROM users WHERE id=member AND status='withdrawn' FOR UPDATE;
    IF withdrawn_time IS NULL OR member=-1 THEN RAISE EXCEPTION 'withdrawal is not effective'; END IF;
    INSERT INTO users(id,provider,provider_user_id,nickname,status)
    VALUES(-1,'internal','withdrawn-author','탈퇴한 회원','withdrawn') ON CONFLICT(id) DO NOTHING;

    DELETE FROM notification_outbox WHERE user_id=member OR payload->>'actorId'=member::text;
    DELETE FROM notifications WHERE user_id=member OR payload->>'actorId'=member::text;
    DELETE FROM follows WHERE user_id=member OR (target_type='user' AND target_id=member);
    DELETE FROM post_reactions WHERE user_id=member;
    DELETE FROM user_settings WHERE user_id=member;
    DELETE FROM member_sky_revisions WHERE user_id=member;

    DELETE FROM post_history_attachments WHERE history_id IN (SELECT id FROM analysis_histories WHERE user_id=member);
    DELETE FROM comment_history_attachments WHERE history_id IN (SELECT id FROM analysis_histories WHERE user_id=member);
    DELETE FROM post_source_links WHERE target_type='analysis'
      AND target_id IN (SELECT id FROM published_analyses WHERE user_id=member);
    DELETE FROM star_unlocks WHERE user_id=member;
    DELETE FROM user_star_progress WHERE user_id=member;
    DELETE FROM user_candidate_achievements WHERE user_id=member;
    DELETE FROM published_analyses WHERE user_id=member;
    DELETE FROM analysis_snapshots WHERE history_id IN (SELECT id FROM analysis_histories WHERE user_id=member);
    DELETE FROM analysis_histories WHERE user_id=member;
    DELETE FROM submissions WHERE user_id=member;

    UPDATE posts SET user_id=-1,author_withdrawn_at=withdrawn_time WHERE user_id=member;
    UPDATE comments SET user_id=-1,author_withdrawn_at=withdrawn_time WHERE user_id=member;
    DELETE FROM users WHERE id=member;
END $$;
REVOKE ALL ON FUNCTION cleanup_withdrawn_member(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cleanup_withdrawn_member(bigint) TO planetory_app;
GRANT SELECT, INSERT, UPDATE ON withdrawal_requests TO planetory_app;
GRANT UPDATE (withdrawn_at) ON published_analyses TO planetory_app;

CREATE FUNCTION prune_withdrawal_retention() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path FROM CURRENT AS $$
BEGIN
    UPDATE posts SET title='삭제된 게시글',body='',status='deleted'
      WHERE author_withdrawn_at < clock_timestamp()-interval '1 year'
        AND (title<>'삭제된 게시글' OR body<>'' OR status<>'deleted');
    UPDATE comments SET body='',status='deleted'
      WHERE author_withdrawn_at < clock_timestamp()-interval '1 year' AND (body<>'' OR status<>'deleted');
    DELETE FROM stats_snapshots WHERE snapshot_date < (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date-365;
    DELETE FROM withdrawal_requests WHERE status IN ('READY','COMPLETED')
      AND created_at < clock_timestamp()-interval '90 days';
END $$;
REVOKE ALL ON FUNCTION prune_withdrawal_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prune_withdrawal_retention() TO planetory_app;
