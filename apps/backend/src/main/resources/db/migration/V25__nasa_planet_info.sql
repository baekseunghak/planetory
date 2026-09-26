-- S15P21C206-266: 요청한 확정 후보의 NASA PS 기본 해만 보관한다.
-- Gold/후보/성과와 독립된 서비스 조회 자료다. 기존 V1~V24는 수정하지 않는다.
CREATE TABLE nasa_planet_info (
    candidate_id BIGINT PRIMARY KEY REFERENCES candidates(id),
    tic_id BIGINT NOT NULL REFERENCES stars(tic_id),
    archive_planet_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'not_found', 'identity_unresolved', 'temporarily_unavailable')),
    normalized JSONB,
    source_hash TEXT,
    source_version SMALLINT,
    fetched_at TIMESTAMPTZ,
    changed_at TIMESTAMPTZ,
    last_attempt_at TIMESTAMPTZ NOT NULL,
    next_refresh_at TIMESTAMPTZ NOT NULL,
    in_flight_until TIMESTAMPTZ,
    attempt_generation BIGINT NOT NULL DEFAULT 1 CHECK (attempt_generation > 0),
    last_refresh_status TEXT NOT NULL,
    CHECK (archive_planet_name <> ''),
    CHECK ((normalized IS NULL AND source_hash IS NULL AND source_version IS NULL AND fetched_at IS NULL)
        OR (normalized IS NOT NULL AND source_hash IS NOT NULL AND source_version IS NOT NULL AND fetched_at IS NOT NULL)),
    CHECK (status <> 'ready' OR normalized IS NOT NULL)
);

COMMENT ON TABLE nasa_planet_info IS '266: 회원 요청으로 조회한 NASA PS 기본 해. Gold 판정과 독립';
COMMENT ON COLUMN nasa_planet_info.normalized IS 'ps-default-v1 정규화값, 단위·오차·상하한·필드 출처 포함';
COMMENT ON COLUMN nasa_planet_info.source_hash IS '정규화 JSON의 SHA-256 hex. 같은 원본 재확인은 changed_at을 유지';
COMMENT ON COLUMN nasa_planet_info.attempt_generation IS '조회 시도 순번. 늦게 끝난 시도의 저장을 막는다';

GRANT SELECT, INSERT, UPDATE ON nasa_planet_info TO planetory_app;
