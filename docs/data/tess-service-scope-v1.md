# v1 서비스 TESS 범위·대표 표본·초기 예산 초안

작성일: 2026-09-16 / 담당: 윤성용 / Jira: `S15P21C206-108` (계획 ID D02-1) / 상태: **확정**. 초기 수집 범위 B(Sector 3·4·5)는 2026-09-18 완료 확인됐으며 할당량·비용 실측과 확대 판단은 별도 FinOps·I18 작업에서 관리한다.

이 문서는 서비스가 처리할 TESS 원천의 범위 시나리오를 비교하고, 처리·저장·전송량을 fixture 실측에서 외삽하며, 예산 상한과 초과 시 축소 순서를 제안한다.
대표 표본(fixture 9별과 구분)은 `experiments/tess-fixture/configs/service_sample_v1.json` 에 고정했고 `python -m tess_fixture sample` 로 받는다.
무신호 별 비율 실측과 튜토리얼 TIC 선정은 `S15P21C206-109`(D02-2), 다운로드 도구 구현은 `S15P21C206-75`(I05-1, 김동혁), 실환경 시간·용량 측정은 I18-1·I18-2 다.

근거: [요구사항 명세서](../requirements/planetory-requirements-spec.md) DAT-01, [결정 등록부](../requirements/planetory-decision-register.md) DEC-01·DEC-16, [데이터 관리](data-guidelines.md), [GCP 분산 인프라](../architecture/gcp-distributed-infrastructure.md) 저장 용량, [TESS fixture 세트](tess-fixture-set.md), [전처리 벤치마크](tess-preprocess-benchmark.md), [AstroNet 평가 세트](tess-astronet-eval-set.md) 실행 시간.

## 1. 질문

DEC-01 "사용할 Sector·데이터 릴리스·케이던스·대상 수" 를 정하기 위해 (1) 후보 범위마다 파일·별이 몇 개인지, (2) 그 규모가 처리 시간·HDFS·PostgreSQL·전송량으로 얼마인지, (3) 어느 범위부터 시작하고 예산을 넘으면 무엇을 먼저 줄이는지를 재현 가능한 숫자로 적는다.

## 2. 원천 범위 사실 (MAST 공식 목록, 2026-09-16 01:01 UTC)

제품은 **SPOC 2분 cadence Light Curve FITS**(`*-s_lc.fits`) 하나로 고정한다. 기존 PoC·fixture·벤치마크가 모두 이 제품이고, FFI(QLP·TESS-SPOC HLSP)·20초 cadence·Target Pixel·DV 제품은 v1 범위 밖이다.

Sector별 파일 수는 MAST bulk download 스크립트 `https://archive.stsci.edu/missions/tess/download_scripts/sector/tesscurl_sector_<N>_lc.sh` 의 항목 수다(파일 1개 = 별 1개·Sector 1개).

| Sector | LC 파일 수 | 파일명 접두 / pipeline id |
|---|---:|---|
| 1 | 15,889 | `tess2018206045859` / 0120 |
| 2 | 15,994 | `tess2018234235059` / 0121 |
| 3 | 15,993 | `tess2018263035959` / 0123 |
| 4 | 19,997 | `tess2018292075959` / 0124 |
| 5 | 19,996 | `tess2018319095959` / 0125 |
| 6 | 19,995 | `tess2018349182500` / 0126 |
| 7 | 19,995 | `tess2019006130736` / 0131 |
| 8 | 19,994 | `tess2019032160000` / 0136 |
| 9 | 19,996 | `tess2019058134432` / 0139 |
| 10 | 19,999 | `tess2019085135100` / 0140 |
| 11 | 19,990 | `tess2019112060037` / 0143 |
| 12 | 19,989 | `tess2019140104343` / 0144 |
| 13 | 19,997 | `tess2019169103026` / 0146 |
| **1~13 합** | **247,824** | 고유 별 **128,258** |

1년차(남반구) 별 128,258개 중 한 Sector 에만 관측된 별이 92,443개(72%), 두 Sector 20,620, 세 Sector 4,361, 13개 Sector 전부(연속 관측 구역) 1,828개다. 접두·pipeline id 는 `tess_fixture.targets.SECTOR_PRODUCT_PREFIX` 에 1~13 을 등록했다(75 의 파일명 생성에 그대로 쓸 수 있다).

팀 문서의 "약 171만 FITS" 는 전체 임무 기준 추정이며 이 문서의 범위 밖 참고값이다.

## 3. 시나리오

| | A. 최소 | B. 권장 초기 수집 | C. v1 목표 | (참고) 전체 임무 |
|---|---|---|---|---|
| Sector | 3 | 3·4·5 | 1~13 | 전체 |
| 파일 수 | 15,993 | 55,986 | 247,824 | 약 1,710,000 |
| 고유 별 | 15,993 | 38,748 | 128,258 | 미산정 |
| 용도 | 파이프라인 첫 통과, I18-1 E2E 시간 측정, 109 무신호 비율 예비 | 서비스 초기 공개. 다중 Sector 결합·판 갱신(Sector 추가) 경로 검증 | 남반구 1년차 전체. DEC-16 시나리오 충족 여부 판단 | v1 밖 |

