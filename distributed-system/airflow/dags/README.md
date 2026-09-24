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
