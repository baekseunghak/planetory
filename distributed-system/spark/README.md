# Spark

Raw를 Bronze와 Silver로 변환하는 PySpark 작업을 둔다.

운영 작업은 YARN에 제출하고 결과는 HDFS에 쓴다. 서비스 DB나 EC2 Gold를 Spark Worker가 직접 수정하지 않는다.

## TESS Raw → Bronze (`S15P21C206-77`)

`tess_bronze.py`는 Sector 하나의 불변 Raw `manifest.parquet`와 `bundle-*.seq`를 읽어 FITS 제품 하나를 Bronze Parquet 행 하나로 변환한다. SequenceFile 전체를 로컬에 풀지 않고 Spark partition에서 원본 바이트 크기와 SHA-256을 manifest와 대조한 뒤 `astro_kernel.fits_adapter.parse_spoc_hdul`을 호출한다.

입력과 최종 출력은 다음과 같다.

```text
/lake/raw/tess/release=<release>/sector=<NNNN>/
├─ bundle-*.seq
├─ manifest.parquet/
└─ _READY.json

/lake/bronze/tess/sector=<NNNN>/
├─ part-*.parquet
├─ _SUCCESS
└─ _READY.json

/lake/bronze/tess/coverage=<raw-coverage-sha256>/_READY.json
```

최종 경로에는 성공 행만 둔다. 작업 중 `data`, `errors`, `summary`는 `/lake/bronze/tess/.staging/run=<run>/sector=<NNNN>/attempt=<UTC>/`에 쓰며 다음 조건이 모두 참일 때만 `data`를 덮어쓰기 없는 원자 rename으로 최종 경로에 공개한다.

- Raw `_READY.json`, manifest 필수 열·null·Sector·source list SHA-256·제품 수·SequenceFile key 유일성 일치
- SequenceFile 레코드 수와 distinct 제품 수가 manifest 제품 수와 일치
- 모든 제품의 원본 크기·SHA-256, TIC·Sector, FITS 시간계·단위·필수 배열 계약 통과
- 오류 행 0, Parquet 재읽기 제품 수 일치
- 출력 RF2, HDFS part checksum, FSCK `HEALTHY`

### 행 스키마와 계보

곡선 배열은 `time`, `flux`, `flux_err`가 `array<double>`, `quality`, `cadenceno`가 `array<long>`이다. 다섯 배열 길이는 `observation_count`와 같아야 한다. Bronze에서는 품질 bit 필터, NaN/Inf 제거, 정규화, 정렬, 중복 시각 제거를 하지 않는다. 원본 의미를 보존하고 이런 과학 처리는 후속 단계가 담당한다.

메타데이터는 `tic_id`, `sector`, `product_id`, `procver`, `timesys`, `bjdrefi`, `bjdreff`, `timeunit`, `timedel`, `flux_unit`을 기록한다. 계보는 `raw_release`, `raw_size_bytes`, `raw_sha256`, `bundle_location`, `sequence_key`, `offset_start`, `offset_end`, 파일별 `input_snapshot_id`, `source_list_sha256`, `worker_slot`, `schema_version`, `pipeline_version`을 기록한다. Sector marker에는 전체 파일별 snapshot ID 집합의 개수와 정렬 LF 직렬화 SHA-256도 기록한다.

Raw SHA-256이 77의 원본 바이트 무결성 기준이다. 2026-09-21 실환경 표본은 Primary HDU의 FITS `CHECKSUM`만 유효하고 LIGHTCURVE·APERTURE HDU 값은 Astropy 검증에 실패했으므로 HDU `CHECKSUM`을 publish 차단 조건으로 추가하지 않는다. 이 값의 원천 독립 검증은 수집 문서에 남은 별도 개선 후보다.

### 오류 계약

제품별 오류는 `sector`, `product_id`, `raw_release`, `bundle_location`, `raw_sha256`, `error_stage`, `error_code`, `error_detail`로 격리한다. `error_detail`은 공백을 정규화하고 500자로 제한하며 FITS 본문을 넣지 않는다.

| stage | code |
| --- | --- |
| `input` | `manifest_entry_missing`, `sequence_product_count_mismatch` |
| `raw_checksum` | `raw_size_mismatch`, `raw_sha256_mismatch` |
| `fits_parse` | `fits_open_failed`, `invalid_identity`, `invalid_array`, `unsupported_time_metadata`, `unsupported_flux_unit`, `missing_header`, `missing_header_or_column`, `invalid_fits_structure`, `length_mismatch`, `sector_identity_mismatch`, `tic_identity_mismatch`, `unexpected_parse_error` |

오류가 하나라도 있으면 summary의 `contract_ok=false`이며 staging과 오류 Parquet을 보존하고 Sector final을 만들지 않는다. 제품 파싱·Raw checksum, Raw·Bronze marker 불일치처럼 같은 입력에서 반복되는 데이터 계약 오류는 전용 오류와 종료 코드 65로 구분하며, Sector 변환 중 확인한 오류는 상태 파일에도 `terminal_failed`로 기록한다. Spark 드라이버에서 확인한 manifest 구조·개수·lineage 오류는 해당 attempt의 `_TERMINAL` marker로 제어기에 전달해 같은 경로로 처리한다. systemd는 이 종료 코드를 재시작하지 않고 unit을 disable하므로 해당 attempt 하나만 남는다. terminal marker가 없는 HDFS·YARN·Spark 제출 실패처럼 운영 중 복구될 수 있는 오류만 5분 뒤 다시 시도한다. 모든 실패는 final 공개 전에 중단한다.

### 실행

저장소 루트에서 다음 순서를 사용한다. `CodeReleaseId`와 `RunId`는 UTC `yyyyMMddTHHmmssZ`다.

```powershell
.\infra\distributed-system\scripts\test-tess-bronze.ps1
.\infra\distributed-system\scripts\run-tess-bronze.ps1 -Step Install -CodeReleaseId <code-release>
.\infra\distributed-system\scripts\run-tess-bronze.ps1 -Step Preflight -CodeReleaseId <code-release> -Sector 3
.\infra\distributed-system\scripts\run-tess-bronze.ps1 -Step Canary -CodeReleaseId <code-release> -RunId <run> -Sector 3
.\infra\distributed-system\scripts\run-tess-bronze.ps1 -Step Start -CodeReleaseId <code-release> -RunId <run> -Sector 3,4,5
.\infra\distributed-system\scripts\run-tess-bronze.ps1 -Step Status -CodeReleaseId <code-release> -RunId <run>
```

