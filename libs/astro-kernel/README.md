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
119 당시에는 Spark·DB·BLS 연결과 실제 불량 구간 추가 마스킹을 제외했다. 후속 245 구현은 [아래 계약](#근거-구간-마스킹-245)을 따른다.

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
추가 마스크를 원래 QUALITY에 덮어쓰지 않는다. 119의 사유 기록을 245에서 원래 QUALITY와 근거 구간을 보존하도록 확장했다. 상세 계약·버전·검증 범위는 [245](#근거-구간-마스킹-245)를 따른다.
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
진단 대상과 단일/다중 Sector 구분은 유효 flux만이 아닌 전체 입력의 고유 Sector를 기준으로 한다.
유효점이 전부 마스킹된 Sector도 행을 유지하며 통과 안/밖 점 수는 0, depth·snr은 None(JSON null)이다.
호출자가 미리 삭제해 전달하지 않은 Sector는 복원할 수 없으므로 진단에는 마스킹 위치를 NaN으로 보존한 배열을 전달한다.
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

## 반복 BLS·제거 QA·후보 출력 (122)

상태: **구현·로컬 검증 완료, 122 리뷰 보완·최신 develop 통합 검증 중**. 112는 사용자 확인에 따라 최종 승인·병합 완료다. Jira `S15P21C206-122`.
`astro_kernel.iteration`은 120 최초 탐색과 121 고정 모델 제거를 연결한다. 데이터베이스 쓰기,
Spark 전체 배치·온라인 API 연결은 이 모듈의 책임이 아니다.

```python
from astro_kernel.iteration import iterate_bls

# 119/245 전처리가 실패한 결과는 넘기지 않는다.
if detrended.status == "ok":
    iteration = iterate_bls(
        prepared.time, detrended.flux_det,
        sector=prepared.sector, baseline_time=prepared.time,
        input_snapshot_id=snapshot_id,
        preprocessing_version=detrended.version,
    )
```

### 고정 계산과 실패 처리

탐색은 120의 선형 20,000점·상위 5피크를 사용한다. coarse 피크를 기존 채택 후보와
중복 검사한 뒤 국소 재적합하고 SNR >= 7·coarse SDE >= 6·관측 transit >= 2를 적용한다.
120 단독 게이트와 달리 최소 transit·재적합은 111에서 승인된 반복 전용 조건이다.
111의 unity 기준, 깊이 상대 편차 0.1, duration 탐색 확장 12시간, 최대 후보 5개를 고정한다.
실제 duration 격자는 주기·최소 탐색 주기의 제약도 받으므로 모든 후보를 12시간으로 맞추지 않는다.
전체 설정과 `iteration_config_sha256`, 입력·전처리·BLS·품질·제거 버전을 반환한다.

제거 후 국소 power 비·경계 돌출·다른 채택 후보 깊이·통과 겹침·창 안 편향·유한점을 검사한다.
비교할 기존 후보가 있는데 제거 전후 깊이가 유한한 양수가 아니면
`other_depth_not_measurable`로 거절한다. 실험 정답 목록을 QA에 넣지 않는다.
QA 실패 시 그 제거 결과를 버리고 직전 정상 후보·잔차를 유지한 채 종료한다.
실패 피크를 마스킹하고 계속하는 경로는 제공하지 않는다.
마지막으로 각 채택 후보의 원본 정제곡선 SNR >= 7을 확인하며 재검증 실패도 기록한다.

| 결과 | 의미·소비 규칙 |
| --- | --- |
| `status=ok`, `complete=true` | `no_quality_peak` 또는 `duplicate_or_harmonic_only` 종료. 후보 동일성·후속 공개 검증으로 전달 가능 |
| `status=incomplete` | `max_iterations_reached`. 안전 상한 도달은 완전한 후보 조사로 간주하지 않음 |
| `status=failed` | `insufficient_observations`, `removal_qa_failed`, `candidate_validation_failed`, `numerical_failure`. 이전 공개 판을 대체하지 않음 |
| `BlsError` | 배열·Sector·입력 버전 등 호출 계약 오류. 정상 후보 0개로 변환하지 않음 |

`accepted`는 실행 중 QA를 통과했던 진단 후보이며 `complete`와 원본 검증을 확인하지 않고
곧바로 Gold에 넣지 않는다. `steps`에는 거절·실패 원인과 측정 불가능한 수치의 null을 남긴다.
`peak_id=step-N`은 한 실행 안의 원시 기록 키이며 DB candidate ID가 아니다.
`transit_model`은 113의 box·unity·`box-divide-v0` JSON이며 ID는 후보 동일성 처리 후 붙인다.
기본 반환은 엄격 JSON으로 직렬화할 수 있다. `keep_residual=True`의 ndarray는 검증용 임시값이고
지속 저장·Gold 직렬화 대상에서 제외한다.

111의 1/2·1·2배 중복 검사는 다음 탐색에서 이미 제거한 피크를 반복 채택하지 않기 위한
탐색 억제다. 확정 고조파 병합이나 `candidate_aliases` 생성으로 해석하지 않는다.
120의 Sector·마스크 진단은 재적합 전 피크 파라미터와 함께 `search_diagnostics`에 보존한다.
이는 재적합된 최종 모델의 Sector 재측정값이 아니다. 전체 NaN Sector도 진단 입력에서 유지하며
Sector·마스크의 미정 문턱을 새 게이트로 추가하지 않는다.

### 검증 범위

합성·경계 테스트는 7종 종료, QA 실패 후 후보·잔차 복구, 측정 불가능한 다른 후보 깊이,
전체 NaN Sector, 엄격 JSON 및 잘못된 입력을 확인한다.
실제 FITS 비교 명령과 실행 근거는 [tess-bench 122 회귀](../../experiments/tess-bench/README.md#122-반복-bls-공용-커널-회귀)에 기록한다.
111의 정답 보조 QA가 포함된 1,127곡선 전체 재실험과 이번 운영 입력만의 참조회귀는 구분한다.

### 후보 동일성·ID·후속 인계

`astro_kernel.candidate_catalog.build_candidate_catalog`는 반복 결과와 이전 판을 받아
112 v3의 정확 모델 기록 정리 → 판 내부 검토 → 유일 직접 대응을 연결한다.
소비자는 이 진입점을 사용한다. 내부 비교 보조 함수의 판정값만으로 후보표를 교체하지 않는다.
실험 모듈을 import하지 않으며 광도 동등성 실험에 쓰인 SciPy·자동 P/2 병합은 도입하지 않는다.
기존의 직접 오차·고조파 의심 판정은 같은 0.5 duration 문턱을 사용한다. 정확 모델 복사본만
묶으며 미세한 부동소수점 차이를 epsilon으로 합치지 않는다.

호출은 `build_candidate_catalog(iteration, previous_bundle=None, *, tic_id, bundle_id,
identity_tolerance=0.5, new_candidate_ids=None, identity_approval=None)`다.
`previous_bundle`은 같은 TIC의 이전 **완전한 판**으로, `complete=true`, `tic_id`, `bundle_id`,
`time_start_btjd`, `time_end_btjd`, `candidates`와 선택적 `candidate_aliases`를 전달한다.
TIC·Bundle·candidate ID는 양의 bigint다. 현재 Bundle과 신규 할당 ID의 숫자 문자열 입력은 정수로 정규화한다.
새로 갱신하는 `updated_bundle_id`도 DB와 같은 bigint이며, 기존 retired 행의 이력 표현은 보존한다.
이전 후보는 `candidate_id`, `status=active/retired`와 모델 파라미터를 가진다.
이는 DB 어댑터 입력 계약이며 `candidates.id` 열 이름을 바꾸는 DB 마이그레이션이 아니다.

신규 ID가 필요하면 `needed_new_peak_ids`를 반환한다. 호출자는 해당 원시 기록 키에 대해
DB에서 할당·예약한 bigint를 `new_candidate_ids={peak_id: candidate_id}`로 전달한다.
기간·깊이를 해시하거나 배열 순위로 영구 ID를 만들지 않는다. 재시도는 같은 이전 판·입력과
같은 예약 ID를 사용해야 한다. 같은 신호의 유일 1:1 대응이면 ID를 유지하며,
새 판의 파라미터·`removal_step`을 반영하고 `transit_model.candidate_id`는 `c-<id>`로 맞춘다.

`identity_approval`은 소비자 최종 승인 근거의 참조 문자열이다. 112 최종 승인·병합은 사용자 확인으로 완료됐으며, 호출자는 해당 승인 근거를 명시한다.
승인 참조를 자동 생성하거나 임의의 문자열을 넣어 승인된 것으로 표현하지 않는다.
승인 근거와 필요한 ID가 없으면 제안·필요 항목만 반환하고 `lifecycle_actions`는 비운다.
`catalog_ready=true`도 122의 후보 처리 준비만 뜻하며 `publishable`은 false다.
123의 제공 해상도 discoverable·125의 Gold 검증·Publisher의 원자적 current 전환이 남는다.
`discoverable`을 SNR에서 추정하거나 이전 활성 후보의 값을 그대로 복사하지 않는다.

#### Publisher 필드별 인계 (122 소비자 리뷰 보완)

`proposed_candidates`는 Silver 진단을 포함하는 **변경안이지 DB 행이 아니다**.
125의 Gold 직렬화와 Publisher는 아래 책임으로 필수 값을 보완하고, 현재 스키마에 실제로
있는 열만 명시적으로 선택·매핑해 적재한다. 전체 dict를 INSERT 인자로 전달하지 않는다.
`downstream_required`는 후속 단계 표시이며 필수 DB 열의 완전한 목록이 아니다.

| 값 | 생성·검증 책임 | DB 적재 시 처리 |
| --- | --- | --- |
| `candidate_id`, 모델·주기·깊이·`removal_step` 등 | 122 후보 변경안 | `candidate_id`를 `candidates.id`로 매핑하고 실제 열만 선택한다. 모델 ID는 `c-<id>`를 유지한다. |
| `discoverable` | 123의 제공 해상도 판정 | 125가 판정 결과를 검증한 뒤 Publisher가 필수 boolean을 적재한다. |
| `is_confirmed` | **116(D08) 외부 매칭 계약에 따른 124 외부 카탈로그 조인·라벨 처리** | 내부 후보 ID에 연결된 외부 확정 여부를 124가 제공하고 125가 검증하며 Publisher가 NOT NULL boolean으로 적재한다. 113은 모델 계약이며 외부 라벨 담당이 아니다. 미실행·실패·누락을 임의의 false로 채우지 않고 공개를 보류한다. 미매칭·상충 라벨 해석은 116 계약을 따른다. |
| `sde`, `snr` | 122 품질 게이트·Silver 진단 | **현행 candidates DB에 보존하지 않는다.** Silver 실행·검증 결과에서 보존하며 이번 MR에 열 추가 계획·마이그레이션은 없다. 145 상세 API의 null을 0이나 이 진단 값으로 바꾸지 않는다. |
| `peak_id`, `step`, `original_snr`, `validated_on_original`, `search_diagnostics` 등 | 원시 기록·원본 재검증·추적용 Silver 진단 | candidates 열이 아니므로 DB 행 투영에서 제외한다. `step`은 122가 명시적으로 만든 `removal_step` 열을 사용한다. |

필드·DB 열 정본은 [서비스 ERD](../../docs/architecture/database-erd.md),
단계 소유권은 [후속 Task 계획](../../docs/project/tess-processing-ai-task-plan.md)의 116·124·125를 따른다.
122의 `catalog_ready=true`만으로 `discoverable`·`is_confirmed`가 채워졌다고 판단하지 않는다.
향후 SDE/SNR의 Gold 저장이 필요해지면 별도 스키마·API 계약 변경으로 검토한다.

**candidate_aliases의 책임도 구분한다.** 별칭 관계의 과학적 판정 규칙은 112, 승인된 규칙에
따라 신규 확정 alias를 계산·출력하는 배치 책임은 122, Gold 직렬화·검증은 125,
실제 테이블 쓰기는 Publisher(김동혁 담당)다. Backend나 외부 라벨 조인 124가 추정해 채우지 않는다.
현재 v3는 자동 확정 규칙을 채택하지 않았으므로 **이번 122에서 새로 채울 alias는 없다**.
기존 확정 행은 보존하고 의심 배율은 Silver 검토 근거로만 남긴다. 향후 신규 생성은
112 규칙 승인과 122 구현·검증을 거쳐야 하며, 이 인계는 자동 병합 구현 완료 선언이 아니다.

QA 실패·상한 도달·원본 재검증 실패, 일대다/다대일·고조파 의심은 ID 변경 전체를 보류하고
기존 후보·alias를 유지한다. retired ID와 새 후보의 관계가 다시 의심되면 자동 재활성하지 않고
검토 대상으로 남긴다. 완전 종료했더라도 후보 0개인 별은 무신호 별 공개 제외 정책에 따라
공개 보류한다. 이를 실패와 동일하게 기록하지 않으며 기존 판의 전체 후보를 조용히 삭제하지 않는다.

- `raw_peaks`, `exact_model_groups`, `pair_evidence`는 진단 근거다. 의심 배율을 확정 alias로
  바꾸지 않으며 신규 `candidate_aliases` 행은 생성하지 않는다. 이전 확정 alias를 전달하는
  것은 새 파라미터에서 재검증했다는 뜻이 아니며 후속 Publisher 검증을 생략하지 않는다.
- `proposed_candidates`와 `lifecycle_actions`는 유지·추가·retired 변경안이다. 함수는 DB를 쓰지
  않으며 이전 입력도 수정하지 않는다. Publisher는 이전 행과 변경안을 비교해
  `candidate_status_history`와 current 전환을 같은 트랜잭션에서 반영해야 한다.
- retired는 기존 공개 분석·공식 스레드·성과·챌린지 참여 집계를 지우거나 숨기지 않는다.
  새 매칭에서 제외하며 별도 공개 취소·운영 숨김 정책은 유지한다.
- `removal_step`은 새 판의 배치 발견 순서다. 동일 ID의 단계 번호 변경만으로 145의
  `STEP_NOT_RESTORABLE`을 만들지 않는다. 온라인 복원은 저장 제거 ID가 현재 유효한지로 판단한다.
- 122의 `added`는 재개 이벤트 자체가 아니다. 신규 또는 false→true 후보 중 현재 활성·탐색 가능하고
  해당 회원이 미매칭인 고유 ID를 150에서 판정한다. retired만으로 재개하지 않는다.
  `newDiscoverableCount`·알림·기존 성과 갱신은 이 계산 모듈에서 만들지 않는다.


### 122 리뷰 보완: 원본 검증 종료 이력

원본 SNR 재검증 실패로 정상 탐색 종료 또는 안전 상한 종료를
`candidate_validation_failed`로 변경할 때, 기존 탐색 기록을 수정·삭제하지 않고
마지막에 `phase=original_validation`, `status=error`, `reason=candidate_validation_failed`
기록을 추가한다. `search_termination`은 직전 탐색 종료 사유,
`failed_candidate_steps`는 원본 검증을 통과하지 못한 후보의 단계 목록이다.
최상위 termination과 마지막 steps.reason은 일치한다. 이전 정상 잔차·후보 진단은 보존하지만
공개 가능 후보로 승격하지 않는다. 이미 제거 QA 실패 등으로 끝난 경우에는 그 실패 사유를 유지한다.

## 근거 구간 마스킹 (245)

상태: 구현·로컬 검증 완료, 리뷰 전. 숫자 커널 `silver-biweight-1.0.0`은 유지하고 입력 마스크 계약을
`silver-interval-mask-1.0.0`으로 구분한다. 기존 호출은 빈 마스크로 수치가 동일하다.

`prepare_silver(curves, interval_masks=...)`와 `preprocess_silver`는 `IntervalMask` 목록을 받는다.
각 항목은 `interval_id`, `product_id`, `sector`, `product_sha256`, `coordinate`, `start/end`,
`closed`, `reason`, `source_uri`, `source_sha256`, `version`을 필수로 받는다.
`coordinate`는 `cadenceno` 또는 `BTJD_TDB_day`이며 `closed`는 both/left/right/neither이다.
구간은 `start < end`이며 길이 0은 거절한다. 실제 행과 겹치지 않는 구간은 허용하고 근거를 남긴다.
단위 변환·시간대 추정은 하지 않는다. 정규화 전 모든 원본 행에서 마스크를 계산하며 QUALITY를 덮어쓰지 않는다.
호출자는 원본 바이트 checksum을 검증한 뒤 `SectorInput.source_sha256` 또는 FITS 어댑터의
`source_sha256=`에 전달한다. 제품·Sector·SHA가 다른 마스크는 `mask_source_mismatch`로 실패한다.
근거 snapshot 바이트 checksum 검증은 파일을 열지 않는 커널 밖 호출자의 책임이다.

`PreparedCurve.original_quality`는 생존 행의 원래 QUALITY다. `excluded`에는 `source_row`,
`cadenceno`, `original_quality`, `original_time`, 겹친 모든 `reasons`·`interval_ids`가 보존된다.
`interval_masks`에는 근거와 마스크 버전 전체가 남는다. 허용한 NumPy scalar는 검증 후 `sector`와 cadence 경계를 Python `int`, BTJD 경계를 `float`로 정규화해 저장하므로 `json.dumps(prepared.interval_masks, allow_nan=False)`를 지원한다. `exclusion_ledger(prepared, result)`는
추세·clipping·관측 부족 제외까지 원본 행으로 합친다. 내부 `excluded`는 원본 NaN/Inf를 보존하고,
장부 함수는 `original_time=null`과 `original_time_nonfinite`의 `NaN`/`+Infinity`/`-Infinity`로 구분해
엄격한 JSON 직렬화를 지원한다. 유한 시각은 원래 숫자다. 행 번호를 다시 매기지 않는다.
전체 제외 시 Sector 중앙값은 None, 결과는 `insufficient_observations`다. 정상 무후보와 구분한다.

실제 Sector 3 근거·재현 명령·검증 범위는 [245 실측](../../experiments/tess-bench/README.md#245-근거-구간-마스크-검증)을 따른다.
127/Spark 소비자는 기존 `preprocess_silver`에 검증된 마스크를 전달하고 장부·근거를 Silver에 저장한다.
Gold와 사용자 응답으로 원본 QUALITY 장부를 전달하지 않는다. 클러스터 배포·전체 Sector 구간 채택은 이번 로컬 검증과 구분한다.

마스크 목록(제품/근거 SHA·버전·경계 포함) 전체와 `MASK_CONTRACT_VERSION`을 실행 manifest에 기록한다.
숫자 전처리 버전만으로 캐시를 재사용하지 않는다. 마스크가 바뀐 제품을 포함하는 TIC의
Silver 정규화·추세부터 BLS/비닝/후보 및 Gold 검증까지 새로 실행한다. 원본 Bronze·기존 공개 판은 덮어쓰지 않는다.
새 판의 검증·승인 후 기존 Publisher의 원자 전환 절차를 사용한다. 전체 제외 또는 관측 부족·수치 실패는
정상 무후보로 적재하지 않는다. 원본 시각 배열을 마스크 적용 전에 보존해야 이후 제외율 진단 기준을 잃지 않는다.

## 세그먼트 비닝·revision (123)

상태: **비닝·119 연결부 구현 및 합성 검증 완료, 123 전체 완료 전**.
정본은 [114 Gold 채택안](../../contracts/gold/README.md#41-s15p21c206-114-비닝-운영-채택안)이다.
`astro_kernel.segmentation`은 `bin_sector`, `segment_revision`, `segment_silver`를 제공한다.

- `bin_sector(time, flux)`는 단일 Sector의 전처리 입력 시간축 전체를 받는다. 제외된 flux는 NaN으로 전달한다. 시각은 정렬하며 중복·비유한 시각은 거절한다. 10분 mean, 부분 bin 유지, 빈 bin 보존, 20,000점 초과 실패를 적용한다.
- `Segment.values()`는 빈 값을 JSON null로 변환하고 폐구간 gaps와 전체 n_points를 반환한다. DB ID는 생성하지 않는다. counts는 진단용이며 Gold flux 배열과 함께 게시하는 열이 아니다.
- 유효 bin이 전혀 없으면 `no_valid_bins`로 실패한다. 유한한 상수 곡선의 MAD 0은 산포 0으로 보존한다. 이것을 잡음 분모나 탐지 성공으로 해석하지 않는다.
- `segment_revision`은 제품 SHA-256·snapshot·TIC/Sector·전처리 버전과 파라미터·비닝 규칙·수치 구현 버전의 키 정렬 JSON을 SHA-256으로 식별한다. 문자열은 UTF-8, JSON 구분자는 쉼표/콜론, 비유한 수치는 거절한다. 파라미터 숫자 타입도 직렬화의 일부이므로 호출자는 고정 설정의 타입을 유지한다. 실행 시각·경로·lock 전체 hash는 받지 않는다.
- `segment_silver`는 정렬·정합성이 확인된 119 `PreparedCurve`/`DetrendedCurve`와 제품 checksum을 받는다. 전처리 status가 ok가 아니면 중단한다. 적용 마스크 전체를 revision 재료에 포함한다. 개별 Sector의 비닝 실패는 quarantined에 별도 기록한다.
- 반환값은 세그먼트 제안이며 `publishable=false`, `discoverability_status=pending_evaluation`이다. 후보의 discoverable을 임의로 false로 채우거나 이전 값을 복사하지 않는다.

검증: `uv run --locked python -m pytest -q`에서 전체 225개 통과(새 segmentation 20개 포함).
경계 스냅·부분 bin·빈 구간·전처리 제외점 시간축·상한·revision 변경·출처 누락·실패 격리를 검사했다.
제공 해상도 판정 연결과 비교 실행기는 아래 절을 따른다. 실제 FITS 회귀는 실행 전이다.
기존 판 보존/DB ID/current 전환은 Publisher 책임이다.
Gold QA 수치 허용 오차는 계속 pending-measurement이며 DB·EC2 검증 완료를 뜻하지 않는다.
114 인계의 Java 설명과 새 V20 DB COMMENT migration을 준비했다. 기존 V1은 수정하지 않았고 DB 적용은 하지 않았다.

## 제공 해상도 판정 (123)

`astro_kernel.discoverability.prepare_discoverability`는 `segment_silver` 결과와 122의
`build_candidate_catalog` 결과를 받는다. 실험 모듈·파일·DB에 의존하지 않는다.
게시·실패·회원 재개 경계는 [Gold 계약 4.2절](../../contracts/gold/README.md#42-s15p21c206-123-discoverable-연결게시-경계)이 정본이다.

```python
from astro_kernel.discoverability import prepare_discoverability

proposal = prepare_discoverability(
    segmented, catalog,
    fine_tune={"half_width_cells": 3},
    candidate_quality_version=iteration_result["candidate_quality_version"],
    rule_approval=approved_rule_reference,
    previous_bundle=previous_public_snapshot,
)
```

`previous_bundle`은 기존 공개 판의 TIC·Bundle ID, `complete=true`, 후보 목록과
`candidate_quality_revision`이다. 122의 ready 결과에 있는 `candidates`는 새 제안이므로
기존 공개 판 대신 넘기지 않는다. 최초 게시는 None이다. 기존 ID를 유지·은퇴시키는 경우 이전 snapshot은 필수다.
비어 있지 않은 `rule_approval`은 호출자가 확인한 승인 근거다. 문자열 존재 검사만으로 외부 승인을 검증하지는 않는다.

지원 규칙 정본은 코드의 `RULE`(`discoverability-1.0.0`)이다. 로그 5,000점·0.5일 시작·Gold 상한,
SNR 7·SDE 6·관측 통과 2, 직접 대응 3칸·epoch 반폭, 엄격한 내부 극대이며 고조파만으로 매칭하지 않는다.
`RULE`과 다른 설정은 명시적으로 거절하므로 설명 필드만 바꾸어 계산이 그대로 실행되지 않는다.
승인 상태는 규칙에서 분리했고 변경된 규칙은 새 버전 구현·검증을 요구한다.
115의 `discoverability_v1.json`은 이전 실험 재현용으로 그대로 보존한다.

모델은 bin 중심에서 평가하며, 현재 후보보다 앞선 **모든 raw peak** 제거 이력으로 잔차를 만든다.
ID 그룹화로 생략된 raw peak도 제거하며 현재 후보 자신은 제거하지 않는다.
`removed_peak_ids`는 카탈로그 candidate ID가 없는 raw peak 식별자다.
`segment_index_map`의 gaps는 Sector 내부 bin 인덱스다. `sorted_indices[i]`로 최종 정렬 배열의
해당 bin 위치를 찾는다. `concatenated_offset`은 정렬 전 위치이며 겹친 Sector에는 단일 offset만 사용하지 않는다.

SNR/SDE 문턱을 먼저 검사하고 관측 통과 수를 계산한다. 품질 봉우리 수에는 P/2·2P 등 중복이
포함되므로 독립 신호 수가 아니다. 대조군은 품질 봉우리 유무로 해석한다.
`insufficient_observations`, `degenerate_flux`, `numerical_failure`만 측정 실패로 기록하고
잘못된 입력·격자 등 구현/설정 오류는 전파한다.

`periodograms`에는 NumPy 배열과 BLS 객체가 있으므로 런타임 산출물로 따로 저장한다.
그 외 제안은 엄격한 JSON으로 직렬화할 수 있다. 원본 단계와 각 후보 단계의 잔차/주기도를 모두 반환한다.
revision은 canonical JSON hash이며 승인 댓글 문자열·실행 시각을 포함하지 않는다.
기존 판을 보존한 held 결과에는 새 후보 제안·변경 이력을 내보내지 않는다.
