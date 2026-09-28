--
-- PostgreSQL database dump
--

\restrict vooPMJiEQBMoskiffUZ1gp5P8U2xtDlHvU1pboJm4cchYwiwslEEgohweg47exw

-- Dumped from database version 18.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner:
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: candidates_official_summary(); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.candidates_official_summary() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
    -- 고정 스냅샷으로 신규 스레드를 놓친 채 후보 변경만 커밋하지 않는다.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Candidate summary updates require READ COMMITTED'
            USING ERRCODE = '25000';
    END IF;
    UPDATE posts SET body=official_signal_summary(NEW.period_days,NEW.epoch_btjd,NEW.duration_hours,NEW.depth_ppm),
        updated_at=clock_timestamp()
        WHERE kind='system_thread' AND candidate_id=NEW.id;
    RETURN NEW;
END $$;


ALTER FUNCTION public.candidates_official_summary() OWNER TO planetory;

--
-- Name: capture_challenge_notification(); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.capture_challenge_notification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP='UPDATE' THEN NEW.notification_started_at := OLD.notification_started_at;
    ELSE NEW.notification_started_at := NULL;
    END IF;
    IF NEW.status='active' AND NEW.notification_started_at IS NULL THEN
        NEW.notification_started_at := clock_timestamp();
        INSERT INTO notification_outbox(event_key,user_id,type,payload,preference_epoch,state)
        SELECT 'challenge:'||NEW.id,u.id,'challenge',
               jsonb_build_object('roundId',NEW.id::text,'startedAt',NEW.notification_started_at),
               coalesce((s.notification_epochs->>'challenge')::bigint,0),
               CASE WHEN coalesce((s.notification_prefs->>'challenge')::boolean,true) THEN 'pending' ELSE 'excluded' END
          FROM users u LEFT JOIN user_settings s ON s.user_id=u.id
         -- HOME-06/POL-24: 활성 튜토리얼 5개 완료. Java TUTORIAL_STAR_COUNT와 함께 변경한다.
         -- 활성 개수로 나누면 0개/4개 설정에서도 자격을 주므로 여기만 동적으로 바꾸지 않는다.
         WHERE u.status='active' AND (SELECT count(*) FROM tutorial_stars t
                 JOIN user_star_progress p ON p.tic_id=t.tic_id
                 WHERE t.active AND p.user_id=u.id AND (p.progress_stage='completed' OR p.completed_at IS NOT NULL))=5
        ON CONFLICT(user_id,event_key) DO NOTHING;
    END IF;
    RETURN NEW;
END $$;


ALTER FUNCTION public.capture_challenge_notification() OWNER TO planetory;