`Install`은 코드, 고정 Python 의존성, 기존 FITS adapter와 원자 rename Java helper를 root 소유 불변 release로 설치한다. 실행 환경은 Astropy·NumPy·adapter를 결정적 tar archive로 만들고 HDFS RF2에 한 번 올린 뒤 YARN `--archives`로 배포한다. `Canary`는 한 bundle의 정렬된 앞 5개만 validation 경로에서 검증하고 성공 시 그 경로만 삭제한다. `Start`는 enabled systemd oneshot에 실행을 인계하므로 운영자 PC가 끊기거나 재부팅돼도 서버에서 재개한다. 일시적인 인프라 실패는 5분 뒤 서버가 자체 재시작하며 시작 횟수 제한을 두지 않는다. 데이터 계약 오류는 자동 재시작과 다음 부팅 실행을 중단하고 실패 상태·attempt·오류 목록을 운영자 확인용으로 보존한다. 입력이나 코드를 수정한 뒤 새 RunId로 명시적으로 다시 시작한다. 성공하면 unit을 disable해 다음 부팅의 불필요한 재실행을 막는다. 재실행은 동일 pipeline version의 검증된 final만 재감사해 건너뛴다.

Sector 1~13을 한 실행에 모두 지정하면 먼저 Raw coverage marker가 13개 Raw `_READY.json`을 정확히 가리키는지 확인한다. 모든 Bronze Sector를 완료·재감사한 뒤 각 Bronze marker의 SHA-256, 제품·관측점 합계, Raw coverage marker SHA-256과 pipeline version을 묶은 Bronze coverage marker를 RF2·FSCK 확인 후 원자 확정한다. 이 marker가 없으면 일부 또는 13개 Sector 경로가 존재해도 전체 Bronze 완료로 판단하지 않는다.

Airflow처럼 Sector를 하나씩 실행하는 조정기는 마지막 Sector 뒤 `tess_bronze_ctl.py coverage --release-dir <release> --run-id <run> --pipeline-version <version>`을 호출한다. 이 명령은 Raw coverage와 Bronze Sector 1~13을 모두 재감사한 뒤 같은 coverage marker를 멱등 확정한다.

2026-09-22 단계별 DAG 연동을 위해 `run-all --sector <N> --raw-release <UTC release> --expected-source-sha <SHA-256>` 인자를 추가했다. 신규 Sector는 Raw release를 명시하고 `_READY.json`의 source SHA가 인자와 다르면 변환 전에 종료 코드 65로 중단한다. Sector 1~13의 기존 고정 release·전체 coverage 계약은 변경하지 않았다. Sector 14 이상 자동 수집은 원천 목록·HDFS coverage 일반화와 운영 검증이 끝나기 전까지 활성화하지 않는다.

### 2026-09-21 실행 결과

전체 run `20260920T230600Z`는 서버 systemd와 YARN cluster mode에서 `2:14:41` 동안 실행됐다. Sector 1~13의 제품 247,824개와 관측점 4,666,320,826개를 520개 Parquet part로 확정했으며 parse 오류는 0이다. 최종 Sector 경로의 논리 용량 합계는 83,007,747,330 bytes이고 RF2 적용 용량은 166,015,494,660 bytes다.

13개 Sector marker 합계와 coverage marker를 독립 대조했고, 전체 `/lake/bronze/tess` FSCK는 missing·corrupt·under-replicated block 0으로 `HEALTHY`였다. 최종 marker는 `/lake/bronze/tess/coverage=df6bfa638a0d70913b0d0bade11f0c5335bf9c505a9fbe256fa8552f0623bd94/_READY.json`이다. 실행 중 운영자 PC의 Tailnet 연결이 끊긴 동안에도 서버에서 다음 Sector가 완료됐고, 종료 시 systemd `Result=success`, exit 0, 재시작 0, YARN 실행 application 0을 확인했다.

## 127 전처리·최초 BLS Worker 초기 검증

상태: **Sector 3의 20 TIC 실제 Spark/YARN 수치·부분 재실행 검증 및 develop 병합 완료**. Jira `S15P21C206-127`.
`tess_kernel_check.py`는 119·120을 재사용하는 고정 소규모 검증 실행기다. Silver 운영 공개·전체 데이터 처리,
반복 BLS·Gold·DB 변경은 하지 않는다. Tailscale로 서버에 접속하며, 사용자 승인으로 에이전트도 검증을 실행한다.

- `export`: `_READY.json`이 있는 불변 Bronze Sector 경로에서 TIC 오름차순 20개(최대 50개)를 고른다.
  표본 선택은 과학적 성공 여부와 무관하다. 해당 Sector의 원본 배열·제품·raw SHA·snapshot ID를 JSONL로 내보낸다.
  동일 TIC/Sector에 복수 제품이 있으면 임의 선택하지 않고 실패한다. 현재 export는 Sector 하나를 기준으로 한다.
- `local`: 내보낸 같은 JSONL을 노트북에서 119 전처리 → 120 최초 BLS로 처리한다.
- `worker`: 같은 입력을 Spark Executor에서 처리한다. 표본 한정으로 최대 50 TIC를 driver에 가져오므로
  운영 전체 Bronze를 입력하지 않는다. 각 TIC의 모든 지정 Sector를 하나의 계산 단위로 유지한다.
- `compare`: 입력·코드 지문, 전체 전처리/마스크/원본 행 추적, 주기도·피크·진단·실패 결과를 비교한다.
  수치 허용치는 실행 전 rtol=1e-12, atol=0으로 고정한다. 과학적 채택 문턱이 아닌 엄격한 구현 동등성 검사다.
  NaN 위치·정수·상태는 정확히 일치해야 한다. 플랫폼·Python/NumPy/Astropy 차이는 보고서에 따로 남긴다.
  불일치 시 허용치를 사후 확대하지 않고 원인·환경을 확인한다.

