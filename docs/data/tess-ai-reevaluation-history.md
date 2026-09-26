# 130 AI 재평가·과거 결과 보존

- Jira: S15P21C206-130. 상태: 공용 순수 커널 구현·로컬 검증 완료, MR 리뷰 전.
- 요구사항: AI-05·DAT-15·GRD-06. 상위 안내: [데이터 문서](README.md).
- 126의 [내부 실험 경계](tess-astronet-internal-batch.md)를 유지한다. 운영 모델 재채택·초기 추론·Gold 연결·판정 밴드는 S15P21C206-264에서 별도로 인수한다.

## 호출 계약

구현은 `libs/astro-kernel/astro_kernel/ai_reevaluation.py`다. 모델 실행기·파일·DB·네트워크 의존성이 없다. `request`로 평가 의도를 만들고 `empty_history` 또는 이 커널이 반환한 신뢰된 이력에 `reevaluate`를 적용한다. 반환값은 복사본이며 과거 입력을 수정하지 않는다. 임의 외부 JSON 이력을 검증·복원하는 API는 제공하지 않는다.

| 입력 | 의미 |
| --- | --- |
| candidate_id | 호출자가 공급하는 양의 bigint. 커널은 운영 ID를 할당하지 않는다 |
| generation | 후보별 단조 증가하는 변경 순번. 재시도는 같은 순번, 새 변경은 새 순번 |
| model_version / checkpoint_sha256 | 모델 버전과 실제 checkpoint 식별 hash |
| input_version / input_sha256 | 입력 규칙 버전과 후보 입력의 내용 hash. 규칙이 바뀌면 버전도 바꾼다 |
| score_semantics | 점수 의미. 다른 의미의 점수를 재사용하지 않는다 |
| threshold | version·lower·upper. 유한한 0≤lower<upper≤1. 운영 기본값은 제공하지 않는다 |
| attempt_id / expected_revision | 시도 식별자와 읽은 이력 revision. 같은 시도 ID를 다른 요청에 쓰면 거절 |
| predict(intent) | 추론 콜백. 유한한 [0,1] score 및 JSON 직렬화 가능한 raw_output 반환 |

모델·checkpoint·입력 규칙·입력 hash·점수 의미가 모두 같은 성공 이력이 있어야 원점수와 raw_output을 재사용한다. 임계값만 바뀐 경우 추론 콜백을 호출하지 않는다. 다른 정체성 또는 성공 이력 부재는 추론이 필요하다. 모델·입력의 실제 파일과 선언 hash의 일치는 호출자가 실행 전후 확인해야 한다.

판정은 `score < lower`이면 rejected, `score >= upper`이면 approved, 그 사이는 hold다. 이는 호출자가 제공한 임계값을 적용하는 계약이며 AstroNet 운영 임계값 채택이 아니다. 동일 threshold version에 다른 경계를 넣으면 후보 이력 내에서 거절한다. 후보 사이의 버전 등록·불변성은 호출자 책임이다.

## 이력·실패·재시도

- 이력은 `intents`, `attempts`, `current`, `revision`으로 구성한다. attempt는 원점수·원출력·판정·모델/입력/임계값·실패 사유·재사용 출처를 보존한다. 물리적 DB 실행/evaluation ID가 아니다.
- 같은 시도·같은 요청의 재전달과 이미 성공한 요청의 재전달은 아무것도 추가하지 않는다. 실패한 요청을 다시 실행하려면 새 attempt_id를 사용한다.
- 실패는 score/verdict/raw_output=null과 예외 클래스 이름으로 기록한다. 정상 0점과 구별하며 예외 메시지는 저장하지 않는다.
- 새 평가 실패 시 current는 이전 성공을 유지한다. 최초 평가 실패 시 current=null이다. 이전 성공을 최신 요청의 성공으로 표시하지 않도록 소비자는 최신 intent/attempt 상태와 current를 함께 읽는다.
- 새 generation을 받은 뒤 미완료 옛 generation 재시도는 거절한다. 이미 성공한 옛 요청의 지연 전달은 no-op이므로 최신 current를 되돌리지 않는다.
- 회원 성과·등급·외부 disposition·완료 별·재개 이벤트는 입력 및 출력 계약에 없다. 이 커널이 만드는 이력은 AI 평가 이력이며 candidate_status_history의 다른 필드를 수정하지 않는다.

`expected_revision` 검사는 전달된 메모리 상태에 대한 검사다. 동시 실행의 DB 원자성을 보장하지 않는다. 적재 호출자는 후보별 직렬화 또는 CAS/트랜잭션과 고유 실행 키로 상태를 저장하고, 충돌 시 최신 상태를 다시 읽어야 한다. DB 적재·Publisher 전환·C15-2 후처리 연결을 이 로컬 검증의 완료로 주장하지 않는다. AI 변경만으로 별 재개나 성과 재분류 이벤트를 발행하지 않는 경계는 운영 연결에서도 유지해야 한다.

## 저장 결과 연결 검증

2026-09-24 실행 `run-20260924T034244Z-28996f4c`는 기존 126의 `20260923T112206Z-ba539ace/run`을 읽었다. manifest가 내부 전용·비게시·검증 완료인지, 두 predictions 파일 hash와 행이 같은지 확인했다. 원본을 수정하지 않았다.

- 저장 점수 55개를 fixture ID 1~55로 연결했다. 운영 ID 예약 검증이 아니다.
- 후보당 최초 저장 점수 입력 → 임계값 변경/점수 재사용 → 통제된 새 모델 실패 → 새 시도 복구, 총 220개 attempt를 검증했다.
- 중복 요청과 오래된 완료 요청 재전달은 이력을 추가하거나 current를 되돌리지 않았다.
- checkpoint 식별자·임계값은 검증용 fixture다. 최초/복구 콜백은 저장 점수를 돌려주며 실제 새 checkpoint 추론이 아니다. 원본 모델 버전은 별도 provenance로 보존한다.
- plan은 입력 3개와 커널/실행기 2개 hash를 고정하고 종료 시 재대조한다. 실행 코드는 미커밋 상태의 파일 hash로 식별하며 clean commit 실험이라고 하지 않는다.
- 출력 manifest는 internal_only=true, publishable=false, fixture_ids_only=true다. 출력 2개 checksum도 저장한다.
- 공용 커널 전체 333 passed, astronet-eval 전체 70 passed. 신규 재평가 26개·연결 검증 3개가 포함된다.

산출물은 Git 제외 경로 `experiments/astronet-eval/results/reevaluation-130/`에 있다. 리뷰 ZIP `experiments/astronet-eval/results/review-130-28996f4c.zip`은 MR에 첨부할 검산 자료이며 저장소 파일이 아니다. ZIP에는 고정 코드·테스트·plan·manifest·이력·원본 소형 점수/manifest·검산기가 포함되고 FITS·checkpoint는 포함하지 않는다.

## 126·264·130의 완료 범위

사용자 확인으로 126 병합·Jira 완료 및 운영 후속 264 발급(담당 윤성용)을 확인했다. 130은 변경 트리거와 재평가·이력 보존 fixture 검증을 맡는다. 264의 운영 재채택 조건이 충족됐다는 뜻은 아니다. 내부 결과를 서비스 DB·Gold에 넣지 않으며, 실제 운영 연결 시 계산 버전 변경·새 bundle 게시와 과거 판 불변을 별도로 검증해야 한다. 79의 정책상 AI 미실행 경로는 130 재평가 성공을 기다리지 않는다.
