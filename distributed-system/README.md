# 분산 시스템

GCP에서 데이터 수집·처리·전달을 수행하는 실행 코드를 둔다.

- `ingestion/`: 원천 수집
- `spark/`: 분산 처리
- `airflow/`: 실행 순서와 재시도
- `publisher/`: Gold 검증·전송

서버별 포트·볼륨·노드 역할은 `infra/distributed-system/`에서 관리한다.