입력 파일은 모든 제품 내용의 SHA-256을 TIC별로 가지며 local/worker가 검증한다. 코드 지문은 실행기와
BLS·전처리·고정 모델 모듈 소스로 생성한다. JSON에서는 비유한 원본/배열 값을 `NaN`·`Infinity`·`-Infinity`
문자열로 표현해 null과 구분하며 Gold 계약으로 사용하지 않는다. Sector 진단의 None은 JSON null이다.
119가 실패/관측 부족을 반환하면 BLS로 전달하지 않는다. 정상 `no_quality_peak`와 실패를 구분한다.
상류 prepare_silver가 제거한 Sector의 상태는 products/sectors·excluded에서 추적한다.

### 준비·실행 순서

1. 서버 Python/Spark·YARN·HDFS 상태, Bronze `_READY.json`, 검증 출력 위치·여유 공간을 읽기 전용으로 확인한다.
2. 127 실행기와 전체 astro_kernel 패키지를 같은 코드로 노트북/서버에 준비한다. 기존 77의 archive는 FITS
   adapter만 포함할 수 있으므로 BLS·전처리 전체 모듈과 Astropy·NumPy 포함 여부를 확인한다.
   기존 운영 release를 덮어쓰지 않고 별도 검증 release/환경을 사용한다. Executor에도 의존성을 전달한다.
3. 아래 export를 서버에서 실행하고 출력 part들을 `hdfs dfs -getmerge`로 새 로컬 JSONL에 합쳐 노트북에 전달한다.
   노트북 입력과 서버 export의 TIC별 input_sha256은 같아야 한다.
4. 노트북 기준 실행과 실제 YARN worker 실행을 수행한다. 각 명령의 출력 경로는 존재하지 않아야 한다.
5. worker 결과도 getmerge로 전달해 compare한다. 로그의 application_id와 YARN 최종 상태·입출력 경로를 보관한다.
6. 별도 fault attempt에 실제 표본 TIC 하나를 `--fail-tic`로 지정한다. 다음 retry에서는 이 옵션을 빼고
   `--previous`에 fault attempt를 전달한다. 성공 TIC는 재출력하지 않고 실패/누락 TIC만 새 경로에 기록한다.
   비교 시 fault와 retry delta를 합쳐 최초 기준과 일치하며 성공 TIC 중복이 없음을 확인한다.

다음은 위치가 확정된 뒤 사용할 명령 형태다. 실제 archive 경로·Python·YARN 자원은 사전 점검 뒤 정한다.
`--py-files`에는 이 실행기와 전체 astro_kernel ZIP을 전달하고, 의존성 archive는 77과 같은 YARN 배포 방식을 따른다.
Python 파일과 ZIP만으로 NumPy/Astropy 바이너리를 배포한 것으로 간주하지 않는다.

```powershell
# 노트북: 저장소 최상위, 입력 경로는 서버에서 받은 파일
libs/astro-kernel/.venv/Scripts/python.exe distributed-system/spark/tess_kernel_check.py local --input <sample.jsonl> --output <reference.jsonl>
libs/astro-kernel/.venv/Scripts/python.exe distributed-system/spark/tess_kernel_check.py compare --input <reference.jsonl> --previous <worker.jsonl> --output <comparison.jsonl>
libs/astro-kernel/.venv/Scripts/python.exe distributed-system/spark/tess_kernel_check.py compare --input <reference.jsonl> --previous <fault.jsonl> --retry <retry.jsonl> --output <retry-comparison.jsonl>
```

서버 spark-submit의 애플리케이션 인자는 다음과 같다(archive·py-files·환경 옵션 앞에 별도 설정).

```text
export --input <immutable-bronze-sector> --output <new-sample-path> --count 20
worker --input <sample-path> --output <new-worker-path>
worker --input <sample-path> --output <new-fault-path> --fail-tic <sample-tic>
worker --input <sample-path> --previous <fault-path> --output <new-retry-path>
```

Spark 클러스터의 실행은 제출 세션 종료와 별개로 유지되는 서버 작업 방식으로 인계하며 로그와 종료 상태를
확인한다. 경로 준비·배포·실행 명령은 실제 환경 확인 전 실행하지 않는다. 기존 Bronze 운영 제어기의 Install/Start를
127을 위해 재실행하지 않는다. 출력은 검증 전용 새 위치이며 기존 성공 결과를 덮어쓰거나 삭제하지 않는다.

### 검증과 미완료 사항

서버 실행기는 [run_kernel_check.sh](run_kernel_check.sh)다. 준비된 패키지 폴더, `export`/`worker`,
새 attempt 이름과 CLI 인자를 받아 기존 77과 같은 Docker/YARN cluster 배포를 사용한다.
검증 전용 경로는 `/lake/validation/worker-127-2939779df51b`이며 executor 2개·각 2 core/6 GiB로 제한한다.
표준 출력은 `nohup` 호출에서 별도 로그로 보관하고 Spark 제출 종료 코드는 `<attempt>.exit`에 기록한다.
출력이 이미 존재하면 덮어쓰지 않고 중단한다. 실제 작업 완료 여부는 YARN 최종 상태와 결과 검산으로 확인한다.

2026-09-21 서버 사전 검사에서 Python 3.12.3·NumPy 2.5.3·Astropy 7.2.2 및 ZIP의 BLS·전처리 import를 확인했다.
`sudo -u hdfs`는 사용자 환경을 보존하지 않으므로 `JAVA_HOME`과 `HADOOP_CONF_DIR=/etc/hadoop`을 함께 지정한다.
설정이 없으면 `fs.defaultFS=file:///`로 로컬 경로를 조회하므로 HDFS 작업 전 `hdfs://planetory`인지 확인한다.
첫 YARN 시도 `application_1789686202146_0022`는 의존성 archive의 이전 astro_kernel이 먼저 import되어 실패했다.
Driver와 Executor 모두 `PYTHONPATH=./kernel-check.zip:./environment`로 고정해 새 커널을 우선한다.
실패 시도는 성공 결과로 계산하지 않으며, 새 attempt에서 다시 검증한다.

