# 탐사 API C02 계약 예제

143번의 사용자 채택 계산·멱등·실패 경계와 본체/후속 연동 인수 구분은 [제출 구현 계약·인수 조건](submission-readiness.md)을 따른다. 141·147은 담당자 구현을 기다리며 본체 착수를 막지 않는다. `node docs/api/exploration/snapshot-v0.cjs`는 보존된 v0(bin 시작) 계약의 합성 경계만 검증한다. 현재 v1(bin 중심)은 백엔드 `SubmissionTest`로 검증한다.

[#133 검토안](../../../apps/backend/docs/exploration-contract-review.md)을 위한 합성 JSON이다. 2026-09-14 원격 `develop` `321f10b`의 SRS v1.2 변경안과 탐사 API Draft 0.3을 기준으로 한 **초안 예제**이며 운영 API 구현·권한 집행·수치 정책 승인 증거가 아니다.

`contracts.json`의 각 case는 독립 초기 상태다. `same-request-replay`와 `idempotency-conflict`만 normal-harmonic의 접수 완료를 전제로 한다. `request`와 `response`만 HTTP 표현이며 setup/effects/at/sourceSection은 검증 메타데이터다. 설명용 축약 UUID는 유효 UUID로, 반올림 duration은 원본 위상에서 계산한 값으로 교정했다. 기존 탐사 명세의 정상 제출·곡선·별 목록 DTO를 재사용했으며 구판 `docs/api/analysis/examples`는 변경하지 않았다.

`decisions.json`은 HTTP 응답이 아닌 공동 검토용 계산·정책 사례다. 은퇴 경로별 서로 다른 결과와 duration 중첩의 양쪽 결과를 보존한다. 특정 대안의 채택을 의미하지 않는다. 기준 시각 환산 예제는 AT-118을 재사용한다.

저장소 루트에서 `node docs/api/exploration/validate.cjs`로 검사한다. JSON 파싱, UUID/오류/상태, 원본 요청·응답 일치, duration·위상 환산, 배열 길이, 은퇴 대체 배열, 추천 밖의 격자 포함 여부, 중첩 상한의 차이, 공개 조회의 작업 생성 금지, 참여자 중복 제거를 검사한다. 실제 서버 호출·후보 매칭·DB 동시성·브라우저 계산은 실행하지 않는다.

C02-R1 은퇴 3경로는 2026-09-14 사용자 선택에 따라 분석 복귀·재도전은 최신 현재 진행, History CURRENT는 원본으로 고정했다. C02-R2 기준 시각은 같은 날 Bundle 공통값으로 결정했으며 모든 유효 원본 관측 시각의 중앙값을 한 번 저장한다. C02-R3은 사용자가 고른 봉우리의 grid index를 제출하고 그 봉우리의 추천 duration 3배를 선택 폭 상한으로 적용한다. 직접 주기 선택은 Bundle 공통 위상 상한만 쓴다. 세 결정은 정본·API·JSON에 같은 버전으로 반영했으며 MR !32에서는 반영 누락과 문서 충돌을 검토한다. 예제의 합성 수치를 운영 설정에 복사하지 않는다.

## 제출 매칭 수치 규칙 v0 (`rule-0`, Jira S15P21C206-128)

사용자 제출(주기·위상 구간)을 배치 BLS 후보와 대조하는 수치 규칙의 **개발용 v0**다. SRS 5.1 초기값과 탐사 API 예시값에 출처를 붙인 것이며 운영 기본값·확정 인수 기준이 아니다. 확정 v1(`rule-1`)은 `S15P21C206-111` 실측과 강재민(C09)·백지웅(A04) 공동 승인 뒤 만든다. 128의 완료는 v0 제공만으로 처리하지 않는다.

| 파일 | 내용 |
|---|---|
| [`matching-rules.v0.json`](matching-rules.v0.json) | 규칙 값 한 세트. 항목마다 `source`(SRS·API·결정 출처)와 `status`(`confirmed` / `v0-assumption`)를 표시. 확정 요구사항(네 조건 모두 만족, 배율 1 우선)과 v0 가정(우세/모호 판정, 정규화 오차, 중첩 지표, 수치 정밀도)을 구분 |
| [`matching-cases.v0.json`](matching-cases.v0.json) | 합성 별 하나(60일, 5일 공백, 10분 bin)와 후보 위에 사례 31개. 정상(직접·P/2·2P·`phaseEnd > 1`·배율 1 우선), 모호(0점 동률, 0 근처 비율만 큰 경우, 점수 차·비율 경계의 직전/정확/직후, 후보 3개, 입력 순서 반전), 거절(최소 창, 위상 폭, duration 3배 상한, 관측점 없는 구간, epoch 범위 밖, 격자 밖), 재현성(추천 밖 제출 허용, 겹친 fineTune, 표시 반올림 경계, 공백 통과 제외). 각 case 의 `expected`는 참조 구현이 계산한 값 |
| [`matching-v0.cjs`](matching-v0.cjs) | 참조 구현 + 검증기. `node docs/api/exploration/matching-v0.cjs` 로 모든 사례를 재계산해 `expected`와 비교한다. 규칙 값은 JSON 에서 읽고 코드에 박지 않는다. Backend(Java)·Frontend(TS) 구현은 같은 입력으로 같은 `expected`가 나와야 한다 |

**v0 가정 요약.** 조건별 오차를 허용치로 나눈 정규화 오차 `e_period = |P_corr − P_c|·N/(D_c/2)`, `e_epoch = 순환 epoch 차/(D_c/2)`, `e_duration = |log2(D_user/D_c)|`. 점수 `score = max(e_period, e_epoch, e_duration)` 는 "허용치 대비 가장 약한 조건" 이며 정답 확률·곡선 유사도가 아니다. 통과 후보가 둘 이상이면 (1) 점수 차 ≥ `minScoreGap` 0.1, (2) 1위 ≤ `dominanceRatio` 0.5 × 2위, (3) 1위 중첩 비율이 2위보다 0.1 넘게 낮지 않음 — 셋 다 만족해야 1위를 채택하고, 아니면 `ambiguous_match`. 0점 동률·수치 동률(`epsilon` 1e-9)은 모호. 통과 판정은 원래 비율 부등식(duration 0.5–2배, 경계 포함)으로 하고 점수는 순위에만 쓴다. 후보 집계 단위는 후보 id 하나(같은 후보의 여러 배율 해석을 따로 세지 않음). 사용자 창은 사용자가 고른 주기 간격으로 반복하고, alias 의 epoch 순환 주기는 `min(P_user, P_c)` 로 둔다.

**수치·경계.** IEEE-754 float64, 중간 반올림 없음, 부등호 그대로(경계 포함), `epsilon` 은 동률 판정에만. 경계 사례(`gap-exact`, `ratio-exact-boundary`, `duration-2x-boundary`, `duration-0.5x-boundary`)는 epoch·offset·반폭을 2진으로 정확한 값으로 골라 언어 간 차이가 없어야 한다. 표시용 duration 반올림(소수 2자리)은 검증·매칭에 쓰지 않는다(`display-rounding-boundary` 에서 갈린다). 후보 id 정렬은 출력 순서용이며 모호한 후보 중 하나를 고르는 기준이 아니다.

**중첩 우세.** SRS 5.2 (6) 의 "통과 구간 중첩 비교" 는 조건 (3) 으로 넣었다. 다만 v0 정의에서는 주기·epoch 통과가 창 이탈을 D_c 이내로 제한해 점수 1위가 중첩에서 명확히 불리해지는 사례를 구성할 수 없었다(`overlap-recorded-no-inversion`). 111 실측에서 실제 사례가 없으면 (3) 을 제거한다.

**미결(이 fixture 로 확정하지 않은 것).** N 상한(DEC-03), 최소 중첩 통과 수·비율, `dominanceRatio`·`minScoreGap`·`overlapRatioTolerance` 값, alias epoch 순환 주기 해석, epoch 허용 폭의 창 전체/반폭 해석, `phaseWidthMax` 0.25·`allowEmptyPhaseSpan=false`(DEC-19/Q03), 3배 고조파(112 뒤). 탐사 API 5.4 vs 6.8 은 충돌이 아님으로 확인돼 미결에서 뺐다(6.8 다시 풀기는 `sourcePeakGridIndex=null` 로 시작). 전부 `matching-rules.v0.json` 의 `openItems` 와 각 항목 `status` 에 있다.

**버전.** 선택 규칙(최소·최대 폭, 3배 상한, `allowEmptyPhaseSpan`, fineTune)과 매칭 허용치를 한 `rule-N` 으로 묶는다. `submissions.rule_version` 하나로 그 제출의 검증·판정을 재현해야 하기 때문이며, 선택 규칙 값만 바뀌어도 새 `rule-N` 을 만든다. 탐사 API 5.1 의 `selectionRules.version` 은 같은 문자열을 내려준다. 별도 `sel-N` 은 두지 않는다(2026-09-17 강재민 질문 반영, API 표기는 151).

**A04 화면 처리 방침(2026-09-17 백지웅, v0 사용 조건).** (1) 핸들 드래그 중 빈 구간 통과는 허용하고, 선택 구간에 관측점이 없으면 "선택한 구간에 관측점이 없습니다. 구간을 이동하거나 넓혀 주세요." 안내와 함께 제출을 제한한다. 서버가 거절해도 선택 상태를 유지해 바로 수정할 수 있게 한다. (2) 최소 위상 폭 `minWindowDays / periodDays`, 최대 `phaseWidthMax`. 봉우리에서 시작하면 `min(3 × suggestedDurationHours / (24 × periodDays), phaseWidthMax)` 을 상한으로 쓰고, fineTune 이 겹쳐도 주기로 봉우리를 역추정하지 않고 사용자가 고른 `sourcePeakGridIndex` 의 제안 duration 을 쓴다. 0.25 는 시작값이며 화면은 전달받은 설정값을 쓴다. (3) 계산·검증은 반올림 전 값, 미리보기는 "약 2.83시간" 처럼 근삿값 표기, 상세값은 더 많은 자릿수로 확인 가능. `display-rounding-boundary` 는 입력 오류가 아니라 `not_matched` 이므로 제출을 막지 않는다. 실제 프론트 계산·조작 검증은 A04 구현에서 한다.

**C09 후속(강재민, 이 MR 범위 밖).** 정정하지 않은 제출은 저장 시 `harmonic_multiplier`·정정 주기를 NULL 로 둔다(V5 제약, 143). fixture 는 배율 1 우선 규칙을 보여주기 위해 `harmonicMultiplier: 1` 을 유지한다. `harmonic_multiplier`(`P_user × m = P_c`)와 `candidate_aliases.multiplier` 의 방향은 ERD 에 명시한다(142).

**C09 구현 상태(S15P21C206-142).** 백엔드 `SubmissionMatching`이 이 규칙을 옮겼고 `SubmissionMatchingCasesTest`가 사례 31개의 검증·서버 산정·판정을 재현한다. V9가 넣은 운영 규칙 `rule-0`의 값이 이 JSON 규칙과 같은지도 같은 테스트가 확인한다. 운영 데이터의 관측 창은 곡선 점 시각(bin 시작)에서 결측이 아닌 점이 이어진 구간으로 만든다(탐사 API 6.2절). `harmonic_multiplier` 방향은 탐사 API 6.3절에 적었고, `candidate_aliases.multiplier` 방향은 그 표를 쓰는 작업에서 정한다.