--
-- Name: cleanup_withdrawn_member(bigint); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.cleanup_withdrawn_member(member bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', '$user', 'public'
    AS $$
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


ALTER FUNCTION public.cleanup_withdrawn_member(member bigint) OWNER TO planetory;

--
-- Name: exploration_target_must_be_published(); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.exploration_target_must_be_published() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', '$user', 'public'
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


ALTER FUNCTION public.exploration_target_must_be_published() OWNER TO planetory;

--
-- Name: mark_star_board_open(); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.mark_star_board_open() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', '$user', 'public'
    AS $$
BEGIN
    UPDATE stars SET board_open=true WHERE tic_id=NEW.tic_id AND NOT board_open;
    RETURN NEW;
END $$;


ALTER FUNCTION public.mark_star_board_open() OWNER TO planetory;

--
-- Name: notification_bundle_published(); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.notification_bundle_published() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE event_id BIGINT; signal_id BIGINT;
BEGIN
    IF NEW.status<>'current' OR (TG_OP='UPDATE' AND OLD.status='current')
       OR NOT EXISTS(SELECT 1 FROM publication_bundles WHERE id=NEW.id AND status='current')
    THEN RETURN NULL; END IF;
    FOR signal_id IN SELECT id FROM candidates WHERE updated_bundle_id=NEW.id ORDER BY id LOOP
      PERFORM notification_signal_changed(signal_id);
    END LOOP;
    IF NOT EXISTS(SELECT 1 FROM notification_candidate_changes WHERE bundle_id=NEW.id AND NOT was_discoverable AND is_discoverable) THEN RETURN NULL; END IF;
    INSERT INTO notification_events(event_key,type,payload)
    VALUES('reopen:'||NEW.tic_id||':'||NEW.id,'reopen',jsonb_build_object('ticId',NEW.tic_id::text,'bundleId',NEW.id::text))
    ON CONFLICT(event_key) DO NOTHING RETURNING id INTO event_id;
    IF event_id IS NULL THEN RETURN NULL; END IF;
    INSERT INTO notification_outbox(event_key,user_id,type,payload,preference_epoch,follow_id,follow_epoch,state)
    SELECT 'reopen:'||NEW.tic_id||':'||NEW.id,u.id,'reopen',
      jsonb_build_object('ticId',NEW.tic_id::text,'originBundleId',NEW.id::text,'targetKind','STAR_BOARD','eventId',event_id::text),
      coalesce((s.notification_epochs->>'reopen')::bigint,0),f.id,coalesce((s.notification_epochs->>'follow')::bigint,0),
      CASE WHEN coalesce((s.notification_prefs->>'reopen')::boolean,true) AND coalesce((s.notification_prefs->>'follow')::boolean,true)
      THEN 'pending' ELSE 'excluded' END
    FROM follows f JOIN users u ON u.id=f.user_id AND u.status='active'
    LEFT JOIN user_settings s ON s.user_id=u.id WHERE f.target_type='star' AND f.target_id=NEW.tic_id
    ON CONFLICT(user_id,event_key) DO NOTHING;
    RETURN NULL;
END $$;


ALTER FUNCTION public.notification_bundle_published() OWNER TO planetory;

--
-- Name: notification_candidate_change(); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.notification_candidate_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
    INSERT INTO notification_candidate_changes VALUES(NEW.updated_bundle_id,NEW.id,
      CASE WHEN TG_OP='INSERT' THEN false ELSE OLD.status='active' AND OLD.discoverable END,
      NEW.status='active' AND NEW.discoverable)
    ON CONFLICT(bundle_id,candidate_id) DO UPDATE SET is_discoverable=EXCLUDED.is_discoverable;
    RETURN NULL;
END $$;


ALTER FUNCTION public.notification_candidate_change() OWNER TO planetory;

--
-- Name: notification_signal_changed(bigint); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.notification_signal_changed(candidate bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE before_row notification_signal_state%ROWTYPE; next_disposition TEXT; next_ai TEXT;
        signal_tic BIGINT; axis TEXT; old_value TEXT; new_value TEXT; event_id BIGINT; cause TEXT;
BEGIN
    SELECT c.tic_id INTO signal_tic FROM candidates c JOIN publication_bundles b ON b.id=c.updated_bundle_id WHERE c.id=candidate AND b.status='current';
    IF NOT FOUND THEN RETURN; END IF;
    INSERT INTO notification_signal_state(candidate_id) VALUES(candidate) ON CONFLICT DO NOTHING;
    SELECT * INTO before_row FROM notification_signal_state WHERE candidate_id=candidate FOR UPDATE;
    SELECT disposition INTO next_disposition FROM candidate_dispositions WHERE candidate_id=candidate;
    SELECT CASE WHEN x.status='success' THEN e.verdict END INTO next_ai FROM ai_evaluations e JOIN ai_executions x ON x.id=e.execution_id
      WHERE e.candidate_id=candidate
      ORDER BY x.started_at DESC,e.id DESC LIMIT 1;
    FOREACH axis IN ARRAY ARRAY['disposition','ai_verdict'] LOOP
      old_value := CASE WHEN axis='disposition' THEN before_row.disposition ELSE before_row.ai_verdict END;
      new_value := CASE WHEN axis='disposition' THEN next_disposition ELSE next_ai END;
      -- 최초 유효 값은 비교 기준이다. 누락·실패는 판정 변경이 아니다.
      IF old_value IS NOT NULL AND new_value IS NOT NULL AND old_value<>new_value THEN
        cause := 'relabel:'||candidate||':'||axis||':'||pg_current_xact_id()::text;
        INSERT INTO notification_events(event_key,type,payload)
        VALUES(cause,'relabel',jsonb_build_object('candidateId',candidate::text,'ticId',signal_tic::text,
          'axis',axis,'before',old_value,'after',new_value,'source',
          CASE WHEN axis='disposition' THEN (SELECT jsonb_build_object('ruleVersion',rule_version,'appliedAt',applied_at,'sourceRefs',source_refs) FROM candidate_dispositions WHERE candidate_id=candidate)
          ELSE (SELECT jsonb_build_object('executionId',x.id::text,'modelVersion',x.model_version,'thresholdVersion',e.threshold_version) FROM ai_evaluations e JOIN ai_executions x ON x.id=e.execution_id WHERE e.candidate_id=candidate ORDER BY x.started_at DESC,e.id DESC LIMIT 1) END))
        ON CONFLICT(event_key) DO NOTHING RETURNING id INTO event_id;
        IF event_id IS NOT NULL THEN
          INSERT INTO notification_outbox(event_key,user_id,type,payload,preference_epoch,state)
          SELECT cause,u.id,'relabel',jsonb_build_object('ticId',signal_tic::text,'eventId',event_id::text),
            coalesce((s.notification_epochs->>'relabel')::bigint,0),
            CASE WHEN coalesce((s.notification_prefs->>'relabel')::boolean,true) THEN 'pending' ELSE 'excluded' END
          FROM users u LEFT JOIN user_settings s ON s.user_id=u.id WHERE u.status='active'
            AND EXISTS(SELECT 1 FROM submissions m WHERE m.user_id=u.id AND m.matched_candidate_id=candidate
                AND m.match_result IN ('matched','matched_harmonic','duplicate'))
          ON CONFLICT(user_id,event_key) DO NOTHING;
        END IF;
      END IF;
    END LOOP;
    UPDATE notification_signal_state SET disposition=coalesce(next_disposition,disposition),ai_verdict=coalesce(next_ai,ai_verdict)
      WHERE candidate_id=candidate;
END $$;


ALTER FUNCTION public.notification_signal_changed(candidate bigint) OWNER TO planetory;

--
-- Name: notification_signal_trigger(); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.notification_signal_trigger() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE candidate BIGINT;
BEGIN
    IF TG_TABLE_NAME='ai_executions' THEN
      FOR candidate IN SELECT candidate_id FROM ai_evaluations WHERE execution_id=NEW.id ORDER BY candidate_id LOOP
        PERFORM notification_signal_changed(candidate);
      END LOOP;
    ELSE PERFORM notification_signal_changed(NEW.candidate_id);
    END IF;
    RETURN NULL;
END $$;


ALTER FUNCTION public.notification_signal_trigger() OWNER TO planetory;

--
-- Name: official_signal_summary(numeric, numeric, numeric, numeric); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.official_signal_summary(period numeric, epoch numeric, duration numeric, depth numeric) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$ SELECT '주기 ' || coalesce(trim_scale(period)::text, '미정') || ' 일 · 기준 시각 '
    || coalesce(trim_scale(epoch)::text, '미정') || ' BTJD · 지속시간 '
    || coalesce(trim_scale(duration)::text, '미정') || ' 시간 · 깊이 '
    || coalesce(trim_scale(depth)::text, '미정') || ' ppm' $$;


ALTER FUNCTION public.official_signal_summary(period numeric, epoch numeric, duration numeric, depth numeric) OWNER TO planetory;

--
-- Name: operation_rules_fail(text, text); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.operation_rules_fail(path text, reason text) RETURNS void
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', '$user', 'public'
    AS $$
BEGIN
    RAISE EXCEPTION 'operation_settings.%: %', path, reason
        USING ERRCODE = 'check_violation',
              HINT = '형식은 docs/operations/operation-rule-runbook.md를 따른다.';
END;
$$;


ALTER FUNCTION public.operation_rules_fail(path text, reason text) OWNER TO planetory;

--
-- Name: operation_rules_integer(jsonb, text); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.operation_rules_integer(v jsonb, path text) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', '$user', 'public'
    AS $_$
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
$_$;


ALTER FUNCTION public.operation_rules_integer(v jsonb, path text) OWNER TO planetory;

--
-- Name: operation_rules_number(jsonb, text); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.operation_rules_number(v jsonb, path text) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', '$user', 'public'
    AS $$
BEGIN
    IF v IS NULL OR jsonb_typeof(v) <> 'number' THEN
        PERFORM operation_rules_fail(path, '숫자여야 한다');
    END IF;
    RETURN (v #>> '{}')::NUMERIC;
END;
$$;


ALTER FUNCTION public.operation_rules_number(v jsonb, path text) OWNER TO planetory;

--
-- Name: operation_rules_object(jsonb, text, text[]); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.operation_rules_object(v jsonb, path text, keys text[]) RETURNS void
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', '$user', 'public'
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


ALTER FUNCTION public.operation_rules_object(v jsonb, path text, keys text[]) OWNER TO planetory;

--
-- Name: operation_rules_valid(jsonb); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.operation_rules_valid(v jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', '$user', 'public'
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


ALTER FUNCTION public.operation_rules_valid(v jsonb) OWNER TO planetory;

--
-- Name: operation_settings_keep_history(); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.operation_settings_keep_history() RETURNS trigger
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


ALTER FUNCTION public.operation_settings_keep_history() OWNER TO planetory;

--
-- Name: posts_official_summary(); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.posts_official_summary() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
BEGIN
    IF NEW.kind = 'system_thread' THEN
        -- 최초 공개와 후보 변경이 경합해도 이전 수치로 된 본문이 남지 않도록 직렬화한다.
        SELECT official_signal_summary(c.period_days,c.epoch_btjd,c.duration_hours,c.depth_ppm)
          INTO STRICT NEW.body FROM candidates c
          WHERE c.id=NEW.candidate_id AND c.tic_id=NEW.tic_id FOR SHARE;
    END IF;
    RETURN NEW;
END $$;


ALTER FUNCTION public.posts_official_summary() OWNER TO planetory;

--
-- Name: prune_withdrawal_retention(); Type: FUNCTION; Schema: public; Owner: planetory
--

CREATE FUNCTION public.prune_withdrawal_retention() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', '$user', 'public'
    AS $$
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


ALTER FUNCTION public.prune_withdrawal_retention() OWNER TO planetory;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ai_evaluations; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.ai_evaluations (
    id bigint NOT NULL,
    candidate_id bigint NOT NULL,
    execution_id bigint NOT NULL,
    score numeric,
    verdict text,
    threshold_version text NOT NULL,
    raw_output jsonb,
    CONSTRAINT ai_evaluations_verdict_check CHECK ((verdict = ANY (ARRAY['rejected'::text, 'hold'::text, 'approved'::text])))
);


ALTER TABLE public.ai_evaluations OWNER TO planetory;

--
-- Name: TABLE ai_evaluations; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.ai_evaluations IS 'AI 실행이 후보 하나에 매긴 점수와 판정';


--
-- Name: COLUMN ai_evaluations.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.ai_evaluations.id IS '고유 번호';


--
-- Name: COLUMN ai_evaluations.candidate_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.ai_evaluations.candidate_id IS '후보';


--
-- Name: COLUMN ai_evaluations.execution_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.ai_evaluations.execution_id IS '실행';


--
-- Name: COLUMN ai_evaluations.score; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.ai_evaluations.score IS '점수';


--
-- Name: COLUMN ai_evaluations.verdict; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.ai_evaluations.verdict IS 'rejected/hold/approved';


--
-- Name: COLUMN ai_evaluations.threshold_version; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.ai_evaluations.threshold_version IS '임계값 버전';


--
-- Name: COLUMN ai_evaluations.raw_output; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.ai_evaluations.raw_output IS '모델 원본 출력';


--
-- Name: ai_evaluations_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.ai_evaluations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.ai_evaluations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ai_executions; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.ai_executions (
    id bigint NOT NULL,
    model_version text NOT NULL,
    checkpoint text,
    status text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    error text,
    duration_ms bigint
);


ALTER TABLE public.ai_executions OWNER TO planetory;

--
-- Name: TABLE ai_executions; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.ai_executions IS 'AI 모델 실행 1회의 메타데이터. 모델·체크포인트 버전과 성공 여부를 남긴다';


--
-- Name: COLUMN ai_executions.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.ai_executions.id IS '고유 번호';


--
-- Name: COLUMN ai_executions.model_version; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.ai_executions.model_version IS '모델 버전';


--
-- Name: COLUMN ai_executions.checkpoint; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.ai_executions.checkpoint IS '체크포인트';


--
-- Name: COLUMN ai_executions.status; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.ai_executions.status IS '상태';


--
-- Name: COLUMN ai_executions.started_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.ai_executions.started_at IS '시작';


--
-- Name: COLUMN ai_executions.error; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.ai_executions.error IS '실패 내용';


--
-- Name: COLUMN ai_executions.duration_ms; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.ai_executions.duration_ms IS '실행 시간';


--
-- Name: ai_executions_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.ai_executions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.ai_executions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: analysis_histories; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.analysis_histories (
    id bigint NOT NULL,
    submission_id bigint NOT NULL,
    user_id bigint NOT NULL,
    tic_id bigint NOT NULL,
    snapshot_params jsonb NOT NULL,
    versions jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.analysis_histories OWNER TO planetory;

--
-- Name: TABLE analysis_histories; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.analysis_histories IS '제출 시점의 분석 파라미터 스냅샷. 재현과 글 첨부의 단위다';


--
-- Name: COLUMN analysis_histories.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.analysis_histories.id IS '고유 번호';


--
-- Name: COLUMN analysis_histories.submission_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.analysis_histories.submission_id IS '제출';


--
-- Name: COLUMN analysis_histories.user_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.analysis_histories.user_id IS '회원';


--
-- Name: COLUMN analysis_histories.tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.analysis_histories.tic_id IS '별';


--
-- Name: COLUMN analysis_histories.snapshot_params; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.analysis_histories.snapshot_params IS '재현 파라미터';


--
-- Name: COLUMN analysis_histories.versions; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.analysis_histories.versions IS '데이터·계산 버전';


--
-- Name: COLUMN analysis_histories.created_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.analysis_histories.created_at IS '생성 시각';


--
-- Name: analysis_histories_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.analysis_histories ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.analysis_histories_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: analysis_snapshots; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.analysis_snapshots (
    history_id bigint NOT NULL,
    bins smallint DEFAULT 150 NOT NULL,
    folded_flux real[] NOT NULL,
    folded_err real[] NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT analysis_snapshots_check CHECK (((bins > 0) AND (array_ndims(folded_flux) = 1) AND (cardinality(folded_flux) = bins) AND (array_ndims(folded_err) = 1) AND (cardinality(folded_err) = bins)))
);


ALTER TABLE public.analysis_snapshots OWNER TO planetory;

--
-- Name: TABLE analysis_snapshots; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.analysis_snapshots IS '히스토리에 딸린 위상 접기 곡선. 150구간으로 압축해 둔다';


--
-- Name: COLUMN analysis_snapshots.history_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.analysis_snapshots.history_id IS '히스토리';


--
-- Name: COLUMN analysis_snapshots.bins; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.analysis_snapshots.bins IS '구간 수(150)';


--
-- Name: COLUMN analysis_snapshots.folded_flux; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.analysis_snapshots.folded_flux IS '구간별 밝기 중앙값';


--
-- Name: COLUMN analysis_snapshots.folded_err; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.analysis_snapshots.folded_err IS '구간별 오차';


--
-- Name: COLUMN analysis_snapshots.created_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.analysis_snapshots.created_at IS '생성 시각';


--
-- Name: candidate_aliases; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.candidate_aliases (
    id bigint NOT NULL,
    candidate_id bigint NOT NULL,
    multiplier numeric NOT NULL,
    alias_period_days numeric NOT NULL
);


ALTER TABLE public.candidate_aliases OWNER TO planetory;

--
-- Name: TABLE candidate_aliases; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.candidate_aliases IS '후보 주기의 배수 별칭(1/2배·2배 등). 제출 주기 정정 판정에 쓴다';


--
-- Name: COLUMN candidate_aliases.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_aliases.id IS '고유 번호';


--
-- Name: COLUMN candidate_aliases.candidate_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_aliases.candidate_id IS '후보';


--
-- Name: COLUMN candidate_aliases.multiplier; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_aliases.multiplier IS '배수';


--
-- Name: COLUMN candidate_aliases.alias_period_days; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_aliases.alias_period_days IS '별칭 주기';


--
-- Name: candidate_aliases_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.candidate_aliases ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.candidate_aliases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: candidate_dispositions; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.candidate_dispositions (
    candidate_id bigint NOT NULL,
    disposition text NOT NULL,
    answer_class text NOT NULL,
    planet_truth text,
    rule_version text NOT NULL,
    applied_at timestamp with time zone NOT NULL,
    source_refs jsonb NOT NULL,
    CONSTRAINT candidate_dispositions_answer_class_check CHECK ((answer_class = ANY (ARRAY['graded'::text, 'analysis'::text]))),
    CONSTRAINT candidate_dispositions_disposition_check CHECK ((disposition = ANY (ARRAY['confirmed'::text, 'fp'::text, 'pc'::text, 'none'::text]))),
    CONSTRAINT candidate_dispositions_planet_truth_check CHECK ((planet_truth = ANY (ARRAY['planet'::text, 'not_planet'::text])))
);


ALTER TABLE public.candidate_dispositions OWNER TO planetory;

--
-- Name: TABLE candidate_dispositions; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.candidate_dispositions IS '후보의 최종 분류와 정답 근거. 규칙 버전별로 적용된다';


--
-- Name: COLUMN candidate_dispositions.candidate_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_dispositions.candidate_id IS '후보';


--
-- Name: COLUMN candidate_dispositions.disposition; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_dispositions.disposition IS 'confirmed/fp/pc/none';


--
-- Name: COLUMN candidate_dispositions.answer_class; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_dispositions.answer_class IS 'graded/analysis';


--
-- Name: COLUMN candidate_dispositions.planet_truth; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_dispositions.planet_truth IS 'planet/not_planet/null';


--
-- Name: COLUMN candidate_dispositions.rule_version; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_dispositions.rule_version IS '규칙 버전';


--
-- Name: COLUMN candidate_dispositions.applied_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_dispositions.applied_at IS '적용 시각';


--
-- Name: COLUMN candidate_dispositions.source_refs; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_dispositions.source_refs IS '분류 원천';


--
-- Name: candidate_status_history; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.candidate_status_history (
    id bigint NOT NULL,
    candidate_id bigint NOT NULL,
    bundle_id bigint NOT NULL,
    field text NOT NULL,
    old_value text,
    new_value text,
    changed_at timestamp with time zone NOT NULL,
    rule_version text NOT NULL,
    reason text
);


ALTER TABLE public.candidate_status_history OWNER TO planetory;

--
-- Name: TABLE candidate_status_history; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.candidate_status_history IS '후보 항목 값의 변경 이력. 판이 바뀔 때 무엇이 달라졌는지 남긴다';


--
-- Name: COLUMN candidate_status_history.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_status_history.id IS '고유 번호';


--
-- Name: COLUMN candidate_status_history.candidate_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_status_history.candidate_id IS '후보';


--
-- Name: COLUMN candidate_status_history.bundle_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_status_history.bundle_id IS '판';


--
-- Name: COLUMN candidate_status_history.field; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_status_history.field IS '항목';


--
-- Name: COLUMN candidate_status_history.old_value; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_status_history.old_value IS '이전';


--
-- Name: COLUMN candidate_status_history.new_value; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_status_history.new_value IS '이후';


--
-- Name: COLUMN candidate_status_history.changed_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_status_history.changed_at IS '변경 시각';


--
-- Name: COLUMN candidate_status_history.rule_version; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_status_history.rule_version IS '규칙 버전';


--
-- Name: COLUMN candidate_status_history.reason; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidate_status_history.reason IS '변경 사유';


--
-- Name: candidate_status_history_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.candidate_status_history ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.candidate_status_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: candidates; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.candidates (
    id bigint NOT NULL,
    tic_id bigint NOT NULL,
    status text NOT NULL,
    updated_bundle_id bigint NOT NULL,
    removal_step smallint NOT NULL,
    period_days numeric NOT NULL,
    epoch_btjd numeric NOT NULL,
    duration_hours numeric NOT NULL,
    depth_ppm numeric NOT NULL,
    bls_power numeric NOT NULL,
    transit_model jsonb NOT NULL,
    discoverable boolean NOT NULL,
    is_confirmed boolean NOT NULL,
    CONSTRAINT candidates_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retired'::text])))
);


ALTER TABLE public.candidates OWNER TO planetory;

--
-- Name: TABLE candidates; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.candidates IS '별에서 검출된 통과 신호 후보. 판이 바뀌어도 id는 유지된다';


--
-- Name: COLUMN candidates.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidates.id IS '고유 번호 · 판이 바뀌어도 유지';


--
-- Name: COLUMN candidates.tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidates.tic_id IS '별';


--
-- Name: COLUMN candidates.status; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidates.status IS 'active/retired';


--
-- Name: COLUMN candidates.updated_bundle_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidates.updated_bundle_id IS '마지막 갱신 판';


--
-- Name: COLUMN candidates.removal_step; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidates.removal_step IS '배치 제거 순번';


--
-- Name: COLUMN candidates.period_days; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidates.period_days IS '주기(일)';


--
-- Name: COLUMN candidates.epoch_btjd; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidates.epoch_btjd IS '중심 시각';


--
-- Name: COLUMN candidates.duration_hours; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidates.duration_hours IS '지속시간';


--
-- Name: COLUMN candidates.depth_ppm; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidates.depth_ppm IS '깊이';


--
-- Name: COLUMN candidates.bls_power; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidates.bls_power IS 'BLS 세기';


--
-- Name: COLUMN candidates.transit_model; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidates.transit_model IS '통과 모델 파라미터';


--
-- Name: COLUMN candidates.discoverable; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidates.discoverable IS '현재 데이터로 찾을 수 있는지';


--
-- Name: COLUMN candidates.is_confirmed; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.candidates.is_confirmed IS '외부 확정 여부';


--
-- Name: candidates_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.candidates ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.candidates_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: challenge_round_extra_targets; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.challenge_round_extra_targets (
    round_id bigint NOT NULL,
    tic_id bigint NOT NULL
);


ALTER TABLE public.challenge_round_extra_targets OWNER TO planetory;

--
-- Name: TABLE challenge_round_extra_targets; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.challenge_round_extra_targets IS '283: 챌린지 회차의 대표 대상 밖 추가 대상 별';


--
-- Name: COLUMN challenge_round_extra_targets.round_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.challenge_round_extra_targets.round_id IS '회차';


--
-- Name: COLUMN challenge_round_extra_targets.tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.challenge_round_extra_targets.tic_id IS '대표 대상(challenge_rounds.target_tic_id) 밖의 추가 대상 별';


--
-- Name: challenge_rounds; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.challenge_rounds (
    id bigint NOT NULL,
    round_no integer NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    target_tic_id bigint NOT NULL,
    description text NOT NULL,
    status text NOT NULL,
    notification_started_at timestamp with time zone,
    CONSTRAINT challenge_rounds_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'active'::text, 'closed'::text]))),
    CONSTRAINT ck_challenge_rounds_period CHECK ((starts_on <= ends_on))
);


ALTER TABLE public.challenge_rounds OWNER TO planetory;

--
-- Name: TABLE challenge_rounds; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.challenge_rounds IS '기간제 챌린지 회차. 대상 별과 진행 상태를 관리한다';


--
-- Name: COLUMN challenge_rounds.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.challenge_rounds.id IS '고유 번호';


--
-- Name: COLUMN challenge_rounds.round_no; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.challenge_rounds.round_no IS '회차';


--
-- Name: COLUMN challenge_rounds.starts_on; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.challenge_rounds.starts_on IS '시작일';


--
-- Name: COLUMN challenge_rounds.ends_on; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.challenge_rounds.ends_on IS '종료일';


--
-- Name: COLUMN challenge_rounds.target_tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.challenge_rounds.target_tic_id IS '대상 별';


--
-- Name: COLUMN challenge_rounds.description; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.challenge_rounds.description IS '한 줄 설명';


--
-- Name: COLUMN challenge_rounds.status; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.challenge_rounds.status IS 'planned/active/closed';


--
-- Name: COLUMN challenge_rounds.notification_started_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.challenge_rounds.notification_started_at IS '최초 시작 알림 경계; 기존 active/closed는 -infinity로 비소급 표시';


--
-- Name: challenge_round_targets; Type: VIEW; Schema: public; Owner: planetory
--

CREATE VIEW public.challenge_round_targets AS
 SELECT r.id AS round_id,
    r.target_tic_id AS tic_id,
    true AS is_primary
   FROM public.challenge_rounds r
UNION ALL
 SELECT e.round_id,
    e.tic_id,
    false AS is_primary
   FROM (public.challenge_round_extra_targets e
     JOIN public.challenge_rounds r ON ((r.id = e.round_id)))
  WHERE (e.tic_id <> r.target_tic_id);


ALTER VIEW public.challenge_round_targets OWNER TO planetory;

--
-- Name: VIEW challenge_round_targets; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON VIEW public.challenge_round_targets IS '챌린지 회차의 모든 대상 별(대표 + 추가)';


--
-- Name: challenge_rounds_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.challenge_rounds ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.challenge_rounds_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: comment_history_attachments; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.comment_history_attachments (
    id bigint NOT NULL,
    comment_id bigint NOT NULL,
    history_id bigint NOT NULL,
    attached_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.comment_history_attachments OWNER TO planetory;

--
-- Name: TABLE comment_history_attachments; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.comment_history_attachments IS '답글에 첨부된 분석 히스토리 연결';


--
-- Name: COLUMN comment_history_attachments.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.comment_history_attachments.id IS '고유 번호';


--
-- Name: COLUMN comment_history_attachments.comment_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.comment_history_attachments.comment_id IS '답글';


--
-- Name: COLUMN comment_history_attachments.history_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.comment_history_attachments.history_id IS '히스토리';


--
-- Name: COLUMN comment_history_attachments.attached_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.comment_history_attachments.attached_at IS '첨부 시각';


--
-- Name: comment_history_attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.comment_history_attachments ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.comment_history_attachments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: comments; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.comments (
    id bigint NOT NULL,
    post_id bigint NOT NULL,
    user_id bigint NOT NULL,
    body text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    author_withdrawn_at timestamp with time zone,
    CONSTRAINT comments_status_check CHECK ((status = ANY (ARRAY['visible'::text, 'hidden'::text, 'deleted'::text])))
);


ALTER TABLE public.comments OWNER TO planetory;

--
-- Name: TABLE comments; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.comments IS '글에 달린 답글';


--
-- Name: COLUMN comments.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.comments.id IS '고유 번호';


--
-- Name: COLUMN comments.post_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.comments.post_id IS '원글·스레드';


--
-- Name: COLUMN comments.user_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.comments.user_id IS '회원';


--
-- Name: COLUMN comments.body; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.comments.body IS '본문';


--
-- Name: COLUMN comments.status; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.comments.status IS 'visible/hidden/deleted';


--
-- Name: COLUMN comments.created_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.comments.created_at IS '생성 시각';


--
-- Name: COLUMN comments.updated_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.comments.updated_at IS '수정 시각';


--
-- Name: comments_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.comments ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.comments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: external_signal_references; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.external_signal_references (
    id bigint NOT NULL,
    candidate_id bigint,
    source text NOT NULL,
    external_id text NOT NULL,
    disposition text,
    period_days numeric,
    fetched_on date NOT NULL,
    tic_id bigint NOT NULL,
    epoch_btjd numeric
);


ALTER TABLE public.external_signal_references OWNER TO planetory;

--
-- Name: TABLE external_signal_references; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.external_signal_references IS 'TCE·TOI·ExoFOP 등 외부 카탈로그 신호 참조. 후보 대조의 근거다';


--
-- Name: COLUMN external_signal_references.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.external_signal_references.id IS '고유 번호';


--
-- Name: COLUMN external_signal_references.candidate_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.external_signal_references.candidate_id IS '후보(NULL 가능)';


--
-- Name: COLUMN external_signal_references.source; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.external_signal_references.source IS 'tce/toi/archive/exofop';


--
-- Name: COLUMN external_signal_references.external_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.external_signal_references.external_id IS '원천 ID';


--
-- Name: COLUMN external_signal_references.disposition; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.external_signal_references.disposition IS '원천 판정';


--
-- Name: COLUMN external_signal_references.period_days; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.external_signal_references.period_days IS '주기';


--
-- Name: COLUMN external_signal_references.fetched_on; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.external_signal_references.fetched_on IS '조회일';


--
-- Name: COLUMN external_signal_references.tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.external_signal_references.tic_id IS '별';


--
-- Name: COLUMN external_signal_references.epoch_btjd; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.external_signal_references.epoch_btjd IS '외부 신호 중심 시각';


--
-- Name: external_signal_references_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.external_signal_references ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.external_signal_references_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: flyway_schema_history; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.flyway_schema_history (
    installed_rank integer NOT NULL,
    version character varying(50),
    description character varying(200) NOT NULL,
    type character varying(20) NOT NULL,
    script character varying(1000) NOT NULL,
    checksum integer,
    installed_by character varying(100) NOT NULL,
    installed_on timestamp without time zone DEFAULT now() NOT NULL,
    execution_time integer NOT NULL,
    success boolean NOT NULL
);


ALTER TABLE public.flyway_schema_history OWNER TO planetory;

--
-- Name: follows; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.follows (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    target_type text NOT NULL,
    target_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT follows_target_type_check CHECK ((target_type = ANY (ARRAY['user'::text, 'star'::text])))
);


ALTER TABLE public.follows OWNER TO planetory;

--
-- Name: TABLE follows; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.follows IS '회원의 팔로우. 대상은 다른 회원 또는 별이다';


--
-- Name: COLUMN follows.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.follows.id IS '고유 번호';


--
-- Name: COLUMN follows.user_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.follows.user_id IS '팔로우한 회원';


--
-- Name: COLUMN follows.target_type; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.follows.target_type IS 'user/star';


--
-- Name: COLUMN follows.target_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.follows.target_id IS '대상 회원 또는 별';


--
-- Name: COLUMN follows.created_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.follows.created_at IS '생성 시각';


--
-- Name: follows_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.follows ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.follows_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: observation_datasets; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.observation_datasets (
    id bigint NOT NULL,
    tic_id bigint NOT NULL,
    sector smallint NOT NULL,
    start_btjd numeric NOT NULL,
    end_btjd numeric NOT NULL,
    cadence text NOT NULL,
    source_version text NOT NULL,
    time_system text NOT NULL
);


ALTER TABLE public.observation_datasets OWNER TO planetory;

--
-- Name: TABLE observation_datasets; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.observation_datasets IS '별의 섹터별 관측 구간 메타데이터. 어느 기간을 어떤 간격으로 찍었는지';


--
-- Name: COLUMN observation_datasets.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.observation_datasets.id IS '고유 번호';


--
-- Name: COLUMN observation_datasets.tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.observation_datasets.tic_id IS '별';


--
-- Name: COLUMN observation_datasets.sector; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.observation_datasets.sector IS '섹터';


--
-- Name: COLUMN observation_datasets.start_btjd; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.observation_datasets.start_btjd IS '시작(BTJD)';


--
-- Name: COLUMN observation_datasets.end_btjd; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.observation_datasets.end_btjd IS '끝(BTJD)';


--
-- Name: COLUMN observation_datasets.cadence; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.observation_datasets.cadence IS '촬영 간격';


--
-- Name: COLUMN observation_datasets.source_version; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.observation_datasets.source_version IS '원천 버전';


--
-- Name: COLUMN observation_datasets.time_system; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.observation_datasets.time_system IS '시간 체계';


--
-- Name: posts; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.posts (
    id bigint NOT NULL,
    kind text NOT NULL,
    user_id bigint,
    candidate_id bigint,
    board text NOT NULL,
    tic_id bigint,
    tag text,
    title text NOT NULL,
    body text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    author_withdrawn_at timestamp with time zone,
    CONSTRAINT posts_board_check CHECK ((board = ANY (ARRAY['star'::text, 'free'::text]))),
    CONSTRAINT posts_check CHECK ((((kind = 'user'::text) AND (user_id IS NOT NULL) AND (candidate_id IS NULL)) OR ((kind = 'system_thread'::text) AND (user_id IS NULL) AND (candidate_id IS NOT NULL) AND (tag IS NULL) AND (board = 'star'::text)))),
    CONSTRAINT posts_check1 CHECK ((((board = 'star'::text) AND (tic_id IS NOT NULL)) OR ((board = 'free'::text) AND (tic_id IS NULL)))),
    CONSTRAINT posts_kind_check CHECK ((kind = ANY (ARRAY['user'::text, 'system_thread'::text]))),
    CONSTRAINT posts_status_check CHECK ((status = ANY (ARRAY['visible'::text, 'hidden'::text, 'deleted'::text]))),
    CONSTRAINT posts_tag_check CHECK ((tag = ANY (ARRAY['ANALYSIS'::text, 'QUESTION'::text, 'DISCUSSION'::text, 'INFORMATION'::text, 'GENERAL'::text])))
);


ALTER TABLE public.posts OWNER TO planetory;

--
-- Name: TABLE posts; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.posts IS '커뮤니티 글. 회원 글과 후보별 공식 스레드를 함께 담는다';


--
-- Name: COLUMN posts.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.posts.id IS '고유 번호';


--
-- Name: COLUMN posts.kind; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.posts.kind IS 'user/system_thread';


--
-- Name: COLUMN posts.user_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.posts.user_id IS '작성자(system_thread는 NULL)';


--
-- Name: COLUMN posts.candidate_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.posts.candidate_id IS '공식 스레드의 신호';


--
-- Name: COLUMN posts.board; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.posts.board IS 'star/free';


--
-- Name: COLUMN posts.tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.posts.tic_id IS '별(free는 NULL)';


--
-- Name: COLUMN posts.tag; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.posts.tag IS '대표 태그';


--
-- Name: COLUMN posts.title; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.posts.title IS '제목';


--
-- Name: COLUMN posts.body; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.posts.body IS '본문';


--
-- Name: COLUMN posts.status; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.posts.status IS 'visible/hidden/deleted';


--
-- Name: COLUMN posts.created_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.posts.created_at IS '생성 시각';


--
-- Name: COLUMN posts.updated_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.posts.updated_at IS '수정 시각';


--
-- Name: published_analyses; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.published_analyses (
    id bigint NOT NULL,
    post_id bigint NOT NULL,
    user_id bigint NOT NULL,
    candidate_id bigint NOT NULL,
    history_id bigint NOT NULL,
    published_at timestamp with time zone NOT NULL,
    unpublished_at timestamp with time zone,
    hidden_at timestamp with time zone,
    withdrawn_at timestamp with time zone
);


ALTER TABLE public.published_analyses OWNER TO planetory;

--
-- Name: TABLE published_analyses; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.published_analyses IS '공식 스레드에 공개된 회원 분석';


--
-- Name: COLUMN published_analyses.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.published_analyses.id IS '고유 번호';


--
-- Name: COLUMN published_analyses.post_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.published_analyses.post_id IS '공식 스레드';


--
-- Name: COLUMN published_analyses.user_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.published_analyses.user_id IS '작성자';


--
-- Name: COLUMN published_analyses.candidate_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.published_analyses.candidate_id IS '신호';


--
-- Name: COLUMN published_analyses.history_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.published_analyses.history_id IS '본인 히스토리';


--
-- Name: COLUMN published_analyses.published_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.published_analyses.published_at IS '공개 시각';


--
-- Name: COLUMN published_analyses.unpublished_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.published_analyses.unpublished_at IS '본인 취소';


--
-- Name: COLUMN published_analyses.hidden_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.published_analyses.hidden_at IS '운영 숨김(DB 설정)';


--
-- Name: star_unlocks; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.star_unlocks (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    tic_id bigint NOT NULL,
    unlock_reason text NOT NULL,
    trigger_tic_id bigint,
    trigger_achievement_id bigint,
    seq smallint,
    generation smallint,
    angle_deg numeric,
    radius_jitter numeric,
    depth_z numeric NOT NULL,
    unlocked_at timestamp with time zone NOT NULL,
    world_x numeric NOT NULL,
    world_y numeric NOT NULL,
    layout_version text NOT NULL,
    layout_ordinal integer NOT NULL,
    CONSTRAINT ck_star_unlocks_depth_z_range CHECK (((depth_z >= ('-1'::integer)::numeric) AND (depth_z <= (1)::numeric))),
    CONSTRAINT ck_star_unlocks_layout_ordinal_range CHECK (((layout_ordinal >= 0) AND (layout_ordinal <= 2147483647))),
    CONSTRAINT ck_star_unlocks_layout_version_not_blank CHECK ((btrim(layout_version) <> ''::text)),
    CONSTRAINT ck_star_unlocks_world_x_finite CHECK (((world_x > '-Infinity'::numeric) AND (world_x < 'Infinity'::numeric))),
    CONSTRAINT ck_star_unlocks_world_y_finite CHECK (((world_y > '-Infinity'::numeric) AND (world_y < 'Infinity'::numeric))),
    CONSTRAINT star_unlocks_check CHECK (((unlock_reason <> 'achievement'::text) OR ((trigger_achievement_id IS NOT NULL) AND (seq IS NOT NULL)))),
    CONSTRAINT star_unlocks_seq_check CHECK ((seq >= 0)),
    CONSTRAINT star_unlocks_unlock_reason_check CHECK ((unlock_reason = ANY (ARRAY['tutorial'::text, 'achievement'::text, 'challenge'::text])))
);


ALTER TABLE public.star_unlocks OWNER TO planetory;

--
-- Name: TABLE star_unlocks; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.star_unlocks IS '회원이 연 별과 은하 지도상의 배치 좌표';


--
-- Name: COLUMN star_unlocks.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.id IS '고유 번호';


--
-- Name: COLUMN star_unlocks.user_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.user_id IS '회원';


--
-- Name: COLUMN star_unlocks.tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.tic_id IS '별';


--
-- Name: COLUMN star_unlocks.unlock_reason; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.unlock_reason IS 'tutorial/achievement/challenge';


--
-- Name: COLUMN star_unlocks.trigger_tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.trigger_tic_id IS '발견을 일으킨 별';


--
-- Name: COLUMN star_unlocks.trigger_achievement_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.trigger_achievement_id IS '원인 성과';


--
-- Name: COLUMN star_unlocks.seq; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.seq IS '한 성과가 연 별 중 순번';


--
-- Name: COLUMN star_unlocks.generation; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.generation IS '이전 배치 세대(폐기 예정)';


--
-- Name: COLUMN star_unlocks.angle_deg; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.angle_deg IS '이전 배치 각도(폐기 예정)';


--
-- Name: COLUMN star_unlocks.radius_jitter; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.radius_jitter IS '이전 배치 지터(폐기 예정)';


--
-- Name: COLUMN star_unlocks.depth_z; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.depth_z IS '월드 깊이(-1.0~1.0 정규화)';


--
-- Name: COLUMN star_unlocks.unlocked_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.unlocked_at IS '발견 시각';


--
-- Name: COLUMN star_unlocks.world_x; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.world_x IS '은하 월드 X';


--
-- Name: COLUMN star_unlocks.world_y; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.world_y IS '은하 월드 Y';


--
-- Name: COLUMN star_unlocks.layout_version; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.layout_version IS '배치 버전';


--
-- Name: COLUMN star_unlocks.layout_ordinal; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.star_unlocks.layout_ordinal IS '회원별 발견 순번(0부터) · 모든 발견 종류가 공유';


--
-- Name: stars; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.stars (
    tic_id bigint NOT NULL,
    teff_k numeric,
    radius_rsun numeric,
    tmag numeric,
    confirmed_count smallint NOT NULL,
    service_status text NOT NULL,
    board_open boolean DEFAULT false NOT NULL,
    CONSTRAINT stars_service_status_check CHECK ((service_status = ANY (ARRAY['hidden'::text, 'published'::text])))
);


ALTER TABLE public.stars OWNER TO planetory;

--
-- Name: TABLE stars; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.stars IS 'TESS 관측 대상 별의 기본 제원. tic_id가 별의 식별자다';


--
-- Name: COLUMN stars.tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.stars.tic_id IS '별(TIC)';


--
-- Name: COLUMN stars.teff_k; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.stars.teff_k IS '표면 온도(K)';


--
-- Name: COLUMN stars.radius_rsun; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.stars.radius_rsun IS '반지름(태양=1)';


--
-- Name: COLUMN stars.tmag; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.stars.tmag IS 'TESS 밝기 등급';


--
-- Name: COLUMN stars.confirmed_count; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.stars.confirmed_count IS '후보표의 확정 행성 수';


--
-- Name: COLUMN stars.service_status; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.stars.service_status IS 'hidden/published';


--
-- Name: submissions; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.submissions (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    tic_id bigint NOT NULL,
    bundle_id bigint NOT NULL,
    request_id uuid NOT NULL,
    submission_kind text NOT NULL,
    curve_step smallint NOT NULL,
    removed_candidate_ids bigint[] NOT NULL,
    submitted_period numeric,
    matched_period numeric,
    harmonic_multiplier numeric,
    phase_start numeric,
    phase_end numeric,
    fold_reference_time_btjd double precision NOT NULL,
    epoch_btjd numeric,
    duration_hours numeric,
    user_judgment text,
    evidence_checks jsonb NOT NULL,
    match_result text NOT NULL,
    matched_candidate_id bigint,
    achievement_result text NOT NULL,
    retry_of_submission_id bigint,
    answer_viewed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    correction_reason text,
    residual_model_version text NOT NULL,
    periodogram_config_version text NOT NULL,
    memo text,
    rule_version text NOT NULL,
    source_peak_grid_index integer,
    source_peak_suggested_duration_hours numeric,
    duration_limit_hours numeric,
    request_hash text,
    request_hash_version smallint,
    response_snapshot jsonb,
    detail_target_candidate_id bigint,
    CONSTRAINT ck_submission_request_hash CHECK ((((request_hash IS NULL) AND (request_hash_version IS NULL) AND (response_snapshot IS NULL)) OR ((request_hash IS NOT NULL) AND (request_hash ~ '^[0-9a-f]{64}$'::text) AND (request_hash_version IS NOT NULL) AND (request_hash_version = 1) AND ((response_snapshot IS NULL) OR (jsonb_typeof(response_snapshot) = 'object'::text))))),
    CONSTRAINT ck_submissions_achievement_matches_result CHECK ((((achievement_result = ANY (ARRAY['recognized'::text, 'judgment_mismatch'::text, 'pending_publish'::text])) AND (match_result = ANY (ARRAY['matched'::text, 'matched_harmonic'::text]))) OR ((achievement_result = 'already_recognized'::text) AND (match_result = 'duplicate'::text)) OR ((achievement_result = 'none'::text) AND (match_result <> ALL (ARRAY['matched'::text, 'matched_harmonic'::text, 'duplicate'::text]))))),
    CONSTRAINT ck_submissions_correction_only_for_harmonic CHECK ((((match_result = 'matched_harmonic'::text) AND (matched_period IS NOT NULL) AND (harmonic_multiplier IS NOT NULL)) OR ((match_result <> 'matched_harmonic'::text) AND (matched_period IS NULL) AND (harmonic_multiplier IS NULL) AND (correction_reason IS NULL)))),
    CONSTRAINT ck_submissions_derived_only_for_candidate CHECK (((submission_kind = 'candidate'::text) OR ((epoch_btjd IS NULL) AND (duration_hours IS NULL) AND (matched_period IS NULL)))),
    CONSTRAINT ck_submissions_source_peak_all_or_none CHECK ((((source_peak_grid_index IS NULL) AND (source_peak_suggested_duration_hours IS NULL) AND (duration_limit_hours IS NULL)) OR ((submission_kind = 'candidate'::text) AND (source_peak_grid_index IS NOT NULL) AND (source_peak_grid_index >= 0) AND (((source_peak_suggested_duration_hours IS NULL) AND (duration_limit_hours IS NULL)) OR ((source_peak_suggested_duration_hours IS NOT NULL) AND (duration_limit_hours IS NOT NULL) AND (source_peak_suggested_duration_hours > (0)::numeric) AND (source_peak_suggested_duration_hours < 'Infinity'::numeric) AND (duration_limit_hours > (0)::numeric) AND (duration_limit_hours < 'Infinity'::numeric)))))),
    CONSTRAINT submissions_achievement_result_check CHECK ((achievement_result = ANY (ARRAY['recognized'::text, 'judgment_mismatch'::text, 'pending_publish'::text, 'already_recognized'::text, 'none'::text]))),
    CONSTRAINT submissions_check CHECK (((phase_start >= (0)::numeric) AND (phase_start < (1)::numeric) AND (phase_end > phase_start) AND (phase_end < (phase_start + (1)::numeric)))),
    CONSTRAINT submissions_check1 CHECK ((((submission_kind = 'candidate'::text) AND (user_judgment IS NOT NULL) AND (submitted_period IS NOT NULL) AND (phase_start IS NOT NULL) AND (phase_end IS NOT NULL)) OR ((submission_kind <> 'candidate'::text) AND (user_judgment IS NULL)))),
    CONSTRAINT submissions_check2 CHECK ((((match_result = ANY (ARRAY['matched'::text, 'matched_harmonic'::text, 'duplicate'::text])) AND (matched_candidate_id IS NOT NULL)) OR ((match_result <> ALL (ARRAY['matched'::text, 'matched_harmonic'::text, 'duplicate'::text])) AND (matched_candidate_id IS NULL)))),
    CONSTRAINT submissions_match_result_check CHECK ((match_result = ANY (ARRAY['matched'::text, 'matched_harmonic'::text, 'not_matched'::text, 'duplicate'::text, 'ambiguous_match'::text, 'none_wrong'::text, 'skipped'::text]))),
    CONSTRAINT submissions_submission_kind_check CHECK ((submission_kind = ANY (ARRAY['candidate'::text, 'no_candidate'::text, 'skipped'::text]))),
    CONSTRAINT submissions_user_judgment_check CHECK ((user_judgment = ANY (ARRAY['LIKELY_PLANET'::text, 'UNLIKELY_PLANET'::text, 'UNSURE'::text])))
);


ALTER TABLE public.submissions OWNER TO planetory;

--
-- Name: TABLE submissions; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.submissions IS '회원의 후보 판정 제출. 채점 결과와 판정 근거를 함께 남기는 핵심 기록이다';


--
-- Name: COLUMN submissions.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.id IS '고유 번호 · 동률 순서';


--
-- Name: COLUMN submissions.user_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.user_id IS '회원';


--
-- Name: COLUMN submissions.tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.tic_id IS '별';


--
-- Name: COLUMN submissions.bundle_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.bundle_id IS '판정 당시 판';


--
-- Name: COLUMN submissions.request_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.request_id IS '멱등 요청 ID';


--
-- Name: COLUMN submissions.submission_kind; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.submission_kind IS 'candidate/no_candidate/skipped';


--
-- Name: COLUMN submissions.curve_step; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.curve_step IS '곡선 단계';


--
-- Name: COLUMN submissions.removed_candidate_ids; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.removed_candidate_ids IS '뺀 후보(정렬)';


--
-- Name: COLUMN submissions.submitted_period; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.submitted_period IS '제출 주기';


--
-- Name: COLUMN submissions.matched_period; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.matched_period IS '정정 대표 주기';


--
-- Name: COLUMN submissions.harmonic_multiplier; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.harmonic_multiplier IS '배율';


--
-- Name: COLUMN submissions.phase_start; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.phase_start IS '위상 시작';


--
-- Name: COLUMN submissions.phase_end; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.phase_end IS '위상 끝';


--
-- Name: COLUMN submissions.fold_reference_time_btjd; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.fold_reference_time_btjd IS '그때 기준 시각';


--
-- Name: COLUMN submissions.epoch_btjd; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.epoch_btjd IS '서버 파생 epoch';


--
-- Name: COLUMN submissions.duration_hours; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.duration_hours IS '서버 파생 지속시간';


--
-- Name: COLUMN submissions.user_judgment; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.user_judgment IS 'LIKELY/UNLIKELY/UNSURE';


--
-- Name: COLUMN submissions.evidence_checks; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.evidence_checks IS '근거 3종';


--
-- Name: COLUMN submissions.match_result; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.match_result IS '판정 결과';


--
-- Name: COLUMN submissions.matched_candidate_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.matched_candidate_id IS '일치 후보';


--
-- Name: COLUMN submissions.achievement_result; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.achievement_result IS '성과 결과';


--
-- Name: COLUMN submissions.retry_of_submission_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.retry_of_submission_id IS '재도전 원 제출';


--
-- Name: COLUMN submissions.answer_viewed; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.answer_viewed IS '상세 열람';


--
-- Name: COLUMN submissions.created_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.created_at IS '접수 시각';


--
-- Name: COLUMN submissions.correction_reason; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.correction_reason IS '정정 사유';


--
-- Name: COLUMN submissions.residual_model_version; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.residual_model_version IS '잔차 모델 버전';


--
-- Name: COLUMN submissions.periodogram_config_version; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.periodogram_config_version IS '주기도 설정 버전';


--
-- Name: COLUMN submissions.memo; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.memo IS '분석 메모';


--
-- Name: COLUMN submissions.rule_version; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.rule_version IS '판정 규칙 버전';


--
-- Name: COLUMN submissions.source_peak_grid_index; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.source_peak_grid_index IS '선택 봉우리 · 직접 선택은 NULL';


--
-- Name: COLUMN submissions.source_peak_suggested_duration_hours; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.source_peak_suggested_duration_hours IS '검증에 쓴 제안값';


--
-- Name: COLUMN submissions.duration_limit_hours; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.duration_limit_hours IS '적용한 선택 폭 상한';


--
-- Name: COLUMN submissions.request_hash; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.request_hash IS '경로 TIC + 정규화 요청 SHA-256';


--
-- Name: COLUMN submissions.request_hash_version; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.request_hash_version IS '정규화 규칙 버전. 기존 행은 NULL';


--
-- Name: COLUMN submissions.response_snapshot; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.response_snapshot IS '최초 성공 POST 본문. 같은 트랜잭션에서 저장, 재전송 때 재현';


--
-- Name: COLUMN submissions.detail_target_candidate_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.submissions.detail_target_candidate_id IS '상세 보기에서 처음 연 신호. 한 번 정하면 바꾸지 않는다(탐사 API 6.7절)';


--
-- Name: user_candidate_achievements; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.user_candidate_achievements (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    candidate_id bigint NOT NULL,
    achievement_type text NOT NULL,
    recognized_submission_id bigint NOT NULL,
    recognized_analysis_id bigint,
    recognized_at timestamp with time zone NOT NULL,
    relabeled_at timestamp with time zone,
    relabel_disposition text,
    CONSTRAINT user_candidate_achievements_achievement_type_check CHECK ((achievement_type = ANY (ARRAY['confirmed'::text, 'unconfirmed'::text, 'fp'::text])))
);


ALTER TABLE public.user_candidate_achievements OWNER TO planetory;

--
-- Name: TABLE user_candidate_achievements; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.user_candidate_achievements IS '회원이 후보에 대해 인정받은 성과';


--
-- Name: COLUMN user_candidate_achievements.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_candidate_achievements.id IS '고유 번호';


--
-- Name: COLUMN user_candidate_achievements.user_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_candidate_achievements.user_id IS '회원';


--
-- Name: COLUMN user_candidate_achievements.candidate_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_candidate_achievements.candidate_id IS '후보';


--
-- Name: COLUMN user_candidate_achievements.achievement_type; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_candidate_achievements.achievement_type IS 'confirmed/unconfirmed/fp';


--
-- Name: COLUMN user_candidate_achievements.recognized_submission_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_candidate_achievements.recognized_submission_id IS '근거 제출';


--
-- Name: COLUMN user_candidate_achievements.recognized_analysis_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_candidate_achievements.recognized_analysis_id IS '근거 공개 분석(미확정)';


--
-- Name: COLUMN user_candidate_achievements.recognized_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_candidate_achievements.recognized_at IS '인정 시각';


--
-- Name: COLUMN user_candidate_achievements.relabeled_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_candidate_achievements.relabeled_at IS '라벨 갱신 표식';


--
-- Name: COLUMN user_candidate_achievements.relabel_disposition; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_candidate_achievements.relabel_disposition IS '라벨 갱신 표식';


--
-- Name: user_star_progress; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.user_star_progress (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    tic_id bigint NOT NULL,
    planet_count smallint DEFAULT 0 NOT NULL,
    achievement_count smallint DEFAULT 0 NOT NULL,
    fp_success boolean DEFAULT false NOT NULL,
    progress_stage text DEFAULT 'unexplored'::text NOT NULL,
    current_curve_step smallint DEFAULT 0 NOT NULL,
    completion_reason text,
    reopen_pending boolean DEFAULT false NOT NULL,
    completed_at timestamp with time zone,
    reopened_at timestamp with time zone,
    CONSTRAINT user_star_progress_completion_reason_check CHECK ((completion_reason = ANY (ARRAY['all_found'::text, 'undiscoverable_only'::text, 'skipped'::text]))),
    CONSTRAINT user_star_progress_progress_stage_check CHECK ((progress_stage = ANY (ARRAY['unexplored'::text, 'in_progress'::text, 'completed'::text])))
);


ALTER TABLE public.user_star_progress OWNER TO planetory;

--
-- Name: TABLE user_star_progress; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.user_star_progress IS '회원의 별 단위 탐색 진행도와 완료 사유';


--
-- Name: COLUMN user_star_progress.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_star_progress.id IS '고유 번호';


--
-- Name: COLUMN user_star_progress.user_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_star_progress.user_id IS '회원';


--
-- Name: COLUMN user_star_progress.tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_star_progress.tic_id IS '별';


--
-- Name: COLUMN user_star_progress.planet_count; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_star_progress.planet_count IS '찾은 행성 수(색·궤도)';


--
-- Name: COLUMN user_star_progress.achievement_count; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_star_progress.achievement_count IS '성과 수(등급 문자)';


--
-- Name: COLUMN user_star_progress.fp_success; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_star_progress.fp_success IS 'FP 판단 성공 있음';


--
-- Name: COLUMN user_star_progress.progress_stage; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_star_progress.progress_stage IS 'unexplored/in_progress/completed';


--
-- Name: COLUMN user_star_progress.current_curve_step; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_star_progress.current_curve_step IS '현재 곡선 단계';


--
-- Name: COLUMN user_star_progress.completion_reason; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_star_progress.completion_reason IS 'all_found/undiscoverable_only/skipped';


--
-- Name: COLUMN user_star_progress.reopen_pending; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_star_progress.reopen_pending IS '재개 대기';


--
-- Name: COLUMN user_star_progress.completed_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_star_progress.completed_at IS '완료 시각';


--
-- Name: COLUMN user_star_progress.reopened_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_star_progress.reopened_at IS '재개 시각';


--
-- Name: users; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.users (
    id bigint NOT NULL,
    provider text NOT NULL,
    provider_user_id text NOT NULL,
    nickname text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    withdrawn_at timestamp with time zone,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['member'::text, 'operator'::text]))),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'withdrawn'::text])))
);