오프라인 테스트는 실제 119·120 호출·원본 행 추적·입력 변조 거절·중복 Sector 거절·실패/누락 TIC 선택 재실행·
관측 부족 실패·NaN/마스크 비교를 확인한다. 같은 실패 결과끼리 일치해도 all_successful=false로 별도 보고하며
parity_passed만으로 127 완료를 선언하지 않는다. 실제 다중 Sector 표본 검증은 아직 수행하지 않았다.
이번 결과는 아래 단일 Sector 범위이며 전체 Silver 운영이나 과학적 회수 성능 검증으로 확대 해석하지 않는다.
검증 결과는 develop 병합 커밋 `8653e21`에 포함됐다.

### 2026-09-21 실제 검증 결과

- 불변 입력: `/lake/bronze/tess/sector=0003`, `_READY.json`의 run `20260920T221100Z`.
- TIC 오름차순 20개, 관측점 393,840개. 입력 JSONL SHA-256:
  `68099c7c63ab46e55e14ba794c92b4274faf245be79fa5058d6063719fc2ea89`.
- 실행 코드 지문: `ffbf961fde667c00e4ce4822cdb3fbf93e0f07e1ece4f5fdfb6fa3b8a96b0e70`.
  미커밋 검증 실행이므로 Git clean 실행으로 주장하지 않는다. 전달 ZIP 소스와 결과 코드 지문을 근거로 삼는다.
- 노트북 Python 3.11.9/NumPy 2.4.6/Astropy 7.2.2와 Worker Python 3.12.3/NumPy 2.5.3/Astropy 7.2.2를 비교했다.
- 전처리 배열·마스크·원본 행 추적·주기도 power/period·피크·진단이 rtol=1e-12, atol=0에서 일치했다.
  계산 성공 20개, 실패 0개이며 모두 `no_quality_peak`다. 양성 후보 회수 성능은 이 표본에서 검증하지 않았다.
- TIC 3811238에 의도적 실패를 넣은 시도는 정상 19개·실패 1개를 기록했다. 재시도 출력은 해당 TIC 1행뿐이며,
  기존 정상 결과와 합친 20개가 기준 결과와 일치했다. 정상 TIC 중복 출력 0건, 최종 실패 0건이다.
- Worker 계산은 ApplicationMaster worker-2, Executor worker-3·worker-5에서 수행했다.
  종료 시 YARN 실행 중 application 0개를 확인했다. Bronze 원본·운영 release·DB는 변경하지 않았다.

| 단계 | YARN application | 최종 상태 | 검증 경로의 하위 출력 |
| --- | --- | --- | --- |
| 최초 export (이전 커널 우선 import) | `application_1789686202146_0022` | FAILED | 성공 출력 없음 |
| 수정 후 export | `application_1789686202146_0023` | SUCCEEDED / exit 0 | `sample-s3-v2` |
| Worker 계산 | `application_1789686202146_0024` | SUCCEEDED / exit 0 | `worker-s3` |
| 실패 주입 | `application_1789686202146_0025` | SUCCEEDED / exit 0, 별 1개 실패 | `fault-s3` |
| 실패 별 재시도 | `application_1789686202146_0026` | SUCCEEDED / exit 0 | `retry-s3` |

노트북 결과는 Git 제외 경로 `experiments/tess-bench/results/worker-127/`에 보관한다.
`comparison-s3.jsonl`과 `retry-comparison-s3.jsonl` 모두 `parity_passed=true`, `all_successful=true`다.
실행 로그·종료 코드·입출력 SHA와 결과는 리뷰 증빙으로 함께 보관한다. 오프라인 테스트 19 passed,
실행 스크립트 `bash -n` 통과. Git 검사는 사용자 실행 단계로 남긴다.
## TESS Bronze → Silver 최초 탐색 (`S15P21C206-78`)

`tess_silver.py`는 확정 Bronze coverage가 가리키는 Sector 1~13 Parquet을 읽고 `tic_id`로 분산 그룹화한다. 각 TIC에서 `astro_kernel.preprocessing.preprocess_silver`와 `astro_kernel.bls.search_bls`를 순서대로 호출하며, 전체 Bronze나 TIC 목록을 드라이버에 수집하지 않는다. 한 TIC의 데이터·수치 오류는 그 TIC의 manifest 행으로 격리하고 다른 TIC 결과를 보존한다.

Canary·failed-TIC 재처리는 대상 TIC를 먼저 필터링한 뒤 행 계약을 검사하므로 다른 TIC의 전체 sector distinct를 선행 스캔하지 않는다. 전체 run만 13개 Sector 분포를 검사한다. Bronze/Silver 제어기의 YARN 작업은 Node 1의 `/run/planetory-tess-yarn-<N>.lock` 슬롯 파일 집합으로 **상한을 두고 병렬 실행**한다. 슬롯 수는 `PLANETORY_YARN_SLOTS`(기본 2, 1~8)이며 빈 슬롯이 없으면 15초 간격으로 대기한다. 제한 sudo 경로는 환경 변수를 넘기지 않으므로 Airflow 실행은 항상 기본값 2를 쓰며, 상한을 바꾸려면 `configure-tess-silver-airflow-node1.sh`의 Pool 슬롯과 제어기 기본값을 함께 바꾼다. 이 상한은 두 제어기의 **새 release를 모두 배포한 뒤** 효력이 있다. 슬롯은 살아 있는 제어기 수만 세므로 사전 점검(`require_yarn_headroom`)이 RUNNING YARN 앱도 함께 센다. 앱 이름이 `S15P21C206-77-bronze-<run>-`·`S15P21C206-78-silver-<run>-` 형식이 아닌 앱이 하나라도 있으면 거부하고, 이름 열을 읽지 못한 행도 외부 앱으로 간주한다. 파이프라인 앱은 그 수가 슬롯 수보다 적을 때만 새 제출을 허용하므로, Airflow 재시작 등으로 제어기가 죽어 슬롯 없이 남은 cluster-mode 앱(고아)이 상한을 깨지 못한다. Airflow 실행 계약과 14+ 제외 범위는 [Silver DAG 안내](../airflow/dags/README.md)를 따른다.

