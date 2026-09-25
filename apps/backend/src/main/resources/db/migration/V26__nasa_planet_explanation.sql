-- S15P21C206-267: V25의 검증된 후보 자료에만 연결되는 한국어 설명 캐시.
CREATE TABLE nasa_planet_explanation (
    candidate_id BIGINT PRIMARY KEY REFERENCES nasa_planet_info(candidate_id),
    source_hash TEXT NOT NULL,
    source_version SMALLINT NOT NULL CHECK (source_version > 0),
    model_name TEXT NOT NULL CHECK (model_name <> ''),
    prompt_version TEXT NOT NULL CHECK (prompt_version <> ''),
    status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
    content JSONB,
    generated_at TIMESTAMPTZ,
    last_attempt_at TIMESTAMPTZ NOT NULL,
    next_retry_at TIMESTAMPTZ NOT NULL,
    in_flight_until TIMESTAMPTZ,
    attempt_generation BIGINT NOT NULL DEFAULT 1 CHECK (attempt_generation > 0),
    attempt_count SMALLINT NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 3),
    last_failure TEXT,
    CHECK ((status = 'ready') = (content IS NOT NULL AND generated_at IS NOT NULL)),
    CHECK (status <> 'ready' OR in_flight_until IS NULL)
);

COMMENT ON TABLE nasa_planet_explanation IS '267: V25의 현재 정상 원천 해시·버전에 묶인 한국어 설명';
COMMENT ON COLUMN nasa_planet_explanation.attempt_generation IS '설명 생성 임대 순번. 늦게 끝난 모델 응답의 저장을 막는다';
COMMENT ON COLUMN nasa_planet_explanation.attempt_count IS '같은 원천·모델·프롬프트 조합의 최대 생성 시도 3회';

GRANT SELECT, INSERT, UPDATE ON nasa_planet_explanation TO planetory_app;