ALTER TABLE public.users OWNER TO planetory;

--
-- Name: TABLE users; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.users IS '회원 계정. OAuth 제공자와 제공자 쪽 ID 조합으로 식별한다';


--
-- Name: COLUMN users.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.users.id IS '고유 번호';


--
-- Name: COLUMN users.provider; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.users.provider IS '로그인 제공자 · ssafy/google';


--
-- Name: COLUMN users.provider_user_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.users.provider_user_id IS '제공자 쪽 회원 ID';


--
-- Name: COLUMN users.nickname; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.users.nickname IS '닉네임(상시 변경)';


--
-- Name: COLUMN users.role; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.users.role IS 'member/operator';


--
-- Name: COLUMN users.status; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.users.status IS 'active/withdrawn';


--
-- Name: COLUMN users.created_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.users.created_at IS '생성 시각';


--
-- Name: COLUMN users.withdrawn_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.users.withdrawn_at IS '탈퇴 시각';


--
-- Name: global_stats; Type: MATERIALIZED VIEW; Schema: public; Owner: planetory
--

CREATE MATERIALIZED VIEW public.global_stats AS
 WITH active_members AS MATERIALIZED (
         SELECT users.id
           FROM public.users
          WHERE (users.status = 'active'::text)
        ), s AS MATERIALIZED (
         SELECT s.id,
            s.user_id,
            s.tic_id,
            s.created_at,
            s.match_result,
            s.matched_candidate_id,
            s.user_judgment
           FROM (public.submissions s
             JOIN active_members u ON ((u.id = s.user_id)))
        ), unlocks AS MATERIALIZED (
         SELECT su.id,
            su.user_id,
            su.tic_id,
            su.unlock_reason,
            su.trigger_tic_id,
            su.trigger_achievement_id,
            su.seq,
            su.generation,
            su.angle_deg,
            su.radius_jitter,
            su.depth_z,
            su.unlocked_at,
            su.world_x,
            su.world_y,
            su.layout_version,
            su.layout_ordinal
           FROM (public.star_unlocks su
             JOIN active_members u ON ((u.id = su.user_id)))
        ), progress AS MATERIALIZED (
         SELECT p.id,
            p.user_id,
            p.tic_id,
            p.planet_count,
            p.achievement_count,
            p.fp_success,
            p.progress_stage,
            p.current_curve_step,
            p.completion_reason,
            p.reopen_pending,
            p.completed_at,
            p.reopened_at
           FROM (public.user_star_progress p
             JOIN active_members u ON ((u.id = p.user_id)))
        ), achievements AS MATERIALIZED (
         SELECT a.id,
            a.user_id,
            a.candidate_id,
            a.achievement_type,
            a.recognized_submission_id,
            a.recognized_analysis_id,
            a.recognized_at,
            a.relabeled_at,
            a.relabel_disposition
           FROM (public.user_candidate_achievements a
             JOIN active_members u ON ((u.id = a.user_id)))
        ), first_matches AS (
         SELECT DISTINCT ON (s.user_id, s.matched_candidate_id) s.user_id,
            s.matched_candidate_id,
            s.user_judgment
           FROM s
          WHERE (s.match_result = ANY (ARRAY['matched'::text, 'matched_harmonic'::text]))
          ORDER BY s.user_id, s.matched_candidate_id, s.created_at, s.id
        ), graded AS MATERIALIZED (
         SELECT f.user_id,
            f.matched_candidate_id,
            f.user_judgment,
            (((d.planet_truth = 'planet'::text) AND (f.user_judgment = 'LIKELY_PLANET'::text)) OR ((d.planet_truth = 'not_planet'::text) AND (f.user_judgment = 'UNLIKELY_PLANET'::text))) AS agrees
           FROM (first_matches f
             JOIN public.candidate_dispositions d ON ((d.candidate_id = f.matched_candidate_id)))
          WHERE (d.answer_class = 'graded'::text)
        ), public_votes AS MATERIALIZED (
         SELECT DISTINCT ON (s.user_id, pa.candidate_id) s.user_id,
            pa.candidate_id,
            s.tic_id,
            s.user_judgment
           FROM (((public.published_analyses pa
             JOIN public.posts p ON ((p.id = pa.post_id)))
             JOIN public.analysis_histories h ON ((h.id = pa.history_id)))
             JOIN s ON ((s.id = h.submission_id)))
          WHERE ((pa.unpublished_at IS NULL) AND (pa.hidden_at IS NULL) AND (p.kind = 'system_thread'::text) AND (p.status = 'visible'::text))
          ORDER BY s.user_id, pa.candidate_id, s.created_at DESC, s.id DESC
        ), counts(key, unit, numerator, denominator, scale) AS (
         SELECT 'discoveredStars'::text AS "?column?",
            'STAR'::text AS "?column?",
            count(*) AS count,
            NULL::bigint AS int8,
            1 AS "?column?"
           FROM unlocks
        UNION ALL
         SELECT 'uniqueDiscoveredStars'::text,
            'STAR'::text,
            count(DISTINCT unlocks.tic_id) AS count,
            NULL::bigint,
            1
           FROM unlocks
        UNION ALL
         SELECT 'startedStars'::text,
            'STAR'::text,
            count(DISTINCT ROW(s.user_id, s.tic_id)) AS count,
            NULL::bigint,
            1
           FROM s
        UNION ALL
         SELECT 'currentCompletedStars'::text,
            'STAR'::text,
            count(*) AS count,
            NULL::bigint,
            1
           FROM progress
          WHERE (progress.progress_stage = 'completed'::text)
        UNION ALL
         SELECT 'uniqueCurrentCompletedStars'::text,
            'STAR'::text,
            count(DISTINCT progress.tic_id) AS count,
            NULL::bigint,
            1
           FROM progress
          WHERE (progress.progress_stage = 'completed'::text)
        UNION ALL
         SELECT 'recognizedSignals'::text,
            'ACHIEVEMENT'::text,
            count(*) AS count,
            NULL::bigint,
            1
           FROM achievements
        UNION ALL
         SELECT 'confirmedAchievements'::text,
            'ACHIEVEMENT'::text,
            count(*) AS count,
            NULL::bigint,
            1
           FROM achievements
          WHERE (achievements.achievement_type = 'confirmed'::text)
        UNION ALL
         SELECT 'unconfirmedAchievements'::text,
            'ACHIEVEMENT'::text,
            count(*) AS count,
            NULL::bigint,
            1
           FROM achievements
          WHERE (achievements.achievement_type = 'unconfirmed'::text)
        UNION ALL
         SELECT 'fpAchievements'::text,
            'ACHIEVEMENT'::text,
            count(*) AS count,
            NULL::bigint,
            1
           FROM achievements
          WHERE (achievements.achievement_type = 'fp'::text)
        UNION ALL
         SELECT 'uniqueRecognizedSignals'::text,
            'SIGNAL'::text,
            count(DISTINCT achievements.candidate_id) AS count,
            NULL::bigint,
            1
           FROM achievements
        UNION ALL
         SELECT 'uniqueConfirmedSignals'::text,
            'SIGNAL'::text,
            count(DISTINCT a.candidate_id) AS count,
            NULL::bigint,
            1
           FROM (achievements a
             JOIN public.candidate_dispositions d ON ((d.candidate_id = a.candidate_id)))
          WHERE (d.disposition = 'confirmed'::text)
        UNION ALL
         SELECT 'uniqueFpSignals'::text,
            'SIGNAL'::text,
            count(DISTINCT a.candidate_id) AS count,
            NULL::bigint,
            1
           FROM (achievements a
             JOIN public.candidate_dispositions d ON ((d.candidate_id = a.candidate_id)))
          WHERE (d.disposition = 'fp'::text)
        UNION ALL
         SELECT 'uniqueUnconfirmedSignals'::text,
            'SIGNAL'::text,
            count(DISTINCT a.candidate_id) AS count,
            NULL::bigint,
            1
           FROM (achievements a
             JOIN public.candidate_dispositions d ON ((d.candidate_id = a.candidate_id)))
          WHERE (d.disposition = ANY (ARRAY['pc'::text, 'none'::text]))
        UNION ALL
         SELECT 'firstMatchAccuracy'::text,
            'PERCENT'::text,
            count(*) FILTER (WHERE graded.agrees) AS count,
            count(*) AS count,
            100
           FROM graded
        UNION ALL
         SELECT 'publicLikelyPlanet'::text,
            'PARTICIPATION'::text,
            count(*) FILTER (WHERE (public_votes.user_judgment = 'LIKELY_PLANET'::text)) AS count,
            NULL::bigint,
            1
           FROM public_votes
        UNION ALL
         SELECT 'publicUnlikelyPlanet'::text,
            'PARTICIPATION'::text,
            count(*) FILTER (WHERE (public_votes.user_judgment = 'UNLIKELY_PLANET'::text)) AS count,
            NULL::bigint,
            1
           FROM public_votes
        UNION ALL
         SELECT 'publicUnsure'::text,
            'PARTICIPATION'::text,
            count(*) FILTER (WHERE (public_votes.user_judgment = 'UNSURE'::text)) AS count,
            NULL::bigint,
            1
           FROM public_votes
        UNION ALL
         SELECT 'publicLikelyPlanetRate'::text,
            'PERCENT'::text,
            count(*) FILTER (WHERE (public_votes.user_judgment = 'LIKELY_PLANET'::text)) AS count,
            count(*) AS count,
            100
           FROM public_votes
        UNION ALL
         SELECT 'publicUnlikelyPlanetRate'::text,
            'PERCENT'::text,
            count(*) FILTER (WHERE (public_votes.user_judgment = 'UNLIKELY_PLANET'::text)) AS count,
            count(*) AS count,
            100
           FROM public_votes
        UNION ALL
         SELECT 'publicUnsureRate'::text,
            'PERCENT'::text,
            count(*) FILTER (WHERE (public_votes.user_judgment = 'UNSURE'::text)) AS count,
            count(*) AS count,
            100
           FROM public_votes
        UNION ALL
         SELECT 'publicParticipations'::text,
            'PARTICIPATION'::text,
            count(*) AS count,
            NULL::bigint,
            1
           FROM public_votes
        UNION ALL
         SELECT 'aiAttemptUnknown'::text,
            'PARTICIPATION'::text,
            count(*) AS count,
            NULL::bigint,
            1
           FROM public_votes
        ), metric_values AS MATERIALIZED (
         SELECT jsonb_object_agg(counts.key, jsonb_build_object('unit', counts.unit, 'value',
                CASE
                    WHEN (counts.denominator IS NULL) THEN (counts.numerator)::numeric
                    ELSE (((counts.numerator)::numeric * (counts.scale)::numeric) / (NULLIF(counts.denominator, 0))::numeric)
                END, 'numerator', counts.numerator, 'denominator', counts.denominator, 'status',
                CASE
                    WHEN (counts.denominator = 0) THEN 'NO_SAMPLE'::text
                    ELSE 'AVAILABLE'::text
                END, 'reason',
                CASE
                    WHEN (counts.key = 'aiAttemptUnknown'::text) THEN 'AI_ATTEMPT_UNKNOWN'::text
                    WHEN (counts.denominator = 0) THEN 'ZERO_DENOMINATOR'::text
                    ELSE NULL::text
                END)) AS metrics
           FROM counts
        ), weekly AS (
         SELECT (w.week)::date AS week_start,
            count(s.id) AS submissions
           FROM (generate_series((date_trunc('week'::text, (statement_timestamp() AT TIME ZONE 'Asia/Seoul'::text)) - '49 days'::interval), date_trunc('week'::text, (statement_timestamp() AT TIME ZONE 'Asia/Seoul'::text)), '7 days'::interval) w(week)
             LEFT JOIN s ON (((s.created_at >= (w.week AT TIME ZONE 'Asia/Seoul'::text)) AND (s.created_at < ((w.week + '7 days'::interval) AT TIME ZONE 'Asia/Seoul'::text)))))
          GROUP BY w.week
        ), top_stars AS (
         SELECT p.tic_id,
            count(*) AS count
           FROM (public.posts p
             JOIN public.stars st ON (((st.tic_id = p.tic_id) AND (st.service_status = 'published'::text))))
          WHERE ((p.board = 'star'::text) AND (p.status = 'visible'::text) AND (EXISTS ( SELECT 1
                   FROM unlocks u
                  WHERE (u.tic_id = p.tic_id))) AND ((p.kind = 'system_thread'::text) OR (EXISTS ( SELECT 1
                   FROM active_members u
                  WHERE (u.id = p.user_id)))))
          GROUP BY p.tic_id
          ORDER BY (count(*)) DESC, p.tic_id
         LIMIT 5
        ), sectors AS (
         SELECT d.sector,
            count(*) AS denominator,
            count(*) FILTER (WHERE (p.progress_stage = 'completed'::text)) AS numerator
           FROM ((( SELECT DISTINCT observation_datasets.sector,
                    observation_datasets.tic_id
                   FROM public.observation_datasets) d
             JOIN unlocks u ON ((u.tic_id = d.tic_id)))
             LEFT JOIN progress p ON (((p.user_id = u.user_id) AND (p.tic_id = u.tic_id))))
          GROUP BY d.sector
        ), rounds AS (
         SELECT r.id,
            r.round_no,
            count(DISTINCT p.user_id) AS members,
            count(p.user_id) AS participations,
            count(*) FILTER (WHERE (p.user_judgment = 'LIKELY_PLANET'::text)) AS likely,
            count(*) FILTER (WHERE (p.user_judgment = 'UNLIKELY_PLANET'::text)) AS unlikely,
            count(*) FILTER (WHERE (p.user_judgment = 'UNSURE'::text)) AS unsure
           FROM ((public.challenge_rounds r
             LEFT JOIN public.challenge_round_targets t ON ((t.round_id = r.id)))
             LEFT JOIN public_votes p ON ((p.tic_id = t.tic_id)))
          WHERE (r.status = 'active'::text)
          GROUP BY r.id, r.round_no
        ), payload AS MATERIALIZED (
         SELECT m.metrics,
            COALESCE(( SELECT jsonb_agg(jsonb_build_object('weekStart', weekly.week_start, 'submissions', weekly.submissions, 'partial', (weekly.week_start = (date_trunc('week'::text, (statement_timestamp() AT TIME ZONE 'Asia/Seoul'::text)))::date)) ORDER BY weekly.week_start) AS jsonb_agg
                   FROM weekly), '[]'::jsonb) AS weekly_submissions,
            COALESCE(( SELECT jsonb_agg(jsonb_build_object('ticId', (top_stars.tic_id)::text, 'postCount', top_stars.count) ORDER BY top_stars.count DESC, top_stars.tic_id) AS jsonb_agg
                   FROM top_stars), '[]'::jsonb) AS most_posts_stars,
            COALESCE(( SELECT jsonb_agg(jsonb_build_object('sector', sectors.sector, 'unit', 'PERCENT', 'numerator', sectors.numerator, 'denominator', sectors.denominator, 'value', ((100.0 * (sectors.numerator)::numeric) / (NULLIF(sectors.denominator, 0))::numeric), 'status',
                        CASE
                            WHEN (sectors.denominator = 0) THEN 'NO_SAMPLE'::text
                            ELSE 'AVAILABLE'::text
                        END) ORDER BY sectors.sector) AS jsonb_agg
                   FROM sectors), '[]'::jsonb) AS sector_completion,
            COALESCE(( SELECT jsonb_agg(jsonb_build_object('roundId', (rounds.id)::text, 'roundNo', rounds.round_no, 'participantCount', rounds.members, 'participationCount', rounds.participations, 'likelyPlanet', rounds.likely, 'unlikelyPlanet', rounds.unlikely, 'unsure', rounds.unsure) ORDER BY rounds.round_no) AS jsonb_agg
                   FROM rounds), '[]'::jsonb) AS challenges
           FROM metric_values m
        )
 SELECT 1 AS singleton,
    statement_timestamp() AS as_of,
    clock_timestamp() AS generated_at,
    jsonb_build_object('metrics', metrics, 'weeklySubmissions', weekly_submissions, 'mostPostsStars', most_posts_stars, 'sectorCompletion', sector_completion, 'challenges', challenges, 'aiJudgmentBands', jsonb_build_object('status', 'NO_SAMPLE', 'reason', 'AI_ATTEMPT_UNKNOWN', 'items', '[]'::jsonb)) AS payload
   FROM payload
  WITH NO DATA;