현재 구현 범위는 245 원본 행·구간 마스크 추적 전처리, 최초 BLS, 122 반복 BLS·제거 QA까지다. 첫 탐색의 검증된 메모리 결과를 반복 커널에 전달해 중복 탐색하지 않는다. 후보 ID·판 비교·생명주기 변경은 Publisher의 이전 판·ID 예약·승인 근거를 받아 별도 연결한다. 세그먼트·비닝(`123`), 외부 조인(`124`), AI 입력·추론(`126`)은 아직 연결하지 않는다.

### 입력·출력 경계

입력은 Bronze coverage marker의 `sectors[].location` 13개만 사용한다. 임의의 Sector glob이나 Raw 파일을 다시 읽지 않는다. 제어기는 coverage와 각 Sector `_READY.json`의 SHA-256, schema, pipeline version, 제품·관측점 수와 RF2를 대조한 뒤 제출한다.

```text
/lake/silver/pipeline_version=<version>/run_id=<run>/attempt=<UTC>/
├─ target_combined/
├─ periodogram/
├─ iteration/
├─ manifest/
├─ summary/
└─ _READY.json
```

각 attempt는 덮어쓰지 않는 독립 결과다. Spark는 `.staging`에 `errorifexists`로 쓰고 제어기가 네 Parquet 출력의 RF2·part checksum과 전체 FSCK를 확인한 뒤 attempt 전체를 원자 rename한다. `planetory.tess-silver-attempt.v4` `_READY.json`은 attempt 처리가 끝났다는 뜻이며 `failed_tics=0`을 뜻하지 않는다. 최초 탐색·반복 탐색 수와 실패·미완료·QA 판정 수를 별도로 기록한다. `failed_tics`는 최초 `failed`와 반복 `failed`·`incomplete`의 합이며, 반복 `qa_stopped`는 `iteration_qa_stopped_tics`에만 센다. 선택 TIC와 최초 manifest TIC, 반복 대상 TIC와 반복 manifest TIC, 실제 반복 출력 TIC를 각각 대조한다. 후속 소비자가 선택할 current alias는 아직 만들지 않는다.

`target_combined`는 `QUALITY == 0` 필터, Sector별 중앙값 정규화, 전처리 결과와 다음 배열을 같은 위치로 보존한다.

| 필드 | 의미 |
| --- | --- |
| `time`, `normalized_flux`, `flux_err` | TIC 결합 후 정렬된 관측 배열 |
| `sector`, `product_id`, `source_row`, `cadenceno`, `original_quality` | 각 관측점의 Bronze 원천 위치와 변경하지 않은 원래 QUALITY |
| `trend`, `cleaned_flux`, `kept`, `segment_id` | 전처리 수치 결과와 BLS 입력 mask |
| `normalization_median_json`, `excluded_json`, `detrend_failures_json` | Sector 정규화와 제외·수치 진단 |
| `mask_contract_version`, `interval_masks_json`, `exclusion_ledger_json` | 적용한 마스크 계약·근거와 원본 제품·행별 제외 장부 |
| `raw_observation_count`, `prepared_observation_count`, `kept_observation_count`, `excluded_observation_count` | `raw = kept + excluded` 행 보존 검증값 |
| `input_snapshot_id` | 정렬한 `product_id`, Bronze `input_snapshot_id`, Raw SHA-256의 LF 직렬화 SHA-256 |
| `preprocessing_version`, `provenance_status` | 계산 버전과 추적 계약 완성도 |

`periodogram`은 최초 탐색의 주기·power·epoch·duration·depth·depth error·SNR·SDE 배열, 유효 입력 mask, BLS 설정과 상위 peak·채택 peak JSON을 기록한다. 반복 제거용 residual·periodogram 배열은 현재 만들지 않는다. 이 20,000점 선형 탐색 결과는 후속 `periodograms` Gold용 5,000점 로그 격자 결과가 아니며 그대로 게시하지 않는다. `bls_config_version=bls_grid_v1/poc_linear20k`, `candidate_quality_version=gate_v1/snr7_sde6`을 행마다 기록한다.

`iteration`은 최초 탐색이 정상 수행된 TIC에만 실행한다. 공용 `iterate_bls(..., initial_search=first_result)`에 최초 결과를 메모리에서 직접 전달하고, `result_json`에 단계별 QA·종료 사유·채택 제안·설정 지문을 엄격 JSON으로 기록한다. `residual` 배열을 저장하지 않으며 후보의 `peak_id=step-N`을 DB candidate ID로 취급하지 않는다. `complete=true`인 `status=ok`만 다음 후보 검토의 입력으로 사용할 수 있고 `incomplete`·`qa_stopped`·`failed`는 기존 공개 판을 바꾸지 않는다.

반복 커널이 스스로 내린 품질 판정으로 멈춘 경우(`removal_qa_failed`, `candidate_validation_failed`)는 manifest `status=qa_stopped`로 기록한다. 같은 입력과 설정에서는 항상 같은 결과가 나오는 과학 판정이므로 처리 실패로 세지 않고 retry 대상도 아니다. 멈추기 전까지 수락한 후보와 `result_json`은 그대로 보존한다. 예를 들어 13 Sector 장기관측의 고SNR 행성은 박스 모델 제거 잔차에 `alias_multipliers=(0.5, 1, 2)` 밖의 배수 alias가 남아 여기서 멈출 수 있다. 판정 기준 자체는 122 커널 범위다. `numerical_failure`는 커널의 예외 처리 경로가 코드 결함까지 같은 이름으로 기록하므로 `failed`로 유지한다. 반복 뒤 원본 SNR 재검증에서 난 예외도 커널이 `numerical_failure`(`phase=original_validation`, `error_type`)로 기록하므로 `qa_stopped`가 아니라 `failed`다(2026-09-26 보완). 그 전 release에서는 이 예외가 NaN으로 바뀌어 `candidate_validation_failed`(`qa_stopped`)에 섞일 수 있었다. 2026-09-25 전체 run은 수락 후보의 `original_snr`가 null인 TIC가 0개라 이 경로의 예외가 없었다. 그 run의 `qa_stopped` 17,553개는 `removal_qa_failed` 17,460개와 `candidate_validation_failed` 93개(유한한 원본 SNR 미달 91개, 반복 루프 안 후보 기하 검증 실패 2개)다.

manifest schema는 `planetory.tess-silver-stage.v4`이며 TIC·stage 한 쌍당 한 행이다.

