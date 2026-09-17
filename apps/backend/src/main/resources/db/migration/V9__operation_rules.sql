-- 운영 규칙 버전의 형식·불변성, 초기 규칙, 튜토리얼·챌린지 대상 제약 [S15P21C206-151]
--
-- 운영 화면이 없어 운영자가 SQL로 직접 규칙·튜토리얼 별·챌린지 회차를 넣는다(OPS-04·07·08, ERD
-- 결정 11). 앱 계정은 이 테이블을 읽기만 한다(V5). 그래서 잘못된 값은 저장 순간 DB가 거절해야
-- 한다(AT-41). 앱이 읽을 때 거절하면 이미 저장된 규칙으로 제출이 판정된 뒤일 수 있다.
--
-- 값 형식(format_version 1)과 적용 절차는 docs/operations/operation-rule-runbook.md가 정본이다.
-- 여기 검증은 그 형식의 키·자료형·범위만 본다. 값 자체(허용 오차·임계값)는 D20·D11이 정한다.

-- ---------------------------------------------------------------------------
-- 1. 규칙 값 검증 함수
-- ---------------------------------------------------------------------------

-- 검증 실패. 어느 키가 왜 틀렸는지 메시지로 남긴다. CHECK가 거짓만 돌려주면 제약 이름만 보인다.
CREATE FUNCTION operation_rules_fail(path TEXT, reason TEXT) RETURNS VOID
    LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
    RAISE EXCEPTION 'operation_settings.%: %', path, reason
        USING ERRCODE = 'check_violation',
              HINT = '형식은 docs/operations/operation-rule-runbook.md를 따른다.';
END;
$$;

-- 객체이고 정해진 키를 모두, 그리고 그 키만 가졌는지. 오타 난 키가 조용히 무시되지 않게 한다.
CREATE FUNCTION operation_rules_object(v JSONB, path TEXT, keys TEXT[]) RETURNS VOID
    LANGUAGE plpgsql IMMUTABLE
    SET search_path FROM CURRENT
AS $$
DECLARE
    k TEXT;
BEGIN
    IF v IS NULL OR jsonb_typeof(v) <> 'object' THEN
        PERFORM operation_rules_fail(path, '객체여야 한다');
    END IF;
    FOREACH k IN ARRAY keys LOOP
        IF NOT v ? k THEN
            PERFORM operation_rules_fail(path || '.' || k, '키가 없다');
        END IF;
    END LOOP;
    FOR k IN SELECT jsonb_object_keys(v) LOOP
        IF NOT k = ANY (keys) THEN
            PERFORM operation_rules_fail(path || '.' || k, '형식 1에 없는 키다');
        END IF;
    END LOOP;
END;
$$;

CREATE FUNCTION operation_rules_number(v JSONB, path TEXT) RETURNS NUMERIC
    LANGUAGE plpgsql IMMUTABLE
    SET search_path FROM CURRENT