ALTER MATERIALIZED VIEW public.global_stats OWNER TO planetory;

--
-- Name: light_curve_segments; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.light_curve_segments (
    id bigint NOT NULL,
    tic_id bigint NOT NULL,
    sector smallint NOT NULL,
    binning_revision text NOT NULL,
    start_btjd double precision NOT NULL,
    bin_minutes numeric NOT NULL,
    n_points integer NOT NULL,
    flux real[] NOT NULL,
    flux_scatter numeric,
    gaps jsonb NOT NULL,
    CONSTRAINT ck_light_curve_segments_flux_finite_or_null CHECK (((array_position(flux, 'NaN'::real) IS NULL) AND (array_position(flux, 'Infinity'::real) IS NULL) AND (array_position(flux, '-Infinity'::real) IS NULL))),
    CONSTRAINT light_curve_segments_bin_minutes_check CHECK ((bin_minutes > (0)::numeric)),
    CONSTRAINT light_curve_segments_check CHECK (((n_points > 0) AND (array_ndims(flux) = 1) AND (cardinality(flux) = n_points)))
);


ALTER TABLE public.light_curve_segments OWNER TO planetory;

--
-- Name: TABLE light_curve_segments; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.light_curve_segments IS '별의 섹터별 광도 곡선을 비닝한 배열. 분석 화면이 읽는 원천 데이터다';


--
-- Name: COLUMN light_curve_segments.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.light_curve_segments.id IS '고유 번호';


--
-- Name: COLUMN light_curve_segments.tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.light_curve_segments.tic_id IS '별';


--
-- Name: COLUMN light_curve_segments.sector; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.light_curve_segments.sector IS '섹터';


--
-- Name: COLUMN light_curve_segments.binning_revision; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.light_curve_segments.binning_revision IS '원천·전처리·비닝 설정 버전';


--
-- Name: COLUMN light_curve_segments.start_btjd; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.light_curve_segments.start_btjd IS '첫 점 시각';


--
-- Name: COLUMN light_curve_segments.bin_minutes; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.light_curve_segments.bin_minutes IS '비닝 간격(분)';


--
-- Name: COLUMN light_curve_segments.n_points; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.light_curve_segments.n_points IS '점 수';


--
-- Name: COLUMN light_curve_segments.flux; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.light_curve_segments.flux IS '정규화 밝기 배열';


--
-- Name: COLUMN light_curve_segments.flux_scatter; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.light_curve_segments.flux_scatter IS '점간 산포(오차 대표값)';


--
-- Name: COLUMN light_curve_segments.gaps; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.light_curve_segments.gaps IS '빈 구간 인덱스';


--
-- Name: light_curve_segments_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.light_curve_segments ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.light_curve_segments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: member_sky_revisions; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.member_sky_revisions (
    user_id bigint NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT member_sky_revisions_revision_check CHECK ((revision > 0))
);


ALTER TABLE public.member_sky_revisions OWNER TO planetory;

--
-- Name: TABLE member_sky_revisions; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.member_sky_revisions IS '회원 지도의 단조 증가 개정값. 발견·상태 변경과 같은 트랜잭션에서 올린다';


--
-- Name: COLUMN member_sky_revisions.revision; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.member_sky_revisions.revision IS '단조 증가 개정값. 같은 시각의 변경도 구분한다';


--
-- Name: nasa_explanation_daily_total; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.nasa_explanation_daily_total (
    usage_day date NOT NULL,
    attempt_count integer NOT NULL,
    CONSTRAINT nasa_explanation_daily_total_attempt_count_check CHECK ((attempt_count > 0))
);


ALTER TABLE public.nasa_explanation_daily_total OWNER TO planetory;

--
-- Name: TABLE nasa_explanation_daily_total; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.nasa_explanation_daily_total IS '268: 탈퇴와 무관하게 유지하는 UTC 날짜별 전체 모델 생성 시도권';


--
-- Name: nasa_explanation_daily_usage; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.nasa_explanation_daily_usage (
    usage_day date NOT NULL,
    member_id bigint NOT NULL,
    attempt_count integer NOT NULL,
    CONSTRAINT nasa_explanation_daily_usage_attempt_count_check CHECK ((attempt_count > 0))
);


ALTER TABLE public.nasa_explanation_daily_usage OWNER TO planetory;

--
-- Name: TABLE nasa_explanation_daily_usage; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.nasa_explanation_daily_usage IS '268: UTC 날짜와 회원별 모델 생성 시도권';


--
-- Name: nasa_planet_explanation; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.nasa_planet_explanation (
    candidate_id bigint NOT NULL,
    source_hash text NOT NULL,
    source_version smallint NOT NULL,
    model_name text NOT NULL,
    prompt_version text NOT NULL,
    status text NOT NULL,
    content jsonb,
    generated_at timestamp with time zone,
    last_attempt_at timestamp with time zone NOT NULL,
    next_retry_at timestamp with time zone NOT NULL,
    in_flight_until timestamp with time zone,
    attempt_generation bigint DEFAULT 1 NOT NULL,
    attempt_count smallint DEFAULT 1 NOT NULL,
    last_failure text,
    CONSTRAINT nasa_planet_explanation_attempt_count_check CHECK (((attempt_count >= 1) AND (attempt_count <= 3))),
    CONSTRAINT nasa_planet_explanation_attempt_generation_check CHECK ((attempt_generation > 0)),
    CONSTRAINT nasa_planet_explanation_check CHECK (((status = 'ready'::text) = ((content IS NOT NULL) AND (generated_at IS NOT NULL)))),
    CONSTRAINT nasa_planet_explanation_check1 CHECK (((status <> 'ready'::text) OR (in_flight_until IS NULL))),
    CONSTRAINT nasa_planet_explanation_model_name_check CHECK ((model_name <> ''::text)),
    CONSTRAINT nasa_planet_explanation_prompt_version_check CHECK ((prompt_version <> ''::text)),
    CONSTRAINT nasa_planet_explanation_source_version_check CHECK ((source_version > 0)),
    CONSTRAINT nasa_planet_explanation_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text])))
);


ALTER TABLE public.nasa_planet_explanation OWNER TO planetory;

--
-- Name: TABLE nasa_planet_explanation; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.nasa_planet_explanation IS '267: V25의 현재 정상 원천 해시·버전에 묶인 한국어 설명';


--
-- Name: COLUMN nasa_planet_explanation.attempt_generation; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.nasa_planet_explanation.attempt_generation IS '설명 생성 임대 순번. 늦게 끝난 모델 응답의 저장을 막는다';


--
-- Name: COLUMN nasa_planet_explanation.attempt_count; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.nasa_planet_explanation.attempt_count IS '같은 원천·모델·프롬프트 조합의 최대 생성 시도 3회';


--
-- Name: nasa_planet_info; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.nasa_planet_info (
    candidate_id bigint NOT NULL,
    tic_id bigint NOT NULL,
    archive_planet_name text NOT NULL,
    status text NOT NULL,
    normalized jsonb,
    source_hash text,
    source_version smallint,
    fetched_at timestamp with time zone,
    changed_at timestamp with time zone,
    last_attempt_at timestamp with time zone NOT NULL,
    next_refresh_at timestamp with time zone NOT NULL,
    in_flight_until timestamp with time zone,
    attempt_generation bigint DEFAULT 1 NOT NULL,
    last_refresh_status text NOT NULL,
    CONSTRAINT nasa_planet_info_archive_planet_name_check CHECK ((archive_planet_name <> ''::text)),
    CONSTRAINT nasa_planet_info_attempt_generation_check CHECK ((attempt_generation > 0)),
    CONSTRAINT nasa_planet_info_check CHECK ((((normalized IS NULL) AND (source_hash IS NULL) AND (source_version IS NULL) AND (fetched_at IS NULL)) OR ((normalized IS NOT NULL) AND (source_hash IS NOT NULL) AND (source_version IS NOT NULL) AND (fetched_at IS NOT NULL)))),
    CONSTRAINT nasa_planet_info_check1 CHECK (((status <> 'ready'::text) OR (normalized IS NOT NULL))),
    CONSTRAINT nasa_planet_info_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'not_found'::text, 'identity_unresolved'::text, 'temporarily_unavailable'::text])))
);


ALTER TABLE public.nasa_planet_info OWNER TO planetory;

--
-- Name: TABLE nasa_planet_info; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.nasa_planet_info IS '266: 회원 요청으로 조회한 NASA PS 기본 해. Gold 판정과 독립';


--
-- Name: COLUMN nasa_planet_info.normalized; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.nasa_planet_info.normalized IS 'ps-default-v1 정규화값, 단위·오차·상하한·필드 출처 포함';


--
-- Name: COLUMN nasa_planet_info.source_hash; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.nasa_planet_info.source_hash IS '정규화 JSON의 SHA-256 hex. 같은 원본 재확인은 changed_at을 유지';


--
-- Name: COLUMN nasa_planet_info.attempt_generation; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.nasa_planet_info.attempt_generation IS '조회 시도 순번. 늦게 끝난 시도의 저장을 막는다';


--
-- Name: nasa_star_catalog; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.nasa_star_catalog (
    tic_id bigint NOT NULL,
    status text NOT NULL,
    host_name text,
    fetched_at timestamp with time zone,
    next_refresh_at timestamp with time zone NOT NULL,
    in_flight_until timestamp with time zone,
    attempt_generation bigint DEFAULT 1 NOT NULL,
    last_refresh_status text NOT NULL,
    CONSTRAINT nasa_star_catalog_attempt_generation_check CHECK ((attempt_generation > 0)),
    CONSTRAINT nasa_star_catalog_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'empty'::text, 'partial'::text, 'temporarily_unavailable'::text])))
);


ALTER TABLE public.nasa_star_catalog OWNER TO planetory;

--
-- Name: TABLE nasa_star_catalog; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.nasa_star_catalog IS '270: TIC별 NASA PS 기본 해 목록의 완전 조회와 갱신 임대';


--
-- Name: COLUMN nasa_star_catalog.attempt_generation; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.nasa_star_catalog.attempt_generation IS '늦게 끝난 NASA 조회의 목록 덮어쓰기를 막는다';


