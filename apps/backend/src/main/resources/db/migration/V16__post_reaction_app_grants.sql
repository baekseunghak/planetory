-- 일반 글 반응 조회·최종 상태 저장·NONE 취소 [S15P21C206-163]. V1 테이블·유일 제약을 재사용한다.
DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.post_reactions TO planetory_app', current_schema());
    EXECUTE format('REVOKE TRUNCATE ON %I.post_reactions FROM planetory_app', current_schema());
END $$;
