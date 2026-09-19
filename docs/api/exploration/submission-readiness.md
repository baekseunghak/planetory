# 143 제출 구현 계약·인수 조건

- Jira: [S15P21C206-143](https://ssafy.atlassian.net/browse/S15P21C206-143)
- 상태: 2026-09-19 사용자 채택. 143 본체 구현과 141·147 실제 생산자 연동 검증을 구분한다.
- 기준: develop `157fb5e`, [탐사 API](../../../apps/backend/docs/exploration-api-spec.md) 2.2·6·8.3절, [ERD](../../architecture/database-erd.md), 141·142·144·145·147·148·149·139번 티켓.
- 목적: 채택한 계산·실패 경계와 인수 증거를 명시한다. 다른 티켓의 완료 조건을 축소하지 않는다. 141·147의 완료를 143 본체 착수·구현의 선행 조건으로 두지 않는다.

## 1. 채택한 스냅샷 계산

`foldedError`는 중앙값의 표준오차나 신뢰구간이 아니라 **구간 안 밝기의 robust 산포**다. 사용자가 `folded-mad-v0`를 채택했다. 담당자 공유는 후속이며 구현 승인 대기가 아니다. 이후 산식이 바뀌어도 새 계산 버전을 사용하고 당시 저장 배열을 재해석하지 않는다. 최초 ERD 커밋 `20133e9`에는 구간별 오차라는 설명만 있으며, 128번의 매칭 허용 오차는 별개다.

| 항목 | 채택 계약 |
| --- | --- |
| 입력 | 제출 당시 원본 사용자 주기 P, Bundle 공통 기준 시각 T, 해당 곡선 문맥의 전체 비닝 flux. 화면 축약값·정정 주기·다음 단계 잔차를 사용하지 않는다 |
| 점 시각 | 기존 곡선 계약의 bin 시작 `startBtjd + i × binMinutes / 1440` |
| 위상 | `q = ((t - T) / P) mod 1`을 [0,1)로 정규화한 뒤 q ≥ 0.5면 q − 1. 선택 통과 중심으로 별도 이동하지 않는다 |
| 구간 | [-0.5,0.5)를 150등분. 왼쪽 포함·오른쪽 제외. +0.5는 −0.5와 같은 위상이다. 경계에 epsilon을 더하지 않는다 |
| 밝기 | 구간별 중앙값. 짝수 개면 가운데 두 값의 평균 |
| 산포 | `1.4826 × median(abs(flux - 구간 중앙값))`. sqrt(n)으로 나누지 않는다 |
| 결측·소수 표본 | null 관측값 제외. 0점은 두 배열 모두 null, 1점은 밝기만 저장하고 산포는 null. 2점 이상은 계산하되 적은 표본의 산포가 안정적이라는 의미는 아니다 |
| 손상 | NaN·Infinity·float32 overflow는 오류로 처리한다. 손상값을 결측으로 숨기거나 0으로 바꾸지 않는다 |
| 정밀도 | float64로 계산하고 최종 배열만 float32로 변환한다. 계산 중 반올림·보간·추가 clipping은 하지 않는다 |
| 잔차 | 제출한 단계의 완료된 잔차 flux에서 같은 계산을 한다. 원본 세그먼트의 fluxScatter를 복사하지 않는다 |
| 저장 | matched·matched_harmonic·duplicate만 150개 배열 저장. 계산 버전은 기존 history versions JSONB의 snapshotVersion에 기록하며, 같은 요청 재전송 시 재계산하지 않는다 |
| 표시 | ‘밝기 산포’. 95% 신뢰구간·정확도·측정 잡음으로 부르지 않는다. MAD=0도 측정 오차 없음이 아니며, 구간 내 실제 신호 변화도 포함할 수 있다 |

[SciPy MAD 정의](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.median_abs_deviation.html)는 계산 근거일 뿐 프로젝트 승인 증거가 아니다. [참조 검증기](snapshot-v0.cjs)는 이 안의 계산만 검증한다. 잔차 모델의 불확실성 전파·중앙값의 신뢰구간 추정은 이 지표가 제공하지 않는다.

## 2. 멱등·잠금

1. 인증 후 requestId의 소유자·요청 내용부터 확인한다. 타인 결과는 반환하지 않는다. 경로 TIC도 요청 동일성에 포함한다.
2. SHA-256 입력은 버전 있는 정규화 DTO로 만든다. 객체 키 순서·같은 숫자의 표기 차이는 무시한다. 제거 후보와 근거 체크는 집합으로 정렬·중복 제거한다. memo 공백·대소문자는 보존하고 viewState·retryOf도 비교한다. 명세상 무시하는 서버 파생 필드는 해시에 포함하지 않는다. 선택 필드의 누락/null은 DTO 기본값이 같은 경우에만 통일한다. 원문 JSON 문자열을 바로 해시하지 않는다.
3. requestId별 PostgreSQL transaction advisory try-lock으로 진행 중을 구분한다. 잠금 실패는 REQUEST_IN_PROGRESS이며, 성공 후 기존 행을 다시 확인한다. DB UNIQUE(request_id)는 유지한다. 잠금 키 해시 충돌은 일시적인 경합만 일으키고 요청 동일성 판정에 쓰지 않는다.
4. 신규 처리는 users 행부터 잠근다. submissions 등 FK 행을 먼저 INSERT하지 않는다. 이후 기존 순서(users → progress → achievements → unlocks)를 따른다. 외부 Worker 호출을 이 잠금 안에서 기다리지 않는다.
5. POST 성공 응답은 제출 트랜잭션 안에 저장해 재전송 때 200으로 재현한다. 새 행·성과·별 열림은 만들지 않는다. GET(145)은 6.6절의 현재값을 별도로 구성하며 저장 응답 전체를 그대로 반환하지 않는다. 프론트는 requestId로 연출을 중복 방지하고 옛 progress를 최신 상태로 덮어쓰지 않는다.
6. 응답 유실 복구 GET은 아직 접수되지 않은 ID의 404와 진행 중 409를 구분하도록 같은 잠금 규약을 사용한다. 완료 이후 조회는 재판정하지 않는다.
7. V12는 submissions에 request_hash·request_hash_version·response_snapshot을 추가한다. 이전 migration과 기존 행은 변경하지 않는다. 해시/응답이 없는 기존 기록의 POST 재전송은 503 DEPENDENCY_UNAVAILABLE이며 가짜 응답을 복원하거나 신규 제출로 처리하지 않는다. GET 145의 조회 계약은 별개다.
8. REPEATABLE READ로 판·후보·통계를 한 DB 스냅샷에서 읽는다. 첫 SELECT 시작과 advisory lock 획득 사이에 선행 요청이 커밋하면 잠금을 얻어도 그 요청은 기존 스냅샷에 보이지 않을 수 있다. 잠금/직렬화 실패뿐 아니라 DuplicateKeyException도 전체 트랜잭션을 최대 3회 시도해 새 스냅샷에서 재조회한다. 계속 충돌하면 503이며 이번 시도의 쓰기는 모두 롤백한다. Publisher와의 전환 완료 후 후처리 경합은 별도 통합 검증 대상이다.

## 3. 141·147 연결과 실패 처리

| 조건 | 처리 | 완료 증거 |
| --- | --- | --- |
| sourcePeakGridIndex 없음 | 기존 142의 직접 주기 선택 검증을 사용한다 | 추천 밖이지만 격자 안인 제출 테스트 |
| sourcePeakGridIndex 있음 | 141의 같은 곡선 문맥·규칙 버전 봉우리로 존재·fineTune·추천 duration을 검증한다. 후보 정답표나 가장 가까운 봉우리로 대신하지 않는다 | 실제 141 출력 → 142 검증 입력 대조 |
| 봉우리 생산 기능이 아직 없거나 자료를 읽지 못함 | 입력 오류로 몰거나 source를 null로 지우지 않는다. 503 DEPENDENCY_UNAVAILABLE, 미접수 | SubmissionPeakReader가 같은 곡선 문맥·ruleVersion의 검증용 봉우리를 제공한다. 실제 연결은 141 인계 후 |
| 새 제출에 필요한 잔차 결과가 미완료·없음·만료됨 | 스냅샷 없는 성공·원본 대체·제출 중 자동 작업 생성을 금지한다. 409 SUBMISSION_CONTEXT_NOT_READY, 현재 residual 상태·실제 jobId만 포함 | ResidualResultReader 경계는 대체 자료로 검사. 147·프론트 187 실제 대조는 인계 후 |
| 잔차 의존성 통신 장애·손상 결과 | 503 DEPENDENCY_UNAVAILABLE. 새 제출·History·성과는 저장하지 않는다 | 배열·세그먼트 검증 |
| 기존 성공 요청 재전송 | 위 준비 상태와 무관하게 저장 결과 재현 | 캐시 삭제·판 교체 후 replay |
| 제출 후 다음 곡선 계산 실패 | 성공한 제출·성과·완료를 유지한다 | AT-101, 147 실패 주입 |

새 409는 접수 후 비동기 처리가 아닌 **미접수**다. 기존 조회의 202 CURVE_NOT_READY를 바꾸지 않는다. 요청 실패 후 같은 requestId를 사용하며 서버가 접수를 예약하거나 백그라운드에서 제출하지 않는다. 판이 바뀌면 기존 BUNDLE_CHANGED 규칙으로 최신 입력을 다시 확인한다.

입력 배열은 검증한 한 결과를 스냅샷 생성까지 보유한다. 중간에 캐시를 다시 읽어 다른 결과를 섞지 않는다. 본인의 매칭·발견·판 검증을 통과한 뒤에만 작업 정보를 노출한다. 전체가 null인 잔차를 정상 데이터로 간주하지 않는다.

현재 develop에는 141 봉우리 생산 구현과 147의 실제 ResidualResultReader 연결이 없다. 143 안에 큐·Worker·BLS를 복제하지 않는다. **2026-09-19 사용자 결정: 141·147번은 담당자 구현을 기다린다.** 두 티켓의 인계 후 실제 연동을 검증하며 미완료를 P1로 이관하지 않는다.

## 4. 본체 검사와 후속 통합 검사

- 계산: 원본 주기/P÷2/P×2, 위상 경계, 음수 시각 차, 짝수 중앙값, 빈/단일/동일값 구간, 이상점, 비유한값·float32 overflow, 원본/잔차 구분.
- HTTP: 실제 인증으로 401·타인 결과 비노출·미공개/잠긴 별·봉우리 선택·직접 선택·잔차 미준비·판 교체 응답 확인. no_candidate/skipped는 후보 선택값 없이 기존 6.5절을 따른다.
- 멱등: 같은 ID 같은 입력 동시 요청, 다른 입력 충돌, 다른 회원 동일 ID, JSON 키 순서·숫자 표기·집합 순서, memo/viewState 변경, 응답 유실, 판 교체·캐시 삭제 후 재전송.
- DB: 같은 회원 다른 제출 동시 처리 및 공개 처리와 경합. Snapshot INSERT·성과·다음 튜토리얼 저장 실패를 각각 주입해 새 Submission/History/Snapshot/성과/진행/onboarding/별 열림 전체 rollback 확인.
- 권한: migration 소유자가 아닌 planetory_app 역할로 실제 저장·replay·불변 History 권한을 확인한다.
- 이력: 정상 matched의 배율 1은 DB 정정 주기/배율 열에 NULL로 매핑한다. 과거 단계 재도전이 누적 매칭·완료를 지우지 않으며 ambiguous_match는 진행을 변경하지 않는다.
- 인계: 145의 당시/현재 필드 구분과 148의 당시 스냅샷 불변을 실제 API로 확인한다. 합성 검증만으로 이 항목들을 통과 처리하지 않는다.

## 검증 상태

`node docs/api/exploration/snapshot-v0.cjs`는 합성 경계 12개를 검사한다. 본체의 실행 가능한 검사는 `SubmissionTest`(일회용 PostgreSQL 18.6 + 실제 보안 필터)와 기존 `SubmissionMatchingCasesTest`다. 실행 결과는 변경 이력에 기록한다.

별도로 남는 통합 검증은 141 봉우리·147 실제 캐시/Worker, 145 조회·148 재현 API, 공개 쓰기와 제출의 동시 경합이다. 해당 기능을 143에서 구현하거나 테스트 대체 자료의 성공을 실제 연결 성공으로 보고하지 않는다. 현재 Gold에 없는 BLS SDE/SNR·외부 행성명/링크는 생성하지 않는다. SDE/SNR은 null이며 외부 레퍼런스는 실제 저장된 source/externalId/disposition/fetchedOn만 반환한다.