--
-- Name: nasa_star_planet; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.nasa_star_planet (
    tic_id bigint NOT NULL,
    planet_id text NOT NULL,
    planet_name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    status text NOT NULL,
    normalized jsonb,
    source_hash text,
    source_version smallint,
    fetched_at timestamp with time zone NOT NULL,
    changed_at timestamp with time zone NOT NULL,
    CONSTRAINT nasa_star_planet_check CHECK (((status = 'ready'::text) = ((normalized IS NOT NULL) AND (source_hash IS NOT NULL) AND (source_version IS NOT NULL)))),
    CONSTRAINT nasa_star_planet_planet_id_check CHECK ((planet_id ~ '^np-[0-9a-f]{64}$'::text)),
    CONSTRAINT nasa_star_planet_planet_name_check CHECK ((planet_name <> ''::text)),
    CONSTRAINT nasa_star_planet_source_hash_check CHECK (((source_hash IS NULL) OR (source_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT nasa_star_planet_status_check CHECK ((status = ANY (ARRAY['ready'::text, 'identity_unresolved'::text, 'invalid_source'::text])))
);


ALTER TABLE public.nasa_star_planet OWNER TO planetory;

--
-- Name: TABLE nasa_star_planet; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.nasa_star_planet IS '270: 후보 FK 없이 저장한 NASA 확정 행성별 정규화 자료';


--
-- Name: COLUMN nasa_star_planet.active; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.nasa_star_planet.active IS '마지막 완전 조회에 포함된 행성만 노출한다. 정정·삭제된 이전 행은 보존한다';


--
-- Name: nasa_star_planet_explanation; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.nasa_star_planet_explanation (
    tic_id bigint NOT NULL,
    planet_id text NOT NULL,
    source_hash text NOT NULL,
    source_version smallint NOT NULL,
    model_name text NOT NULL,
    prompt_version text NOT NULL,
    status text NOT NULL,
    content jsonb,
    generated_at timestamp with time zone,
    next_retry_at timestamp with time zone NOT NULL,
    in_flight_until timestamp with time zone,
    attempt_generation bigint DEFAULT 1 NOT NULL,
    attempt_count smallint DEFAULT 1 NOT NULL,
    last_failure text,
    CONSTRAINT nasa_star_planet_explanation_attempt_count_check CHECK (((attempt_count >= 1) AND (attempt_count <= 3))),
    CONSTRAINT nasa_star_planet_explanation_attempt_generation_check CHECK ((attempt_generation > 0)),
    CONSTRAINT nasa_star_planet_explanation_check CHECK (((status = 'ready'::text) = ((content IS NOT NULL) AND (generated_at IS NOT NULL)))),
    CONSTRAINT nasa_star_planet_explanation_check1 CHECK (((status <> 'ready'::text) OR (in_flight_until IS NULL))),
    CONSTRAINT nasa_star_planet_explanation_model_name_check CHECK ((model_name <> ''::text)),
    CONSTRAINT nasa_star_planet_explanation_prompt_version_check CHECK ((prompt_version <> ''::text)),
    CONSTRAINT nasa_star_planet_explanation_source_version_check CHECK ((source_version > 0)),
    CONSTRAINT nasa_star_planet_explanation_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text])))
);


ALTER TABLE public.nasa_star_planet_explanation OWNER TO planetory;

--
-- Name: TABLE nasa_star_planet_explanation; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.nasa_star_planet_explanation IS '270: 현재 원천 해시·모델·프롬프트에 묶인 행성별 설명';


--
-- Name: COLUMN nasa_star_planet_explanation.attempt_generation; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.nasa_star_planet_explanation.attempt_generation IS '늦게 끝난 모델 응답의 설명 덮어쓰기를 막는다';


--
-- Name: notification_candidate_changes; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.notification_candidate_changes (
    bundle_id bigint NOT NULL,
    candidate_id bigint NOT NULL,
    was_discoverable boolean NOT NULL,
    is_discoverable boolean NOT NULL
);


ALTER TABLE public.notification_candidate_changes OWNER TO planetory;

--
-- Name: TABLE notification_candidate_changes; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.notification_candidate_changes IS '공개 판별 후보의 최초·최종 탐색 가능 상태. 별 재개 사건 판별에 사용한다';


--
-- Name: notification_events; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.notification_events (
    id bigint NOT NULL,
    event_key text NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT notification_events_type_check CHECK ((type = ANY (ARRAY['reopen'::text, 'relabel'::text])))
);


ALTER TABLE public.notification_events OWNER TO planetory;

--
-- Name: TABLE notification_events; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.notification_events IS '별 재개와 신호 판정 변경의 원천 사건 및 중복 판별 키';


--
-- Name: notification_events_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.notification_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.notification_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification_outbox; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.notification_outbox (
    id bigint NOT NULL,
    event_key text NOT NULL,
    user_id bigint NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    preference_epoch bigint NOT NULL,
    follow_id bigint,
    source_notification_id bigint,
    state text NOT NULL,
    recorded_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    follow_epoch bigint,
    CONSTRAINT notification_outbox_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'delivered'::text, 'excluded'::text]))),
    CONSTRAINT notification_outbox_type_check CHECK ((type = ANY (ARRAY['achievement'::text, 'reopen'::text, 'challenge'::text, 'comment'::text, 'relabel'::text, 'follow'::text])))
);


ALTER TABLE public.notification_outbox OWNER TO planetory;

--
-- Name: TABLE notification_outbox; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.notification_outbox IS '사건 당시 수신 대상·설정·관계를 보존하는 알림 대기 기록과 발행·제외 상태';


--
-- Name: notification_outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.notification_outbox ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.notification_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: notification_signal_state; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.notification_signal_state (
    candidate_id bigint NOT NULL,
    disposition text,
    ai_verdict text
);


ALTER TABLE public.notification_signal_state OWNER TO planetory;

--
-- Name: TABLE notification_signal_state; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.notification_signal_state IS '후보별 마지막 유효 외부 분류와 AI 판정. 실제 상태 변화 비교 기준';


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.notifications (
    id bigint NOT NULL,
    user_id bigint NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    event_key text,
    published_at timestamp with time zone,
    publication_seq bigint,
    CONSTRAINT ck_notification_publication CHECK ((((event_key IS NOT NULL) AND (published_at IS NOT NULL) AND (publication_seq IS NOT NULL) AND (publication_seq > 0)) OR ((event_key IS NULL) AND (published_at IS NULL) AND (publication_seq IS NULL)))),
    CONSTRAINT notifications_type_check CHECK ((type = ANY (ARRAY['achievement'::text, 'reopen'::text, 'challenge'::text, 'comment'::text, 'relabel'::text, 'follow'::text])))
);


ALTER TABLE public.notifications OWNER TO planetory;

--
-- Name: TABLE notifications; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.notifications IS '회원에게 발송된 알림과 읽음 여부';


--
-- Name: COLUMN notifications.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.notifications.id IS '고유 번호';


--
-- Name: COLUMN notifications.user_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.notifications.user_id IS '회원';


--
-- Name: COLUMN notifications.type; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.notifications.type IS '종류';


--
-- Name: COLUMN notifications.payload; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.notifications.payload IS '내용';


--
-- Name: COLUMN notifications.read_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.notifications.read_at IS '읽은 시각';


--
-- Name: COLUMN notifications.created_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.notifications.created_at IS '생성 시각';


--
-- Name: COLUMN notifications.event_key; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.notifications.event_key IS '생산 트랜잭션의 불변 원인 키; 기존 사건은 NULL로 보존';


--
-- Name: COLUMN notifications.published_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.notifications.published_at IS '최초 발행 시각; 알림함 90일 기준';


--
-- Name: COLUMN notifications.publication_seq; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.notifications.publication_seq IS '회원 잠금 안에서 할당하는 발행 순번; 모두 읽음 경계';


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.notifications ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: observation_datasets_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.observation_datasets ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.observation_datasets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: operation_settings; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.operation_settings (
    rule_version text NOT NULL,
    "values" jsonb NOT NULL,
    applied_at timestamp with time zone NOT NULL,
    note text NOT NULL,
    CONSTRAINT ck_operation_settings_values_valid CHECK (public.operation_rules_valid("values"))
);


ALTER TABLE public.operation_settings OWNER TO planetory;

--
-- Name: TABLE operation_settings; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.operation_settings IS '운영 규칙 버전별 설정 값. 판정 임계값 등을 담는다';


--
-- Name: COLUMN operation_settings.rule_version; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.operation_settings.rule_version IS '규칙 버전';


--
-- Name: COLUMN operation_settings."values"; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.operation_settings."values" IS '설정 값 묶음';


--
-- Name: COLUMN operation_settings.applied_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.operation_settings.applied_at IS '적용 시각';


--
-- Name: COLUMN operation_settings.note; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.operation_settings.note IS '변경 사유';


--
-- Name: periodograms; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.periodograms (
    bundle_id bigint NOT NULL,
    period_min_days numeric NOT NULL,
    period_max_days numeric NOT NULL,
    n_periods integer NOT NULL,
    power real[] NOT NULL,
    CONSTRAINT ck_periodograms_power_all_finite CHECK (((array_position(power, NULL::real) IS NULL) AND (array_position(power, 'NaN'::real) IS NULL) AND (array_position(power, 'Infinity'::real) IS NULL) AND (array_position(power, '-Infinity'::real) IS NULL))),
    CONSTRAINT periodograms_check CHECK (((n_periods > 0) AND (array_ndims(power) = 1) AND (cardinality(power) = n_periods))),
    CONSTRAINT periodograms_check1 CHECK (((period_min_days > (0)::numeric) AND (period_max_days > period_min_days)))
);


ALTER TABLE public.periodograms OWNER TO planetory;

--
-- Name: TABLE periodograms; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.periodograms IS '공개 판별로 계산한 BLS 주기도 세기 배열';


--
-- Name: COLUMN periodograms.bundle_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.periodograms.bundle_id IS '공개 데이터 판';


--
-- Name: COLUMN periodograms.period_min_days; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.periodograms.period_min_days IS '주기 축 시작';


--
-- Name: COLUMN periodograms.period_max_days; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.periodograms.period_max_days IS '주기 축 끝';


--
-- Name: COLUMN periodograms.n_periods; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.periodograms.n_periods IS '격자 점 수';


--
-- Name: COLUMN periodograms.power; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.periodograms.power IS '세기 배열';


