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

오류가 하나라도 있으면 summary의 `contract_ok=false`이며 staging과 오류 Parquet을 보존하고 Sector final을 만들지 않는다. 제품 파싱·Raw checksum, Raw·Bronze marker 불일치처럼 같은 입력에서 반복되는 데이터 계약 오류는 전용 오류와 종료 코드 65로 구분하며, Sector 변환 중 확인한 오류는 상태 파일에도 `terminal_failed`로 기록한다. systemd는 이 종료 코드를 재시작하지 않고 unit을 disable하므로 해당 attempt 하나만 남는다. HDFS·YARN 명령 실패처럼 운영 중 복구될 수 있는 오류만 5분 뒤 다시 시도한다. manifest 자체의 구조·개수·lineage 오류나 Spark/YARN 실패도 final 공개 전에 중단한다.

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
