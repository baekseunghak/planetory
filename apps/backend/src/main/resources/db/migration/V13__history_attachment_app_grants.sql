-- History 첨부 참조의 읽기·추가·교체만 허용한다. 원본 History 권한은 그대로 둔다. [S15P21C206-160]
DO $$
DECLARE
    target_schema TEXT := current_schema();
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['post_history_attachments', 'comment_history_attachments'] LOOP
        EXECUTE format('GRANT SELECT, INSERT, DELETE ON %I.%I TO planetory_app', target_schema, t);
        EXECUTE format('REVOKE UPDATE, TRUNCATE ON %I.%I FROM planetory_app', target_schema, t);
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO planetory_app',
                       pg_get_serial_sequence(format('%I.%I', target_schema, t), 'id'));
    END LOOP;
END $$;