| 필드 | 계약 |
| --- | --- |
| `stage` | `initial_bls`는 모든 TIC, `iteration`은 정상 최초 탐색 TIC에 한 행이다. |
| `status` | 최초 탐색은 `succeeded`/`no_quality_peak`/`failed`, 반복 탐색은 `succeeded`/`incomplete`/`qa_stopped`/`failed`다. 정상 첫 무후보도 반복 종료를 확인한다. |
| `retryable` | 예상하지 못한 Worker 처리 오류만 `true`다. 데이터·수치 계약 오류는 같은 입력으로 자동 반복하지 않는다. Bronze 행을 읽는 동안의 `KeyError`·`TypeError`·`ValueError`만 `invalid_bronze_row`이고, 전처리 호출 이후의 코드 결함은 `unexpected_processing_error`(`retryable=true`, 상세에 예외 형식과 메시지)로 기록한다. 커널이 던진 `PreprocessError`·`BlsError`는 그 코드를 유지한다. |
| `input_snapshot_id`, 계산 버전 3종 | 입력과 전처리·탐색·품질 게이트를 함께 고정한다. |
| `provenance_status`, `mask_contract_version`, `interval_mask_count` | 마스크 공급 여부와 적용한 245 계약을 기록한다. 빈 마스크는 baseline 상태를 유지한다. |
| `target_location`, `periodogram_location`, `iteration_location` | 실제 생성된 출력만 기록한다. 반복 실패로 출력이 없으면 마지막 값은 null이다. |
| `error_code`, `error_detail` | 실패 원인과 공백 정규화·500자 제한 상세를 기록한다. 원본 배열은 넣지 않는다. |

`Retry`는 현재 v4 완료 attempt의 manifest에서 `status=failed` 또는 `incomplete`인 TIC만 Bronze와 semi join해 새 attempt에서 최초·반복 단계를 함께 재실행한다. 이전 성공 결과를 덮어쓰거나 합쳐 쓰지 않는다. 운영자가 실패·상한 원인과 코드·입력 수정 여부를 확인한 뒤 명시적으로 시작한다. `qa_stopped` TIC는 선택하지 않는다. 이전 v2·v3 attempt는 새 스키마로 직접 재시도하지 않는다. v3 운영 attempt는 만들어진 적이 없다.

### 담당자 인계 인터페이스

| 담당 작업 | 이 작업이 제공하는 입력 | 담당 작업이 제공해야 하는 결과 | 현재 처리 |
| --- | --- | --- | --- |
| `245` 관측 구간 마스킹 | `product_id`, `source_row`, `cadenceno`, `sector`, Bronze `quality`, Raw FITS SHA-256 | 정규화 전에 적용할 관측점별 evidence mask, 원래 QUALITY, 제외 사유·근거 버전 | 공용 계약과 Silver 출력 연결은 완료했다. 운영 manifest가 공급되지 않은 실행은 빈 마스크와 `provenance_status=quality0_baseline_pending_interval_mask`를 유지하므로 최종 DAT-02로 간주하지 않는다. |
| `127` Worker 초기 연결 | `process_tic`의 `SectorInput[]` 호출과 TIC별 결과 계약 | 실제 YARN canary의 executor 배치·자원·수치 동일성 증거 | 127의 Sector 3 20 TIC local/Worker parity·실패 재실행과 78의 다중 Sector 단일 TIC Canary를 모두 통과했다. 전체 처리량·장시간 안정성은 별도 gate로 남는다. |
| `122` 반복 탐색 | `target_combined`, 최초 탐색 메모리 결과·계산 버전 | 반복 BLS·제거 QA·종료 사유·후보 제안 | Spark `iteration` stage에 연결했다. ID 예약·이전 판·승인 입력이 없어 DB 후보 ID와 생명주기 결정은 만들지 않는다. |
| `123`·`124`·`126` | 확정 후보 ID와 TIC snapshot | 비닝·외부 snapshot 조인·AI 결과 및 각 계산 버전 | 각 결과 계약이 확정된 뒤 별도 stage로 연결한다. |

같은 Python/Spark release를 공유하므로 내부 호출 계약은 `tess_silver.py`의 `TicStageResult`와 `_schemas`가 정본이다. 독립 서비스 간 직렬화 계약이 아니므로 `contracts/`에 같은 형식을 중복 정의하지 않는다.

### 실행과 검증

저장소 루트에서 먼저 오프라인 계약 검증을 실행한다. `Canary`는 관측점이 충분한 것으로 확인된 TIC를 1~5개 명시해야 하며 임의의 앞 N개를 선택하지 않는다.

```powershell
.\infra\distributed-system\scripts\test-tess-silver.ps1
.\infra\distributed-system\scripts\run-tess-silver.ps1 -Step Install -CodeReleaseId <code-release>
.\infra\distributed-system\scripts\run-tess-silver.ps1 -Step Preflight -CodeReleaseId <code-release>
.\infra\distributed-system\scripts\run-tess-silver.ps1 -Step Canary -CodeReleaseId <code-release> -RunId <run> -TicId <tic>
.\infra\distributed-system\scripts\run-tess-silver.ps1 -Step Start -CodeReleaseId <code-release> -RunId <run>
.\infra\distributed-system\scripts\run-tess-silver.ps1 -Step Status -CodeReleaseId <code-release> -RunId <run>
.\infra\distributed-system\scripts\run-tess-silver.ps1 -Step Retry -CodeReleaseId <code-release> -RunId <run> -UnitId <new-unit-id> -RetryFrom <completed-attempt>
```

`Install`은 Silver job·제어기, 77의 검증된 공용 제어 primitive, 고정 Python 의존성, `astro_kernel`과 원자 rename helper를 불변 release로 설치한다. 압축에 Windows `tar`가 필요하므로 Git Bash가 아니라 PowerShell에서 실행한다(Git Bash의 GNU tar는 `C:` 경로를 원격 호스트로 해석해 실패한다). `-TicId`는 배열이므로 `pwsh -File`로 쉼표 목록을 넘기지 말고 PowerShell 안에서 `& .\infra\distributed-system\scripts\run-tess-silver.ps1 ... -TicId @(259377017, 149603524)`처럼 호출한다. `Start`와 `Retry`는 systemd oneshot에 인계한다.

