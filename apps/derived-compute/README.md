# Derived Compute

잔차 곡선과 잔차 주기도를 요청 시 계산하는 Python Worker 위치다.

Backend가 PostgreSQL에서 읽은 곡선 배열·고정 transit model·계산 버전을 전달하며 Worker는 DB와 Redis를 직접 읽지 않는다. 잔차 제거는 `libs/astro-kernel`의 `remove_transit_models`를 사용하고, 호출·상태·캐시는 [온라인 파생 계산](../../docs/architecture/online-derived-compute.md)을 따른다.
