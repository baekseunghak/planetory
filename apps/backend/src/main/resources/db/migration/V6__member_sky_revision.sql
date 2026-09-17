-- 회원별 지도 개정값 [S15P21C206-136]
--
-- 탐사 API 4.1의 `version`은 "동일 시각의 여러 변경도 구분하는 단조 증가 개정값"이다.
-- 시각에서 파생하면 같은 순간의 두 발견을 구분할 수 없으므로 카운터를 따로 둔다.
--
-- 프론트는 이 값을 문자열로만 비교한다. 의미를 읽거나 순서를 계산하지 않는다.

CREATE TABLE member_sky_revisions (
    user_id BIGINT PRIMARY KEY,
    revision BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (revision > 0)
);

ALTER TABLE member_sky_revisions
    ADD CONSTRAINT fk_member_sky_revisions_user_id FOREIGN KEY (user_id) REFERENCES users(id);

COMMENT ON TABLE member_sky_revisions IS '회원 지도 버전. 발견·상태 변경마다 증가한다';
COMMENT ON COLUMN member_sky_revisions.revision IS '단조 증가 개정값. 같은 시각의 변경도 구분한다';

-- 앱이 발견·상태 변경 때 증가시킨다. 운영이 손대는 값이 아니다.
DO $$
DECLARE
    target_schema TEXT := current_schema();
BEGIN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I.member_sky_revisions TO planetory_app',
                   target_schema);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I.member_sky_revisions FROM planetory_app',
                   target_schema);
END $$;
