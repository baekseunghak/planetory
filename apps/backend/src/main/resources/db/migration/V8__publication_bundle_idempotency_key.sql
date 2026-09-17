-- Publisher 멱등 키 유일 제약 [S15P21C206-230]
--
-- S15P21C206-69가 Publisher 적재의 재시도 키를 `(tic_id, bundle_version)`으로 확정했다.
-- 그 계약은 "같은 키의 판을 확인한 뒤 같은 payload면 기존 bundleId를 반환한다"인데,
-- 같은 키가 두 행이면 어느 것을 반환할지가 정의되지 않는다.
--
-- 지금까지는 `pg_advisory_xact_lock(tic_id)` 잠금에만 기대고 있었다. 잠금은 그 코드를
-- 지나는 쪽만 지키는 규약이고, 제약은 누가 쓰든 DB가 거절한다. 수동 백필·복구 스크립트처럼
-- 잠금을 잡지 않는 경로가 하나만 생겨도 중복이 조용히 들어간다.
--
-- 기존 `uq_publication_bundles_current`(부분 유일 인덱스)와 역할이 다르다. 그쪽은 "한 TIC에
-- current는 하나"를, 이쪽은 "한 TIC에 같은 버전은 하나"를 막는다. 서로 대체하지 않는다.
-- 판 버전이 다른 archived 행이 한 TIC에 여러 개 남는 것은 이 제약으로 막히지 않으며,
-- 과거 제출이 그 행들을 참조하므로 막아서도 안 된다.
--
-- 중복이 이미 있는 DB에서는 적용이 실패한다. PostgreSQL이 중복된 키 값을 그대로 알려주므로
-- 따로 안내를 감싸지 않는다.

ALTER TABLE publication_bundles
    ADD CONSTRAINT uq_publication_bundles_tic_bundle_version UNIQUE (tic_id, bundle_version);
