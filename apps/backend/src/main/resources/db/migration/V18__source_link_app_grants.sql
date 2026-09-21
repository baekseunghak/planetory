-- 기존 출처 관계의 조회·추가·교체만 허용한다. [S15P21C206-167]
DO $$
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, DELETE ON %I.post_source_links TO planetory_app', current_schema());
    EXECUTE format('REVOKE UPDATE, TRUNCATE ON %I.post_source_links FROM planetory_app', current_schema());
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO planetory_app',
                   pg_get_serial_sequence(format('%I.post_source_links', current_schema()), 'id'));
END $$;
