# astro-kernel: 전처리·고정 transit 모델·잔차 제거 공용 커널

Silver 전처리(`S15P21C206-119`)의 계약·검증 방법은 아래 [Silver 전처리](#silver-전처리-119)를 따른다.
기존 121의 완료 상태와 새 119의 검증·리뷰 상태는 구분한다.

Jira `S15P21C206-121` (계획 ID D14-1) / 담당: 윤성용

상태: **구현 완료·회귀 통과**. 모델 JSON 계약은 D06(`S15P21C206-113`)에서 확정해 [`contracts/gold/transit-model.schema.json`](../../contracts/gold/transit-model.schema.json)
(계약 1.0)이 정본이고, 이 패키지는 그 Schema 가 표현하지 못하는 필드 사이 규칙·수식·실패 코드를 구현한다. 88 담당자(소비자)의 MR 리뷰는
!43 에서 통과했다. 88·131 의 **실제 구현 완료**는 121 의 선행 조건이 아니다.

Spark 배치의 Silver 반복 탐색(`S15P21C206-122`)과 EC2 온라인 Worker(`S15P21C206-88`, 김동혁)가 **같은 수식**으로
"후보 신호를 제거한 잔차곡선"을 만들도록, 순수 함수만 모아 둔 패키지다. 파일·DB·네트워크·큐를 다루지 않고 numpy 외
기본 의존성이 없다. BLS(120)는 선택 extra `astro-kernel[bls]`로 Astropy를 사용한다.
수치 검증(`S15P21C206-131`)도 이 구현을 기준값으로 쓴다.

여기서 하지 않는 것: 반복 BLS·후보 병합(122), Worker 프로세스·큐·Redis·후보 조회·오류 상태 매핑(88), `transit_model`
스키마 최종 확정(113), 실제 PostgreSQL round-trip 과 배치–EC2 환경 비교(131), 온라인 재적합(`joint_refit`).
PoC `pipeline.joint_refit_candidates` 는 "Gold 의 고정 모델을 나눈다"는 v1.0 계약과 달라 옮기지 않았다.

## 설치·실행

```powershell
cd libs/astro-kernel
uv sync --python 3.11
uv run pytest -q
```

다른 uv 프로젝트에서 가져올 때는 두 곳에 적는다. 상대 경로는 **소비 프로젝트의 위치**에 따라 달라진다
(예: `apps/derived-compute/` 에서는 `../../libs/astro-kernel`, `experiments/tess-bench/` 에서도 `../../libs/astro-kernel`).

```toml
[project]
dependencies = ["astro-kernel"]

[tool.uv.sources]
astro-kernel = { path = "../../libs/astro-kernel", editable = true }
```

## 입력 계약: `transit_model` JSON (D06 확정, 계약 1.0)

Gold `candidates.transit_model` JSONB 와 같은 dict 다. 단위는 ERD `candidates` 열 이름과 같다. 필드·타입·단독 필드 범위는
[`contracts/gold/transit-model.schema.json`](../../contracts/gold/transit-model.schema.json) 이 검사하고, 아래 표의 필드 사이 규칙
(`duration_hours/24 < period_days`)과 수식은 이 패키지가 검사한다. 다른 언어 구현은 Schema 로 형식을, `contracts/gold/examples/` 의
정상·불량 예제로 판정을 대조한다.

```json
{
  "candidate_id": "example-b",
  "shape": "box",
  "parameters": {"period_days": 3.36, "epoch_btjd": 1387.06, "duration_hours": 1.6, "depth_ppm": 1450.0},
  "baseline": {"kind": "unity"},
  "residual_model_version": "box-divide-v0"
}
```

| 키 | 필수 | 규칙 |
|---|---|---|
| `shape` | O | `box` 만 지원 |
| `parameters.period_days` | O | 유한, > 0 |
| `parameters.epoch_btjd` | O | 유한. 첫 통과 중심 시각(BTJD = BJD − 2457000) |
| `parameters.duration_hours` | O | 유한, > 0, `duration_hours/24 < period_days` |
| `parameters.depth_ppm` | O | 유한, `0 < depth_ppm < 1,000,000`. 계산은 `depth_ppm / 1e6` |
| `baseline.kind` | X (기본 `unity`) | `unity` 만 지원. 곡선이 이미 1 로 정규화됐다고 가정하고 재정규화하지 않는다 |
| `residual_model_version` | X (기본 `box-divide-v0`) | 지원 목록에 있어야 하고, 한 호출 안의 모델은 같은 버전이어야 한다 |
| `candidate_id` | X | 비어 있지 않은 문자열. 키를 생략할 수는 있지만 `null`·`""` 은 거절(`invalid_type`). 결과의 모델 순서 확인용 |

`parameters` 에 계약 밖 키가 있으면 실패한다(`unknown_parameter`). 값 타입은 숫자만 받고 문자열·bool 은 거절한다.
같은 규칙이 `TransitModel(...)` 을 직접 만들 때도 적용된다(생성 시 검증). 불량 값은 객체가 되지 못한다.

## 함수

```python
from astro_kernel import remove_transit_models, segment_times, TransitModelError

t = segment_times(start_btjd=1386.9, bin_minutes=10.0, n_points=48)   # Gold 세그먼트 시각(ERD 복원식)
try:
    r = remove_transit_models(t, flux, models=[model_json_a, model_json_b])
except TransitModelError as e:
    e.code, e.index, e.field                                          # 상태 매핑용
r.flux_residual      # float64, flux / 결합 모델. 입력 flux 가 NaN 인 위치는 NaN
r.model_flux         # 제거에 쓴 결합 모델 곡선(모든 점에서 유한, 유효 flux 위치에서 > 0)
r.models             # 실제 곱한 순서(정렬 후)의 TransitModel 튜플
r.residual_model_version
r.n_points, r.n_valid_input, r.n_finite_residual                       # 성공하면 뒤 둘은 항상 같다
```

| 함수 | 역할 |
|---|---|
| `parse_transit_model(dict_or_model, *, index=None)` | JSON 하나를 검증해 `TransitModel` 로. 이미 객체면 그대로 |
| `parse_transit_models(iterable)` | 목록 검증 |
| `phase_distance_days(time, period, epoch)` | 가장 가까운 통과 중심까지의 거리(일), 범위 [−P/2, P/2) |
| `model_flux(time, model)` | box 곡선. 통과 중 `1 − depth_ppm/1e6`, 밖 1 |
| `combined_model_flux(time, models)` | 모델들의 곱. 빈 목록이면 1 |
| `remove_transit_models(time, flux, models=(), *, residual_model_version=None)` | 잔차 = flux / 결합 모델 |
| `segment_times(start_btjd, bin_minutes, n_points)` | `start_btjd + i × bin_minutes/1440` |

### 입력 전제

- `time` 은 **모두 유한**해야 한다. NaN·Inf 가 있으면 계산 전에 `invalid_time` 으로 실패한다(빈 모델 목록이어도 같다).
  Gold 세그먼트 시각은 `segment_times` 가 만들고, 2분 원본은 DAT-02 필터(유한 TIME)를 거친 곡선이므로 정상 경로에서는
  비유한 시각이 오지 않는다. 이 정책은 v0 초안이며 D06 결정 항목이다(아래).
- `flux` 의 NaN 은 결측(빈 bin)이다. 그대로 NaN 으로 남고 채우거나 삭제하지 않는다. `flux` 의 Inf 는 결측이 아니라
  `numerical_failure` 다.
- `models` 는 **중복 없는** 목록이어야 한다. 같은 후보를 두 번 넣으면 두 번 나눈다. 중복·잘못된 제거 조합 검증은 호출자(88)의
  책임이다.
- 해상도는 함수가 알지 못한다. 2분 원본(배치 탐색)과 10분·확대 비닝 세그먼트(온라인)가 같은 코드를 쓰되, 두 해상도의 결과를
  서로 비교하는 것은 이 함수의 일이 아니다(131).

### 수식·불변량

- **통과 경계**: `|phase distance| < duration/2` (엄격 부등호). 경계에 정확히 놓인 점은 통과 밖이다.
- **결합**: 여러 모델은 곱한다. 겹친 통과의 깊이는 `1 − (1−d₁)(1−d₂)` 다. 곱하는 순서는 `(period_days, epoch_btjd,
  duration_hours, depth_ppm, shape, candidate_id)` 정렬로 고정한다. 그래서 같은 모델 집합이면 입력 순서와 무관하게 **허용
  오차 없이 같은 값**이 나오고, 같은 환경(같은 numpy·CPU)에서는 비트까지 같다(테스트가 `uint64` 뷰로 비트 비교). 다른 언어·CPU
  구현에는 비트 동일을 요구하지 않고 131 이 허용 오차로 비교한다.
- **빈 제거**: 모델 목록이 비면 `flux` 를 float64 로 복사해 그대로 돌려준다(값 동일, 새 배열). float32 `real[]` 입력도 값이 보존된다.
- **결측 보존**: `flux` NaN 개수는 늘거나 줄지 않는다. 성공한 결과는 항상 `n_finite_residual == n_valid_input` 이다.
- **새 NaN·Inf 금지**: 유효 flux 위치에서 결합 모델이 NaN·Inf 면 `numerical_failure`, 0 이하면 `nonpositive_model`, 잔차가 새로
  NaN·Inf 가 되면 `numerical_failure` 다. 부분 결과를 내지 않는다. 개별 모델은 항상 (0, 1] 이지만 **많은 모델의 곱은 underflow
  로 비정규 수나 0 이 될 수 있어** 파라미터 검증만으로는 막지 못한다. 결측 위치에서만 생긴 underflow 는 실패가 아니다.
- **재정규화 없음**: baseline `unity` 만 지원. 곡선은 Sector 중앙값 정규화가 끝난 상태여야 한다.

### PoC·tess-fixture 와의 관계

수학식(위상 거리 → box → 곱 → 나눗셈)은 `experiments/tess-bls/pipeline.py` 의 `box_transit_model`·`combined_box_model`·
`residual_after_candidates`, `experiments/tess-fixture` 의 `inject.box_model` 과 같다. 다만 아래는 **의도적으로 다르다**.

| 항목 | PoC `pipeline.py` | tess-fixture `inject.py` | astro-kernel |
|---|---|---|---|
| 경계 부등호 | `<=` | `<` | `<` |
| 깊이 0 | 허용 | 허용 | 거절(`invalid_parameter`) |
| baseline 스칼라 인자 | 있음(기본 1.0) | 없음 | 없음(`unity` 만) |
| 비유한 시각 | 모델 1 로 통과 | 모델 1 로 통과 | `invalid_time` 실패 |
| 깊이 변환 | `depth` 소수 직접 | `depth_ppm * 1e-6` | `depth_ppm / 1e6` |

같은 입력에서 "같은 결과"는 수학적 동치를 뜻한다. 부동소수점 경계와 깊이 변환 방식이 달라 마지막 비트까지 같다고는
주장하지 않는다. 비트 동일은 이 패키지 안에서 같은 모델 집합의 순열 사이에만 보장한다.

### 실패 코드 (`TransitModelError.code`)

계산 전에 검증하며 부분 결과를 내지 않는다. `index` 는 실패한 모델의 목록 위치, `field` 는 필드 경로다.

| code | 언제 |
|---|---|
| `invalid_type` | 모델·parameters 가 dict 가 아님, `candidate_id` 가 문자열이 아니거나 `null`·빈 문자열, 배열을 숫자로 바꿀 수 없음 |
| `unsupported_shape` | `shape` 누락 또는 `box` 외 |
| `missing_parameter` / `unknown_parameter` | 필수 파라미터 누락 / 계약 밖 키(`parameters` 안, `baseline` 안, 최상위 모두. Schema `additionalProperties: false` 와 같은 범위) |
| `invalid_parameter` | 숫자 아님·비유한·범위 밖(위 표) |
| `unsupported_baseline` | `baseline.kind` 가 `unity` 외 |
| `unsupported_version` / `version_mismatch` | 지원하지 않는 버전 / 모델 사이 또는 요청값과 버전이 다름 |
| `shape_mismatch` | time·flux 가 1차원이 아니거나 길이가 다름 |
| `invalid_time` | time 에 NaN·Inf |
| `nonpositive_model` | 유효 flux 위치에서 결합 모델 ≤ 0 (곱셈 underflow 포함) |
| `numerical_failure` | 유효 flux 위치에서 결합 모델 또는 잔차가 NaN·Inf, flux 가 Inf |
| `invalid_argument` | `segment_times` 인자가 숫자가 아니거나 범위 밖 |

## 계약 예제

| 파일 | 위치 | 내용 |
|---|---|---|
| `transit-model.valid.json` | `contracts/gold/examples/` | 정상 모델 3개(선택 키 생략형 포함) |
| `transit-model.invalid.json` | `contracts/gold/examples/` | 불량 모델 15개와 기대 `expected_code`, Schema 가 잡는지(`schema_rejects`). 파서와 Schema 의 수용 범위가 같음을 이 파일로 검사한다 |
| `removal_case.json` | `examples/` | 10분 비닝 48점 세그먼트, 겹친 두 통과(5점), 빈 bin 3개. 전체·부분·빈 제거의 기대 잔차 |
| `bin_center_case.json` | `examples/` | bin 시작 vs bin 중심 평가가 경계 bin 하나에서 갈리는 12점 예제. 호출자 시각 이동 결정(아래)의 검증용 |

모델 JSON 예제는 113 계약 정본 옆에 두고 `tests/test_examples.py`·`tests/test_contract_schema.py` 가 거기서 읽는다.
테스트는 (1) 코드 출력과 예제의 값·비트 일치, (2) numpy 를 쓰지 않는 순수 파이썬 재계산과 예제의 값 일치, (3) Schema 와 파서가 같은
모델을 받고 같은 모델을 거절하는지를 검사한다. 기대값은 패키지 출력의 단순 복사가 아니라 두 계산이 일치함을 확인한 값이다. Worker 나
다른 언어 구현은 같은 파일로 자기 결과를 대조한다. 파라미터 값은 계약 설명용 가상값이며 실제 카탈로그 값이 아니다.

## D06(113) 결정 사항

2026-09-16 강재민·김동혁과 글로 합의하고 113 MR 로 정본화했다. v0 초안이던 아래 여섯 항목은 그대로 **확정**이며 `box-divide-v0`
문자열을 유지한다. 바꾸려면 새 `residual_model_version` 을 만든다.

1. **통과 경계 `<`** (경계에 놓인 점은 통과 밖). PoC 의 `<=` 는 따르지 않는다.
2. **`depth_ppm` 은 0 초과 1,000,000 미만.** 깊이 0 후보는 모델이 아니라 거절한다. Gold 계약 4절도 같은 범위다.
3. **모델 평가 시각은 bin 중심.** ERD 의 `start_btjd` 는 첫 bin 의 시작 시각이고 `segment_times` 는 그 복원식 그대로다. 10분 bin 에
   들어간 원본 점(+1·3·5·7·9분)의 평균 시각이 bin 중심이므로, Gold 세그먼트로 잔차를 만들 때는 **호출자가 `start_btjd + bin_minutes/2880`
   을 넘긴다**. 온라인 경로에서 옮기는 주체는 **Worker 어댑터(88) 하나**다. Backend 는 Gold 의 `start_btjd`(ERD 정의: 첫 bin 시작)를
   그대로 보내고 옮기지 않는다(70 계약 3.2절). 둘이 다 옮기면 반 bin 이 아니라 한 bin 이 어긋난다. 배치(122)는 Silver 에서 같은 식으로
   한 번만 옮긴다. 2분 원본은 `TIME` 이 이미 노출 중심이라 이동하지 않는다. 커널은 넘겨받은 시각에서 그대로 평가하며 이동을 내부에서
   하지 않는다. bin 시작에서 평가하면 경계 bin 이 깊이 전체만큼 틀리고 제거 후보마다 반복된다. 중심 평가에도
   "반쯤 가린" 경계 bin 의 잔여는 남으며 111 이 실측한다. 예제는 `examples/bin_center_case.json`.
4. **비유한 시각은 `invalid_time` 실패.** 결측으로 취급해 잔차 NaN 을 두는 대안은 "빈 제거는 flux 보존" 과 충돌해 택하지 않았다.
5. **baseline 은 `unity` 만.** 재정규화는 제거 함수 밖(전처리·Silver 정규화)의 책임이고 `baseline.kind` 확장은 필요할 때 새 버전으로.
6. **한 호출 안의 버전 혼용 거절**(`version_mismatch`). 문자열 규칙은 `<모델>-<연산>-v<정수>` 로 `box-divide-v0` 하나.

실패 코드는 아래 표의 **13종**이다. Worker 가 이 코드를 어떻게 외부에 노출하고 재시도하는지는 [70 계약 4절 오류표](../../contracts/derived-compute/README.md)가
정한다(astro-kernel 코드는 전부 외부 `COMPUTE_ERROR`, `retryable=false`, 원래 code·field·model index 보존). 사용자에게 보이는 문구는 이 문서가
정하지 않으며 탐사 API·Backend `ErrorCode` 담당(강재민, 137 뒤)이 정본에 명시한다.

## 관련 문서

- [TESS 파이프라인 분석 5절](../../docs/data/tess-pipeline/README.md) `transit_model` JSONB 행, [검증과 재처리 7.2·7.4절](../../docs/data/tess-pipeline/validation-and-reprocessing.md)
- [서비스 DB ERD](../../docs/architecture/database-erd.md) `light_curve_segments` 시각 복원식, [온라인 파생 계산](../../docs/architecture/online-derived-compute.md), [저장소 구조 `libs/`](../../docs/architecture/repository-structure.md)
- [후속 Task 계획 9절](../../docs/project/tess-processing-ai-task-plan.md) D14-1 행

## Silver 전처리 (119)

상태: **구현·합성 검증·실제 4별 회귀 완료, MR 리뷰 대기** (2026-09-20).
Jira `S15P21C206-119`, 담당 윤성용. `silver-biweight-1.0.0`은 **42/D03 기준 공용 전처리 기본 커널**이다.
위 완료 상태는 이 기본 커널과 회귀 검증에 한정되며 **DAT-02 전체 구현 완료가 아니다**.
Spark·DB·BLS 연결과 확인된 실제 불량 구간의 추가 마스킹은 이번 MR 범위가 아니다.

### 근거와 리뷰 항목

[42 결과 6절](../../docs/data/tess-preprocess-benchmark.md),
[MR !29](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/merge_requests/29)의 병합 기록,
[MR !77](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/merge_requests/77)의 2026-09-18 김동혁 리뷰에서
언급한 D03 확정 `biweight_1.0d`를 기준으로 구현한다. 110의 BLS 채택이나 D03→D04 duration·epoch 검증 책임
이관까지 승인됐다고 해석하지 않는다. 기존 문서의 과거 실험 수치는 수정하지 않는다.

2026-09-20 윤성용 요청으로 고정 가장자리 6·12시간 마스크 없이 구현을 진행한다.
김동혁의 !107 리뷰에서 고정 6·12시간 일괄 제외를 기본 커널에 넣지 않는 방향에 동의했다.
특정 Sector 시작·궤도 근점의 확인된 불량 구간을 별도 마스킹하는 DAT-02 요구는 유지한다.
후속 [S15P21C206-245](https://ssafy.atlassian.net/browse/S15P21C206-245)에 적용 계층·추적 계약·검증 조건을 등록했다.
이번 보완은 문서 범위 정리이며 임의 마스크 로직·설정·기존 수치를 변경하지 않는다. MR 재리뷰는 대기한다.
[문서 정합화 요청](../../docs/project/planetory-doc-sync-requests.md)에 현재 차이와 승인 상태를 기록한다.

### 함수·입출력 계약

실제 불량 구간 마스킹의 후속 적용 계층은 **FITS 파싱 후 원본 행 식별자를 부여한 Silver 입력 준비 계층**이다.
245에서 품질/유한값 선택·Sector 중앙값 정규화·추세 계산 전에 근거 있는 구간 마스크를 적용한다.
행을 외부에서 먼저 삭제하고 `source_row`를 다시 매기는 방식으로 연결하지 않는다.
생존 배열과 제외 장부에 `product_id`, 원본 `source_row`, `cadenceno`, 원래 `QUALITY`, 원본 시각,
겹친 모든 제외 사유, 근거 구간 ID·출처/checksum·마스크 버전을 보존해야 한다.
추가 마스크를 원래 QUALITY에 덮어쓰지 않는다. 현재 `PreparedCurve.excluded`의 사유 기록만으로는
원래 QUALITY 값까지 보존하는 후속 계약이 완성되지 않으므로 245에서 어댑터/커널 확장과 버전을 검토한다.
구간 단위·경계 포함·원천 일치·전체 제외·관측 부족 검증도 245가 담당하고 127의 Spark 연결로 인계한다.

```python
from astro_kernel.fits_adapter import parse_spoc_hdul
from astro_kernel.preprocessing import preprocess_silver, prepare_silver, detrend_silver

# 호출자가 astropy.io.fits.open(..., memmap=False)로 연 HDUList를 전달한다.
sector_input, metadata = parse_spoc_hdul(hdul, product_id="source-product.fits")
prepared, result = preprocess_silver([sector_input])
if result.status == "ok":
    time = prepared.time[result.kept]
    flux = result.flux_det[result.kept]
```

어댑터도 파일을 열지 않는다. numpy 외 의존성을 추가하지 않으며 호출자가 FITS 열기·손상 파일 읽기 예외 처리,
checksum 검증·제품/cadence 선택을 담당한다. 어댑터는 HDU·필수 열/헤더, BTJD(TDB, BJDREFI=2457000,
BJDREFF=0, day), 양수 TIMEDEL, 전자/초 flux 단위를 검사한다. PROCVER·시간 메타데이터를 반환하고
파일 종료 전에 배열을 복사한다. 미지 단위를 추측해 변환하지 않는다.

`SectorInput`은 같은 TIC의 Sector당 제품 하나다. TIME은 BTJD 일, flux·flux_err는 전자/초,
QUALITY·CADENCENO는 음이 아닌 정수다. 제품·Sector 중복 및 같은 Sector의 유효 시각 중복은 실패한다.
중복 제품·시각의 선택은 수집 계층의 책임이며 임의 평균·삭제하지 않는다.

`prepare_silver`는 QUALITY=0·유한 TIME/flux를 선택하고 Sector별 양수 중앙값으로 flux와 오차를 나눈다.
정렬 뒤에도 `product_id`·0부터 시작하는 `source_row`·`cadenceno`를 보존한다. `excluded`에는 제외된 모든
원본 행과 중복 가능한 제외 사유를 남긴다. `n_raw`와 Sector별 중앙값도 반환한다. 비유한/음수 오차는 NaN으로
남기고, 오차가 없다는 이유로 유효 flux를 제외하지 않는다(42와 같은 선택 규칙).

`detrend_silver(time, normalized_flux, sector)`는 정규화 완료 배열을 받고 **재정규화하지 않는다**.
주입 회귀도 이 경로를 사용한다. 결과는 prepared 배열과 같은 길이·순서의 `trend`, `flux_det`, `kept`,
`segment_id`, `reasons`와 구간 경계·scatter·구간별 `failures`·`status`·`version`을 제공한다.
제외된 정제 flux는 NaN이며 보간해 채우지 않는다. 후속 오차는 `prepared.flux_err / result.trend`에 같은
kept 마스크를 적용한다. 이는 고정 추세에 조건부인 측정 오차이며 추세 추정 불확실성을 포함하지 않는다.

### 버전·경계·실패

버전 `silver-biweight-1.0.0`의 전체 설정은 `preprocessing_config()`로 얻는다.
QUALITY=0, Sector 중앙값 정규화, Sector 독립 처리, **0.5일 초과** 공백 분리,
biweight 1일(c=6, MAD, 3회, stride=10과 마지막 점, 선형 보간), 상방 5σ, 최소 500점,
고정 가장자리 추가 마스크·2단계 추세 없음으로 고정한다. 1일은 최대 8시간의 3배이며 12시간 이상 신호의 보존을 보증하지 않는다.

- Sector가 겹쳐도 서로 추세를 섞지 않는다. 42의 4별은 Sector 간 공백이 0.5일보다 커서 참조 설정의
  `split_sectors=false`와 같아야 한다. 합성 테스트는 짧은 경계·겹친 Sector도 검증한다.
- 구간 1~2점은 중앙값 fallback과 사유를 기록한다. 단순히 1일보다 짧다는 이유로 fallback하지 않는다.
- clipping은 TIC 전체의 `1.4826 × MAD(fd)`와 `fd < 1 + 5 × scatter`다. **scatter=0인 평탄 곡선은
  기존 엄격 부등호 때문에 전부 제외될 수 있다.** 이를 몰래 바꾸지 않고 관측 부족으로 반환한다.
- 제외 뒤 500점 미만은 `insufficient_observations`, 일부라도 잘못된 추세·나눗셈은 `numerical_failure`다.
  진단 배열이 있어도 `status != 'ok'`면 BLS에 전달하지 않는다. 기존 벤치마크의 성공 조건을 강화한 차이다.
- 입력 오류는 `PreprocessError.code`로 구분한다: `empty_input`, `invalid_identity`, `invalid_array`,
  `length_mismatch`, `mixed_tic`, `duplicate_product`, `duplicate_time`, `invalid_normalization`,
  `invalid_input`, `unsorted_time`, `numerical_failure`. FITS에는 `missing_header_or_column`, `missing_header`,
  `unsupported_time_metadata`, `unsupported_flux_unit`, `invalid_fits_structure`도 있다.
  오류·관측 부족을 정상 후보 0개로 바꾸지 않는다. Worker 외부 오류 매핑은 후속 연결의 책임이다.

### 회귀 기준과 현재 결과

같은 Python/NumPy 프로세스에서 같은 float64 연산 순서를 사용하므로 정규화·추세·정제값·scatter·마스크·구간·
요약 지표를 **rtol=0, atol=0, 같은 위치 NaN 허용**으로 비교한다. 깊이 ±0.01·잡음 ±1% 같은 과학적 허용치를
임의로 만들지 않는다. 다른 CPU·언어와의 수치 비교는 131의 별도 범위다.

`tess_bench.silver_regression`은 TOI-270·TOI-451·WASP-62·π Men의 등록 FITS checksum을 확인하고,
입력·코드·lock·설정·주입 격자 해시, 환경, 허용 오차를 `plan.json`에 **수치 계산 전에** 저장한다.
별마다 무주입 1 + 단일 108 + 쌍 3 = 112곡선, 전체 448곡선을 대조한다. 구현별 456개 신호 지표와 4별 요약을
CSV로 남긴다. 계산 전후 입력 해시를 재검사하며 실패는 비정상 종료·failure.json 또는 passed=false manifest로 남긴다.
manifest는 PROCVER·단위·wall time·출력 checksum을 포함한다. Git은 호출하지 않고 코드 식별은 파일 SHA-256을 사용한다.

주입 격자는 1.1.0이다. 이는 현재 고정 42 참조 구현과의 회귀이며 옛 실행 환경·반올림된 표를 그대로 재실행했다고
주장하지 않는다. 원래 환경·격자 차이를 이유 없이 허용 오차로 흡수하지 않는다.

2026-09-20 합성 FITS 종단·전처리 예외·기존 커널·벤치마크 테스트 **133개 통과**.
실제 4별 회귀도 아래 실행에서 통과했다. 팀 리뷰·병합 전이므로 119 완료로 간주하지 않는다.

```powershell
cd experiments/tess-bench
uv sync --locked --python 3.11
uv run --locked python -m tess_bench.silver_regression
```

산출물은 `experiments/tess-bench/results/silver-regression/run-.../`이다.
원본·생성 CSV는 Git 제외를 유지한다.

### 2026-09-20 실제 4별 회귀 결과

사용자 실행: `run-20260919T162247Z-9c908a11` (UTC 2026-09-19 16:22:47, KST 2026-09-20 01:22:47).
총 428.510초(약 7분 9초), Python 3.11.4 / NumPy 2.4.6 / Astropy 7.2.2 / SciPy 1.17.1, Windows AMD64.
4별·11개 Sector의 FITS에서 448/448곡선이 허용 오차 0으로 일치했고, 4별 요약도 모두 일치했다.
구현별 456개 신호 지표(두 구현 합계 CSV 912행)를 기록했다. 아래 값은 두 구현에서 동일하다.

| 대상 | 일치 곡선 | 신호 수 | 8h 깊이 보존 중앙값 | 통과 밖 scatter 중앙값(ppm) | 통과점 유지 중앙값 |
|---|---:|---:|---:|---:|---:|
| TOI-270 | 112/112 | 114 | 0.906296635 | 1342.515533 | 1.0 |
| TOI-451 | 112/112 | 114 | 0.859073582 | 1292.713861 | 1.0 |
| WASP-62 | 112/112 | 114 | 0.880908220 | 927.609695 | 1.0 |
| π Men | 112/112 | 114 | 0.981566209 | 171.634079 | 1.0 |

저장된 입력·출력·plan의 해시 44개를 사후 대조해 불일치 0을 확인했다. 계산 코드는 사후 변경하지 않았다.
FITS PROCVER는 `spoc-5.0.11-20200915`, `spoc-5.0.19-20201114`, `spoc-5.0.20-20201120`이며
파일별 값은 manifest에 있다. 참조와의 구현 동등성 검증이지 새 과학적 채택 기준·운영 성능 승인은 아니다.

리뷰 자료는 위 run 디렉터리의 다음 5개 파일이다. Git에는 추가하지 않고 MR에 필요 시 직접 첨부한다.
문서 요약·코드로 검토할 수 있지만, 원시 수치 전수 대조에는 해당 파일이 필요하다.

| 파일 | SHA-256 |
|---|---|
| manifest.json | `a6b48f90ab31ae3c6e31a52c14f7293d745b85123cad16da19bfc2aef4e9f4ad` |
| plan.json | `561ea84c01c4940da43e7a0bcbc5b1ebd95caa2a7605a4bb79df631707fcfbca` |
| comparisons.csv | `a4dfee09cc3d466c1e4f4d5f96d9f5fd0fafaa060605d87cbb394de8063380f3` |
| metrics.csv | `bce61a5139d663d78b6fd1803c415a7fc118bb7bff37fe4df7f68b1f154ef381` |
| summary.csv | `f3c80bd4f0a891b3a216cb275d4afe7c407b8c07d1104efcac47354efb74fb07` |

## BLS 탐색과 품질 게이트 (120)

상태: **구현·합성·실제 4별 회귀 검증 완료, MR 리뷰 대기**. Jira `S15P21C206-120`.
110의 고정 기준을 순수 함수 `astro_kernel.bls`로 옮겼다. 반복 제거·고조파 병합·Spark·온라인 연결은 후속 범위다.
BLS 소비자는 `astro-kernel[bls]`로 Astropy를 설치한다. 기본 전처리·고정 모델 함수에는 Astropy가 필요 없다.

| 함수 | 계약 |
|---|---|
| `search_bls(time, flux, *, input_snapshot_id, preprocessing_version, sector=None, baseline_time=None)` | 고정 탐색, 상위 피크·게이트·진단·입력 버전 반환 |
| `bls_periodogram(time, flux, periods, *, durations_hours, config_version)` | 호출자가 제공한 주기·duration 격자로 계산, `Periodogram` 반환 |
| `period_grid(min, max, n, *, spacing)` | 양수 증가 범위의 linear/log 격자 생성 |
| `top_period_peaks(periods, power, *, count=5, separation_rel=0.02)` | power 순 2% 분리. 고조파 병합 없음 |
| `quality_gate(snr, sde)` | 상태와 사유 목록 반환 |

탐색 버전은 `bls_grid_v1/poc_linear20k`다. 0.5일부터 min(유효 시각 baseline/3, 100일)까지
선형 20,000점, duration 1.2·1.92·2.88·4.8시간, likelihood·oversample 10을 사용한다.
오차는 정제 flux의 전역 `1.4826 × MAD`, SNR은 Astropy depth_snr,
SDE는 전체 power의 `(power-mean)/std`(ddof=0)다. 243의 대안 SDE를 미리 반영하지 않는다.
`Periodogram`에는 전체 격자별 power·epoch·duration·깊이·오차·SNR·SDE, 원래 위치의 valid_input,
실제 설정이 있다. 제공용 로그 5,000점은 명시적으로 생성할 수 있으며 제공용 범위·duration·버전은 호출자가 전달한다.

품질 버전 `gate_v1/snr7_sde6`은 **SNR >= 7 그리고 SDE >= 6**이다. 최소 transit 수를 추가 문턱으로 넣지 않는다.
개별 피크 상태는 accepted/held/failed이고, 보류 사유는 snr_below_threshold·sde_below_threshold다.
성공 실행 상태는 ok 또는 no_quality_peak다. 후자는 품질 게이트를 넘는 피크가 없다는 뜻이며 천체의 무신호를 확정하지 않는다.
비유한 지표·잘못된 피크 기하가 있으면 실행 failed, accepted_peaks는 빈 목록으로 반환한다.
호출자는 개별 진단 피크 대신 실행 상태와 accepted_peaks를 사용한다.

입력은 정렬된 유한 BTJD time·정제 flux의 같은 길이 숫자 배열이다. NaN flux는 결측으로 보존하고
Inf flux는 numerical_failure로 거절한다. 유효 100점 미만·짧은 baseline은 insufficient_observations,
MAD=0은 degenerate_flux이며 정상 후보 0개와 구분한다. 입력·격자 오류와 계산 실패는 `BlsError.code`로 전달한다.

Sector별 고정 전체 피크의 통과 안/밖 점 수·평균 차 깊이·전역 MAD 기반 SNR 및 transit별 점 수를 기록한다.
Sector별 독립 epoch 재적합은 하지 않는다. 단일 Sector는 not_applicable, 다중 Sector는 not_evaluated,
Sector 미제공은 unavailable이다. 마스크 지표는 baseline_time의 예상 통과점 대비 제외 비율이며
기준 시각을 주지 않으면 None이다. baseline_time은 중복 관측까지 입력 시각을 포함해야 한다.
이는 제공된 기준 배열 이후의 제외 비율이며 원본 QUALITY 제외까지 자동 복원하는 지표가 아니다.
**Sector·마스크 문턱은 미정**으로 diagnostic_reasons에 남기고 게이트에는 적용하지 않는다(사용자 합의).

```python
from astro_kernel.bls import search_bls

# 119의 실패/부분 결과를 정상 탐색 입력으로 전달하지 않는다.
if detrended.status == "ok":
    result = search_bls(
        prepared.time, detrended.flux_det, sector=prepared.sector,
        baseline_time=prepared.time, input_snapshot_id=snapshot_id,
        preprocessing_version=detrended.version,
    )
```

119 실제 함수 출력 연결·게이트 경계·결측/실패와 기존 기능을 포함해 astro-kernel 98개,
기존 110과의 합성 수치 비교를 포함해 tess-bench 78개 테스트가 통과했다.
[실제 FITS 회귀 명령](../../experiments/tess-bench/README.md#120-공용-bls-커널-회귀)은 별도 사용자 실행으로 검증한다.
실제 회귀 결과는 아래에 기록한다. 참조 구현과의 일치를 새 독립 평가·Jira 완료·병합 승인으로 간주하지 않는다.

### 120 실제 4별 회귀 결과

사용자 실행 `run-20260921T002811Z-24dc68f1` (2026-09-21), 소요 6,704.365초(약 1시간 51분 44초).
Python 3.11.9 / NumPy 2.4.6 / Astropy 7.2.2 / SciPy 1.17.1, Windows AMD64.
TOI-270·TOI-451·WASP-62·π Men 각각 80곡선, 총 320곡선 모두 참조와의 비교를 통과했다.
119 전처리 결과·마스크 일치와 110 전체 주기도·상위 피크 수치(rtol=1e-12, atol=0),
SNR/SDE 게이트 및 주입 회수 종류·순위 일치를 검사했다.

336개 주입 신호의 게이트 적용 후 매칭은 direct 188, alias_half 25, alias_double 4,
wrong 28, missed 91이다. 회귀 통과는 이 미회수 사례까지 참조와 일치한다는 뜻이며 전 신호 회수가 아니다.
입력·코드·설정·plan·출력 해시 52개를 사후 검사해 불일치 0건, CSV 행 수와 manifest 불일치 0건을 확인했다.
이후 최신 develop 통합·Git 검사·MR 리뷰는 별도이며, 계산 관련 변경이 생기면 재검증 범위를 판단한다.

| 파일 | SHA-256 |
|---|---|
| plan.json | `cec3ffe5c5f8ba31b813f0ec6785c5bef1554176102774a61b92eff0ca506575` |
| comparisons.csv | `62ad3a3afac3e4538c7a13e3ea438c51758eec2d847f754131374e1ab224fa6e` |
| matches.csv | `29764e7578ea7b86386f78f7d66908639d51897ac4825030a6ad38606540713f` |

자료는 `experiments/tess-bench/results/bls-kernel-regression/run-20260921T002811Z-24dc68f1/`에 있다.
원본과 생성 결과는 Git 제외를 유지하며 MR 검토 자료로 별도 전달한다.