AS $$
BEGIN
    IF v IS NULL OR jsonb_typeof(v) <> 'number' THEN
        PERFORM operation_rules_fail(path, '숫자여야 한다');
    END IF;
    RETURN (v #>> '{}')::NUMERIC;
END;
$$;

CREATE FUNCTION operation_rules_integer(v JSONB, path TEXT) RETURNS NUMERIC
    LANGUAGE plpgsql IMMUTABLE
    SET search_path FROM CURRENT
AS $$
DECLARE
    n NUMERIC := operation_rules_number(v, path);
BEGIN
    -- 1.0처럼 소수점을 붙이면 앱이 정수로 읽지 못한다. 앱의 int 범위를 넘는 값도 읽지 못한다.
    IF (v #>> '{}') !~ '^-?[0-9]+$' THEN
        PERFORM operation_rules_fail(path, '소수점 없는 정수여야 한다');
    END IF;
    IF n > 2147483647 THEN
        PERFORM operation_rules_fail(path, '2147483647 이하여야 한다');
    END IF;
    RETURN n;
END;
$$;

CREATE FUNCTION operation_rules_valid(v JSONB) RETURNS BOOLEAN
    LANGUAGE plpgsql IMMUTABLE
    SET search_path FROM CURRENT
AS $$
DECLARE
    section JSONB;
    item JSONB;
    n NUMERIC;
    lower_bound NUMERIC;
    upper_bound NUMERIC;
    seen NUMERIC[] := '{}';
BEGIN
    PERFORM operation_rules_object(v, 'values', ARRAY['format_version', 'selection', 'matching',
        'peaks', 'discovery', 'tutorial', 'ai', 'bls']);
    IF operation_rules_integer(v -> 'format_version', 'values.format_version') <> 1 THEN
        PERFORM operation_rules_fail('values.format_version', '이 DB가 아는 형식은 1뿐이다');
    END IF;

    -- 위상 선택 (탐사 API 5.1 selectionRules, 6.2). 최소 창은 케이던스 2배로 요구사항이 정해 별마다 계산한다.
    section := v -> 'selection';
    PERFORM operation_rules_object(section, 'values.selection',
        ARRAY['phase_width_max', 'max_duration_multiple_of_suggested', 'allow_empty_phase_span']);
    n := operation_rules_number(section -> 'phase_width_max', 'values.selection.phase_width_max');
    IF n <= 0 OR n >= 1 THEN
        PERFORM operation_rules_fail('values.selection.phase_width_max', '0 초과 1 미만이어야 한다');
    END IF;
    IF operation_rules_number(section -> 'max_duration_multiple_of_suggested',
            'values.selection.max_duration_multiple_of_suggested') <= 0 THEN
        PERFORM operation_rules_fail('values.selection.max_duration_multiple_of_suggested', '0보다 커야 한다');
    END IF;
    IF jsonb_typeof(section -> 'allow_empty_phase_span') <> 'boolean' THEN
        PERFORM operation_rules_fail('values.selection.allow_empty_phase_span', 'true 또는 false여야 한다');
    END IF;

    -- 제출 매칭 (SRS 5.1·5.2, 제출 매칭 규칙 v0)
    section := v -> 'matching';
    PERFORM operation_rules_object(section, 'values.matching',
        ARRAY['harmonic_multipliers', 'n_transits_cap', 'duration_ratio_min', 'duration_ratio_max',
              'min_overlap_transits', 'dominance_ratio', 'min_score_gap', 'overlap_ratio_tolerance']);
    -- SQL은 AND·OR의 평가 순서를 보장하지 않는다. 자료형을 먼저 확인하는 조건은 IF를 나눠 쓴다.
    IF jsonb_typeof(section -> 'harmonic_multipliers') <> 'array' THEN
        PERFORM operation_rules_fail('values.matching.harmonic_multipliers', '배열이어야 한다');
    END IF;
    IF jsonb_array_length(section -> 'harmonic_multipliers') = 0 THEN
        PERFORM operation_rules_fail('values.matching.harmonic_multipliers', '비어 있으면 안 된다');
    END IF;
    FOR item IN SELECT jsonb_array_elements(section -> 'harmonic_multipliers') LOOP
        n := operation_rules_number(item, 'values.matching.harmonic_multipliers');
        -- SRS 5.1은 지금 1·1/2·2배만 둔다. 3배는 S15P21C206-112 뒤에 새 형식으로 연다.
        IF n NOT IN (0.5, 1, 2) THEN
            PERFORM operation_rules_fail('values.matching.harmonic_multipliers',
                '지원하지 않는 배율 ' || n || '. 1, 2, 0.5만 쓸 수 있다');
        END IF;
        IF n = ANY (seen) THEN
            PERFORM operation_rules_fail('values.matching.harmonic_multipliers', '배율 ' || n || '이 중복됐다');
        END IF;
        seen := seen || n;
    END LOOP;
    IF NOT 1 = ANY (seen) THEN
        PERFORM operation_rules_fail('values.matching.harmonic_multipliers', '배율 1이 있어야 한다(SRS 5.2 배율 1 우선)');
    END IF;
    IF jsonb_typeof(section -> 'n_transits_cap') <> 'null' THEN
        IF operation_rules_integer(section -> 'n_transits_cap', 'values.matching.n_transits_cap') < 1 THEN
            PERFORM operation_rules_fail('values.matching.n_transits_cap', 'null(상한 없음) 또는 1 이상이어야 한다');
        END IF;
    END IF;
    lower_bound := operation_rules_number(section -> 'duration_ratio_min', 'values.matching.duration_ratio_min');
    upper_bound := operation_rules_number(section -> 'duration_ratio_max', 'values.matching.duration_ratio_max');
    IF lower_bound <= 0 THEN
        PERFORM operation_rules_fail('values.matching.duration_ratio_min', '0보다 커야 한다');
    END IF;
    IF lower_bound >= upper_bound THEN
        PERFORM operation_rules_fail('values.matching.duration_ratio_min', 'duration_ratio_max보다 작아야 한다');
    END IF;
    IF operation_rules_integer(section -> 'min_overlap_transits', 'values.matching.min_overlap_transits') < 1 THEN
        PERFORM operation_rules_fail('values.matching.min_overlap_transits', '1 이상이어야 한다');
    END IF;
    n := operation_rules_number(section -> 'dominance_ratio', 'values.matching.dominance_ratio');
    IF n <= 0 OR n > 1 THEN
        PERFORM operation_rules_fail('values.matching.dominance_ratio', '0 초과 1 이하여야 한다');
    END IF;
    IF operation_rules_number(section -> 'min_score_gap', 'values.matching.min_score_gap') < 0 THEN
        PERFORM operation_rules_fail('values.matching.min_score_gap', '0 이상이어야 한다');
    END IF;
    n := operation_rules_number(section -> 'overlap_ratio_tolerance', 'values.matching.overlap_ratio_tolerance');
    IF n < 0 OR n > 1 THEN
        PERFORM operation_rules_fail('values.matching.overlap_ratio_tolerance', '0 이상 1 이하여야 한다');
    END IF;

    -- 봉우리 (탐사 API 5.4)
    section := v -> 'peaks';
    PERFORM operation_rules_object(section, 'values.peaks', ARRAY['top_n']);
    IF operation_rules_integer(section -> 'top_n', 'values.peaks.top_n') < 1 THEN
        PERFORM operation_rules_fail('values.peaks.top_n', '1 이상이어야 한다');
    END IF;

    -- 발견 (OPS-08, 탐사 API 9.2)
    section := v -> 'discovery';
    PERFORM operation_rules_object(section, 'values.discovery', ARRAY['stars_per_achievement', 'seed_policy']);
    IF operation_rules_integer(section -> 'stars_per_achievement', 'values.discovery.stars_per_achievement') < 0 THEN
        PERFORM operation_rules_fail('values.discovery.stars_per_achievement', '0 이상이어야 한다');
    END IF;
    IF jsonb_typeof(section -> 'seed_policy') <> 'string' THEN
        PERFORM operation_rules_fail('values.discovery.seed_policy', '문자열이어야 한다');
    END IF;
    IF section ->> 'seed_policy' NOT IN ('hash-user-achievement-seq-v1') THEN
        PERFORM operation_rules_fail('values.discovery.seed_policy', 'hash-user-achievement-seq-v1이어야 한다');
    END IF;

    -- 튜토리얼 건너뛰기 (SUB-12). 0이면 끈다.
    section := v -> 'tutorial';
    PERFORM operation_rules_object(section, 'values.tutorial', ARRAY['skip_after']);
    IF operation_rules_integer(section -> 'skip_after', 'values.tutorial.skip_after') < 0 THEN
        PERFORM operation_rules_fail('values.tutorial.skip_after', '0 이상이어야 한다');
    END IF;

    -- AI 판정 하한·상한 (AI-04). 실측 전에는 둘 다 null이다.
    section := v -> 'ai';
    PERFORM operation_rules_object(section, 'values.ai', ARRAY['lower_threshold', 'upper_threshold']);
    IF (jsonb_typeof(section -> 'lower_threshold') = 'null') <> (jsonb_typeof(section -> 'upper_threshold') = 'null') THEN
        PERFORM operation_rules_fail('values.ai', 'lower_threshold와 upper_threshold는 둘 다 null이거나 둘 다 숫자여야 한다');
    END IF;
    IF jsonb_typeof(section -> 'lower_threshold') <> 'null' THEN
        lower_bound := operation_rules_number(section -> 'lower_threshold', 'values.ai.lower_threshold');
        upper_bound := operation_rules_number(section -> 'upper_threshold', 'values.ai.upper_threshold');
        IF lower_bound < 0 OR upper_bound > 1 OR lower_bound >= upper_bound THEN
            PERFORM operation_rules_fail('values.ai', '0 ≤ lower_threshold < upper_threshold ≤ 1이어야 한다');
        END IF;
    END IF;

    -- BLS 품질은 D13이 값을 정하기 전이라 형식 1에서는 자리만 둔다. 정해지면 새 형식으로 올린다.
    IF jsonb_typeof(v -> 'bls') <> 'null' THEN
        PERFORM operation_rules_fail('values.bls', '형식 1에서는 null이다');
    END IF;

    RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. operation_settings 제약
-- ---------------------------------------------------------------------------

-- 이미 있는 행이 형식에 맞지 않으면 어떤 행이 왜 틀렸는지 모아서 멈춘다.
DO $$
DECLARE
    existing_version TEXT;
    problems TEXT := '';
BEGIN
    FOR existing_version IN SELECT rule_version FROM operation_settings ORDER BY rule_version LOOP
        BEGIN
            PERFORM operation_rules_valid("values") FROM operation_settings WHERE rule_version = existing_version;
        EXCEPTION WHEN check_violation THEN
            problems := problems || existing_version || ' (' || SQLERRM || ') ';
        END;
    END LOOP;
    IF problems <> '' THEN
        RAISE EXCEPTION '형식 1에 맞지 않는 운영 규칙 행이 있습니다: %', problems
            USING HINT = '개발 DB라면 그 행을 형식 1로 고치거나, 참조하는 제출과 함께 비운 뒤 다시 적용하십시오.';
    END IF;
END $$;

ALTER TABLE operation_settings
    ADD CONSTRAINT ck_operation_settings_values_valid CHECK (operation_rules_valid("values"));

-- 현재 규칙 = 지금 이전에 적용된 것 중 applied_at이 가장 늦은 행. 같은 시각이 둘이면 어느 것인지 정해지지 않는다.
CREATE UNIQUE INDEX uq_operation_settings_applied_at ON operation_settings (applied_at);

-- 행 목록이 곧 변경 이력이고 제출이 rule_version으로 판정 근거를 되살린다. 고치면 과거 판정을 재현할 수 없다.
-- 규칙은 운영자가 소유자 계정으로 넣으므로 V5처럼 권한 회수로는 막을 수 없어 트리거를 쓴다.
CREATE FUNCTION operation_settings_keep_history() RETURNS TRIGGER
    LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- 지난 시각으로 넣으면 그 사이 제출을 판정한 버전과 이력이 어긋난다.
        IF NEW.applied_at < now() THEN
            RAISE EXCEPTION '운영 규칙 %의 적용 시각(%)이 이미 지났습니다. now() 또는 앞으로의 시각으로 넣으십시오.',
                NEW.rule_version, NEW.applied_at
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION '운영 규칙 이력은 비울 수 없습니다.'
            USING ERRCODE = 'restrict_violation';
    END IF;
    -- 적용 시각이 오지 않은 예약 버전은 아직 이력이 아니다. 잘못 예약했으면 지우고 다시 넣는다.
    IF TG_OP = 'DELETE' AND OLD.applied_at > now() THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '운영 규칙 버전은 고치거나 지울 수 없습니다(%). 값을 바꾸려면 새 rule_version 행을 넣으십시오.',
        OLD.rule_version
        USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER trg_operation_settings_keep_history
    BEFORE INSERT OR UPDATE OR DELETE ON operation_settings
    FOR EACH ROW EXECUTE FUNCTION operation_settings_keep_history();

CREATE TRIGGER trg_operation_settings_no_truncate
    BEFORE TRUNCATE ON operation_settings
    FOR EACH STATEMENT EXECUTE FUNCTION operation_settings_keep_history();

-- ---------------------------------------------------------------------------
-- 3. 초기 규칙 rule-0
-- ---------------------------------------------------------------------------

-- 제출이 rule_version을 FK로 참조하므로 모든 환경에 규칙이 하나는 있어야 한다.
-- 값은 제출 매칭 규칙 v0(S15P21C206-128)과 탐사 API 기본값이며 운영 확정값이 아니다.
-- tutorial.skip_after만 환경마다 다르다(개발 3, 운영 0=끔). 세션 설정 planetory.tutorial_skip_after를 읽고
-- 없으면 0이다. local 프로필은 spring.flyway.init-sqls로 3을 준다. Flyway placeholder를 쓰지 않는 것은
-- SQL 파일을 Flyway 없이 그대로 실행하는 도구(experiments/gold-roundtrip)도 이 파일을 적용할 수 있게 하려는 것이다.
INSERT INTO operation_settings (rule_version, "values", applied_at, note)
VALUES ('rule-0', jsonb_set('{
          "format_version": 1,
          "selection": {"phase_width_max": 0.25, "max_duration_multiple_of_suggested": 3,
                        "allow_empty_phase_span": false},
          "matching": {"harmonic_multipliers": [1, 2, 0.5], "n_transits_cap": null,
                       "duration_ratio_min": 0.5, "duration_ratio_max": 2, "min_overlap_transits": 1,
                       "dominance_ratio": 0.5, "min_score_gap": 0.1, "overlap_ratio_tolerance": 0.1},
          "peaks": {"top_n": 10},
          "discovery": {"stars_per_achievement": 1, "seed_policy": "hash-user-achievement-seq-v1"},
          "tutorial": {"skip_after": 0},
          "ai": {"lower_threshold": null, "upper_threshold": null},
          "bls": null
        }'::JSONB, '{tutorial,skip_after}',
        to_jsonb(COALESCE(NULLIF(current_setting('planetory.tutorial_skip_after', true), ''), '0')::INTEGER)),
        now(),
        '초기 규칙 [S15P21C206-151]. 제출 매칭 v0 예제와 탐사 API 기본값이며 운영 확정값이 아니다. D20·D11 확정 뒤 새 버전으로 올린다.')
ON CONFLICT (rule_version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. 튜토리얼 별·챌린지 회차 (OPS-07)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    hidden_tutorials BIGINT;
    hidden_rounds BIGINT;
    reversed_rounds BIGINT;
BEGIN
    SELECT count(*) INTO hidden_tutorials FROM tutorial_stars t
     WHERE NOT EXISTS (SELECT 1 FROM stars s WHERE s.tic_id = t.tic_id AND s.service_status = 'published');
    SELECT count(*) INTO hidden_rounds FROM challenge_rounds r
     WHERE NOT EXISTS (SELECT 1 FROM stars s WHERE s.tic_id = r.target_tic_id AND s.service_status = 'published');
    SELECT count(*) INTO reversed_rounds FROM challenge_rounds WHERE starts_on > ends_on;
    IF hidden_tutorials + hidden_rounds + reversed_rounds > 0 THEN
        RAISE EXCEPTION '설정이 어긋난 행이 있습니다: 공개되지 않은 튜토리얼 별 %건, 공개되지 않은 챌린지 대상 %건, 기간이 뒤집힌 회차 %건',
            hidden_tutorials, hidden_rounds, reversed_rounds
            USING HINT = '대상 별을 공개하거나 행을 고친 뒤 다시 적용하십시오.';
    END IF;
END $$;

ALTER TABLE challenge_rounds
    ADD CONSTRAINT ck_challenge_rounds_period CHECK (starts_on <= ends_on);

-- 공개되지 않은 별은 회원에게 열 수 없다. 대상 열을 넣거나 바꿀 때만 검사한다. 대상 별이 나중에
-- 숨겨져도 회차를 닫거나 튜토리얼을 끄는 수정은 막지 않는다.
CREATE FUNCTION exploration_target_must_be_published() RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path FROM CURRENT
AS $$
DECLARE
    target BIGINT := (to_jsonb(NEW) ->> TG_ARGV[0])::BIGINT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM stars WHERE tic_id = target AND service_status = 'published') THEN
        RAISE EXCEPTION '공개된 별만 %.%에 넣을 수 있습니다. TIC %는 없거나 공개되지 않았습니다.',
            TG_TABLE_NAME, TG_ARGV[0], target
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tutorial_stars_published
    BEFORE INSERT OR UPDATE OF tic_id ON tutorial_stars
    FOR EACH ROW EXECUTE FUNCTION exploration_target_must_be_published('tic_id');

CREATE TRIGGER trg_challenge_rounds_published
    BEFORE INSERT OR UPDATE OF target_tic_id ON challenge_rounds
    FOR EACH ROW EXECUTE FUNCTION exploration_target_must_be_published('target_tic_id');
