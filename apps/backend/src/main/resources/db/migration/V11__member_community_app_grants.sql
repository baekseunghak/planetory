-- 회원·커뮤니티 테이블의 planetory_app GRANT 결손 해소 [S15P21C206-238]
--
-- V2는 Gold 12개 테이블에, V5는 탐사 12개 테이블에 GRANT했고 V6이 member_sky_revisions를
-- 더했다. 그 사이에서 회원·커뮤니티 테이블이 빠졌다. 계정을 분리해 앱이 planetory_app으로
-- 접속하면 모든 인증 요청(MemberService.requireActive의 users SELECT)이 42501로 실패한다.
-- 소유자 계정으로 도는 로컬·테스트에서는 드러나지 않고 배포하는 순간에만 터진다.
--
-- 동사 집합은 추측하지 않고 현재 코드를 전수로 읽어 확정했다. 근거는 각 항목에 적었다.
-- V5의 패턴을 따른다 — 필요한 동사만 GRANT하고 나머지는 명시적으로 REVOKE한다.
--
-- SELECT ... FOR UPDATE 주의: PostgreSQL은 행 잠금에 SELECT 외에 UPDATE·DELETE·TRUNCATE 중
-- 하나를 요구한다. users는 StarDiscoveryService:61과 TutorialRepository:108이 FOR UPDATE로
-- 잠그는데, 아래에서 UPDATE를 주므로 충족된다. UPDATE를 빼면 잠금이 42501로 실패한다.

DO $$
DECLARE
    target_schema TEXT := current_schema();
    -- 앱이 행을 만들고 갱신하는 테이블
    --   users         SELECT  MemberService.requireActive가 매 인증 요청에서 읽는다
    --                 INSERT  MemberService:39 OAuth 최초 가입 members.saveAndFlush
    --                 UPDATE  MemberService:82 저장 경로(닉네임 변경 등)와 위 FOR UPDATE
    --   user_settings SELECT  GET /api/v1/me의 설정 조회
    --                 INSERT  MemberService:41 가입 시 기본 설정 생성
    --                 UPDATE  MemberSettingsRepository.completeOnboarding의
    --                         ON CONFLICT DO UPDATE. upsert는 INSERT와 UPDATE를 둘 다 요구한다
    --   posts         SELECT·INSERT  PostService:46 saveAndFlush
    --                 UPDATE  본문 수정과 소프트 삭제(Post:62 status='deleted')
    --   comments      SELECT·INSERT  CommentService:45 saveAndFlush
    --                 UPDATE  본문 수정과 소프트 삭제(Comment:50 status='deleted')
    writable TEXT[] := ARRAY['users', 'user_settings', 'posts', 'comments'];
    -- 앱이 읽기만 하는 테이블
    --   published_analyses  QuestRepository:74와 StarRepository:315의 SELECT 2곳뿐이다.
    --                       쓰기 경로는 아직 구현되지 않았다.
    readable TEXT[] := ARRAY['published_analyses'];
    t TEXT;
BEGIN
    -- 글·댓글의 삭제는 status를 'deleted'로 바꾸는 소프트 삭제다(PostService:81,
    -- CommentService:105). 물리 DELETE 경로는 어디에도 없으므로 주지 않는다.
    FOREACH t IN ARRAY writable LOOP
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I.%I TO planetory_app', target_schema, t);
        EXECUTE format('REVOKE DELETE, TRUNCATE ON %I.%I FROM planetory_app', target_schema, t);
    END LOOP;

    FOREACH t IN ARRAY readable LOOP
        EXECUTE format('GRANT SELECT ON %I.%I TO planetory_app', target_schema, t);
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I.%I FROM planetory_app',
                       target_schema, t);
    END LOOP;

    -- IDENTITY 열의 암묵 시퀀스. users·posts·comments가 쓴다(user_settings는 user_id가 PK다).
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO planetory_app',
                   target_schema);
END $$;

-- 아래 7개는 V1이 만들었지만 현재 코드 참조가 없다.
--
--   follows, notifications, post_reactions, post_source_links,
--   post_history_attachments, comment_history_attachments, stats_snapshots
--
-- 필요한 동사를 코드로 확정할 수 없으므로 추측해서 넣지 않는다. 각 기능을 구현하는 티켓이
-- 실제 접근 경로와 같은 커밋에서 필요한 GRANT를 추가한다.
