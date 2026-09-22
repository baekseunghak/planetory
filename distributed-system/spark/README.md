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

### 2026-09-21 실행 결과

전체 run `20260920T230600Z`는 서버 systemd와 YARN cluster mode에서 `2:14:41` 동안 실행됐다. Sector 1~13의 제품 247,824개와 관측점 4,666,320,826개를 520개 Parquet part로 확정했으며 parse 오류는 0이다. 최종 Sector 경로의 논리 용량 합계는 83,007,747,330 bytes이고 RF2 적용 용량은 166,015,494,660 bytes다.

13개 Sector marker 합계와 coverage marker를 독립 대조했고, 전체 `/lake/bronze/tess` FSCK는 missing·corrupt·under-replicated block 0으로 `HEALTHY`였다. 최종 marker는 `/lake/bronze/tess/coverage=df6bfa638a0d70913b0d0bade11f0c5335bf9c505a9fbe256fa8552f0623bd94/_READY.json`이다. 실행 중 운영자 PC의 Tailnet 연결이 끊긴 동안에도 서버에서 다음 Sector가 완료됐고, 종료 시 systemd `Result=success`, exit 0, 재시작 0, YARN 실행 application 0을 확인했다.

## 127 전처리·최초 BLS Worker 초기 검증

상태: **Sector 3의 20 TIC 실제 Spark/YARN 수치·부분 재실행 검증 완료, 리뷰 전**. Jira `S15P21C206-127`.
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
Jira 완료는 리뷰·병합 후 판단한다.

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


### 245 구간 마스크 인계 (로컬 검증, 배포 전)

127의 최초 BLS 연결에 추가할 입력 계약은 [공용 커널 245](../../libs/astro-kernel/README.md#근거-구간-마스킹-245)를 따른다.
원본 제품 SHA와 근거 snapshot을 검증한 목록을 `preprocess_silver(curves, interval_masks=masks)`에 전달한다.
`SectorInput.source_sha256`는 원본 FITS 바이트의 SHA이며 Bronze Parquet 파일 SHA로 대체하지 않는다.
Bronze 행을 먼저 필터하거나 `source_row`를 다시 매기지 않는다. 호출자는 원본 제품의 0-based 행 배열을
복원한 뒤 마스크를 전달하며, 다른 배열 순서라면 명시적인 원본 행 매핑 없이 이 커널을 호출하지 않는다.
`exclusion_ledger(prepared, detrended)`와 `prepared.interval_masks`, 입력 마스크 계약 버전을 Silver 감사 산출물에 남긴다.
`detrended.status != "ok"`는 정상 무후보가 아니므로 후속 BLS로 넘기지 않는다. 원본 QUALITY는 변경하지 않는다.
실제 클러스터에 마스크를 활성화하거나 기존 공개 판을 바꾸는 작업은 이번 245 로컬 검증에서 실행하지 않았다.
