# DAG

## Sector 14~70 자동 발견·단계 재개 (Sector 14 제한 운영 검증 완료)

`tess_sector_discovery`와 다운로드·Raw·로컬 삭제·Bronze 단계 DAG 4개가 현행 구성이다. 과거 Sector 1~13 단일 DAG `tess_sector_download_raw_bronze`는 운영에서 사용하지 않아 제거했다. [Tailnet 접속·읽기 전용 계정 안내](../../../infra/distributed-system/README.md#airflow-db)를 따른다.

Airflow 3.2.2에서도 다섯 `dag_id`, Sector 계보, 단계 순서·pause 기본값을 유지한다. 발견 DAG의 메타데이터 DB 직접 조회는 Task SDK의 DAG·DagRun 상태 조회로 교체했다. 시도 번호는 이 파이프라인이 생성하는 `_r0`, `_r1`, … 연속 ID를 조회하며, 외부에서 같은 prefix의 비연속 run ID를 만들지 않는다. Node 1 운영 DB 복제·마이그레이션 뒤 DAG 5개·이력 20개·task 이력 39개·SSH Connection 6개·pause 상태가 원본과 일치하고 import 오류 0건이다.

Airflow 3.2.2의 일반 `reschedule` Python sensor는 실제 Sector 17·18에서 대기 후 재개할 때 만료된 내부 실행 토큰으로 실패했다. 따라서 다운로드 완료 대기는 LocalExecutor에 Task를 남기지 않는 **5분 Temporal Trigger**로 구현한다. Node 1의 `airflow-triggerer`가 깨운 뒤에만 marker를 다시 확인하며, 최초 Task 시작 시점에서 계산한 14일 deadline은 매 wake-up마다 연장하지 않는다. 이 대기는 Worker systemd·HDFS·Spark 작업을 실행하거나 변경하지 않으며, 완료 marker가 없으면 다음 확인만 예약한다.

2026-09-23 운영 release `20260922T170848Z`에서 Scheduler·DAG Processor·API Server·Triggerer를 함께 기동했고, API health와 DAG import 오류 0건을 확인했다. Sector 20의 `check_download`는 실제로 5분 대기 후 다시 `deferred`로 전환됐으며 Triggerer 로그에 `Invalid auth token`·`Signature has expired` 오류는 없었다.

후속 운영 관찰에서 Sector 21·22의 `check_download`와 발견 DAG의 `reconcile`이 다시 `Invalid auth token: Signature has expired`로 실패·재시도했다. 첫 5분 재개만으로는 토큰 오류가 해결됐다고 볼 수 없다. 원인은 LocalExecutor 슬롯 부족에 따른 queued 대기 중 실행 토큰 만료였고, `parallelism=8`로 해결한 뒤 운영 회귀를 확인했다. 근거는 [2026-09-23 변경 이력](../../../docs/changes/2026-09-W4/2026-09-23.md)에 있다.

화면에는 `dag_display_name`으로 ID 옆에 한국어 역할을 표시한다. 자동 trigger와 실행 이력은 변경하지 않은 `dag_id`를 계속 사용한다.

| DAG ID | 화면 표시 이름 |
| --- | --- |
| `tess_sector_discovery` | `tess_sector_discovery · 새 섹터 발견·재개` |
| `tess_sector_download` | `tess_sector_download · TESS 다운로드·검증` |
| `tess_sector_raw` | `tess_sector_raw · HDFS Raw 적재·검증` |
| `tess_sector_cleanup` | `tess_sector_cleanup · 로컬 원본 안전 삭제` |
| `tess_sector_bronze` | `tess_sector_bronze · Bronze 변환·검증` |

2026-09-22 Airflow release `20260922T135740Z`에서 다섯 표시 이름과 짧은 설명을 배포했다. 운영 metadata의 표시 이름·설명, import 오류 0건, UI health 200을 확인했다. DAG ID와 pause 상태는 유지하고 데이터 작업은 시작하지 않았다.

2026-09-22 Airflow release `20260922T134419Z`에서 과거 DAG 파일과 실행 이력 0건의 비활성 metadata 행을 제거했다. 새 이미지의 DAG import와 현행 5개 DAG, UI health를 확인했으며 이전 이미지는 롤백용으로 보존한다.

단계별 DAG와 신규 admission은 운영 release `20260922T021406Z`에 배포했다. 2026-09-22 영속 상한 `tess_pipeline_max_sector=14`에서 Sector 14의 다운로드·Raw·로컬 삭제·Bronze 네 DAG가 모두 성공했다. 이후 `tess_pipeline_enabled=false`와 발견 DAG pause로 신규 허가를 drain했고 활성 단계 run은 0건이다. Jira `S15P21C206-252`의 기존 단일 DAG·1~13 완료 조건과 확장 범위는 정합화가 필요하다.

| 단계 DAG | 시작 게이트 | 완료 증거 | 실행기 |
| --- | --- | --- | --- |
| 다운로드·검증 | 직전 Sector 다운로드 완료 또는 첫 미완료 Sector 재개 | Worker 5대 완료 marker·source SHA-256·제품 수·바이트 | 기존 supervisor + Airflow Triggerer 5분 대기, Worker당 파일 스레드 최대 16 |
| Raw 적재·검증 | 같은 Sector 다운로드 감사 완료 | Sector `_READY.json`, bundle·manifest·RF2·FSCK 감사 | 기존 Worker 5대 SequenceFile uploader |
| 로컬 삭제 | 같은 Sector Raw final 재검증 | Worker별 불변 plan의 삭제 상태 | 기존 `cleanup-sector` |
| Bronze 변환·검증 | 같은 Sector Raw `_READY.json` 재확인 | Sector Bronze `_READY.json`·품질 감사 | Spark on YARN |

별도 발견·허가 DAG는 5분마다 MAST의 공식 **일반 LC bulk script**를 조회한다. 기본 상한 70과 영속 Variable `tess_pipeline_max_sector` 중 작은 값까지 순서대로 검사한다. 시작점은 영속 Variable `tess_pipeline_completed_through`(기본 13) 다음 Sector다. 이 값은 Sector 14부터 Bronze final까지 끊김 없이 완료가 확인된 마지막 Sector이며, 완료된 Sector를 매 주기 SSH로 다시 조회하지 않도록 조정기가 전진시킨다. 완료 증거를 의도적으로 지우고 재처리할 때는 이 값을 해당 Sector 앞으로 먼저 되돌린다. 검사 중 게시되지 않은 Sector가 있으면 그 뒤를 건너뛰지 않는다. Node 1의 admission은 공식 script, ingestion/HDFS/Bronze 불변 release, 버전과 파티션 수를 영속 intent에 고정한다. 원천 목록에는 URL·조회 시각·script SHA-256·제품 수·source-list SHA-256을 기록하고 Worker 5대에 배치하며, 기존 1~13 coverage를 수정하지 않는다. 목록 정본은 [MAST 공식 TESS LC bulk 다운로드 페이지](https://archive.stsci.edu/tess/bulk_downloads/bulk_downloads_ffi-tp-lc-dv.html)다. `fast-lc`, FFI·TP·DV와 다른 호스트 링크는 발견 대상으로 삼지 않는다.

MAST 목록 조회가 일시 실패해도 이미 허가한 Sector의 로컬·HDFS 완료 증거를 읽고 단계 실패를 재개한다. 새 Sector 허가만 공식 목록이 복구될 때까지 보류한다. FITS 자체가 아직 다운로드되지 않았다면 그 원천 전송에는 MAST 연결이 계속 필요하다.

Worker marker·계보 불일치나 Bronze 데이터 계약 오류처럼 재시도로 해결할 수 없는 실패는 `tess_pipeline_enabled=false`를 기록해 신규 Sector 허가를 멈춘다. 이미 시작한 작업은 취소하지 않으며, 원인을 수정하고 실제 완료 증거를 확인한 뒤에만 운영자가 다시 활성화한다.

각 단계 DAG run은 Sector 하나와 `sector`, `run_id`, `source_list_sha256`, HDFS/Bronze 불변 release·설정 경로, Bronze run·version·partition 수의 정규화된 계보 지문을 전달받는다. 조정 DAG는 Worker 완료 marker, Raw `_READY`, Worker별 cleanup 기록, Bronze `_READY`를 읽고 첫 미완료 단계를 고른다. 단계 run이 실행 중이면 중복 trigger하지 않고, 실패했다면 같은 불변 계보의 새 시도 번호로 trigger한다. 시도 번호는 단계 DAG마다 r0부터 끊김 없이 매긴다. 앞 단계가 다음 단계를 시작할 때는 앞 단계의 시도 번호와 관계없이 항상 r0으로 trigger하므로, 조정 DAG의 연속 번호 조회가 실행 중인 run을 놓치지 않는다. 성공 run인데 완료 증거가 없으면 오류로 멈춘다. 큰 원천 목록과 FITS는 XCom에 넣지 않는다. Sector N의 다운로드 완료 뒤 Raw·cleanup·Bronze와 Sector N+1 다운로드는 겹칠 수 있다. 첫 미완료 다운로드 Sector에서 admission을 멈춰 동시에 새 다운로드를 여러 개 시작하지 않으며, 각 단계 DAG의 `max_active_runs=1`로 단계별 동시성을 제한한다. Node 1 LocalExecutor `parallelism=8`은 슬롯을 오래 점유하는 `commit_raw`·`cleanup_local`·`commit_bronze`(각 단계 DAG 최대 1개)와 `reconcile`을 모두 실행하고도 슬롯이 남는 값이다. deferred 상태의 `check_download`는 슬롯을 쓰지 않는다. 대량 복구 때 발견 DAG의 동적 매핑 `trigger_stage` 인스턴스가 여러 개 생겨도 각각 수 초 안에 끝나 남는 슬롯을 순환하므로 긴 작업의 종료를 기다리지 않는다. Airflow 3는 Task를 queue에 넣을 때 실행 토큰(`execution_api.jwt_expiration_time`, 기본 600초)을 발급하므로, 슬롯이 부족해 10분 넘게 queued에 머문 Task는 `Invalid auth token: Signature has expired`로 실패한다. 동시 실행 단계를 늘리면 `parallelism`도 함께 올린다.

재개 지점은 `마지막 다운로드 Sector+1` 하나로 정하지 않는다. 각 Sector의 단계별 완료 증거를 대조하며, 삭제된 로컬 FITS를 다운로드 실패로 오인하지 않는다. 영속 Airflow Variable `tess_pipeline_enabled=false`는 **신규 admission·trigger만 중지**한다. 이미 시작한 Worker systemd·HDFS·Spark 작업은 계속 진행하므로 이것이 기본 drain 동작이다. 재부팅 후 Variable이 `true`라면 5분 주기로 조정기가 실제 증거와 실패 DagRun을 다시 읽어 재개한다. UI의 DAG pause만으로 외부 작업이 멈추지 않는다. 즉시 중단용 Worker/systemd 정지 절차는 아직 별도로 구현하지 않았다.

첫 Raw Commit은 원본 FITS 파일별 SHA-256, bundle 복원 표본, manifest 내용, HDFS checksum·RF2·FSCK를 검증한다. 후속 cleanup은 불변 plan·bundle checksum·새로 기록한 manifest HDFS checksum과 final `_READY`·FSCK를 비교하는 **빠른 감사**를 사용한다. 구형 bundle에 manifest checksum이 없으면 상세 감사로 돌아가며 불일치 시 삭제를 막는다. 원본 FITS SHA-256과 SequenceFile의 HDFS checksum은 서로 직접 비교할 수 없다. 로컬 삭제는 정확한 plan의 경로·크기·파일별 SHA-256을 삭제 직전에 다시 확인하고 Worker 5대에서 병렬 수행한다. Worker별 영속 cleanup 상태와 중단 후 재개 규칙은 유지한다.

### 구현·검증 순서

1. 공식 MAST 일반 LC 목록을 읽기 전용으로 발견하고 설정 상한(기본 70)을 적용한다. Worker download marker, HDFS Raw `_READY`, cleanup 기록, Bronze `_READY`를 단계별 실제 완료 증거로 해석해 첫 미완료 단계 선택을 단위 테스트한다. HDFS Raw 이후에는 로컬 FITS가 없더라도 다운로드 단계로 되돌아가지 않는다.
2. 신규 Sector 하나의 원천 목록·해시·run 계보를 불변으로 고정하고 Node 1~6에 동일하게 제공한다. ingestion 설정·supervisor, HDFS coverage·RunAll, Bronze 입력과 설치 스크립트에 남은 1~13 범위를 일반화한다. 기존 1~13 run·coverage는 보존한다.
3. 영속 중지·drain과 기존 Worker/HDFS 용량 게이트를 가진 단일 발견·허가 조정기를 4개 단계 DAG에 연결한다. active run은 중복 트리거하지 않고 실패 run은 실제 증거를 확인한 뒤 안전하게 재실행한다. Scheduler·Node 1 재시작 뒤에도 중지 상태 또는 미완료 단계를 복원한다. UI pause만으로 외부 systemd·YARN 작업을 중지한 것으로 보지 않는다. **배포 완료, Sector 14의 4단계 자동 연결·drain과 다운로드 중 재부팅 재개 검증 완료**.
4. 제한된 신규 Sector 1개에서 정상 경로를 검증한다. 업로드 중·Raw 확정 직후·삭제 중·Bronze 중단과 Node 1/Worker 재부팅을 시험해 중복 final·잘못된 삭제가 없는지 확인한다.
5. 연속 2개 Sector에서 N Raw와 N+1 다운로드가 실제로 겹치는지, 단계별 시간·NameNode RPC·YARN 메모리·Worker 디스크를 측정한다. 빠른 감사 전후를 같은 조건에서 비교한 뒤에만 기본 상한 70 자동 허가를 켠다.

이전 release `20260921T230610Z`에서는 4개 수동 trigger 단계 DAG, cached Raw 빠른 감사, Worker 병렬 cleanup과 Bronze Raw release 인자까지만 배포했다. 그 시점에는 신규 4개와 기존 단일 DAG가 모두 일시정지였고 신규 실행 이력은 0건이었다. 위의 Sector 14 실행·재부팅 검증은 후속 release `20260922T021406Z`의 결과다.

2026-09-22 후속 **운영 배포·부분 검증**: `tess_sector_discovery`는 기본 일시정지이며 5분마다 확인한다. `max_sector` Param(기본 70), 영속 상한 Variable `tess_pipeline_max_sector`(기본 70), `tess_pipeline_enabled` Variable(기본 `false`), `tess_pipeline_settings` JSON Variable의 `ingestion_release`·`hdfs_release`·`bronze_release`·`bronze_pipeline_version`·`bronze_output_partitions`가 필요하다. Node 1 admission은 Worker unit과 불변 source/config를 설치하고, 다운로드 완료 뒤 Raw 단계를 시작할 때 5개 marker를 모아 단일 Sector HDFS 설정을 확정한다. Worker supervisor는 Raw cleanup 기록을 확인하면 재부팅 후 삭제된 FITS를 재다운로드하지 않는다. 실패 DagRun은 새 `_rN` 시도 번호로 재개한다. 운영 release의 Airflow import, SSH Connection 6개·host-key 검증·전용 제한 sudo와 Sector 14 원천 19,970개 admission을 확인했다.

Sector 14 실측에서 다운로드 marker 5개와 Raw 19,970개·RF2·FSCK HEALTHY·Parquet 성공을 확인했다. cleanup task는 약 13분 30초에 걸쳐 75개 bundle 모두 fast 감사(`full_bundles=0`) 뒤 로컬 FITS 19,970개를 삭제했고 Worker 5대 잔여 FITS는 0개다. fast 경로도 HDFS CLI checksum 호출 비용 때문에 충분히 빠르다고 입증하지 못했다. Bronze Spark/YARN 앱 `application_1790045821701_0001`은 성공했고 final `_READY`에는 제품 19,970개·관측값 386,159,890개·파싱 오류 0개·40개 part·RF2가 기록됐다. final FSCK는 HEALTHY·저복제/누락/손상 0이다. **남은 작업**은 업로드·삭제·변환 중단 재개와 두 Sector 동시성·성능·Pool 튜닝이다. **Sector 14~70 전체 자동 수집·무인 복구가 검증됐다고 주장하지 않는다**. Worker 4 재부팅 뒤 수집 자동 재개를 확인했다. Node 1 재부팅 뒤 Docker/Airflow는 자동 복구됐으나 HDFS·YARN은 자동 fencing이 없어 수동 의존 순서로 복구했으며, NameNode Safe Mode 30초 연장이 끝난 뒤 Active 전환에 성공했다. `tess_pipeline_enabled=false`는 신규 trigger만 멈추고 이미 시작한 Worker unit은 계속 실행한다.

2026-09-23 **Jira 완료 조건 검증**: 완료된 Sector 36(run `20260923T013819Z`, 완료 워터마크 이하라 발견 DAG 흐름과 분리)에서 Airflow DAG 경로로 확인했다. 기대 source SHA를 틀리게 준 다운로드 run `tess_s36_faultinject_r0`은 재시도 없이 `invalid download completion marker for Sector 36`으로 실패했고, `trigger_next_stage`는 `upstream_failed`로 Raw를 실행하지 않았다. fail-closed 설계대로 `tess_pipeline_enabled=false`가 기록돼 운영자가 확인 후 복구했다. 같은 계보의 Raw·Bronze `_r1` 재실행은 각각 `COMMIT_CACHED`·`BRONZE_CACHED`로 끝났고, 재실행 전후 HDFS 스냅샷(파일 수·바이트·목록 해시·`_READY` SHA·mtime·`sector=0036` 경로 수)이 완전히 같았다. Bronze 계약 실패(exit 65)는 파이프라인 전체를 정지시키므로 주입 대상에서 제외했다. 대상 Sector 선택은 계보만 분리한다. 계약 실패 주입은 전역 `tess_pipeline_enabled=false`를 기록해 운영 수집 전체의 신규 진입을 멈추므로, 주입 전 운영자 복구 절차를 준비한다. 업로드·삭제·변환 **도중** 중단 후 재개는 이 검증에 포함하지 않았다.

## `tess_bronze_to_silver` (78의 1~13 입력, 수동 실행)

이 DAG는 일시정지·무스케줄로 생성된다. 252의 수집 DAG를 수정하거나 자동 trigger하지 않는다. Airflow는 SSH로 Node 1의 불변 Silver 제어기 `start-unit`을 호출해 요청마다 정해진 이름의 systemd unit을 설치·시작하고 곧바로 끝낸다. 실제 전처리·BLS는 그 unit이 Spark on YARN에서 수행한다. 이후 `wait_silver`가 Triggerer에서 5분마다 `status`로 unit과 최신 attempt 상태를 읽고(최대 14일), 그 사이 LocalExecutor 슬롯과 SSH 세션을 잡지 않는다. 따라서 Airflow 재시작·release 교체가 Silver를 멈추지 않는다.

| task | 동작 | 실패 시 |
| --- | --- | --- |
| `validate_request` | Trigger conf를 allow-list로 검증 | 즉시 실패(재시도 없음) |
| `start_unit` | unit 파일 작성·enable·`--no-block start` | 같은 이름 unit이 실행 중이거나, 그 unit의 최신 attempt 상태가 `complete`이면 다시 시작하지 않음(재부팅 뒤에도 유지). 파일 내용이 다르면 `UNIT_DEFINITION_MISMATCH`. 종료 65는 재시도 없이 실패 |
| `wait_silver` | `status`의 `SILVER_STATUS_JSON` 판정, 확인마다 `SILVER_STATUS` 한 줄 기록 | unit이 실행 중이 아니고 attempt가 `complete`이면 성공(재부팅으로 systemd 기록이 사라져도 성공). 실행·대기·자동 재시작 중이면 defer하되 재시작이 6회를 넘으면 실패(unit은 systemd에서 계속 재시작하므로 원인 확인 후 멈춘다). 종료 65·`terminal_failed`는 데이터 계약 실패, 실행 전에 실패한 unit(`failed`)을 포함한 그 밖의 종료는 실패. `status`는 120초 제한이며 SSH·명령 실패는 연속 6회까지 다시 기다린다 |

제어기는 attempt 상태 파일에 unit 이름을 기록하고, `status`·`start-unit`은 그 unit의 attempt만 본다(필드가 없던 이전 attempt는 `run` unit 것으로 본다). `canary`·`run`·`retry`는 같은 unit의 attempt가 이미 `complete`이면 `SILVER_UNIT_ALREADY_COMPLETE`(종료 65)로 거부하므로 `run-tess-silver.ps1` 경로에서도 끝난 요청을 다시 돌리지 않는다. 다시 처리하려면 새 run ID를 쓴다.

unit 이름은 `run`이 `planetory-tess-silver-<run_id>.service`(`run-tess-silver.ps1`과 같음), `canary`가 `planetory-tess-silver-canary-<run_id>.service`, `retry`가 `planetory-tess-silver-retry-<run_id>-<원본 attempt>.service`이다. unit은 `run-tess-silver.ps1`과 같은 내용(`Restart=on-failure`, `RestartPreventExitStatus=65`, `RestartSec=5min`)이다. 같은 run ID를 다른 release로 요청하면 unit 내용이 달라 거부되므로, 이미 다른 release로 시작한 run은 DAG가 이어받지 않는다.

Silver는 불변 1~13 Bronze coverage를 읽고 Sector 단계 DAG는 14+를 쓰므로 둘을 서로 drain할 필요가 없다. 대신 **동시성에 상한을 둔다**. `tess_sector_bronze`의 `commit_bronze`는 `tess_yarn` Pool을 요구하고(기본 2 슬롯), Node 1에서는 두 제어기가 같은 수의 `/run/planetory-tess-yarn-<N>.lock` 슬롯 파일을 공유한다. Silver는 며칠 동안 Pool 슬롯을 잡지 않도록 Pool을 쓰지 않고, systemd unit 안의 제어기가 슬롯 파일과 YARN 사전 점검으로 상한을 지킨다. **Pool과 슬롯 수는 반드시 일치해야 하며**, `configure-tess-silver-airflow-node1.sh <release-id> [slots]`가 Pool을 설정한다. 이 상한은 두 제어기의 새 release를 모두 배포한 뒤 효력이 있으므로, 새 Bronze release 적용 전에는 여전히 수집을 drain한 뒤에만 이 DAG를 실행한다. 기본 2는 **YARN 용량 실측 없이 고른 보수값**이므로, 올리기 전에 단계별 시간·YARN 메모리·NameNode RPC를 측정한다.

Trigger conf의 필수 키는 `operation`(`canary`·`run`·`retry`), `silver_release`(`/opt/planetory-silver/releases/<UTC-release>`), `bronze_coverage`(`/lake/bronze/tess/coverage=<SHA-256>`), `run_id`(UTC), `pipeline_version`이다. 선택 키는 `shuffle_partitions`(1~2000, 기본 200. 전체 run은 2000 권장), `output_partitions`(1~200, 기본 80)이다. `canary`는 중복 없는 양의 `tic_ids` 1~5개를, `retry`는 완료된 불변 Silver attempt의 `retry_from`을 추가로 요구한다. 알 수 없는 Sector 경로나 임의 셸 인자는 허용하지 않는다. 예시는 다음과 같다.

```json
{
  "operation": "canary",
  "silver_release": "/opt/planetory-silver/releases/20260922T000000Z",
  "bronze_coverage": "/lake/bronze/tess/coverage=<64자리-소문자-SHA-256>",
  "run_id": "20260922T010000Z",
  "pipeline_version": "S15P21C206-78-20260922T000000Z",
  "tic_ids": [123456789]
}
```

실행 전 불변 Silver release와 252의 `tess-airflow` SSH Connection을 준비하고, [Node 1 제한 sudo·Pool 설정 스크립트](../../../infra/distributed-system/scripts/configure-tess-silver-airflow-node1.sh)를 해당 release ID로 실행한다. 이 스크립트는 운영 sudoers·Airflow metadata DB를 바꾸므로 대상과 복구 방법을 확인한 뒤 별도 승인이 필요하다. DAG import·계약 검사는 `python -m unittest discover -s distributed-system/airflow/tests -p "test_*.py"`로 실행한다. DAG 성공은 Silver unit의 성공 종료와 제어기 상태 `complete`(`_READY` 재감사 포함)를 뜻하며, `failed_tics=0`이나 Gold 게시 준비를 뜻하지 않는다. 실패 TIC는 `retry`를 별도 DAG run으로 지정한다.

**배포 상태(2026-09-26)**: 이 DAG는 로컬 Airflow 3.2.2 DagBag import와 단위 검사만 통과했고 운영 이미지에는 배포하지 않았다. Sector 1~13 전체 Silver run은 이 DAG가 아니라 systemd 경로(`run-tess-silver.ps1 -Step Start`)로 실행했다([실행 결과](../../spark/README.md#sector-113-전체-run-결과-2026-09-25-확정)). 서버 배포와 첫 trigger 검증은 80(전체 DAG·publish-ready)에서 다음 순서로 한다.

1. Node 1 root로 `configure-tess-silver-airflow-node1.sh <release-id> [slots]`를 실행해 sudoers와 `tess_yarn` Pool을 만든다. 운영 승인이 필요하며, 사후 `visudo -c`와 Pool 슬롯이 제어기 기본값(2)과 같은지 확인한다. **Airflow 이미지보다 먼저** 한다. 이 브랜치의 `commit_bronze`는 `pool="tess_yarn"`을 요구하므로 Pool이 없으면 Airflow가 그 task를 스케줄하지 않는다.
2. 통합 소스로 이미지를 빌드해 252 단계 DAG 5개와 `tess_bronze_to_silver`가 import 오류 0건으로 함께 올라오는지 **운영 이미지에서** 확인하고, 서버의 실제 `AIRFLOW__CORE__PARALLELISM`을 확인한다. 기존 DAG·Connection을 삭제하거나 재생성하지 않는다.
3. DAG를 pause 상태로 올리고 release·sudo·Pool을 확인한 뒤 Canary conf로 명시적으로 trigger한다. `wait_silver`의 defer·재개와 History Server의 실행 중(`.inprogress`) 앱을 함께 확인한다.

Sector 14+는 252가 Sector별 Bronze `_READY`만 만들고, 78의 Silver 제어기는 **Sector 1~13 전체 coverage와 TIC별 다중 Sector 결합**만 승인하므로 이 DAG가 받지 않는다. Sector 14 성공을 1~13 coverage의 확장이나 완전한 TIC Silver로 오인하지 않는다. 14+ 연속 처리에는 혼합 Bronze 버전·누적 Sector snapshot·변경 TIC 재처리·이전 Silver 결과 조합 계약이 필요하며, 이 작업은 S15P21C206-275로 분리했다(2026-09-26).

## `tess_publication_run` (80, 수동 실행)

상태: 구현·배포 전 검증 완료(2026-09-27). 운영 이미지에는 아직 배포하지 않았다.

run ID 하나로 외부 카탈로그 수집 → Gold 생성 → 게시 준비 gate → 수동 게시 승인을 잇는다. 일시정지·무스케줄로 생성되고 동시 실행은 1개다. Gold와 gate는 Node 1 systemd unit으로 돌고, Airflow는 SSH로 unit을 시작한 뒤 Triggerer에서 5분마다 `status`를 읽는다(최대 3일). 그래서 Airflow 재시작이 Spark를 멈추지 않는다. Spark는 YARN에서 돌고 Airflow는 제출만 한다.

| task | 동작 |
| --- | --- |
| `validate_request` | conf를 allow-list로 검증 |
| `collect_external` | `tess_external_ctl.py collect`(원천 4종 전체 표, 한 시간 제한, 재시도 3회) |
| `start_gold` → `wait_gold` | `tess_gold_ctl.py start-unit run` → `status run`, 완료되면 확정 attempt 경로를 넘긴다 |
| `start_gate` → `wait_gate` | `start-unit gate --attempt <경로>` → `status gate`, 통과하면 publish-ready 요약을 넘긴다 |
| `approve_publication` | Airflow HITL `ApprovalOperator`. 승인해야 다음으로 넘어가고, 거절하면 실패, 7일이 지나면 만료된다 |

276의 게시 task는 `approve_publication` 뒤에 붙인다.

Trigger conf의 필수 키는 `release`(`/opt/planetory-silver/releases/<UTC>`), `run_id`(UTC), `silver_attempt`, `required_sources`(원천 이름 목록), `exclude_tics`(튜토리얼 5종. 비우려면 `[]`를 명시한다), `approvals`(`identity`·`discoverability`·`external`)다. 선택 키는 `shuffle_partitions`(기본 400)와 `output_partitions`(기본 40)다. 승인 참조는 systemd와 sudoers를 거치므로 공백 없는 한 토큰(`[A-Za-z0-9._/-]`)이어야 한다. 외부 snapshot은 `/lake/external/tess/run_id=<run_id>`로 정해진다.

```json
{
  "release": "/opt/planetory-silver/releases/20260927T000000Z",
  "run_id": "20260927T010000Z",
  "silver_attempt": "/lake/silver/pipeline_version=S15P21C206-78-20260924T093328Z/run_id=20260924T133559Z/attempt=20260924T133730Z",
  "required_sources": ["exofop_toi", "mast_tce_s1_s13", "nea_pscomppars", "nea_toi"],
  "exclude_tics": [149603524, 278956474, 279569718, 300871545, 307210830],
  "approvals": {"identity": "S15P21C206-112/MR152/8aaf335d", "discoverability": "S15P21C206-123/MR173/e7b578fd",
                "external": "S15P21C206-124/MR190/67a9e741"}
}
```

**배포 순서(각 단계 운영 승인 필요).**
1. 이 브랜치로 pipeline release를 설치한다(`run-tess-silver.ps1 -Step Install`). release에는 Gold 파일 4개와 79 schema가 함께 들어간다.
2. Node 1 root로 `configure-tess-silver-airflow-node1.sh <release> 2`(sudoers·`tess_yarn` Pool)를 먼저 실행하고, 이어서 `configure-tess-gold-airflow-node1.sh <release>`를 실행한다. 이미지보다 먼저 한다.
3. Airflow 이미지를 `deploy-tess-airflow-node1.sh --update`로 교체한다. DAG 7개의 import 오류가 0건인지 확인한다.
4. Node 1에서 NEA·ExoFOP 연결을 확인하고, Gold Canary(`tess_gold_ctl.py canary`)를 한 뒤 DAG를 trigger한다.

**배포 전 검증(2026-09-27, 로컬).**
- `apache/airflow:3.2.2-python3.12`에 운영 requirements를 설치하고 DagBag을 읽었다. 결과는 import 오류 0건, DAG 7개, task 순서와 승인 task(`template_fields` = subject·body, `fail_on_reject`, 7일)가 설계와 같았다.
- Ubuntu 24.04(sudo 1.9.15p5) 컨테이너에서 두 설정 스크립트를 실제로 실행했다. `visudo`를 통과했고, DAG가 만드는 Gold 명령 6개와 Silver 명령 2개는 허용됐다. 인자 추가·다른 release·staging 경로·셸 문자·허용하지 않은 operation을 넣은 변조 명령 5개는 거부됐다. Node 1의 sudo 버전은 확인하지 않았다.