Spark는 executor 최대 14개 × core 2개(memory `5g` + overhead 2048 MiB = 7 GiB, `OMP_NUM_THREADS=1`)로 제출한다. 24 GiB NodeManager에 정확히 3개, 16 GiB인 worker-2에 2개가 들어가 동시 28작업이다. YARN은 메모리만으로 배치하므로 executor 크기를 이렇게 맞추지 않으면 한 노드에 몰린다. YARN은 `yarn.scheduler.maximum-allocation-vcores=3`을 넘는 컨테이너를 거부하므로 core를 늘리지 않고 개수를 늘린다. dynamic allocation을 켜며(`initialExecutors`·`maxExecutors`=14, `minExecutors`=2, `executorIdleTimeout`=300s, 외부 셔플 서비스 대신 `shuffleTracking`), 시작할 때 덜 받은 executor는 메모리가 비면 다시 늘어난다. 셔플 파일이나 `DISK_ONLY` 결과를 가진 executor는 반납하지 않으므로 계산 단계 이후에는 거의 줄지 않는다. Silver가 YARN 112 GiB 중 약 101 GiB를 쓰므로 동시에 도는 Bronze는 executor 1개 정도만 받는다. `shuffle_partitions`는 1~2000이며 전체 run은 2000을 권장한다(작업당 약 64 TIC). Spark는 Bronze 28개 열 중 `process_tic`이 읽는 10개(`SILVER_INPUT_COLUMNS`)만 Python으로 넘긴다. TIC 결과는 `results.count()`로 shuffle 파티션 수만큼의 작업에서 먼저 계산해 캐시하고, 이후 `coalesce(output_partitions)` 쓰기는 캐시만 읽는다. 이 단계가 없으면 BLS 전체가 쓰기 작업 수(기본 80)로 묶여 전체 run에 긴 꼬리가 생긴다. HDFS·YARN 같은 일시 인프라 실패만 5분 뒤 재기동한다. 재기동은 처음부터 새 attempt로 돌기 때문에, 제어기는 그 전에 실패한 attempt의 `.staging` 출력과 Spark staging을 지운다(`discard_failed_attempt`). 지우는 경로는 자기 attempt staging 형식과 정확히 일치해야 하고 final attempt는 건드리지 않는다. YARN CLI가 일시적으로 `UNKNOWN`을 돌려줘도 앱은 살아 있을 수 있으므로, 앱이 `FAILED`·`KILLED`·`SUCCEEDED`로 확인될 때만 지우고 그 밖에는 `SILVER_CLEANUP_SKIPPED`를 남긴다. 상태 파일에는 `status=failed`와 `staging_discarded`를 기록한다. 그리고 coverage·schema 같은 결정적 계약 오류는 종료 코드 65로 자동 반복을 중단한다.

Canary TIC는 최초 전처리가 `insufficient_observations`(유효 관측 500점 미만) 같은 결정적 데이터 판정으로 끝나지 않는 TIC로 고른다. 이런 판정도 `failed_tics`에 들어가 Canary를 실패시킨다. release를 바꿀 때는 아래 회귀 기준 5개 TIC를 한 번에 실행해 이전 Canary와 과학 값을 비교한다.

| TIC | 별 | 결합 Sector | 반복 탐색 기준 결과 |
| --- | --- | --- | --- |
| 259377017 | TOI-270 | 3 (3~5) | `succeeded`, 1위 주기 5.6593303027일·SNR 52.8359·SDE 22.5652 |
| 149603524 | WASP-62 | 12 | `qa_stopped`(`removal_qa_failed`) |
| 150428135 | TOI-700 | 11 | `succeeded` |
| 307210830 | L 98-59 | 7 | `qa_stopped`(`removal_qa_failed`) |
| 279741379 | HD 21749 | 4 | `succeeded`, 게이트 통과 peak 없음 |

Canary는 상세 Parquet을 감사한 뒤 삭제하지만, 최대 5개 TIC의 Sector·관측점 수·상위 채택 peak 5개·오류를 `SILVER_CANARY_AUDIT` 로그와 `/var/lib/planetory-silver/run=<run>/attempt=<attempt>.json`의 `result.science_audit`에 남긴다. 성공한 정확한 attempt의 Spark staging과 빈 run 부모만 정리하며 다른 attempt가 있으면 부모 삭제를 건너뛴다.

오프라인 검증은 데이터 담당 관점의 Bronze coverage·lineage, 과학 담당 관점의 전처리 상태·BLS 정렬 입력, Spark 운영 관점의 TIC 실패 격리·실패 TIC 재선택·드라이버 전체 수집 금지를 확인한다. 2026-09-21 최종 CodeReleaseId `20260921T062449Z`(archive SHA-256 `86f68700bd92281f356b3e8fc4f9957e9893cc91474d4ac3085f57ccbbab25d9`), RunId `20260921T062522Z`로 TIC `259377017`을 실제 YARN Canary 실행했다. `application_1789686202146_0029`는 `SUCCEEDED`, RF2·checksum·FSCK·원자 rename과 상세 출력 삭제·staging 정리를 통과했다. Sector 3·4·5에서 Raw 57,320개, 준비 44,553개, BLS 유효 44,550개를 처리했고 채택 peak 5개 중 1위 `5.6593303027일`, SNR `52.8359`, SDE `22.5652`였다. 저장소 TOI-270 c fixture `5.66051일`과 약 0.021% 차이며 직전 검증 release에서도 같은 snapshot·관측점 수·과학값을 재현했다. 이는 최초 BLS 재현 증거이며 반복 제거·전체 TIC 성능이나 최종 과학 판정을 증명하지 않는다.

### Sector 1~13 전체 run 결과 (2026-09-25 확정)

systemd 경로(`-Step Start`)로 release `20260924T093328Z`(executor 10개 × core 2개, `-ShufflePartitions 500`)를 실행했다. 결과는 `/lake/silver/pipeline_version=S15P21C206-78-20260924T093328Z/run_id=20260924T133559Z/attempt=20260924T133730Z`이며 `application_1790067725443_0064`가 2026-09-24 13:37 UTC에 시작해 2026-09-25 19:34 UTC에 확정됐다(약 30시간).

