-- S15P21C206-270: 결과 페이지의 NASA 전체 참고 목록. 후보·Gold·성과와 연결하지 않는다.
CREATE TABLE nasa_star_catalog (
    tic_id BIGINT PRIMARY KEY REFERENCES stars(tic_id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'empty', 'partial', 'temporarily_unavailable')),
    host_name TEXT,
    fetched_at TIMESTAMPTZ,
    next_refresh_at TIMESTAMPTZ NOT NULL,
    in_flight_until TIMESTAMPTZ,
    attempt_generation BIGINT NOT NULL DEFAULT 1 CHECK (attempt_generation > 0),
    last_refresh_status TEXT NOT NULL
);

CREATE TABLE nasa_star_planet (
    tic_id BIGINT NOT NULL REFERENCES nasa_star_catalog(tic_id),
    planet_id TEXT NOT NULL CHECK (planet_id ~ '^np-[0-9a-f]{64}$'),
    planet_name TEXT NOT NULL CHECK (planet_name <> ''),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    status TEXT NOT NULL CHECK (status IN ('ready', 'identity_unresolved', 'invalid_source')),
    normalized JSONB,
    source_hash TEXT,
    source_version SMALLINT,
    fetched_at TIMESTAMPTZ NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tic_id, planet_id),
    UNIQUE (tic_id, planet_name),
    CHECK ((status = 'ready') = (normalized IS NOT NULL AND source_hash IS NOT NULL AND source_version IS NOT NULL)),
    CHECK (source_hash IS NULL OR source_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE nasa_star_planet_explanation (
    tic_id BIGINT NOT NULL,
    planet_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    source_version SMALLINT NOT NULL CHECK (source_version > 0),
    model_name TEXT NOT NULL CHECK (model_name <> ''),
    prompt_version TEXT NOT NULL CHECK (prompt_version <> ''),
    status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
    content JSONB,
    generated_at TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ NOT NULL,
    in_flight_until TIMESTAMPTZ,
    attempt_generation BIGINT NOT NULL DEFAULT 1 CHECK (attempt_generation > 0),
    attempt_count SMALLINT NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 3),
    last_failure TEXT,
    PRIMARY KEY (tic_id, planet_id),
    FOREIGN KEY (tic_id, planet_id) REFERENCES nasa_star_planet(tic_id, planet_id),
    CHECK ((status = 'ready') = (content IS NOT NULL AND generated_at IS NOT NULL)),
    CHECK (status <> 'ready' OR in_flight_until IS NULL)
);

COMMENT ON TABLE nasa_star_catalog IS '270: TIC별 NASA PS 기본 해 목록의 완전 조회와 갱신 임대';
COMMENT ON TABLE nasa_star_planet IS '270: 후보 FK 없이 저장한 NASA 확정 행성별 정규화 자료';
COMMENT ON TABLE nasa_star_planet_explanation IS '270: 현재 원천 해시·모델·프롬프트에 묶인 행성별 설명';
COMMENT ON COLUMN nasa_star_planet.active IS '마지막 완전 조회에 포함된 행성만 노출한다. 정정·삭제된 이전 행은 보존한다';
COMMENT ON COLUMN nasa_star_catalog.attempt_generation IS '늦게 끝난 NASA 조회의 목록 덮어쓰기를 막는다';
COMMENT ON COLUMN nasa_star_planet_explanation.attempt_generation IS '늦게 끝난 모델 응답의 설명 덮어쓰기를 막는다';

GRANT SELECT, INSERT, UPDATE ON nasa_star_catalog TO planetory_app;
GRANT SELECT, INSERT, UPDATE ON nasa_star_planet TO planetory_app;
GRANT SELECT, INSERT, UPDATE ON nasa_star_planet_explanation TO planetory_app;
