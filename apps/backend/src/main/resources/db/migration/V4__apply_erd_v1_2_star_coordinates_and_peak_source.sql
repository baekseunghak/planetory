-- ERD v1.2 반영: (1) star_unlocks 은하 배치 좌표 (2) submissions 선택 봉우리 기록.

-- (1) star_unlocks에 은하 배치 월드 좌표와 배치 버전을 저장한다(별지도 표현 계약 1절).
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

-- (2) 봉우리를 선택해 시작한 제출은 그 봉우리의 grid index와 서버가 검증에 적용한 제안 duration·선택 폭 상한을 저장한다.
-- 주기도의 다른 위치를 직접 고른 제출과 candidate가 아닌 제출은 셋 모두 NULL이다(탐사 API 5.4·6.2절, C02-R3).
-- 상한 배율(maxDurationMultipleOfSuggested)은 규칙 값이므로 DB에서 3배로 고정 비교하지 않는다.
ALTER TABLE submissions
    ADD COLUMN source_peak_grid_index INTEGER,
    ADD COLUMN source_peak_suggested_duration_hours NUMERIC,
    ADD COLUMN duration_limit_hours NUMERIC;

-- CHECK는 NULL 결과를 통과시키므로 둘째 조건에 IS NOT NULL을 명시해 일부만 채운 행을 막는다.
ALTER TABLE submissions
    ADD CONSTRAINT ck_submissions_source_peak_all_or_none CHECK (
        (source_peak_grid_index IS NULL AND source_peak_suggested_duration_hours IS NULL AND duration_limit_hours IS NULL)
        OR (submission_kind = 'candidate'
            AND source_peak_grid_index IS NOT NULL AND source_peak_suggested_duration_hours IS NOT NULL
            AND duration_limit_hours IS NOT NULL AND source_peak_grid_index >= 0
            AND source_peak_suggested_duration_hours > 0 AND source_peak_suggested_duration_hours < 'Infinity'
            AND duration_limit_hours > 0 AND duration_limit_hours < 'Infinity'));

COMMENT ON COLUMN submissions.source_peak_grid_index IS '선택 봉우리 · 직접 선택은 NULL';
COMMENT ON COLUMN submissions.source_peak_suggested_duration_hours IS '검증에 쓴 제안값';
COMMENT ON COLUMN submissions.duration_limit_hours IS '적용한 선택 폭 상한';
