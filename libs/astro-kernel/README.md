# astro-kernel: 고정 transit 모델·잔차 제거 공용 커널

Jira `S15P21C206-121` (계획 ID D14-1) / 담당: 윤성용

상태: **구현 완료·로컬 회귀 통과** (v0 초안 계약). 121 의 완료 조건 중 "D06 확정 규약·소비자 계약 리뷰 통과" 는 아직 열려 있다.
D06(`S15P21C206-113`, 해야 할 일)이 규약을 승인하고 88 담당자가 서명·예제를 리뷰하면 완료다. 88·131 의 **실제 구현 완료**는
121 의 선행 조건이 아니다.

Spark 배치의 Silver 반복 탐색(`S15P21C206-122`)과 EC2 온라인 Worker(`S15P21C206-88`, 김동혁)가 **같은 수식**으로
"후보 신호를 제거한 잔차곡선"을 만들도록, 순수 함수만 모아 둔 패키지다. 파일·DB·네트워크·큐를 다루지 않고 numpy 외
의존성이 없다. 수치 검증(`S15P21C206-131`)도 이 구현을 기준값으로 쓴다.

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

## 입력 계약: `transit_model` JSON (D06 초안)

Gold `candidates.transit_model` JSONB 와 같은 dict 다. 단위는 ERD `candidates` 열 이름과 같다.

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
| `candidate_id` | X | 문자열. 결과의 모델 순서 확인용 |

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
| `invalid_type` | 모델·parameters 가 dict 가 아님, `candidate_id` 가 문자열이 아님, 배열을 숫자로 바꿀 수 없음 |
| `unsupported_shape` | `shape` 누락 또는 `box` 외 |
| `missing_parameter` / `unknown_parameter` | 필수 파라미터 누락 / 계약 밖 키 |
| `invalid_parameter` | 숫자 아님·비유한·범위 밖(위 표) |
| `unsupported_baseline` | `baseline.kind` 가 `unity` 외 |
| `unsupported_version` / `version_mismatch` | 지원하지 않는 버전 / 모델 사이 또는 요청값과 버전이 다름 |
| `shape_mismatch` | time·flux 가 1차원이 아니거나 길이가 다름 |
| `invalid_time` | time 에 NaN·Inf |
| `nonpositive_model` | 유효 flux 위치에서 결합 모델 ≤ 0 (곱셈 underflow 포함) |
| `numerical_failure` | 유효 flux 위치에서 결합 모델 또는 잔차가 NaN·Inf, flux 가 Inf |
| `invalid_argument` | `segment_times` 인자가 숫자가 아니거나 범위 밖 |

## 계약 예제 (`examples/`)

| 파일 | 내용 |
|---|---|
| `transit_model.valid.json` | 정상 모델 2개 |
| `transit_model.invalid.json` | 불량 모델 9개와 기대 `expected_code` |
| `removal_case.json` | 10분 비닝 48점 세그먼트, 겹친 두 통과(5점), 빈 bin 3개. 전체·부분·빈 제거의 기대 잔차 |

`tests/test_examples.py` 가 (1) 코드 출력과 예제의 값·비트 일치, (2) numpy 를 쓰지 않는 순수 파이썬 재계산과 예제의 값 일치를
검사한다. 기대값은 패키지 출력의 단순 복사가 아니라 두 계산이 일치함을 확인한 값이다. Worker 나 다른 언어 구현은 같은 파일로
자기 결과를 대조한다. 파라미터 값은 계약 설명용 가상값이며 실제 카탈로그 값이 아니다.

## D06(113)에서 확정할 항목

이 패키지는 아래를 **v0 초안**으로 두고 구현했다. 어느 것도 팀 승인 사항이 아니며, 113 에서 다르게 결정되면
`residual_model_version` 을 올려 반영한다.

1. 통과 경계 부등호 `<` (PoC 는 `<=`).
2. `depth_ppm` 하한 `> 0` (깊이 0 후보를 거절).
3. 모델 평가 시각. ERD 는 `start_btjd` 를 **첫 bin 의 시작 시각**으로 정의하고 `segment_times` 는 그 복원식을 그대로 구현한다(확정
   사실). 잔차 계산 때 모델을 bin 시작에서 평가할지 bin 중심(`+ bin_minutes/2`)에서 평가할지는 별도 결정이다(미결). 현재는 호출자가
   넘긴 시각에서 그대로 평가한다.
4. 비유한 시각 처리. 현재는 `invalid_time` 실패(입력 전제). 대안은 해당 점을 결측으로 보고 잔차 NaN 으로 두는 것인데, 그러면
   "빈 제거는 flux 보존" 과 충돌하므로 둘 중 하나를 계약으로 택해야 한다.
5. baseline 재정규화를 제거 함수 밖(호출자)에 둘지, `baseline.kind` 를 확장할지.
6. `residual_model_version` 문자열 규칙과 한 호출 안의 버전 혼용 허용 여부(현재 거절).

## 관련 문서

- [TESS 파이프라인 분석 5절](../../docs/data/tess-pipeline/README.md) `transit_model` JSONB 행, [검증과 재처리 7.2·7.4절](../../docs/data/tess-pipeline/validation-and-reprocessing.md)
- [서비스 DB ERD](../../docs/architecture/database-erd.md) `light_curve_segments` 시각 복원식, [온라인 파생 계산](../../docs/architecture/online-derived-compute.md), [저장소 구조 `libs/`](../../docs/architecture/repository-structure.md)
- [후속 Task 계획 9절](../../docs/project/tess-processing-ai-task-plan.md) D14-1 행