| 구분 | 값 |
| --- | --- |
| 선택 TIC | 128,258 |
| 최초 탐색 | `succeeded` 28,827, `no_quality_peak` 99,327, `failed` 104(`invalid_normalization` 41, `numerical_failure` 34, `bls_failed` 29, 모두 retryable 아님) |
| 반복 탐색 | `succeeded` 110,601, `qa_stopped` 17,553 |
| 출력 | 논리 318 GB, RF2 636 GB. 확정 뒤 HDFS 사용률 64% |

제어기 재감사(RF2·part checksum·FSCK), Parquet 불변식, 같은 release Canary 5개 TIC와의 값 비교를 모두 통과했다. 실패 104개는 결정적 데이터·수치 판정이라 `retry`로 같은 결과가 반복되므로 자동 재처리하지 않는다.

2026-09-26에 같은 release로 `-Step Retry -RetryFrom <위 attempt>`를 한 번 실행해 부분 재처리를 실클러스터에서 확인했다. `application_1790067725443_0066`이 SUCCEEDED했고 제어기 확정까지 약 9분 걸렸다. 새 attempt `attempt=20260926T091732Z`에는 원본 실패 TIC 104개만 들어 있고, TIC마다 단계·상태·오류 코드·`retryable`이 원본과 같았다. 원본 attempt의 `_READY.json` SHA-256과 파일 시각은 그대로였다. 이 attempt는 검증 기록이며 새 결과가 없으므로, 79 입력은 계속 원본 attempt다. current alias가 없으므로 소비자는 "run의 최신 attempt"를 자동으로 고르지 말고 attempt 경로를 명시한다.

실행 중 2026-09-25 06:12·06:15 UTC에 자동 보안 업데이트가 worker-5·worker-3 NodeManager를 재시작해 executor 6개와 캐시한 결과 파티션 211개를 잃었고, Spark가 이를 다시 계산해 완료가 약 6시간 늦어졌다. TIC 결과를 executor 로컬 디스크에 한 벌만 두는 `DISK_ONLY` 구조라 노드 하나만 재시작돼도 몇 시간 분량을 다시 계산한다. 재발 방지는 [needrestart 예외](../../infra/distributed-system/README.md#needrestart-자동-재시작-예외-s15p21c206-78)로 적용했고, `DISK_ONLY_2` 전환은 HDFS·로컬 디스크 여유와 함께 별도로 검토한다.

현재 설정(executor 14개, dynamic allocation, 입력 열 축소, biweight 벡터화)의 release `20260926T042907Z`는 run `20260926T043105Z`(`application_1790067725443_0065`) Canary에서 5분에 끝났고, `failed_tics=0`, `qa_stopped=2`, executor 14개(worker-2 2개, 나머지 3개씩)를 확인했다. 5개 TIC 결과는 전체 run release Canary(run `20260924T093357Z`)와 비트 단위로 같았다. 다음 Silver 실행은 이 release 또는 그 이후 release를 쓴다. 다음 release는 사용하지 않는다: `20260923T080904Z`(NaN 시각 직렬화 결함), `20260924T091614Z`(core 4 요청으로 YARN 거부).

develop 통합(2026-09-26) 이후 release는 243이 반복 설정 지문에 `candidate_quality_version`을 넣어 `iteration_config_sha256`이 이전 release와 다르다. 기본 품질 버전(`gate_v1/snr7_sde6`)의 판정 값은 같지만, 비트 비교는 같은 지문의 release끼리만 한다.

### Spark 이벤트 로그 (2026-09-26, Node 1 적용)

Bronze·Silver 제어기는 HDFS `/spark-history`가 있을 때만 `spark.eventLog.enabled=true`, `spark.eventLog.dir=hdfs://planetory/spark-history`, 압축과 128 MiB rolling을 제출 설정에 넣는다(`tess_bronze_ctl.event_log_conf`). 디렉터리가 없으면 `SPARK_EVENT_LOG_DISABLED`만 출력하고 이벤트 로그 없이 제출하므로, History Server 설치 여부가 데이터 처리를 막지 않는다. 이벤트 로그는 새 release로 제출한 앱부터 남으며, 이미 실행 중인 앱은 History Server에 나타나지 않는다. 2026-09-26 Canary(`application_1790067725443_0065`)에서 History Server 앱 목록과 HDFS rolling 이벤트 로그를 확인했다. History Server 설치와 접근 경계는 [인프라 안내](../../infra/distributed-system/README.md)를 따른다.

### 245 구간 마스크 인계 (로컬 검증, 배포 전)

127의 최초 BLS 연결에 추가한 입력 계약은 [공용 커널 245](../../libs/astro-kernel/README.md#근거-구간-마스킹-245)를 따른다.
원본 제품 SHA와 근거 snapshot을 검증한 목록을 `preprocess_silver(curves, interval_masks=masks)`에 전달한다.
`SectorInput.source_sha256`는 원본 FITS 바이트의 SHA이며 Bronze Parquet 파일 SHA로 대체하지 않는다.
Bronze 행을 먼저 필터하거나 `source_row`를 다시 매기지 않는다. 호출자는 원본 제품의 0-based 행 배열을
복원한 뒤 마스크를 전달하며, 다른 배열 순서라면 명시적인 원본 행 매핑 없이 이 커널을 호출하지 않는다.
`process_tic(..., interval_masks=())`는 TIC별 마스크를 선택적으로 받는다. `target_combined`에는 `exclusion_ledger(prepared, detrended)`, `prepared.interval_masks`, 원래 QUALITY와 마스크 계약 버전을 남기고 `raw = kept + excluded`를 만족하지 않으면 해당 TIC를 실패로 격리한다.
`detrended.status != "ok"`는 정상 무후보가 아니므로 후속 BLS로 넘기지 않는다. 원본 QUALITY는 변경하지 않는다.
빈 마스크는 기존 수치 결과와 `quality0_baseline_pending_interval_mask` 상태를 유지한다. 실제 클러스터 활성화에는 버전 고정된 마스크 manifest 위치·스키마와 근거 snapshot checksum 승인이 필요하다. 승인 전에는 실험용 Sector 3 범위를 운영 코드에 하드코딩하거나 기존 공개 판을 바꾸지 않는다.
