-- 공개 등록은 기존 V1의 신호별 공식 스레드·History별 공개 유일 제약을 재사용한다. [S15P21C206-161]
-- V13은 160 첨부 권한용이다. 160 병합 후 V13 → V14 순서로 적용하며 out-of-order는 사용하지 않는다.
DO $$
DECLARE
    target_schema TEXT := current_schema();
BEGIN
    EXECUTE format('GRANT SELECT, INSERT ON %I.published_analyses TO planetory_app', target_schema);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I.published_analyses FROM planetory_app', target_schema);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO planetory_app',
                   pg_get_serial_sequence(format('%I.published_analyses', target_schema), 'id'));
END $$;