B 를 3·4·5 로 잡은 이유: fixture 9별 중 TOI-270·TOI-700·WASP-62·HD 21749 가 이 Sector 에 있어 fixture 결과와 서비스 처리 결과를 같은 입력에서 대조할 수 있고, 연속 3개 Sector 라 별 하나가 판 갱신으로 Sector 가 늘어나는 경로(DAT-11·DAT-15)를 실제로 만든다.

## 4. 추정식과 입력값

모든 입력값은 출처가 있는 실측이고, 외삽 가정은 표에 적었다. **BLS 반복 탐색·비닝·Gold 적재 시간은 아직 실측이 없어 잠정**이다.

| 항목 | 단위 값 | 출처 |
|---|---|---|
| Raw LC 파일 크기 | **2.0 MB/파일** 로 계산. 실측 fixture 23개(6 Sector) 평균 1.918 MB(1.806~2.004), 대표 표본 45개(Sector 3) 평균 1.999 MB(1.999~2.002) | fixture `checksums.json`, `service_sample_checksums.json`(manifest `sample-82f4d06e`) |
| Raw 2분 관측점 | 약 19,000~20,000 행/파일, QUALITY==0 후 약 14,000~15,000 | fixture TOI-270 3 Sector 57,320행 → 44,553점(갭 분석 5.2) |
| Silver 정제곡선 | 0.4~0.8 MB/파일 | 행 40 B(time f8·flux f8·err f8·quality i4·cadence i4·sector i2·valid·사유) × 20,000 = 0.8 MB, Parquet 압축 시 약 절반(가정) |
| Gold 세그먼트(PostgreSQL) | 약 16 KB/별·Sector | 27일 ÷ 10분 = 3,888 bin × `real` 4 B + gaps(ERD) |
| Gold 주기도(PostgreSQL) | 약 20 KB/별 | 5,000 격자 × 4 B(ERD `periodograms` 예시) |
| 전처리 + 최초 BLS 시간 | 약 1.9 s/별·Sector(단일 스레드) | 43 smoke: TOI-270 3 Sector 곡선 4개(전처리 biweight 1일 + BLS 선형 20,000점·4 duration) 22.9 s → 5.7 s/곡선 ÷ 3 Sector |
| 반복 탐색 배수 | ×3 (가정) | 111 벤치마크 전. 후보 1~3개 제거 후 재탐색 |
| Worker 코어 | 12 (Node 3~6 × 3 vCore) | GCP 인프라 문서 |
| MAST 전송 속도 | 10 MB/s (가정) | I18-1 에서 실측. fixture 44 MB 다운로드는 수십 초였으나 병렬·대역 미측정 |
| HDFS | 설치 9.77 TiB, 운영 목표 ≤70% = 약 6.8 TiB, RF2 | GCP 인프라 문서 |

### 4.1 시나리오별 추정

| | A (S3) | B (S3~5) | C (S1~13) | 전체 임무 |
|---|---:|---:|---:|---:|
| Raw | 32.0 GB | 112 GB | 496 GB | 3,420 GB |
| Raw RF2 (HDFS) | 64 GB | 224 GB | 991 GB | 6,840 GB |
| Silver (0.4~0.8 MB/파일) | 6~13 GB | 22~45 GB | 99~198 GB | 684~1,368 GB |
| Silver RF2 | 13~26 GB | 45~90 GB | 198~397 GB | 1,368~2,736 GB |
| HDFS 합(RF2) | 0.08~0.09 TB | 0.27~0.31 TB | 1.19~1.39 TB | **8.2~9.6 TB (70% 초과)** |
| Gold PostgreSQL 배열 | 0.57 GB | 1.65 GB | 6.5 GB | 미산정 |
| 처리 CPU 시간 (×1 / ×3) | 8.4 / 25 h | 30 / 89 h | 131 / 392 h | 902 / 2,706 h |
| 12코어 벽시계 (×1 / ×3) | 0.7 / 2.1 h | 2.5 / 7.4 h | 11 / 33 h | 75 / 226 h |
| MAST 전송 (10 MB/s) | 0.9 h | 3.1 h | 14 h | 95 h |

읽는 법: HDFS 합은 Raw·Silver 만이며 팀 문서가 제외한 PublicationBundle 백업·다운로드 임시 파일·Spark shuffle·로그는 들어 있지 않다. C 까지는 HDFS 70% 목표(약 6.8 TiB) 안에 넉넉히 들어오고, 전체 임무는 Raw 만으로도 초과한다. 처리 시간은 전처리·BLS 만이며 비닝·외부 조인·AI 추론·Gold 적재는 포함하지 않는다.