--
-- Name: post_history_attachments; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.post_history_attachments (
    id bigint NOT NULL,
    post_id bigint NOT NULL,
    history_id bigint NOT NULL,
    attached_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.post_history_attachments OWNER TO planetory;

--
-- Name: TABLE post_history_attachments; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.post_history_attachments IS '글에 첨부된 분석 히스토리 연결';


--
-- Name: COLUMN post_history_attachments.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_history_attachments.id IS '고유 번호';


--
-- Name: COLUMN post_history_attachments.post_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_history_attachments.post_id IS '글';


--
-- Name: COLUMN post_history_attachments.history_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_history_attachments.history_id IS '히스토리';


--
-- Name: COLUMN post_history_attachments.attached_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_history_attachments.attached_at IS '첨부 시각';


--
-- Name: post_history_attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.post_history_attachments ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.post_history_attachments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: post_reactions; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.post_reactions (
    id bigint NOT NULL,
    post_id bigint NOT NULL,
    user_id bigint NOT NULL,
    reaction text NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT post_reactions_reaction_check CHECK ((reaction = ANY (ARRAY['agree'::text, 'disagree'::text])))
);


ALTER TABLE public.post_reactions OWNER TO planetory;

--
-- Name: TABLE post_reactions; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.post_reactions IS '일반 글에 대한 회원 반응(동의/비동의)';


--
-- Name: COLUMN post_reactions.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_reactions.id IS '고유 번호';


--
-- Name: COLUMN post_reactions.post_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_reactions.post_id IS '일반 글만';


--
-- Name: COLUMN post_reactions.user_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_reactions.user_id IS '회원';


--
-- Name: COLUMN post_reactions.reaction; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_reactions.reaction IS 'agree/disagree';


--
-- Name: COLUMN post_reactions.updated_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_reactions.updated_at IS '수정 시각';


--
-- Name: post_reactions_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.post_reactions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.post_reactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: post_source_links; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.post_source_links (
    id bigint NOT NULL,
    post_id bigint,
    comment_id bigint,
    target_type text NOT NULL,
    target_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT post_source_links_check CHECK (((post_id IS NOT NULL) <> (comment_id IS NOT NULL))),
    CONSTRAINT post_source_links_target_type_check CHECK ((target_type = ANY (ARRAY['thread'::text, 'analysis'::text])))
);


ALTER TABLE public.post_source_links OWNER TO planetory;

--
-- Name: TABLE post_source_links; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.post_source_links IS '글·답글이 참조하는 스레드 또는 분석 링크';


--
-- Name: COLUMN post_source_links.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_source_links.id IS '고유 번호';


--
-- Name: COLUMN post_source_links.post_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_source_links.post_id IS '글(둘 중 하나)';


--
-- Name: COLUMN post_source_links.comment_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_source_links.comment_id IS '답글(둘 중 하나)';


--
-- Name: COLUMN post_source_links.target_type; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_source_links.target_type IS 'thread/analysis';


--
-- Name: COLUMN post_source_links.target_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_source_links.target_id IS '대상 ID';


--
-- Name: COLUMN post_source_links.created_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.post_source_links.created_at IS '생성 시각';


--
-- Name: post_source_links_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.post_source_links ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.post_source_links_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: posts_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.posts ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.posts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: publication_bundles; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.publication_bundles (
    id bigint NOT NULL,
    tic_id bigint NOT NULL,
    bundle_version text NOT NULL,
    status text NOT NULL,
    manifest jsonb NOT NULL,
    fold_reference_time_btjd double precision NOT NULL,
    base_days numeric NOT NULL,
    published_at timestamp with time zone,
    CONSTRAINT ck_publication_bundles_manifest_shape CHECK (((manifest ?& ARRAY['segment_ids'::text, 'array_checksums'::text, 'residual_model_version'::text, 'periodogram_config_version'::text, 'binning'::text, 'period_grid'::text, 'fine_tune'::text, 'curve_steps'::text]) AND (jsonb_typeof((manifest -> 'segment_ids'::text)) = 'array'::text) AND (jsonb_array_length((manifest -> 'segment_ids'::text)) > 0) AND (jsonb_typeof((manifest -> 'array_checksums'::text)) = 'object'::text) AND (jsonb_typeof((manifest -> 'residual_model_version'::text)) = 'string'::text) AND (jsonb_typeof((manifest -> 'periodogram_config_version'::text)) = 'string'::text) AND (jsonb_typeof((manifest -> 'binning'::text)) = 'object'::text) AND (jsonb_typeof((manifest -> 'period_grid'::text)) = 'object'::text) AND (jsonb_typeof((manifest -> 'fine_tune'::text)) = 'object'::text) AND (jsonb_typeof((manifest -> 'curve_steps'::text)) = 'object'::text))),
    CONSTRAINT publication_bundles_status_check CHECK ((status = ANY (ARRAY['staging'::text, 'current'::text, 'archived'::text])))
);


ALTER TABLE public.publication_bundles OWNER TO planetory;

--
-- Name: TABLE publication_bundles; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.publication_bundles IS '별 단위 공개 데이터 판. 세그먼트 구성과 계산 버전을 한 판으로 고정한다';


--
-- Name: COLUMN publication_bundles.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.publication_bundles.id IS '고유 번호';


--
-- Name: COLUMN publication_bundles.tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.publication_bundles.tic_id IS '별';


--
-- Name: COLUMN publication_bundles.bundle_version; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.publication_bundles.bundle_version IS '판 버전';


--
-- Name: COLUMN publication_bundles.status; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.publication_bundles.status IS 'staging/current/archived';


--
-- Name: COLUMN publication_bundles.manifest; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.publication_bundles.manifest IS '세그먼트 id 집합·checksum·계산 버전·격자 규칙';


--
-- Name: COLUMN publication_bundles.fold_reference_time_btjd; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.publication_bundles.fold_reference_time_btjd IS '위상 접기 기준 시각';


--
-- Name: COLUMN publication_bundles.base_days; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.publication_bundles.base_days IS '관측 기간(일)';


--
-- Name: COLUMN publication_bundles.published_at; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.publication_bundles.published_at IS '공개 시각';


--
-- Name: CONSTRAINT ck_publication_bundles_manifest_shape ON publication_bundles; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON CONSTRAINT ck_publication_bundles_manifest_shape ON public.publication_bundles IS 'ERD 3장 manifest 최소 스키마. 키 존재와 자료형만 검사하며 값 범위는 rule_version이 관리한다';


--
-- Name: publication_bundles_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.publication_bundles ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.publication_bundles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: published_analyses_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.published_analyses ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.published_analyses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: star_unlocks_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.star_unlocks ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.star_unlocks_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: stats_snapshots; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.stats_snapshots (
    id bigint NOT NULL,
    snapshot_date date NOT NULL,
    scope text NOT NULL,
    metrics jsonb NOT NULL,
    round_id bigint,
    CONSTRAINT stats_snapshots_check CHECK (((scope = 'round'::text) = (round_id IS NOT NULL))),
    CONSTRAINT stats_snapshots_scope_check CHECK ((scope = ANY (ARRAY['global'::text, 'round'::text])))
);


ALTER TABLE public.stats_snapshots OWNER TO planetory;

--
-- Name: TABLE stats_snapshots; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.stats_snapshots IS '일자별 집계 지표 스냅샷';


--
-- Name: COLUMN stats_snapshots.id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.stats_snapshots.id IS '고유 번호';


--
-- Name: COLUMN stats_snapshots.snapshot_date; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.stats_snapshots.snapshot_date IS '집계일';


--
-- Name: COLUMN stats_snapshots.scope; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.stats_snapshots.scope IS 'global/round';


--
-- Name: COLUMN stats_snapshots.metrics; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.stats_snapshots.metrics IS 'ComparisonSnapshot 전체 JSON: status, asOf, sourceObservedAt, generatedAt, snapshotDate, cohortStart, cohortEnd, cohortMemberCount, metrics';


--
-- Name: COLUMN stats_snapshots.round_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.stats_snapshots.round_id IS '회차';


--
-- Name: stats_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.stats_snapshots ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.stats_snapshots_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: submissions_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.submissions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.submissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tutorial_stars; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.tutorial_stars (
    seq smallint NOT NULL,
    tic_id bigint NOT NULL,
    intent text NOT NULL,
    active boolean NOT NULL,
    CONSTRAINT tutorial_stars_intent_check CHECK ((intent = ANY (ARRAY['deep_confirmed'::text, 'shallow_confirmed'::text, 'fp'::text, 'deep_fp'::text, 'multi_fp'::text]))),
    CONSTRAINT tutorial_stars_seq_check CHECK (((seq >= 1) AND (seq <= 5)))
);


ALTER TABLE public.tutorial_stars OWNER TO planetory;

--
-- Name: TABLE tutorial_stars; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.tutorial_stars IS '튜토리얼에서 순서대로 제시하는 별과 그 의도';


--
-- Name: COLUMN tutorial_stars.seq; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.tutorial_stars.seq IS '순번 1~5';


--
-- Name: COLUMN tutorial_stars.tic_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.tutorial_stars.tic_id IS '별';


--
-- Name: COLUMN tutorial_stars.intent; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.tutorial_stars.intent IS 'deep_confirmed/shallow_confirmed/fp/deep_fp/multi_fp';


--
-- Name: COLUMN tutorial_stars.active; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.tutorial_stars.active IS '사용 중';


--
-- Name: user_candidate_achievements_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.user_candidate_achievements ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.user_candidate_achievements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_settings; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.user_settings (
    user_id bigint NOT NULL,
    star_list_public boolean DEFAULT true NOT NULL,
    notification_prefs jsonb DEFAULT '{"follow": true, "reopen": true, "comment": true, "relabel": true, "challenge": true, "achievement": true}'::jsonb NOT NULL,
    onboarding_done boolean DEFAULT false NOT NULL,
    notification_epochs jsonb DEFAULT '{}'::jsonb NOT NULL
);


ALTER TABLE public.user_settings OWNER TO planetory;

--
-- Name: TABLE user_settings; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.user_settings IS '회원별 공개 범위와 알림 설정';


--
-- Name: COLUMN user_settings.user_id; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_settings.user_id IS '회원';


--
-- Name: COLUMN user_settings.star_list_public; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_settings.star_list_public IS '내 별 목록 공개';


--
-- Name: COLUMN user_settings.notification_prefs; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_settings.notification_prefs IS '알림 종류별 설정';


--
-- Name: COLUMN user_settings.onboarding_done; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_settings.onboarding_done IS '첫 방문 안내 완료';


--
-- Name: COLUMN user_settings.notification_epochs; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON COLUMN public.user_settings.notification_epochs IS '종류별 OFF 전환 횟수; 대기 사건이 ON 후 부활하지 않도록 보존';


--
-- Name: user_star_progress_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.user_star_progress ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.user_star_progress_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: planetory
--

ALTER TABLE public.users ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: withdrawal_requests; Type: TABLE; Schema: public; Owner: planetory
--

CREATE TABLE public.withdrawal_requests (
    id uuid NOT NULL,
    user_id bigint NOT NULL,
    policy_version text NOT NULL,
    receipt_hash text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    effective_at timestamp with time zone,
    completed_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    CONSTRAINT withdrawal_requests_check CHECK (((completed_at IS NULL) OR (effective_at IS NOT NULL))),
    CONSTRAINT withdrawal_requests_status_check CHECK ((status = ANY (ARRAY['READY'::text, 'PROCESSING'::text, 'COMPLETED'::text, 'FAILED'::text])))
);


ALTER TABLE public.withdrawal_requests OWNER TO planetory;

--
-- Name: TABLE withdrawal_requests; Type: COMMENT; Schema: public; Owner: planetory
--

COMMENT ON TABLE public.withdrawal_requests IS '회원 탈퇴 신청의 정책 버전·영수증 검증값과 처리 상태';


--
-- Data for Name: ai_evaluations; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.ai_evaluations (id, candidate_id, execution_id, score, verdict, threshold_version, raw_output) FROM stdin;
\.


--
-- Data for Name: ai_executions; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.ai_executions (id, model_version, checkpoint, status, started_at, error, duration_ms) FROM stdin;
\.


--
-- Data for Name: analysis_histories; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.analysis_histories (id, submission_id, user_id, tic_id, snapshot_params, versions, created_at) FROM stdin;
\.


--
-- Data for Name: analysis_snapshots; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.analysis_snapshots (history_id, bins, folded_flux, folded_err, created_at) FROM stdin;
\.


--
-- Data for Name: candidate_aliases; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.candidate_aliases (id, candidate_id, multiplier, alias_period_days) FROM stdin;
\.


--
-- Data for Name: candidate_dispositions; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.candidate_dispositions (candidate_id, disposition, answer_class, planet_truth, rule_version, applied_at, source_refs) FROM stdin;
\.


--
-- Data for Name: candidate_status_history; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.candidate_status_history (id, candidate_id, bundle_id, field, old_value, new_value, changed_at, rule_version, reason) FROM stdin;
\.


--
-- Data for Name: candidates; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.candidates (id, tic_id, status, updated_bundle_id, removal_step, period_days, epoch_btjd, duration_hours, depth_ppm, bls_power, transit_model, discoverable, is_confirmed) FROM stdin;
\.


--
-- Data for Name: challenge_round_extra_targets; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.challenge_round_extra_targets (round_id, tic_id) FROM stdin;
\.


--
-- Data for Name: challenge_rounds; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.challenge_rounds (id, round_no, starts_on, ends_on, target_tic_id, description, status, notification_started_at) FROM stdin;
\.


--
-- Data for Name: comment_history_attachments; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.comment_history_attachments (id, comment_id, history_id, attached_at) FROM stdin;
\.


--
-- Data for Name: comments; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.comments (id, post_id, user_id, body, status, created_at, updated_at, author_withdrawn_at) FROM stdin;
\.


--
-- Data for Name: external_signal_references; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.external_signal_references (id, candidate_id, source, external_id, disposition, period_days, fetched_on, tic_id, epoch_btjd) FROM stdin;
\.


--
-- Data for Name: flyway_schema_history; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.flyway_schema_history (installed_rank, version, description, type, script, checksum, installed_by, installed_on, execution_time, success) FROM stdin;
1	1	initial schema	SQL	V1__initial_schema.sql	-987789188	planetory	2026-09-28 03:05:41.34984	335	t
2	2	gold roles	SQL	V2__gold_roles.sql	-1422269885	planetory	2026-09-28 03:05:41.766788	16	t
3	3	gold manifest schema	SQL	V3__gold_manifest_schema.sql	899969749	planetory	2026-09-28 03:05:41.803166	5	t
4	4	apply erd v1 2 star coordinates and peak source	SQL	V4__apply_erd_v1_2_star_coordinates_and_peak_source.sql	1208398101	planetory	2026-09-28 03:05:41.816112	13	t
5	5	exploration domain constraints	SQL	V5__exploration_domain_constraints.sql	82858262	planetory	2026-09-28 03:05:41.837617	16	t
6	6	member sky revision	SQL	V6__member_sky_revision.sql	-297179507	planetory	2026-09-28 03:05:41.862282	8	t
7	7	reject bootstrap layout rows	SQL	V7__reject_bootstrap_layout_rows.sql	-303119	planetory	2026-09-28 03:05:41.878089	3	t
8	8	publication bundle idempotency key	SQL	V8__publication_bundle_idempotency_key.sql	-1860830124	planetory	2026-09-28 03:05:41.88626	2	t
9	9	operation rules	SQL	V9__operation_rules.sql	-1387843159	planetory	2026-09-28 03:05:41.894184	19	t
10	10	gold array values finite	SQL	V10__gold_array_values_finite.sql	713893865	planetory	2026-09-28 03:05:41.922261	3	t
11	11	member community app grants	SQL	V11__member_community_app_grants.sql	1356829897	planetory	2026-09-28 03:05:41.931579	3	t
12	12	submission replay	SQL	V12__submission_replay.sql	2008735137	planetory	2026-09-28 03:05:41.941153	3	t
13	13	history attachment app grants	SQL	V13__history_attachment_app_grants.sql	-1551525439	planetory	2026-09-28 03:05:41.949379	2	t
14	14	public analysis app grants	SQL	V14__public_analysis_app_grants.sql	-1178498955	planetory	2026-09-28 03:05:41.956954	2	t
15	15	public analysis visibility grant	SQL	V15__public_analysis_visibility_grant.sql	-1989519748	planetory	2026-09-28 03:05:41.965542	1	t
16	16	post reaction app grants	SQL	V16__post_reaction_app_grants.sql	821369885	planetory	2026-09-28 03:05:41.972161	1	t
17	17	submission detail target	SQL	V17__submission_detail_target.sql	-2129942389	planetory	2026-09-28 03:05:41.979372	5	t
18	18	source link app grants	SQL	V18__source_link_app_grants.sql	492520611	planetory	2026-09-28 03:05:41.990211	2	t
19	19	official search summary	SQL	V19__official_search_summary.sql	756135332	planetory	2026-09-28 03:05:41.998246	8	t
20	20	follow app grants	SQL	V20__follow_app_grants.sql	-2119793066	planetory	2026-09-28 03:05:42.01233	2	t
21	21	statistics aggregation	SQL	V21__statistics_aggregation.sql	-559777459	planetory	2026-09-28 03:05:42.01956	28	t
22	22	reopen event grants	SQL	V22__reopen_event_grants.sql	-202654133	planetory	2026-09-28 03:05:42.055705	3	t
23	23	notification delivery	SQL	V23__notification_delivery.sql	1079372704	planetory	2026-09-28 03:05:42.065713	38	t
24	24	member withdrawal	SQL	V24__member_withdrawal.sql	-1715088968	planetory	2026-09-28 03:05:42.112561	14	t
25	25	nasa planet info	SQL	V25__nasa_planet_info.sql	-575645142	planetory	2026-09-28 03:05:42.13391	10	t
26	26	nasa planet explanation	SQL	V26__nasa_planet_explanation.sql	95908841	planetory	2026-09-28 03:05:42.1513	11	t
27	27	peak submission optional duration	SQL	V27__peak_submission_optional_duration.sql	1417506790	planetory	2026-09-28 03:05:42.170232	4	t
28	28	nasa explanation daily usage	SQL	V28__nasa_explanation_daily_usage.sql	-884002744	planetory	2026-09-28 03:05:42.182384	11	t
29	29	nasa star planets	SQL	V29__nasa_star_planets.sql	-1230658417	planetory	2026-09-28 03:05:42.2026	31	t
30	30	challenge round extra targets	SQL	V30__challenge_round_extra_targets.sql	36683935	planetory	2026-09-28 03:05:42.243406	49	t
31	\N	table comments	SQL	R__table_comments.sql	545028912	planetory	2026-09-28 03:05:42.306101	21	t
\.


--
-- Data for Name: follows; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.follows (id, user_id, target_type, target_id, created_at) FROM stdin;
\.


--
-- Data for Name: light_curve_segments; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.light_curve_segments (id, tic_id, sector, binning_revision, start_btjd, bin_minutes, n_points, flux, flux_scatter, gaps) FROM stdin;
\.


--
-- Data for Name: member_sky_revisions; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.member_sky_revisions (user_id, revision, updated_at) FROM stdin;
\.


--
-- Data for Name: nasa_explanation_daily_total; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.nasa_explanation_daily_total (usage_day, attempt_count) FROM stdin;
\.


--
-- Data for Name: nasa_explanation_daily_usage; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.nasa_explanation_daily_usage (usage_day, member_id, attempt_count) FROM stdin;
\.


--
-- Data for Name: nasa_planet_explanation; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.nasa_planet_explanation (candidate_id, source_hash, source_version, model_name, prompt_version, status, content, generated_at, last_attempt_at, next_retry_at, in_flight_until, attempt_generation, attempt_count, last_failure) FROM stdin;
\.


--
-- Data for Name: nasa_planet_info; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.nasa_planet_info (candidate_id, tic_id, archive_planet_name, status, normalized, source_hash, source_version, fetched_at, changed_at, last_attempt_at, next_refresh_at, in_flight_until, attempt_generation, last_refresh_status) FROM stdin;
\.


--
-- Data for Name: nasa_star_catalog; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.nasa_star_catalog (tic_id, status, host_name, fetched_at, next_refresh_at, in_flight_until, attempt_generation, last_refresh_status) FROM stdin;
\.


--
-- Data for Name: nasa_star_planet; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.nasa_star_planet (tic_id, planet_id, planet_name, active, status, normalized, source_hash, source_version, fetched_at, changed_at) FROM stdin;
\.


--
-- Data for Name: nasa_star_planet_explanation; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.nasa_star_planet_explanation (tic_id, planet_id, source_hash, source_version, model_name, prompt_version, status, content, generated_at, next_retry_at, in_flight_until, attempt_generation, attempt_count, last_failure) FROM stdin;
\.


--
-- Data for Name: notification_candidate_changes; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.notification_candidate_changes (bundle_id, candidate_id, was_discoverable, is_discoverable) FROM stdin;
\.


--
-- Data for Name: notification_events; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.notification_events (id, event_key, type, payload, occurred_at) FROM stdin;
\.


--
-- Data for Name: notification_outbox; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.notification_outbox (id, event_key, user_id, type, payload, preference_epoch, follow_id, source_notification_id, state, recorded_at, follow_epoch) FROM stdin;
\.


--
-- Data for Name: notification_signal_state; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.notification_signal_state (candidate_id, disposition, ai_verdict) FROM stdin;
\.


--
-- Data for Name: notifications; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.notifications (id, user_id, type, payload, read_at, created_at, event_key, published_at, publication_seq) FROM stdin;
\.


--
-- Data for Name: observation_datasets; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.observation_datasets (id, tic_id, sector, start_btjd, end_btjd, cadence, source_version, time_system) FROM stdin;
\.


--
-- Data for Name: operation_settings; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.operation_settings (rule_version, "values", applied_at, note) FROM stdin;
rule-0	{"ai": {"lower_threshold": null, "upper_threshold": null}, "bls": null, "peaks": {"top_n": 10}, "matching": {"min_score_gap": 0.1, "n_transits_cap": null, "dominance_ratio": 0.5, "duration_ratio_max": 2, "duration_ratio_min": 0.5, "harmonic_multipliers": [1, 2, 0.5], "min_overlap_transits": 1, "overlap_ratio_tolerance": 0.1}, "tutorial": {"skip_after": 0}, "discovery": {"seed_policy": "hash-user-achievement-seq-v1", "stars_per_achievement": 1}, "selection": {"phase_width_max": 0.25, "allow_empty_phase_span": false, "max_duration_multiple_of_suggested": 3}, "format_version": 1}	2026-09-28 03:05:41.898833+00	초기 규칙 [S15P21C206-151]. 제출 매칭 v0 예제와 탐사 API 기본값이며 운영 확정값이 아니다. D20·D11 확정 뒤 새 버전으로 올린다.
\.


--
-- Data for Name: periodograms; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.periodograms (bundle_id, period_min_days, period_max_days, n_periods, power) FROM stdin;
\.


--
-- Data for Name: post_history_attachments; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.post_history_attachments (id, post_id, history_id, attached_at) FROM stdin;
\.


--
-- Data for Name: post_reactions; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.post_reactions (id, post_id, user_id, reaction, updated_at) FROM stdin;
\.


--
-- Data for Name: post_source_links; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.post_source_links (id, post_id, comment_id, target_type, target_id, created_at) FROM stdin;
\.


--
-- Data for Name: posts; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.posts (id, kind, user_id, candidate_id, board, tic_id, tag, title, body, status, created_at, updated_at, author_withdrawn_at) FROM stdin;
\.


--
-- Data for Name: publication_bundles; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.publication_bundles (id, tic_id, bundle_version, status, manifest, fold_reference_time_btjd, base_days, published_at) FROM stdin;
\.


--
-- Data for Name: published_analyses; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.published_analyses (id, post_id, user_id, candidate_id, history_id, published_at, unpublished_at, hidden_at, withdrawn_at) FROM stdin;
\.


--
-- Data for Name: star_unlocks; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.star_unlocks (id, user_id, tic_id, unlock_reason, trigger_tic_id, trigger_achievement_id, seq, generation, angle_deg, radius_jitter, depth_z, unlocked_at, world_x, world_y, layout_version, layout_ordinal) FROM stdin;
\.


--
-- Data for Name: stars; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.stars (tic_id, teff_k, radius_rsun, tmag, confirmed_count, service_status, board_open) FROM stdin;
\.


--
-- Data for Name: stats_snapshots; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.stats_snapshots (id, snapshot_date, scope, metrics, round_id) FROM stdin;
\.


--
-- Data for Name: submissions; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.submissions (id, user_id, tic_id, bundle_id, request_id, submission_kind, curve_step, removed_candidate_ids, submitted_period, matched_period, harmonic_multiplier, phase_start, phase_end, fold_reference_time_btjd, epoch_btjd, duration_hours, user_judgment, evidence_checks, match_result, matched_candidate_id, achievement_result, retry_of_submission_id, answer_viewed, created_at, correction_reason, residual_model_version, periodogram_config_version, memo, rule_version, source_peak_grid_index, source_peak_suggested_duration_hours, duration_limit_hours, request_hash, request_hash_version, response_snapshot, detail_target_candidate_id) FROM stdin;
\.


--
-- Data for Name: tutorial_stars; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.tutorial_stars (seq, tic_id, intent, active) FROM stdin;
\.


--
-- Data for Name: user_candidate_achievements; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.user_candidate_achievements (id, user_id, candidate_id, achievement_type, recognized_submission_id, recognized_analysis_id, recognized_at, relabeled_at, relabel_disposition) FROM stdin;
\.


--
-- Data for Name: user_settings; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.user_settings (user_id, star_list_public, notification_prefs, onboarding_done, notification_epochs) FROM stdin;
\.


--
-- Data for Name: user_star_progress; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.user_star_progress (id, user_id, tic_id, planet_count, achievement_count, fp_success, progress_stage, current_curve_step, completion_reason, reopen_pending, completed_at, reopened_at) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.users (id, provider, provider_user_id, nickname, role, status, created_at, withdrawn_at) FROM stdin;
-1	internal	withdrawn-author	탈퇴한 회원	member	withdrawn	2026-09-28 03:05:42.115514+00	\N
\.


--
-- Data for Name: withdrawal_requests; Type: TABLE DATA; Schema: public; Owner: planetory
--

COPY public.withdrawal_requests (id, user_id, policy_version, receipt_hash, status, created_at, effective_at, completed_at, attempts, next_attempt_at) FROM stdin;
\.


--
-- Name: ai_evaluations_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.ai_evaluations_id_seq', 1, false);


--
-- Name: ai_executions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.ai_executions_id_seq', 1, false);


--
-- Name: analysis_histories_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.analysis_histories_id_seq', 1, false);


--
-- Name: candidate_aliases_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.candidate_aliases_id_seq', 1, false);


--
-- Name: candidate_status_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.candidate_status_history_id_seq', 1, false);


--
-- Name: candidates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.candidates_id_seq', 1, false);


--
-- Name: challenge_rounds_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.challenge_rounds_id_seq', 1, false);


--
-- Name: comment_history_attachments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.comment_history_attachments_id_seq', 1, false);


--
-- Name: comments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.comments_id_seq', 1, false);


--
-- Name: external_signal_references_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.external_signal_references_id_seq', 1, false);


--
-- Name: follows_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.follows_id_seq', 1, false);


--
-- Name: light_curve_segments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.light_curve_segments_id_seq', 1, false);


--
-- Name: notification_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.notification_events_id_seq', 1, false);


--
-- Name: notification_outbox_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.notification_outbox_id_seq', 1, false);


--
-- Name: notifications_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.notifications_id_seq', 1, false);


--
-- Name: observation_datasets_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.observation_datasets_id_seq', 1, false);


--
-- Name: post_history_attachments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.post_history_attachments_id_seq', 1, false);


--
-- Name: post_reactions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.post_reactions_id_seq', 1, false);


--
-- Name: post_source_links_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.post_source_links_id_seq', 1, false);


--
-- Name: posts_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.posts_id_seq', 1, false);


--
-- Name: publication_bundles_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.publication_bundles_id_seq', 1, false);


--
-- Name: published_analyses_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.published_analyses_id_seq', 1, false);


--
-- Name: star_unlocks_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.star_unlocks_id_seq', 1, false);


--
-- Name: stats_snapshots_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.stats_snapshots_id_seq', 1, false);


--
-- Name: submissions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.submissions_id_seq', 1, false);


--
-- Name: user_candidate_achievements_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.user_candidate_achievements_id_seq', 1, false);


--
-- Name: user_star_progress_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.user_star_progress_id_seq', 1, false);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: planetory
--

SELECT pg_catalog.setval('public.users_id_seq', 1, false);


--
-- Name: ai_evaluations ai_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.ai_evaluations
    ADD CONSTRAINT ai_evaluations_pkey PRIMARY KEY (id);


--
-- Name: ai_executions ai_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.ai_executions
    ADD CONSTRAINT ai_executions_pkey PRIMARY KEY (id);


--
-- Name: analysis_histories analysis_histories_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.analysis_histories
    ADD CONSTRAINT analysis_histories_pkey PRIMARY KEY (id);


--
-- Name: analysis_histories analysis_histories_submission_id_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.analysis_histories
    ADD CONSTRAINT analysis_histories_submission_id_key UNIQUE (submission_id);


--
-- Name: analysis_snapshots analysis_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.analysis_snapshots
    ADD CONSTRAINT analysis_snapshots_pkey PRIMARY KEY (history_id);


--
-- Name: candidate_aliases candidate_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.candidate_aliases
    ADD CONSTRAINT candidate_aliases_pkey PRIMARY KEY (id);


--
-- Name: candidate_dispositions candidate_dispositions_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.candidate_dispositions
    ADD CONSTRAINT candidate_dispositions_pkey PRIMARY KEY (candidate_id);


--
-- Name: candidate_status_history candidate_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.candidate_status_history
    ADD CONSTRAINT candidate_status_history_pkey PRIMARY KEY (id);


--
-- Name: candidates candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT candidates_pkey PRIMARY KEY (id);


--
-- Name: challenge_rounds challenge_rounds_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.challenge_rounds
    ADD CONSTRAINT challenge_rounds_pkey PRIMARY KEY (id);


--
-- Name: challenge_rounds challenge_rounds_round_no_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.challenge_rounds
    ADD CONSTRAINT challenge_rounds_round_no_key UNIQUE (round_no);


--
-- Name: comment_history_attachments comment_history_attachments_comment_id_history_id_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.comment_history_attachments
    ADD CONSTRAINT comment_history_attachments_comment_id_history_id_key UNIQUE (comment_id, history_id);


--
-- Name: comment_history_attachments comment_history_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.comment_history_attachments
    ADD CONSTRAINT comment_history_attachments_pkey PRIMARY KEY (id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: external_signal_references external_signal_references_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.external_signal_references
    ADD CONSTRAINT external_signal_references_pkey PRIMARY KEY (id);


--
-- Name: flyway_schema_history flyway_schema_history_pk; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.flyway_schema_history
    ADD CONSTRAINT flyway_schema_history_pk PRIMARY KEY (installed_rank);


--
-- Name: follows follows_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_pkey PRIMARY KEY (id);


--
-- Name: follows follows_user_id_target_type_target_id_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_user_id_target_type_target_id_key UNIQUE (user_id, target_type, target_id);


--
-- Name: light_curve_segments light_curve_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.light_curve_segments
    ADD CONSTRAINT light_curve_segments_pkey PRIMARY KEY (id);


--
-- Name: light_curve_segments light_curve_segments_tic_id_sector_binning_revision_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.light_curve_segments
    ADD CONSTRAINT light_curve_segments_tic_id_sector_binning_revision_key UNIQUE (tic_id, sector, binning_revision);


--
-- Name: member_sky_revisions member_sky_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.member_sky_revisions
    ADD CONSTRAINT member_sky_revisions_pkey PRIMARY KEY (user_id);


--
-- Name: nasa_explanation_daily_total nasa_explanation_daily_total_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_explanation_daily_total
    ADD CONSTRAINT nasa_explanation_daily_total_pkey PRIMARY KEY (usage_day);


--
-- Name: nasa_explanation_daily_usage nasa_explanation_daily_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_explanation_daily_usage
    ADD CONSTRAINT nasa_explanation_daily_usage_pkey PRIMARY KEY (usage_day, member_id);


--
-- Name: nasa_planet_explanation nasa_planet_explanation_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_planet_explanation
    ADD CONSTRAINT nasa_planet_explanation_pkey PRIMARY KEY (candidate_id);


--
-- Name: nasa_planet_info nasa_planet_info_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_planet_info
    ADD CONSTRAINT nasa_planet_info_pkey PRIMARY KEY (candidate_id);


--
-- Name: nasa_star_catalog nasa_star_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_star_catalog
    ADD CONSTRAINT nasa_star_catalog_pkey PRIMARY KEY (tic_id);


--
-- Name: nasa_star_planet_explanation nasa_star_planet_explanation_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_star_planet_explanation
    ADD CONSTRAINT nasa_star_planet_explanation_pkey PRIMARY KEY (tic_id, planet_id);


--
-- Name: nasa_star_planet nasa_star_planet_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_star_planet
    ADD CONSTRAINT nasa_star_planet_pkey PRIMARY KEY (tic_id, planet_id);


--
-- Name: nasa_star_planet nasa_star_planet_tic_id_planet_name_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_star_planet
    ADD CONSTRAINT nasa_star_planet_tic_id_planet_name_key UNIQUE (tic_id, planet_name);


--
-- Name: notification_candidate_changes notification_candidate_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.notification_candidate_changes
    ADD CONSTRAINT notification_candidate_changes_pkey PRIMARY KEY (bundle_id, candidate_id);


--
-- Name: notification_events notification_events_event_key_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.notification_events
    ADD CONSTRAINT notification_events_event_key_key UNIQUE (event_key);


--
-- Name: notification_events notification_events_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.notification_events
    ADD CONSTRAINT notification_events_pkey PRIMARY KEY (id);


--
-- Name: notification_outbox notification_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_pkey PRIMARY KEY (id);


--
-- Name: notification_outbox notification_outbox_user_id_event_key_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.notification_outbox
    ADD CONSTRAINT notification_outbox_user_id_event_key_key UNIQUE (user_id, event_key);


--
-- Name: notification_signal_state notification_signal_state_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.notification_signal_state
    ADD CONSTRAINT notification_signal_state_pkey PRIMARY KEY (candidate_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: observation_datasets observation_datasets_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.observation_datasets
    ADD CONSTRAINT observation_datasets_pkey PRIMARY KEY (id);


--
-- Name: observation_datasets observation_datasets_tic_id_sector_source_version_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.observation_datasets
    ADD CONSTRAINT observation_datasets_tic_id_sector_source_version_key UNIQUE (tic_id, sector, source_version);


--
-- Name: operation_settings operation_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.operation_settings
    ADD CONSTRAINT operation_settings_pkey PRIMARY KEY (rule_version);


--
-- Name: periodograms periodograms_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.periodograms
    ADD CONSTRAINT periodograms_pkey PRIMARY KEY (bundle_id);


--
-- Name: challenge_round_extra_targets pk_challenge_round_extra_targets; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.challenge_round_extra_targets
    ADD CONSTRAINT pk_challenge_round_extra_targets PRIMARY KEY (round_id, tic_id);


--
-- Name: post_history_attachments post_history_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.post_history_attachments
    ADD CONSTRAINT post_history_attachments_pkey PRIMARY KEY (id);


--
-- Name: post_history_attachments post_history_attachments_post_id_history_id_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.post_history_attachments
    ADD CONSTRAINT post_history_attachments_post_id_history_id_key UNIQUE (post_id, history_id);


--
-- Name: post_reactions post_reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.post_reactions
    ADD CONSTRAINT post_reactions_pkey PRIMARY KEY (id);


--
-- Name: post_reactions post_reactions_post_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.post_reactions
    ADD CONSTRAINT post_reactions_post_id_user_id_key UNIQUE (post_id, user_id);


--
-- Name: post_source_links post_source_links_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.post_source_links
    ADD CONSTRAINT post_source_links_pkey PRIMARY KEY (id);


--
-- Name: posts posts_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_pkey PRIMARY KEY (id);


--
-- Name: publication_bundles publication_bundles_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.publication_bundles
    ADD CONSTRAINT publication_bundles_pkey PRIMARY KEY (id);


--
-- Name: published_analyses published_analyses_history_id_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.published_analyses
    ADD CONSTRAINT published_analyses_history_id_key UNIQUE (history_id);


--
-- Name: published_analyses published_analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.published_analyses
    ADD CONSTRAINT published_analyses_pkey PRIMARY KEY (id);


--
-- Name: star_unlocks star_unlocks_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.star_unlocks
    ADD CONSTRAINT star_unlocks_pkey PRIMARY KEY (id);


--
-- Name: star_unlocks star_unlocks_trigger_achievement_id_seq_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.star_unlocks
    ADD CONSTRAINT star_unlocks_trigger_achievement_id_seq_key UNIQUE (trigger_achievement_id, seq);


--
-- Name: star_unlocks star_unlocks_user_id_tic_id_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.star_unlocks
    ADD CONSTRAINT star_unlocks_user_id_tic_id_key UNIQUE (user_id, tic_id);


--
-- Name: stars stars_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.stars
    ADD CONSTRAINT stars_pkey PRIMARY KEY (tic_id);


--
-- Name: stats_snapshots stats_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.stats_snapshots
    ADD CONSTRAINT stats_snapshots_pkey PRIMARY KEY (id);


--
-- Name: submissions submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_pkey PRIMARY KEY (id);


--
-- Name: submissions submissions_request_id_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_request_id_key UNIQUE (request_id);


--
-- Name: tutorial_stars tutorial_stars_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.tutorial_stars
    ADD CONSTRAINT tutorial_stars_pkey PRIMARY KEY (seq);


--
-- Name: notifications uq_notification_event; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT uq_notification_event UNIQUE (user_id, event_key);


--
-- Name: notifications uq_notification_publication; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT uq_notification_publication UNIQUE (user_id, publication_seq);


--
-- Name: publication_bundles uq_publication_bundles_tic_bundle_version; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.publication_bundles
    ADD CONSTRAINT uq_publication_bundles_tic_bundle_version UNIQUE (tic_id, bundle_version);


--
-- Name: star_unlocks uq_star_unlocks_user_layout_ordinal; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.star_unlocks
    ADD CONSTRAINT uq_star_unlocks_user_layout_ordinal UNIQUE (user_id, layout_ordinal);


--
-- Name: user_candidate_achievements user_candidate_achievements_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.user_candidate_achievements
    ADD CONSTRAINT user_candidate_achievements_pkey PRIMARY KEY (id);


--
-- Name: user_candidate_achievements user_candidate_achievements_user_id_candidate_id_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.user_candidate_achievements
    ADD CONSTRAINT user_candidate_achievements_user_id_candidate_id_key UNIQUE (user_id, candidate_id);


--
-- Name: user_settings user_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (user_id);


--
-- Name: user_star_progress user_star_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.user_star_progress
    ADD CONSTRAINT user_star_progress_pkey PRIMARY KEY (id);


--
-- Name: user_star_progress user_star_progress_user_id_tic_id_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.user_star_progress
    ADD CONSTRAINT user_star_progress_user_id_tic_id_key UNIQUE (user_id, tic_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_provider_provider_user_id_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_provider_provider_user_id_key UNIQUE (provider, provider_user_id);


--
-- Name: withdrawal_requests withdrawal_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.withdrawal_requests
    ADD CONSTRAINT withdrawal_requests_pkey PRIMARY KEY (id);


--
-- Name: withdrawal_requests withdrawal_requests_user_id_key; Type: CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.withdrawal_requests
    ADD CONSTRAINT withdrawal_requests_user_id_key UNIQUE (user_id);


--
-- Name: flyway_schema_history_s_idx; Type: INDEX; Schema: public; Owner: planetory
--

CREATE INDEX flyway_schema_history_s_idx ON public.flyway_schema_history USING btree (success);


--
-- Name: ix_comments_post_created; Type: INDEX; Schema: public; Owner: planetory
--

CREATE INDEX ix_comments_post_created ON public.comments USING btree (post_id, created_at);


--
-- Name: ix_notification_inbox; Type: INDEX; Schema: public; Owner: planetory
--

CREATE INDEX ix_notification_inbox ON public.notifications USING btree (user_id, published_at DESC, id DESC) WHERE (published_at IS NOT NULL);


--
-- Name: ix_notification_outbox_pending; Type: INDEX; Schema: public; Owner: planetory
--

CREATE INDEX ix_notification_outbox_pending ON public.notification_outbox USING btree (user_id, id) WHERE (state = 'pending'::text);


--
-- Name: ix_notifications_user_read_created; Type: INDEX; Schema: public; Owner: planetory
--

CREATE INDEX ix_notifications_user_read_created ON public.notifications USING btree (user_id, read_at, created_at DESC);


--
-- Name: ix_posts_body_trgm; Type: INDEX; Schema: public; Owner: planetory
--

CREATE INDEX ix_posts_body_trgm ON public.posts USING gin (body public.gin_trgm_ops);


--
-- Name: ix_posts_tic_kind_created; Type: INDEX; Schema: public; Owner: planetory
--

CREATE INDEX ix_posts_tic_kind_created ON public.posts USING btree (tic_id, kind, created_at DESC);


--
-- Name: ix_posts_title_trgm; Type: INDEX; Schema: public; Owner: planetory
--

CREATE INDEX ix_posts_title_trgm ON public.posts USING gin (title public.gin_trgm_ops);


--
-- Name: ix_posts_user_created; Type: INDEX; Schema: public; Owner: planetory
--

CREATE INDEX ix_posts_user_created ON public.posts USING btree (user_id, created_at DESC);


--
-- Name: ix_published_analyses_candidate_user_published; Type: INDEX; Schema: public; Owner: planetory
--

CREATE INDEX ix_published_analyses_candidate_user_published ON public.published_analyses USING btree (candidate_id, user_id, published_at DESC);


--
-- Name: ix_submissions_candidate_user_created; Type: INDEX; Schema: public; Owner: planetory
--

CREATE INDEX ix_submissions_candidate_user_created ON public.submissions USING btree (matched_candidate_id, user_id, created_at);


--
-- Name: ix_submissions_user_tic_created; Type: INDEX; Schema: public; Owner: planetory
--

CREATE INDEX ix_submissions_user_tic_created ON public.submissions USING btree (user_id, tic_id, created_at DESC);


--
-- Name: uq_challenge_rounds_active; Type: INDEX; Schema: public; Owner: planetory
--

CREATE UNIQUE INDEX uq_challenge_rounds_active ON public.challenge_rounds USING btree (status) WHERE (status = 'active'::text);


--
-- Name: uq_global_stats_singleton; Type: INDEX; Schema: public; Owner: planetory
--

CREATE UNIQUE INDEX uq_global_stats_singleton ON public.global_stats USING btree (singleton);


--
-- Name: uq_notifications_reopen_per_bundle; Type: INDEX; Schema: public; Owner: planetory
--

CREATE UNIQUE INDEX uq_notifications_reopen_per_bundle ON public.notifications USING btree (user_id, ((payload ->> 'ticId'::text)), ((payload ->> 'bundleId'::text))) WHERE (type = 'reopen'::text);


--
-- Name: uq_operation_settings_applied_at; Type: INDEX; Schema: public; Owner: planetory
--

CREATE UNIQUE INDEX uq_operation_settings_applied_at ON public.operation_settings USING btree (applied_at);


--
-- Name: uq_posts_system_candidate; Type: INDEX; Schema: public; Owner: planetory
--

CREATE UNIQUE INDEX uq_posts_system_candidate ON public.posts USING btree (candidate_id) WHERE (kind = 'system_thread'::text);


--
-- Name: uq_publication_bundles_current; Type: INDEX; Schema: public; Owner: planetory
--

CREATE UNIQUE INDEX uq_publication_bundles_current ON public.publication_bundles USING btree (tic_id) WHERE (status = 'current'::text);


--
-- Name: uq_stats_snapshot_scope_date; Type: INDEX; Schema: public; Owner: planetory
--

CREATE UNIQUE INDEX uq_stats_snapshot_scope_date ON public.stats_snapshots USING btree (snapshot_date, scope, round_id) NULLS NOT DISTINCT;


--
-- Name: uq_users_nickname_lower; Type: INDEX; Schema: public; Owner: planetory
--

CREATE UNIQUE INDEX uq_users_nickname_lower ON public.users USING btree (lower(nickname));


--
-- Name: candidates candidates_official_summary; Type: TRIGGER; Schema: public; Owner: planetory
--

CREATE TRIGGER candidates_official_summary AFTER UPDATE OF period_days, epoch_btjd, duration_hours, depth_ppm ON public.candidates FOR EACH ROW WHEN (((((old.period_days IS DISTINCT FROM new.period_days) OR (old.epoch_btjd IS DISTINCT FROM new.epoch_btjd)) OR (old.duration_hours IS DISTINCT FROM new.duration_hours)) OR (old.depth_ppm IS DISTINCT FROM new.depth_ppm))) EXECUTE FUNCTION public.candidates_official_summary();


--
-- Name: challenge_rounds challenge_notification_start; Type: TRIGGER; Schema: public; Owner: planetory
--

CREATE TRIGGER challenge_notification_start BEFORE INSERT OR UPDATE ON public.challenge_rounds FOR EACH ROW EXECUTE FUNCTION public.capture_challenge_notification();


--
-- Name: ai_evaluations notification_ai_changed; Type: TRIGGER; Schema: public; Owner: planetory
--

CREATE CONSTRAINT TRIGGER notification_ai_changed AFTER INSERT OR UPDATE ON public.ai_evaluations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.notification_signal_trigger();


--
-- Name: ai_executions notification_ai_execution_changed; Type: TRIGGER; Schema: public; Owner: planetory
--

CREATE CONSTRAINT TRIGGER notification_ai_execution_changed AFTER INSERT OR UPDATE ON public.ai_executions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.notification_signal_trigger();


--
-- Name: publication_bundles notification_bundle_published; Type: TRIGGER; Schema: public; Owner: planetory
--

CREATE CONSTRAINT TRIGGER notification_bundle_published AFTER INSERT OR UPDATE ON public.publication_bundles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.notification_bundle_published();


--
-- Name: candidates notification_candidate_change; Type: TRIGGER; Schema: public; Owner: planetory
--

CREATE TRIGGER notification_candidate_change AFTER INSERT OR UPDATE ON public.candidates FOR EACH ROW EXECUTE FUNCTION public.notification_candidate_change();


--
-- Name: candidate_dispositions notification_disposition_changed; Type: TRIGGER; Schema: public; Owner: planetory
--

CREATE CONSTRAINT TRIGGER notification_disposition_changed AFTER INSERT OR UPDATE ON public.candidate_dispositions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.notification_signal_trigger();


--
-- Name: posts posts_official_summary; Type: TRIGGER; Schema: public; Owner: planetory
--

CREATE TRIGGER posts_official_summary BEFORE INSERT OR UPDATE OF kind, candidate_id, tic_id, body ON public.posts FOR EACH ROW EXECUTE FUNCTION public.posts_official_summary();


--
-- Name: star_unlocks star_board_open_on_unlock; Type: TRIGGER; Schema: public; Owner: planetory
--

CREATE TRIGGER star_board_open_on_unlock AFTER INSERT ON public.star_unlocks FOR EACH ROW EXECUTE FUNCTION public.mark_star_board_open();


--
-- Name: challenge_round_extra_targets trg_challenge_round_extra_targets_published; Type: TRIGGER; Schema: public; Owner: planetory
--

CREATE TRIGGER trg_challenge_round_extra_targets_published BEFORE INSERT OR UPDATE OF tic_id ON public.challenge_round_extra_targets FOR EACH ROW EXECUTE FUNCTION public.exploration_target_must_be_published('tic_id');


--
-- Name: challenge_rounds trg_challenge_rounds_published; Type: TRIGGER; Schema: public; Owner: planetory
--

CREATE TRIGGER trg_challenge_rounds_published BEFORE INSERT OR UPDATE OF target_tic_id ON public.challenge_rounds FOR EACH ROW EXECUTE FUNCTION public.exploration_target_must_be_published('target_tic_id');


--
-- Name: operation_settings trg_operation_settings_keep_history; Type: TRIGGER; Schema: public; Owner: planetory
--

CREATE TRIGGER trg_operation_settings_keep_history BEFORE INSERT OR DELETE OR UPDATE ON public.operation_settings FOR EACH ROW EXECUTE FUNCTION public.operation_settings_keep_history();


--
-- Name: operation_settings trg_operation_settings_no_truncate; Type: TRIGGER; Schema: public; Owner: planetory
--

CREATE TRIGGER trg_operation_settings_no_truncate BEFORE TRUNCATE ON public.operation_settings FOR EACH STATEMENT EXECUTE FUNCTION public.operation_settings_keep_history();


--
-- Name: tutorial_stars trg_tutorial_stars_published; Type: TRIGGER; Schema: public; Owner: planetory
--

CREATE TRIGGER trg_tutorial_stars_published BEFORE INSERT OR UPDATE OF tic_id ON public.tutorial_stars FOR EACH ROW EXECUTE FUNCTION public.exploration_target_must_be_published('tic_id');


--
-- Name: ai_evaluations fk_ai_evaluations_candidate_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.ai_evaluations
    ADD CONSTRAINT fk_ai_evaluations_candidate_id FOREIGN KEY (candidate_id) REFERENCES public.candidates(id);


--
-- Name: ai_evaluations fk_ai_evaluations_execution_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.ai_evaluations
    ADD CONSTRAINT fk_ai_evaluations_execution_id FOREIGN KEY (execution_id) REFERENCES public.ai_executions(id);


--
-- Name: analysis_histories fk_analysis_histories_submission_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.analysis_histories
    ADD CONSTRAINT fk_analysis_histories_submission_id FOREIGN KEY (submission_id) REFERENCES public.submissions(id);


--
-- Name: analysis_histories fk_analysis_histories_tic_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.analysis_histories
    ADD CONSTRAINT fk_analysis_histories_tic_id FOREIGN KEY (tic_id) REFERENCES public.stars(tic_id);


--
-- Name: analysis_histories fk_analysis_histories_user_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.analysis_histories
    ADD CONSTRAINT fk_analysis_histories_user_id FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: analysis_snapshots fk_analysis_snapshots_history_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.analysis_snapshots
    ADD CONSTRAINT fk_analysis_snapshots_history_id FOREIGN KEY (history_id) REFERENCES public.analysis_histories(id);


--
-- Name: candidate_aliases fk_candidate_aliases_candidate_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.candidate_aliases
    ADD CONSTRAINT fk_candidate_aliases_candidate_id FOREIGN KEY (candidate_id) REFERENCES public.candidates(id);


--
-- Name: candidate_dispositions fk_candidate_dispositions_candidate_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.candidate_dispositions
    ADD CONSTRAINT fk_candidate_dispositions_candidate_id FOREIGN KEY (candidate_id) REFERENCES public.candidates(id);


--
-- Name: candidate_status_history fk_candidate_status_history_bundle_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.candidate_status_history
    ADD CONSTRAINT fk_candidate_status_history_bundle_id FOREIGN KEY (bundle_id) REFERENCES public.publication_bundles(id);


--
-- Name: candidate_status_history fk_candidate_status_history_candidate_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.candidate_status_history
    ADD CONSTRAINT fk_candidate_status_history_candidate_id FOREIGN KEY (candidate_id) REFERENCES public.candidates(id);


--
-- Name: candidates fk_candidates_tic_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT fk_candidates_tic_id FOREIGN KEY (tic_id) REFERENCES public.stars(tic_id);


--
-- Name: candidates fk_candidates_updated_bundle_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.candidates
    ADD CONSTRAINT fk_candidates_updated_bundle_id FOREIGN KEY (updated_bundle_id) REFERENCES public.publication_bundles(id);


--
-- Name: challenge_round_extra_targets fk_challenge_round_extra_targets_round_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.challenge_round_extra_targets
    ADD CONSTRAINT fk_challenge_round_extra_targets_round_id FOREIGN KEY (round_id) REFERENCES public.challenge_rounds(id);


--
-- Name: challenge_round_extra_targets fk_challenge_round_extra_targets_tic_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.challenge_round_extra_targets
    ADD CONSTRAINT fk_challenge_round_extra_targets_tic_id FOREIGN KEY (tic_id) REFERENCES public.stars(tic_id);


--
-- Name: challenge_rounds fk_challenge_rounds_target_tic_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.challenge_rounds
    ADD CONSTRAINT fk_challenge_rounds_target_tic_id FOREIGN KEY (target_tic_id) REFERENCES public.stars(tic_id);


--
-- Name: comment_history_attachments fk_comment_history_attachments_comment_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.comment_history_attachments
    ADD CONSTRAINT fk_comment_history_attachments_comment_id FOREIGN KEY (comment_id) REFERENCES public.comments(id);


--
-- Name: comment_history_attachments fk_comment_history_attachments_history_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.comment_history_attachments
    ADD CONSTRAINT fk_comment_history_attachments_history_id FOREIGN KEY (history_id) REFERENCES public.analysis_histories(id);


--
-- Name: comments fk_comments_post_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT fk_comments_post_id FOREIGN KEY (post_id) REFERENCES public.posts(id);


--
-- Name: comments fk_comments_user_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT fk_comments_user_id FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: external_signal_references fk_external_signal_references_candidate_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.external_signal_references
    ADD CONSTRAINT fk_external_signal_references_candidate_id FOREIGN KEY (candidate_id) REFERENCES public.candidates(id);


--
-- Name: external_signal_references fk_external_signal_references_tic_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.external_signal_references
    ADD CONSTRAINT fk_external_signal_references_tic_id FOREIGN KEY (tic_id) REFERENCES public.stars(tic_id);


--
-- Name: follows fk_follows_user_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT fk_follows_user_id FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: light_curve_segments fk_light_curve_segments_tic_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.light_curve_segments
    ADD CONSTRAINT fk_light_curve_segments_tic_id FOREIGN KEY (tic_id) REFERENCES public.stars(tic_id);


--
-- Name: member_sky_revisions fk_member_sky_revisions_user_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.member_sky_revisions
    ADD CONSTRAINT fk_member_sky_revisions_user_id FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: notifications fk_notifications_user_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT fk_notifications_user_id FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: observation_datasets fk_observation_datasets_tic_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.observation_datasets
    ADD CONSTRAINT fk_observation_datasets_tic_id FOREIGN KEY (tic_id) REFERENCES public.stars(tic_id);


--
-- Name: periodograms fk_periodograms_bundle_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.periodograms
    ADD CONSTRAINT fk_periodograms_bundle_id FOREIGN KEY (bundle_id) REFERENCES public.publication_bundles(id);


--
-- Name: post_history_attachments fk_post_history_attachments_history_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.post_history_attachments
    ADD CONSTRAINT fk_post_history_attachments_history_id FOREIGN KEY (history_id) REFERENCES public.analysis_histories(id);


--
-- Name: post_history_attachments fk_post_history_attachments_post_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.post_history_attachments
    ADD CONSTRAINT fk_post_history_attachments_post_id FOREIGN KEY (post_id) REFERENCES public.posts(id);


--
-- Name: post_reactions fk_post_reactions_post_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.post_reactions
    ADD CONSTRAINT fk_post_reactions_post_id FOREIGN KEY (post_id) REFERENCES public.posts(id);


--
-- Name: post_reactions fk_post_reactions_user_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.post_reactions
    ADD CONSTRAINT fk_post_reactions_user_id FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: post_source_links fk_post_source_links_comment_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.post_source_links
    ADD CONSTRAINT fk_post_source_links_comment_id FOREIGN KEY (comment_id) REFERENCES public.comments(id);


--
-- Name: post_source_links fk_post_source_links_post_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.post_source_links
    ADD CONSTRAINT fk_post_source_links_post_id FOREIGN KEY (post_id) REFERENCES public.posts(id);


--
-- Name: posts fk_posts_candidate_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT fk_posts_candidate_id FOREIGN KEY (candidate_id) REFERENCES public.candidates(id);


--
-- Name: posts fk_posts_tic_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT fk_posts_tic_id FOREIGN KEY (tic_id) REFERENCES public.stars(tic_id);


--
-- Name: posts fk_posts_user_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT fk_posts_user_id FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: publication_bundles fk_publication_bundles_tic_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.publication_bundles
    ADD CONSTRAINT fk_publication_bundles_tic_id FOREIGN KEY (tic_id) REFERENCES public.stars(tic_id);


--
-- Name: published_analyses fk_published_analyses_candidate_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.published_analyses
    ADD CONSTRAINT fk_published_analyses_candidate_id FOREIGN KEY (candidate_id) REFERENCES public.candidates(id);


--
-- Name: published_analyses fk_published_analyses_history_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.published_analyses
    ADD CONSTRAINT fk_published_analyses_history_id FOREIGN KEY (history_id) REFERENCES public.analysis_histories(id);


--
-- Name: published_analyses fk_published_analyses_post_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.published_analyses
    ADD CONSTRAINT fk_published_analyses_post_id FOREIGN KEY (post_id) REFERENCES public.posts(id);


--
-- Name: published_analyses fk_published_analyses_user_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.published_analyses
    ADD CONSTRAINT fk_published_analyses_user_id FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: star_unlocks fk_star_unlocks_tic_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.star_unlocks
    ADD CONSTRAINT fk_star_unlocks_tic_id FOREIGN KEY (tic_id) REFERENCES public.stars(tic_id);


--
-- Name: star_unlocks fk_star_unlocks_trigger_achievement_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.star_unlocks
    ADD CONSTRAINT fk_star_unlocks_trigger_achievement_id FOREIGN KEY (trigger_achievement_id) REFERENCES public.user_candidate_achievements(id);


--
-- Name: star_unlocks fk_star_unlocks_trigger_tic_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.star_unlocks
    ADD CONSTRAINT fk_star_unlocks_trigger_tic_id FOREIGN KEY (trigger_tic_id) REFERENCES public.stars(tic_id);


--
-- Name: star_unlocks fk_star_unlocks_user_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.star_unlocks
    ADD CONSTRAINT fk_star_unlocks_user_id FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: stats_snapshots fk_stats_snapshots_round_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.stats_snapshots
    ADD CONSTRAINT fk_stats_snapshots_round_id FOREIGN KEY (round_id) REFERENCES public.challenge_rounds(id);


--
-- Name: submissions fk_submissions_bundle_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT fk_submissions_bundle_id FOREIGN KEY (bundle_id) REFERENCES public.publication_bundles(id);


--
-- Name: submissions fk_submissions_detail_target_candidate_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT fk_submissions_detail_target_candidate_id FOREIGN KEY (detail_target_candidate_id) REFERENCES public.candidates(id);


--
-- Name: submissions fk_submissions_matched_candidate_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT fk_submissions_matched_candidate_id FOREIGN KEY (matched_candidate_id) REFERENCES public.candidates(id);


--
-- Name: submissions fk_submissions_retry_of_submission_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT fk_submissions_retry_of_submission_id FOREIGN KEY (retry_of_submission_id) REFERENCES public.submissions(id);


--
-- Name: submissions fk_submissions_rule_version; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT fk_submissions_rule_version FOREIGN KEY (rule_version) REFERENCES public.operation_settings(rule_version);


--
-- Name: submissions fk_submissions_tic_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT fk_submissions_tic_id FOREIGN KEY (tic_id) REFERENCES public.stars(tic_id);


--
-- Name: submissions fk_submissions_user_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT fk_submissions_user_id FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: tutorial_stars fk_tutorial_stars_tic_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.tutorial_stars
    ADD CONSTRAINT fk_tutorial_stars_tic_id FOREIGN KEY (tic_id) REFERENCES public.stars(tic_id);


--
-- Name: user_candidate_achievements fk_user_candidate_achievements_candidate_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.user_candidate_achievements
    ADD CONSTRAINT fk_user_candidate_achievements_candidate_id FOREIGN KEY (candidate_id) REFERENCES public.candidates(id);


--
-- Name: user_candidate_achievements fk_user_candidate_achievements_recognized_analysis_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.user_candidate_achievements
    ADD CONSTRAINT fk_user_candidate_achievements_recognized_analysis_id FOREIGN KEY (recognized_analysis_id) REFERENCES public.published_analyses(id);


--
-- Name: user_candidate_achievements fk_user_candidate_achievements_recognized_submission_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.user_candidate_achievements
    ADD CONSTRAINT fk_user_candidate_achievements_recognized_submission_id FOREIGN KEY (recognized_submission_id) REFERENCES public.submissions(id);


--
-- Name: user_candidate_achievements fk_user_candidate_achievements_user_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.user_candidate_achievements
    ADD CONSTRAINT fk_user_candidate_achievements_user_id FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_settings fk_user_settings_user_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT fk_user_settings_user_id FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_star_progress fk_user_star_progress_tic_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.user_star_progress
    ADD CONSTRAINT fk_user_star_progress_tic_id FOREIGN KEY (tic_id) REFERENCES public.stars(tic_id);


--
-- Name: user_star_progress fk_user_star_progress_user_id; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.user_star_progress
    ADD CONSTRAINT fk_user_star_progress_user_id FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: nasa_explanation_daily_usage nasa_explanation_daily_usage_member_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_explanation_daily_usage
    ADD CONSTRAINT nasa_explanation_daily_usage_member_id_fkey FOREIGN KEY (member_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: nasa_planet_explanation nasa_planet_explanation_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_planet_explanation
    ADD CONSTRAINT nasa_planet_explanation_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.nasa_planet_info(candidate_id);


--
-- Name: nasa_planet_info nasa_planet_info_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_planet_info
    ADD CONSTRAINT nasa_planet_info_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id);


--
-- Name: nasa_planet_info nasa_planet_info_tic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_planet_info
    ADD CONSTRAINT nasa_planet_info_tic_id_fkey FOREIGN KEY (tic_id) REFERENCES public.stars(tic_id);


--
-- Name: nasa_star_catalog nasa_star_catalog_tic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_star_catalog
    ADD CONSTRAINT nasa_star_catalog_tic_id_fkey FOREIGN KEY (tic_id) REFERENCES public.stars(tic_id);


--
-- Name: nasa_star_planet_explanation nasa_star_planet_explanation_tic_id_planet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_star_planet_explanation
    ADD CONSTRAINT nasa_star_planet_explanation_tic_id_planet_id_fkey FOREIGN KEY (tic_id, planet_id) REFERENCES public.nasa_star_planet(tic_id, planet_id);


--
-- Name: nasa_star_planet nasa_star_planet_tic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.nasa_star_planet
    ADD CONSTRAINT nasa_star_planet_tic_id_fkey FOREIGN KEY (tic_id) REFERENCES public.nasa_star_catalog(tic_id);


--
-- Name: notification_candidate_changes notification_candidate_changes_bundle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.notification_candidate_changes
    ADD CONSTRAINT notification_candidate_changes_bundle_id_fkey FOREIGN KEY (bundle_id) REFERENCES public.publication_bundles(id);


--
-- Name: notification_candidate_changes notification_candidate_changes_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.notification_candidate_changes
    ADD CONSTRAINT notification_candidate_changes_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE;


--
-- Name: notification_signal_state notification_signal_state_candidate_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: planetory
--

ALTER TABLE ONLY public.notification_signal_state
    ADD CONSTRAINT notification_signal_state_candidate_id_fkey FOREIGN KEY (candidate_id) REFERENCES public.candidates(id) ON DELETE CASCADE;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO planetory_gold_writer;
GRANT USAGE ON SCHEMA public TO planetory_app;
GRANT USAGE ON SCHEMA public TO planetory_stats_job;


--
-- Name: FUNCTION candidates_official_summary(); Type: ACL; Schema: public; Owner: planetory
--

REVOKE ALL ON FUNCTION public.candidates_official_summary() FROM PUBLIC;


--
-- Name: FUNCTION cleanup_withdrawn_member(member bigint); Type: ACL; Schema: public; Owner: planetory
--

REVOKE ALL ON FUNCTION public.cleanup_withdrawn_member(member bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cleanup_withdrawn_member(member bigint) TO planetory_app;


--
-- Name: FUNCTION mark_star_board_open(); Type: ACL; Schema: public; Owner: planetory
--

REVOKE ALL ON FUNCTION public.mark_star_board_open() FROM PUBLIC;


--
-- Name: FUNCTION notification_bundle_published(); Type: ACL; Schema: public; Owner: planetory
--

REVOKE ALL ON FUNCTION public.notification_bundle_published() FROM PUBLIC;


--
-- Name: FUNCTION notification_candidate_change(); Type: ACL; Schema: public; Owner: planetory
--

REVOKE ALL ON FUNCTION public.notification_candidate_change() FROM PUBLIC;


--
-- Name: FUNCTION notification_signal_changed(candidate bigint); Type: ACL; Schema: public; Owner: planetory
--

REVOKE ALL ON FUNCTION public.notification_signal_changed(candidate bigint) FROM PUBLIC;


--
-- Name: FUNCTION notification_signal_trigger(); Type: ACL; Schema: public; Owner: planetory
--

REVOKE ALL ON FUNCTION public.notification_signal_trigger() FROM PUBLIC;


--
-- Name: FUNCTION official_signal_summary(period numeric, epoch numeric, duration numeric, depth numeric); Type: ACL; Schema: public; Owner: planetory
--

REVOKE ALL ON FUNCTION public.official_signal_summary(period numeric, epoch numeric, duration numeric, depth numeric) FROM PUBLIC;


--
-- Name: FUNCTION posts_official_summary(); Type: ACL; Schema: public; Owner: planetory
--

REVOKE ALL ON FUNCTION public.posts_official_summary() FROM PUBLIC;


--
-- Name: FUNCTION prune_withdrawal_retention(); Type: ACL; Schema: public; Owner: planetory
--

REVOKE ALL ON FUNCTION public.prune_withdrawal_retention() FROM PUBLIC;
GRANT ALL ON FUNCTION public.prune_withdrawal_retention() TO planetory_app;


--
-- Name: TABLE ai_evaluations; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ai_evaluations TO planetory_gold_writer;
GRANT SELECT ON TABLE public.ai_evaluations TO planetory_app;


--
-- Name: SEQUENCE ai_evaluations_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.ai_evaluations_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.ai_evaluations_id_seq TO planetory_app;


--
-- Name: TABLE ai_executions; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ai_executions TO planetory_gold_writer;
GRANT SELECT ON TABLE public.ai_executions TO planetory_app;


--
-- Name: SEQUENCE ai_executions_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.ai_executions_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.ai_executions_id_seq TO planetory_app;


--
-- Name: TABLE analysis_histories; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT ON TABLE public.analysis_histories TO planetory_app;


--
-- Name: SEQUENCE analysis_histories_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.analysis_histories_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.analysis_histories_id_seq TO planetory_app;


--
-- Name: TABLE analysis_snapshots; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT ON TABLE public.analysis_snapshots TO planetory_app;


--
-- Name: TABLE candidate_aliases; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.candidate_aliases TO planetory_gold_writer;
GRANT SELECT ON TABLE public.candidate_aliases TO planetory_app;


--
-- Name: SEQUENCE candidate_aliases_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.candidate_aliases_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.candidate_aliases_id_seq TO planetory_app;


--
-- Name: TABLE candidate_dispositions; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.candidate_dispositions TO planetory_gold_writer;
GRANT SELECT ON TABLE public.candidate_dispositions TO planetory_app;
GRANT SELECT ON TABLE public.candidate_dispositions TO planetory_stats_job;


--
-- Name: TABLE candidate_status_history; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.candidate_status_history TO planetory_gold_writer;
GRANT SELECT ON TABLE public.candidate_status_history TO planetory_app;


--
-- Name: SEQUENCE candidate_status_history_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.candidate_status_history_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.candidate_status_history_id_seq TO planetory_app;


--
-- Name: TABLE candidates; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.candidates TO planetory_gold_writer;
GRANT SELECT ON TABLE public.candidates TO planetory_app;


--
-- Name: SEQUENCE candidates_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.candidates_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.candidates_id_seq TO planetory_app;


--
-- Name: TABLE challenge_round_extra_targets; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT ON TABLE public.challenge_round_extra_targets TO planetory_app;


--
-- Name: TABLE challenge_rounds; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT ON TABLE public.challenge_rounds TO planetory_app;


--
-- Name: TABLE challenge_round_targets; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT ON TABLE public.challenge_round_targets TO planetory_app;


--
-- Name: SEQUENCE challenge_rounds_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.challenge_rounds_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.challenge_rounds_id_seq TO planetory_app;


--
-- Name: TABLE comment_history_attachments; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE ON TABLE public.comment_history_attachments TO planetory_app;


--
-- Name: SEQUENCE comment_history_attachments_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.comment_history_attachments_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.comment_history_attachments_id_seq TO planetory_app;


--
-- Name: TABLE comments; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.comments TO planetory_app;


--
-- Name: SEQUENCE comments_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.comments_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.comments_id_seq TO planetory_app;


--
-- Name: TABLE external_signal_references; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.external_signal_references TO planetory_gold_writer;
GRANT SELECT ON TABLE public.external_signal_references TO planetory_app;


--
-- Name: SEQUENCE external_signal_references_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.external_signal_references_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.external_signal_references_id_seq TO planetory_app;


--
-- Name: TABLE follows; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE ON TABLE public.follows TO planetory_app;


--
-- Name: SEQUENCE follows_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.follows_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.follows_id_seq TO planetory_app;


--
-- Name: TABLE observation_datasets; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.observation_datasets TO planetory_gold_writer;
GRANT SELECT ON TABLE public.observation_datasets TO planetory_app;


--
-- Name: TABLE posts; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.posts TO planetory_app;


--
-- Name: TABLE published_analyses; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT ON TABLE public.published_analyses TO planetory_app;


--
-- Name: COLUMN published_analyses.unpublished_at; Type: ACL; Schema: public; Owner: planetory
--

GRANT UPDATE(unpublished_at) ON TABLE public.published_analyses TO planetory_app;


--
-- Name: COLUMN published_analyses.withdrawn_at; Type: ACL; Schema: public; Owner: planetory
--

GRANT UPDATE(withdrawn_at) ON TABLE public.published_analyses TO planetory_app;


--
-- Name: TABLE star_unlocks; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.star_unlocks TO planetory_app;


--
-- Name: TABLE stars; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.stars TO planetory_gold_writer;
GRANT SELECT ON TABLE public.stars TO planetory_app;


--
-- Name: TABLE submissions; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.submissions TO planetory_app;
GRANT SELECT ON TABLE public.submissions TO planetory_stats_job;


--
-- Name: TABLE user_candidate_achievements; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.user_candidate_achievements TO planetory_app;
GRANT SELECT ON TABLE public.user_candidate_achievements TO planetory_stats_job;


--
-- Name: TABLE user_star_progress; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.user_star_progress TO planetory_app;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.users TO planetory_app;
GRANT SELECT ON TABLE public.users TO planetory_stats_job;


--
-- Name: TABLE global_stats; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT ON TABLE public.global_stats TO planetory_app;
GRANT SELECT,MAINTAIN ON TABLE public.global_stats TO planetory_stats_job;


--
-- Name: TABLE light_curve_segments; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.light_curve_segments TO planetory_gold_writer;
GRANT SELECT ON TABLE public.light_curve_segments TO planetory_app;


--
-- Name: SEQUENCE light_curve_segments_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.light_curve_segments_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.light_curve_segments_id_seq TO planetory_app;


--
-- Name: TABLE member_sky_revisions; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.member_sky_revisions TO planetory_app;


--
-- Name: TABLE nasa_explanation_daily_total; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.nasa_explanation_daily_total TO planetory_app;


--
-- Name: TABLE nasa_explanation_daily_usage; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.nasa_explanation_daily_usage TO planetory_app;


--
-- Name: TABLE nasa_planet_explanation; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.nasa_planet_explanation TO planetory_app;


--
-- Name: TABLE nasa_planet_info; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.nasa_planet_info TO planetory_app;


--
-- Name: TABLE nasa_star_catalog; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.nasa_star_catalog TO planetory_app;


--
-- Name: TABLE nasa_star_planet; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.nasa_star_planet TO planetory_app;


--
-- Name: TABLE nasa_star_planet_explanation; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.nasa_star_planet_explanation TO planetory_app;


--
-- Name: TABLE notification_outbox; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT ON TABLE public.notification_outbox TO planetory_app;


--
-- Name: COLUMN notification_outbox.payload; Type: ACL; Schema: public; Owner: planetory
--

GRANT UPDATE(payload) ON TABLE public.notification_outbox TO planetory_app;


--
-- Name: COLUMN notification_outbox.preference_epoch; Type: ACL; Schema: public; Owner: planetory
--

GRANT UPDATE(preference_epoch) ON TABLE public.notification_outbox TO planetory_app;


--
-- Name: COLUMN notification_outbox.follow_id; Type: ACL; Schema: public; Owner: planetory
--

GRANT UPDATE(follow_id) ON TABLE public.notification_outbox TO planetory_app;


--
-- Name: COLUMN notification_outbox.source_notification_id; Type: ACL; Schema: public; Owner: planetory
--

GRANT UPDATE(source_notification_id) ON TABLE public.notification_outbox TO planetory_app;


--
-- Name: COLUMN notification_outbox.state; Type: ACL; Schema: public; Owner: planetory
--

GRANT UPDATE(state) ON TABLE public.notification_outbox TO planetory_app;


--
-- Name: COLUMN notification_outbox.follow_epoch; Type: ACL; Schema: public; Owner: planetory
--

GRANT UPDATE(follow_epoch) ON TABLE public.notification_outbox TO planetory_app;


--
-- Name: SEQUENCE notification_outbox_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.notification_outbox_id_seq TO planetory_app;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT ON TABLE public.notifications TO planetory_app;


--
-- Name: COLUMN notifications.read_at; Type: ACL; Schema: public; Owner: planetory
--

GRANT UPDATE(read_at) ON TABLE public.notifications TO planetory_app;


--
-- Name: COLUMN notifications.event_key; Type: ACL; Schema: public; Owner: planetory
--

GRANT UPDATE(event_key) ON TABLE public.notifications TO planetory_app;


--
-- Name: COLUMN notifications.published_at; Type: ACL; Schema: public; Owner: planetory
--

GRANT UPDATE(published_at) ON TABLE public.notifications TO planetory_app;


--
-- Name: COLUMN notifications.publication_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT UPDATE(publication_seq) ON TABLE public.notifications TO planetory_app;


--
-- Name: SEQUENCE notifications_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.notifications_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.notifications_id_seq TO planetory_app;


--
-- Name: SEQUENCE observation_datasets_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.observation_datasets_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.observation_datasets_id_seq TO planetory_app;


--
-- Name: TABLE operation_settings; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT ON TABLE public.operation_settings TO planetory_app;


--
-- Name: TABLE periodograms; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.periodograms TO planetory_gold_writer;
GRANT SELECT ON TABLE public.periodograms TO planetory_app;


--
-- Name: TABLE post_history_attachments; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE ON TABLE public.post_history_attachments TO planetory_app;


--
-- Name: SEQUENCE post_history_attachments_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.post_history_attachments_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.post_history_attachments_id_seq TO planetory_app;


--
-- Name: TABLE post_reactions; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.post_reactions TO planetory_app;


--
-- Name: SEQUENCE post_reactions_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.post_reactions_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.post_reactions_id_seq TO planetory_app;


--
-- Name: TABLE post_source_links; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE ON TABLE public.post_source_links TO planetory_app;


--
-- Name: SEQUENCE post_source_links_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.post_source_links_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.post_source_links_id_seq TO planetory_app;


--
-- Name: SEQUENCE posts_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.posts_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.posts_id_seq TO planetory_app;


--
-- Name: TABLE publication_bundles; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.publication_bundles TO planetory_gold_writer;
GRANT SELECT ON TABLE public.publication_bundles TO planetory_app;


--
-- Name: SEQUENCE publication_bundles_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.publication_bundles_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.publication_bundles_id_seq TO planetory_app;


--
-- Name: SEQUENCE published_analyses_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.published_analyses_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.published_analyses_id_seq TO planetory_app;


--
-- Name: SEQUENCE star_unlocks_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.star_unlocks_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.star_unlocks_id_seq TO planetory_app;


--
-- Name: TABLE stats_snapshots; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT ON TABLE public.stats_snapshots TO planetory_app;
GRANT SELECT,INSERT ON TABLE public.stats_snapshots TO planetory_stats_job;


--
-- Name: SEQUENCE stats_snapshots_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.stats_snapshots_id_seq TO planetory_gold_writer;
GRANT USAGE ON SEQUENCE public.stats_snapshots_id_seq TO planetory_stats_job;


--
-- Name: SEQUENCE submissions_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.submissions_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.submissions_id_seq TO planetory_app;


--
-- Name: TABLE tutorial_stars; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT ON TABLE public.tutorial_stars TO planetory_app;


--
-- Name: SEQUENCE user_candidate_achievements_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.user_candidate_achievements_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.user_candidate_achievements_id_seq TO planetory_app;


--
-- Name: TABLE user_settings; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.user_settings TO planetory_app;


--
-- Name: SEQUENCE user_star_progress_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.user_star_progress_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.user_star_progress_id_seq TO planetory_app;


--
-- Name: SEQUENCE users_id_seq; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,USAGE ON SEQUENCE public.users_id_seq TO planetory_gold_writer;
GRANT SELECT,USAGE ON SEQUENCE public.users_id_seq TO planetory_app;


--
-- Name: TABLE withdrawal_requests; Type: ACL; Schema: public; Owner: planetory
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.withdrawal_requests TO planetory_app;


--
-- PostgreSQL database dump complete
--

\unrestrict vooPMJiEQBMoskiffUZ1gp5P8U2xtDlHvU1pboJm4cchYwiwslEEgohweg47exw
