-- ERD v1.2: star_unlocks에 은하 배치 월드 좌표와 배치 버전을 저장한다(별지도 표현 계약 1절).
-- 보존할 운영 좌표가 없으므로 방사형 좌표를 이관하지 않는다. 좌표 열은 처음부터 NOT NULL이며,
-- 기존 행이 있는 개발 DB는 이 마이그레이션이 실패한다. 해당 DB의 열린 별 행을 초기화한 뒤 적용한다.
ALTER TABLE star_unlocks
    ADD COLUMN world_x NUMERIC NOT NULL,
    ADD COLUMN world_y NUMERIC NOT NULL,
    ADD COLUMN layout_version TEXT NOT NULL;

-- NUMERIC은 NaN·Infinity를 허용한다. PostgreSQL에서 NaN은 Infinity보다 크므로 아래 범위 비교로 함께 막는다.
ALTER TABLE star_unlocks
    ADD CONSTRAINT ck_star_unlocks_world_x_finite CHECK (world_x > '-Infinity' AND world_x < 'Infinity'),
    ADD CONSTRAINT ck_star_unlocks_world_y_finite CHECK (world_y > '-Infinity' AND world_y < 'Infinity'),
    ADD CONSTRAINT ck_star_unlocks_depth_z_range CHECK (depth_z BETWEEN -1 AND 1),
    ADD CONSTRAINT ck_star_unlocks_layout_version_not_blank CHECK (btrim(layout_version) <> '');

-- 이전 방사형 배치 열은 폐기 예정이다. 신규 좌표 계산·조회에 쓰지 않으며 제거는 별도 스키마 정리에서 한다.
ALTER TABLE star_unlocks
    ALTER COLUMN generation DROP NOT NULL,
    ALTER COLUMN angle_deg DROP NOT NULL,
    ALTER COLUMN radius_jitter DROP NOT NULL;

COMMENT ON COLUMN star_unlocks.world_x IS '은하 월드 X';
COMMENT ON COLUMN star_unlocks.world_y IS '은하 월드 Y';
COMMENT ON COLUMN star_unlocks.depth_z IS '월드 깊이(-1.0~1.0 정규화)';
COMMENT ON COLUMN star_unlocks.layout_version IS '배치 버전';
COMMENT ON COLUMN star_unlocks.generation IS '이전 배치 세대(폐기 예정)';
COMMENT ON COLUMN star_unlocks.angle_deg IS '이전 배치 각도(폐기 예정)';
COMMENT ON COLUMN star_unlocks.radius_jitter IS '이전 배치 지터(폐기 예정)';