## 5. 대표 표본 (`service_sample_v1`, 45 파일)

fixture 9별은 "다중 행성·식쌍성·활동성 별" 처럼 목적이 있는 표본이라 서비스 별의 분포(대부분 무신호)를 대표하지 않는다. 그래서 별도 표본을 Sector 3 에서 고정했다.

| 묶음 | 수 | 선정 규칙 | seed |
|---|---:|---|---|
| random | 40 | Sector 3 LC 목록 15,993 TIC 에서 `random.Random(20260916).sample`. fixture·확인 행성 보유 별과 겹치는지 사후 검사(0개) | 20260916 |
| planet_host | 5 | NASA Exoplanet Archive `pscomppars` `tran_flag=1` 별 3,620개 중 Sector 3 에 있고 fixture 가 아닌 42개에서 `sample` 5개: HD 28109, TOI-216, HD 22946, TOI-257, TOI-277 | 20260916 |

Archive 조회 시각 2026-09-16 01:02 UTC, ADQL 은 설정 파일에 있다. **다운로드 실측(2026-09-16, manifest `sample-82f4d06e`)**: 45 파일 89.9 MB, 평균 1.999 MB(1.999~2.002), PROCVER `spoc-5.0.20-20201120` 단일, checksum 은 `service_sample_checksums.json` 에 고정. Sector 3 파일 크기가 거의 일정한 것은 같은 Sector 의 2분 cadence 수가 같기 때문이다.

```powershell
cd experiments/tess-fixture
uv run python -m tess_fixture sample          # sample_service/<TIC>/ 에 저장, service_sample_checksums.json 갱신, manifest 기록
```

이 표본의 용도: (1) 위 추정식의 파일 크기·처리 시간 입력을 fixture 밖 별로 재확인, (2) 109 무신호 비율 예비 측정(random 40 에서 BLS 채택 후보가 0개인 별의 비율), (3) 75 다운로드 도구의 첫 회귀 입력. 서비스 데이터 범위 결정이 아니다.

## 6. 제안: 초기 수집 범위·예산 상한·축소 순서 (잠정)

- **초기 수집 범위 = B(Sector 3·4·5, 55,986 파일)**. HDFS 약 0.3 TB, 12코어 처리 수 시간, 전송 3시간 규모라 실패해도 다시 받을 수 있다. A 는 I18-1 E2E 측정용으로 B 에 포함된다.
- **v1 목표 = C(Sector 1~13)**. I03 결과와 B 실측(I18-1)이 위 추정의 2배 안이면 C 로 확대한다.
- **예산 상한(잠정)**: HDFS 사용률 70%(팀 규칙), Raw+Silver RF2 ≤ 2 TB, 최초 처리 벽시계 ≤ 48시간, MAST 전송 ≤ 24시간. 수치는 I03 비용·할당량 결과로 조정한다.
- **초과 시 축소 순서**: (1) 가장 최근 Sector 부터 제외(13 → 12 → …, 연속 구간 유지) (2) Silver 의 진단 열(추세·제외 사유)을 보존 기간 뒤 정리 (3) 관측점이 기준 미달인 별 제외(기준은 110·111 뒤) (4) cadence·제품은 바꾸지 않는다(2분 LC 고정).
- **75 인계물**: Sector 목록 + `SECTOR_PRODUCT_PREFIX` + MAST 스크립트 URL 이면 B·C 의 파일 목록을 재생성할 수 있다. 55,986 행 목록 자체는 Git 에 넣지 않고 생성 규칙과 스크립트 조회 시각·항목 수를 manifest 에 남긴다.

## 7. 승인 조건과 미결

| 항목 | 상태 | 담당·시점 |
|---|---|---|
| Sector·제품·파일 수 사실 | 확인(MAST 목록 2026-09-16) | - |
| 대표 표본 45개 고정 | 완료(설정 파일 + checksum 45개, manifest `sample-82f4d06e`) | 윤성용 |
| 처리 시간·용량 외삽 | 잠정(BLS 반복·비닝·적재 미포함) | I18-1·I18-2 실측 후 갱신 |
| 초기 수집 범위 B 승인 | **완료** | Sector 3·4·5, SPOC 2분 LC 55,986개 |
| 예산 상한 수치 | 잠정 | I03 비용·할당량 |
| 최종 서비스 범위(DEC-01) | 미결 | 109 무신호 비율 뒤 팀 결정 |

## 8. 한계

- Silver 파일 크기와 MAST 전송 속도는 가정값이다. B 실측 뒤 표를 갱신한다.
- 처리 시간은 Windows 단일 스레드 실측을 12코어로 단순 나눈 값이며 Spark 오버헤드·I/O 를 포함하지 않는다.
- Sector 14 이후(북반구·확장 임무)는 파일 수를 세지 않았다. 필요하면 같은 스크립트 규칙으로 센다.
