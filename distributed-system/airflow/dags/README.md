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

## 후속 목표 설계: 단계별 DAG와 Sector 자동 재개

2026-09-22 사용자 요청으로 아래 설계와 구현을 시작했다. 위의 단일 DAG 설명은 **현재 배포된 구현**이며, 아래는 **목표 설계**다. Jira `S15P21C206-252`는 아직 단일 DAG·제한 Sector 완료 조건을 적고 있어 이 확장 범위와 정합화가 필요하다.

| 단계 DAG | 시작 게이트 | 완료 증거 | 실행기 |
| --- | --- | --- | --- |
| 다운로드·검증 | 직전 Sector 다운로드 완료 또는 첫 미완료 Sector 재개 | Worker 5대 완료 marker·source SHA-256·제품 수·바이트 | 기존 supervisor, Worker당 파일 스레드 최대 16 |
| Raw 적재·검증 | 같은 Sector 다운로드 감사 완료 | Sector `_READY.json`, bundle·manifest·RF2·FSCK 감사 | 기존 Worker 5대 SequenceFile uploader |
| 로컬 삭제 | 같은 Sector Raw final 재검증 | Worker별 불변 plan의 삭제 상태 | 기존 `cleanup-sector` |
| Bronze 변환·검증 | 같은 Sector Raw `_READY.json` 재확인 | Sector Bronze `_READY.json`·품질 감사 | Spark on YARN |

별도 발견·허가 DAG는 MAST에 공식 **일반 LC bulk script**가 게시된 Sector를 확인하고, 영속 중지 상태·디스크 여유·설정 상한을 검사해 새 Sector를 순서대로 허가한다. 설정 상한은 기본 70이고 실제 목표는 `min(설정 상한, 이용 가능한 최신 Sector)`다. 게시되지 않은 Sector는 실패가 아니라 다음 조회까지 대기한다. 신규 원천 목록은 URL·조회 시각·script SHA-256·제품 수·source-list SHA-256으로 한 번 고정하며 이전 1~13 run과 coverage는 수정하지 않는다.

각 단계 DAG run은 Sector 하나와 `sector`, `run_id`, `source_list_sha256`, HDFS/Bronze 불변 release·설정 경로, Bronze run·version·partition 수의 정규화된 계보 지문을 전달받는다. 각 단계는 Airflow 성공 상태가 아닌 해당 Worker marker 또는 제어기 내부의 실제 Raw/Bronze final을 재검증한다. 결정적인 run ID와 중복 skip은 동일 계보의 재트리거를 막지만, 이미 존재하는 **실패 run을 자동 복구하지는 않는다**. 이 경우 조정 DAG가 실제 marker와 Airflow run 상태를 확인해 실패 task를 재실행해야 한다. 큰 원천 목록과 FITS는 XCom에 넣지 않는다. 같은 Sector 안에서는 순서를 지키되, Sector N 다운로드가 검증되면 N Raw와 N+1 다운로드를 겹쳐 실행한다. 초기 동시성은 다운로드 Sector 1개·Raw Sector 1개·Bronze Sector 1개로 제한하고 Airflow Pool, `max_active_runs`, Worker·HDFS 용량 게이트와 실측을 통해 조정한다. 현재 Node 1 LocalExecutor `parallelism=2`는 목표 동시성에 맞춰 별도 검증해야 한다.

재개 지점은 `마지막 다운로드 Sector+1` 하나로 정하지 않는다. 각 Sector의 다운로드 marker, Raw `_READY`, 삭제 기록, Bronze `_READY`를 대조해 첫 미완료 단계부터 재개한다. 삭제된 로컬 FITS를 다운로드 재감사 대상으로 삼지 않는다. **정상 중지**는 신규 Sector 허가를 영속적으로 끄고 이미 허가한 Sector를 끝까지 처리하는 drain을 기본으로 한다. 빠른 중지는 supervisor를 종료하되 `.part`·이벤트·plan·HDFS staging을 보존하고 명시적 중지 상태를 재부팅 뒤에도 유지한다. **비정상 종료**는 중지 표식이 없는 경우에만 Airflow/systemd 재기동과 멱등 marker 검증으로 자동 재개한다. UI의 DAG pause만으로 외부 systemd·YARN 작업이 멈추는 것으로 간주하지 않는다.

첫 Raw Commit은 원본 FITS 파일별 SHA-256, bundle 복원 표본, manifest 내용, HDFS checksum·RF2·FSCK를 검증한다. 후속 cleanup은 불변 plan·bundle checksum·새로 기록한 manifest HDFS checksum과 final `_READY`·FSCK를 비교하는 **빠른 감사**를 사용한다. 구형 bundle에 manifest checksum이 없으면 상세 감사로 돌아가며 불일치 시 삭제를 막는다. 원본 FITS SHA-256과 SequenceFile의 HDFS checksum은 서로 직접 비교할 수 없다. 로컬 삭제는 정확한 plan의 경로·크기·파일별 SHA-256을 삭제 직전에 다시 확인하고 Worker 5대에서 병렬 수행한다. Worker별 영속 cleanup 상태와 중단 후 재개 규칙은 유지한다.

### 구현·검증 순서

1. 기존 1~13 완료 증거를 읽기 전용으로 확인하고 신규 Sector용 원천 목록·coverage 계약을 정의한다. 수집 설정, Raw coverage, Bronze 입력의 1~13 전제를 일반화하되 이전 계약은 보존한다.
2. 4개 DAG를 Sector 인자 기반으로 구현하고 단계별 marker 게이트·계보 전달·중복 방지·재시도를 오프라인 검증한다. 이후 발견·허가 DAG와 영속 중지 상태를 연결한다.
3. 제한된 신규 Sector 1개에서 정상 경로를 검증한다. 업로드 중·Raw 확정 직후·삭제 중·Bronze 중단과 Node 1/Worker 재부팅을 시험해 중복 final·잘못된 삭제가 없는지 확인한다.
4. 연속 2개 Sector에서 N Raw와 N+1 다운로드가 실제로 겹치는지, 단계별 시간·NameNode RPC·YARN 메모리·Worker 디스크를 측정한다. 빠른 감사 전후를 같은 조건에서 비교한 뒤에만 기본 상한 70 자동 허가를 켠다.

현재 **오프라인 구현·검증 완료**는 4개 수동 trigger 단계 DAG, 계보 지문·실제 marker 게이트·단계 간 트리거, cached Raw 빠른 감사, Worker 병렬 cleanup, 신규 Sector용 Bronze Raw release 인자까지다. 새 DAG도 기본 일시정지이며 미배포다. 기존 단일 DAG도 일시정지 상태를 유지한다. **미완료**는 자동 Sector 발견·원천 목록 고정, 1~13 전제의 HDFS coverage 일반화, 영속 중지/drain·재부팅 후 보충, 단계별 Pool/용량 조정, Airflow 실제 import·실환경 기능/성능 검증이다. 따라서 Sector 14~70 자동 수집과 무인 복구는 아직 동작하지 않는다. 운영 배포·실제 삭제는 정확한 대상과 영향을 확인한 별도 통제 절차에서만 수행한다.
