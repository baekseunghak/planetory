-- 기존 팔로우 관계의 조회·멱등 생성·해제만 허용한다. [S15P21C206-173]
DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, DELETE ON %I.follows TO planetory_app', current_schema());
    EXECUTE format('REVOKE UPDATE, TRUNCATE ON %I.follows FROM planetory_app', current_schema());
    -- IDENTITY 권한은 V11에서 이미 부여했다. 반복 PUT은 생성 시각을 갱신하지 않는다.
END $$;
