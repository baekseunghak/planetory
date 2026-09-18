-- Gold 배열 값 제약 [S15P21C206-140]
--
-- REAL[]은 NaN·±Infinity를 받아들인다. Gold 계약에서 곡선의 빈 bin은 NULL이고 NaN을 쓰지
-- 않는다. 주기도는 격자 전 점에 값이 있어야 하므로 NULL도 없다(S15P21C206-117 공개 QA 계약).
--
-- Publisher 정규화만으로는 부족하다. 제안된 배열 checksum 규칙에서 NULL은 NaN과 같은
-- 바이트(0x7FC00000)가 되므로, NULL 자리에 NaN이 저장돼도 checksum 검증을 통과한다.
-- 정규화를 거치지 않는 경로(수동 적재·복구 스크립트)가 하나만 생겨도 조용히 들어간다.
-- 제약은 누가 쓰든 DB가 거절한다(V8과 같은 이유).
--
-- array_position은 NaN끼리 같다고 보고, NULL 원소가 섞여 있어도 없으면 NULL을 돌려준다.
-- 그래서 곡선의 NULL은 통과하고 NaN·±Infinity만 걸린다. array_position(power, NULL)은
-- NULL 원소의 위치를 찾는다.
--
-- 위반 행이 이미 있는 DB에서는 적용이 실패한다. PostgreSQL이 위반한 제약 이름을 알려주므로
-- 따로 안내를 감싸지 않는다.

ALTER TABLE light_curve_segments
    ADD CONSTRAINT ck_light_curve_segments_flux_finite_or_null CHECK (
        array_position(flux, 'NaN'::real) IS NULL
        AND array_position(flux, 'Infinity'::real) IS NULL
        AND array_position(flux, '-Infinity'::real) IS NULL);

ALTER TABLE periodograms
    ADD CONSTRAINT ck_periodograms_power_all_finite CHECK (
        array_position(power, NULL) IS NULL
        AND array_position(power, 'NaN'::real) IS NULL
        AND array_position(power, 'Infinity'::real) IS NULL
        AND array_position(power, '-Infinity'::real) IS NULL);
