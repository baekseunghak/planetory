# DAG

## TESS Sector 수집 → Raw → Bronze (`S15P21C206-252`)

`tess_sector_download_raw_bronze`는 Sector 1부터 13까지 아래 순서를 직렬로 연결한다.

2026-09-22 Node 1 Airflow에는 import 오류 없이 배포됐으며 안전을 위해 일시정지 상태다. [Tailnet 접속·읽기 전용 계정 안내](../../../infra/distributed-system/README.md#airflow-db)를 따른다. UI 배포는 SSH Connection·실제 DAG 실행 검증을 뜻하지 않는다.

```text
Worker 5대 다운로드 완료 marker 검증
  → HDFS Raw 적재·전수 감사
  → Worker 로컬 FITS 안전 삭제
  → Spark/YARN Bronze 변환·감사
```

Airflow는 순서·재시도·상태만 관리한다. 다운로드는 기존 ingestion systemd supervisor, Raw는 `tess_hdfs_runall.py`, Bronze는 `tess_bronze_ctl.py`를 그대로 사용한다. HDFS·YARN·네트워크 오류는 5분 간격으로 재시도하고, Bronze 데이터 계약 오류(exit 65)는 즉시 실패한다.

다운로드 sensor는 Worker별 `planetory.ingestion-sector-complete.v1` marker의 Sector·Worker slot·source SHA-256·제품 수·바이트를 확인한다. marker가 없으면 이미 설치된 ingestion unit을 시작하고 60초 뒤 다시 확인한다. Raw task는 해당 Sector만 적재·감사하고 cleanup을 건너뛴다. 다음 cleanup task가 동일한 HDFS final을 재감사한 뒤 불변 upload plan에 포함된 FITS만 경로·크기·SHA-256 대조 후 삭제한다. 따라서 Raw 감사 실패나 복제 부족 상태에서는 로컬 파일을 지우지 않는다.

Sector 13 cleanup 뒤 Raw coverage를, Sector 13 Bronze 뒤 Bronze coverage를 별도 확정한다. 모든 제어기는 final과 state를 먼저 재검증하므로 Scheduler나 호스트 재시작 뒤 동일 task를 다시 실행해도 이미 확정된 결과는 재사용한다.

실행 전 다음 Airflow SSH Connection이 metadata DB에 준비되어야 한다. 키·암호는 DAG나 Git에 넣지 않는다.

- `planetory_node_1`: `planetory-admin@10.20.1.10`
- `planetory_worker_1` … `planetory_worker_5`: `planetory-admin@10.20.2.10` … `10.20.6.10`

Node 1과 Worker에는 DAG Param이 가리키는 불변 ingestion/HDFS/Bronze release, systemd unit, HDFS 설정과 제한된 비대화형 sudo 권한이 미리 설치되어야 한다. 기본 Param은 현재 Sector 1~13 계보와 검증된 release를 가리키며 새 수집 run에서는 DAG trigger 시 값을 명시적으로 바꾼다. DAG 실행 중 package·image 다운로드나 운영자 PC·Tailscale 세션은 사용하지 않는다. 단, MAST 원천 다운로드 자체에는 인터넷 연결이 필요하다.

오프라인 계약 검사는 저장소 루트에서 실행한다.

```powershell
python -m unittest discover -s distributed-system/airflow/tests -p "test_*.py"
```

현재 Node 1의 Airflow scheduler·metadata DB는 단일 장애 경계다. 호스트 복구 뒤에는 멱등 task가 이어지지만 Node 1 장애 중 무중단 전환은 보장하지 않으며, 필요하면 Airflow/HDFS/YARN HA를 별도 작업으로 도입한다.
