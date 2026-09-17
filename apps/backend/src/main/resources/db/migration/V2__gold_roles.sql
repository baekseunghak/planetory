-- Gold 카탈로그(B 묶음) 역할 분리 [S15P21C206-134]
--
-- 배치가 적재한 Gold 릴리스를 서비스가 실수로 바꾸지 못하게 한다.
-- 여기서는 그룹 역할과 권한만 정의한다. 실제 접속 계정에 역할을 부여하는 것은
-- 배포 설정의 몫이다(아래 "운영 적용" 참고).
--
-- 역할은 스키마가 아니라 DB 클러스터 전역이므로 재실행과 다중 DB를 고려해 멱등하게 만든다.

-- 역할이 이미 있으면 그대로 쓴다. 없으면 만들되, 만들 권한이 없는 계정(운영)에서는
-- 무엇을 해야 하는지 알리고 멈춘다. 조용히 넘어가면 권한 분리가 안 된 채로 기동한다.
DO $$
DECLARE
    required_roles TEXT[] := ARRAY['planetory_gold_writer', 'planetory_app'];
    r TEXT;
BEGIN
    FOREACH r IN ARRAY required_roles LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            BEGIN
                EXECUTE format('CREATE ROLE %I NOLOGIN', r);
            EXCEPTION WHEN insufficient_privilege THEN
                RAISE EXCEPTION
                    'Gold 역할 %를 만들 수 없습니다. 이 마이그레이션을 실행하는 계정에 CREATEROLE이 없습니다.', r
                    USING HINT = '운영 DB 프로비저닝에서 다음을 먼저 실행하십시오: '
                               || 'CREATE ROLE planetory_gold_writer NOLOGIN; '
                               || 'CREATE ROLE planetory_app NOLOGIN;';
            END;
        END IF;
    END LOOP;
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

-- 운영 적용 (이 마이그레이션 범위 밖) [S15P21C206-83 · 김동혁]
--
-- 이 마이그레이션만으로는 앱이 읽기 전용이 되지 않는다. 배포에서 계정을 셋으로
-- 나눠야 권한 분리가 실제로 성립한다.
--
--   1) 마이그레이션 계정  테이블 소유자. Flyway를 실행한다. CREATEROLE이 필요하다.
--                        (없으면 위 DO 블록이 안내와 함께 실패한다)
--   2) 서비스 접속 계정   소유자가 아니어야 한다. GRANT planetory_app TO <계정>;
--   3) 배치 적재 계정     GRANT planetory_gold_writer TO <계정>;
--
-- 소유자는 GRANT/REVOKE의 영향을 받지 않는다. 서비스가 테이블 소유자로 접속하면
-- 이 REVOKE가 무력화되므로 2)를 1)과 반드시 분리한다.
--
-- 개발 환경은 단일 `planetory` 계정(소유자 겸 슈퍼유저)을 쓰므로 로컬에서는 읽기
-- 전용이 성립하지 않는다. 권한 집행은 GoldRolePermissionTest가 별도 계정으로 검증한다.
