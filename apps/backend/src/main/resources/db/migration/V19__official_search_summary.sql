-- 공개 후보 네 수치만 검색 본문에 투영한다. 회원 메모·정답·개별 분석은 포함하지 않는다.
-- 현재 candidates의 네 열은 NOT NULL이다. '미정'은 함수의 방어 표기이며 열의 null 허용을 뜻하지 않는다.
CREATE FUNCTION official_signal_summary(period NUMERIC, epoch NUMERIC, duration NUMERIC, depth NUMERIC)
RETURNS TEXT LANGUAGE SQL IMMUTABLE
AS $$ SELECT '주기 ' || coalesce(trim_scale(period)::text, '미정') || ' 일 · 기준 시각 '
    || coalesce(trim_scale(epoch)::text, '미정') || ' BTJD · 지속시간 '
    || coalesce(trim_scale(duration)::text, '미정') || ' 시간 · 깊이 '
    || coalesce(trim_scale(depth)::text, '미정') || ' ppm' $$;

CREATE FUNCTION posts_official_summary() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
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

CREATE FUNCTION candidates_official_summary() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
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

-- Gold writer에 posts 쓰기 권한을 주지 않는다. 소유자 함수의 탐색 경로는 신뢰 스키마에 고정한다.
DO $$
DECLARE target_schema TEXT := current_schema();
BEGIN
    EXECUTE format('ALTER FUNCTION official_signal_summary(NUMERIC,NUMERIC,NUMERIC,NUMERIC) SET search_path = pg_catalog, %I, pg_temp', target_schema);
    EXECUTE format('ALTER FUNCTION posts_official_summary() SET search_path = pg_catalog, %I, pg_temp', target_schema);
    EXECUTE format('ALTER FUNCTION candidates_official_summary() SET search_path = pg_catalog, %I, pg_temp', target_schema);
END $$;
REVOKE ALL ON FUNCTION official_signal_summary(NUMERIC,NUMERIC,NUMERIC,NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION posts_official_summary() FROM PUBLIC;
REVOKE ALL ON FUNCTION candidates_official_summary() FROM PUBLIC;

CREATE TRIGGER posts_official_summary BEFORE INSERT OR UPDATE OF kind,candidate_id,tic_id,body ON posts
FOR EACH ROW EXECUTE FUNCTION posts_official_summary();
CREATE TRIGGER candidates_official_summary AFTER UPDATE OF period_days,epoch_btjd,duration_hours,depth_ppm ON candidates
FOR EACH ROW WHEN ((OLD.period_days,OLD.epoch_btjd,OLD.duration_hours,OLD.depth_ppm)
    IS DISTINCT FROM (NEW.period_days,NEW.epoch_btjd,NEW.duration_hours,NEW.depth_ppm))
EXECUTE FUNCTION candidates_official_summary();

-- 기존 공식 본문도 같은 템플릿으로 맞춘다. 숨김·삭제 부모의 상태와 생성 시각은 유지한다.
UPDATE posts p SET body=official_signal_summary(c.period_days,c.epoch_btjd,c.duration_hours,c.depth_ppm),
    updated_at=clock_timestamp()
FROM candidates c WHERE p.kind='system_thread' AND p.candidate_id=c.id AND p.tic_id=c.tic_id
    AND p.body IS DISTINCT FROM official_signal_summary(c.period_days,c.epoch_btjd,c.duration_hours,c.depth_ppm);
