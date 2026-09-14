-- Gold 카탈로그(B 묶음) 역할 분리 [S15P21C206-134]
--
-- 배치가 적재한 Gold 릴리스를 서비스가 실수로 바꾸지 못하게 한다.
-- 여기서는 그룹 역할과 권한만 정의한다. 실제 접속 계정에 역할을 부여하는 것은
-- 배포 설정의 몫이다(아래 "운영 적용" 참고).
--
-- 역할은 스키마가 아니라 DB 클러스터 전역이므로 재실행과 다중 DB를 고려해 멱등하게 만든다.

DO $$
BEGIN
    -- 배치·운영 적재 역할. Gold 본문과 변경 이력을 쓴다(I08/I09).
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'planetory_gold_writer') THEN
        CREATE ROLE planetory_gold_writer NOLOGIN;
    END IF;
    -- 서비스 애플리케이션 역할. Gold는 읽기만 한다.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'planetory_app') THEN
        CREATE ROLE planetory_app NOLOGIN;
    END IF;
END $$;

-- 이 마이그레이션이 적용되는 스키마에 한해 권한을 준다.
-- Flyway가 search_path를 대상 스키마로 맞추므로 이름을 수식하지 않는다.
DO $$
DECLARE
    target_schema TEXT := current_schema();
    b_tables TEXT[] := ARRAY[
        'stars',
        'observation_datasets',
        'publication_bundles',
        'light_curve_segments',
        'periodograms',
        'candidates',
        'candidate_aliases',
        'external_signal_references',
        'candidate_dispositions',
        'candidate_status_history',
        'ai_executions',
        'ai_evaluations'
    ];
    t TEXT;
BEGIN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO planetory_gold_writer, planetory_app', target_schema);

    FOREACH t IN ARRAY b_tables LOOP
        -- 배치 역할: 적재·갱신·은퇴 처리
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO planetory_gold_writer',
                       target_schema, t);
        -- 앱 역할: 읽기만. 이미 가진 쓰기 권한이 있으면 회수한다.
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I.%I FROM planetory_app',
                       target_schema, t);
        EXECUTE format('GRANT SELECT ON %I.%I TO planetory_app', target_schema, t);
    END LOOP;

    -- IDENTITY 열의 암묵 시퀀스는 배치 역할만 쓴다.
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO planetory_gold_writer',
                   target_schema);
END $$;

-- 운영 적용 (이 마이그레이션 범위 밖)
--
-- 접속 계정에 역할을 부여하는 것은 배포 설정에서 한 번 수행한다.
--   GRANT planetory_app TO <서비스 접속 계정>;
--   GRANT planetory_gold_writer TO <배치 적재 계정>;
--
-- 소유자 계정은 이 REVOKE의 영향을 받지 않는다. 서비스가 테이블 소유자로 접속하면
-- 읽기 전용이 성립하지 않으므로, 배포에서 서비스 계정을 소유자와 분리해야 한다.
