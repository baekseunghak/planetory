-- publication_bundles.manifest 최소 스키마 [S15P21C206-134]
--
-- ERD 3장이 요구하는 여덟 항목이 판마다 반드시 있어야 한다. 없으면 곡선을 어느 세그먼트로
-- 조립할지, 주기 격자와 미세 조정 범위를 어떻게 계산할지 정할 수 없다.
--
-- 앱 검증이 아니라 DB CHECK로 두는 이유: Gold 적재 방식이 배치 직접 INSERT(ERD 미결 7 A안)로
-- 정해지면 적재가 애플리케이션을 거치지 않는다. 그때 실효가 있는 검증은 DB 쪽뿐이다.
--
-- 여기서는 키의 존재와 자료형만 본다. 값의 범위와 단위는 과학 계약(D06·D20)이 확정한 뒤
-- operation_settings의 rule_version으로 관리한다. 이 CHECK는 그 값을 판정하지 않는다.
--
-- 키는 snake_case를 쓴다. manifest는 배치가 쓰고 백엔드가 읽는 DB 내부 데이터이며 API로
-- 그대로 나가지 않는다(탐사 API는 residualModelVersion 등 파생값만 노출한다).

ALTER TABLE publication_bundles
    ADD CONSTRAINT ck_publication_bundles_manifest_shape CHECK (
        manifest ?& ARRAY[
            'segment_ids',                 -- 참조할 light_curve_segments id 집합(revision까지 특정)
            'array_checksums',             -- flux·power 배열 checksum
            'residual_model_version',      -- 잔차 계산 버전
            'periodogram_config_version',  -- 주기도 계산 버전
            'binning',                     -- 곡선 비닝 규칙(기본 10분)
            'period_grid',                 -- 주기 격자 범위·간격 규칙
            'fine_tune',                   -- 미세 조정 허용 폭(ERD 결정 9)
            'curve_steps'                  -- 곡선 단계 규칙
        ]
        AND jsonb_typeof(manifest -> 'segment_ids') = 'array'
        AND jsonb_array_length(manifest -> 'segment_ids') > 0
        AND jsonb_typeof(manifest -> 'array_checksums') = 'object'
        AND jsonb_typeof(manifest -> 'residual_model_version') = 'string'
        AND jsonb_typeof(manifest -> 'periodogram_config_version') = 'string'
        AND jsonb_typeof(manifest -> 'binning') = 'object'
        AND jsonb_typeof(manifest -> 'period_grid') = 'object'
        AND jsonb_typeof(manifest -> 'fine_tune') = 'object'
        AND jsonb_typeof(manifest -> 'curve_steps') = 'object'
    );

COMMENT ON CONSTRAINT ck_publication_bundles_manifest_shape ON publication_bundles IS
    'ERD 3장 manifest 최소 스키마. 키 존재와 자료형만 검사하며 값 범위는 rule_version이 관리한다';
