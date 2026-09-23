# 126 내부 실험용 AstroNet 입력·배치 계약

- Jira: S15P21C206-126 / 담당: 윤성용
- 상태: 내부 실험 범위 조건부 승인, 구현·단위 검증 및 동일 환경 실제 추론 회귀 완료. 후속 추적 조건·MR 인수·티켓 완료는 별도다.
- 상위: [요구사항 AI 출시 범위](../requirements/planetory-requirements-spec.md#126-내부-실험과-ai-출시-유예), [118 최종 보류](tess-astronet-benchmark.md#6-최종-운영-채택-보류-결정과-완료-경계)

## 승인과 완료 경계

사용자가 전달한 백지웅(전체 명세·출시 범위 담당)의 조건부 승인에 따른다.
126 내부 실험 범위 변경과 AI-03·04 이번 출시 유예는 [결정 등록부](../requirements/planetory-decision-register.md#126-범위-변경과-ai-출시-유예)에서 별도로 추적한다.
동일 내용에 대해 팀원 전원의 중복 승인을 요구하지 않는다.
운영 후속 티켓·담당·재개 조건 지정, 79·130 범위·일정 확인, 실제 실행·검산·MR 승인·병합 전에는 126을 완료하지 않는다.
사용자 화면·자동 승인/기각·서비스 DB·Gold·내부 도구 배포에 연결하지 않는다.
`publishable=false`, `internal_only=true`는 실험 표시이며 운영 게시 승인 표식이 아니다.
서비스 사용·재배포 조건 검토 완료도 아니다.

## 재사용과 입력 경계

기존 `astronet_eval.convert`와 `views.make_views`의 전처리·201/61 view 변환을 재사용한다.
118 코드·평가 결과는 수정하지 않는다. 전용 `scripts/internal_batch.py`와 `scripts/run_internal_batch.py`가 118 형식 변환 manifest를 읽어 내부 배치만 실행한다.
첫 실행은 기존 55개 평가 후보의 검증된 변환 결과를 재사용하며 **122 운영 후보 ID 연결 검증이나 새 독립 평가가 아니다.**
변환 자체는 기존 views·convert 회귀로 확인하고, 새 변환이 필요하면 기존 convert CLI를 사용한다.
현재 실행기는 두 split을 모두 포함한 118 형식 세트를 지원하며 임의 운영 후보 카탈로그를 직접 받지 않는다.

- 모델 commit: `5675a57dd41dd0321df480453451096dc5a4a6b0`
- 단일 checkpoint: `astronet/models_final/model_1/model.ckpt-14000`
- TensorFlow 1.15.5, CPU, intra/inter-op 각 1 thread. 기존 118 Docker digest 고정을 재사용한다.
- 모델 파일은 assets.json SHA-256과 대조하며 checkpoint index/data·코드·LICENSE 누락을 거부한다.
- 입력은 conversion manifest→CSV→NPZ→배열 hash, 후보/TIC 식별자·float32 shape를 검증한다.
- input_version: `astronet-triage-global201-local61-conversion-manifest-v1`. 실제 입력 정체성에는 conversion manifest·파일·배열 해시를 함께 사용한다.
- 점수 의미: **PC/EB 대 junk triage 점수**. 행성 확률 또는 PC와 EB 구분이 아니다.
- 판정 밴드·threshold 인수를 받지 않으며 임계값을 재조정하지 않는다.

## 상태·재현성·산출물

| 상태 | score | 의미 |
| --- | --- | --- |
| completed | 유한 [0,1], 정상 0 포함 | 추론 성공 |
| input_incomplete | null | 변환 단계 입력 부족·실패 사유 보존 |
| inference_failed | null | 후보 추론 예외·비정상 점수 |

입력/모델 무결성 위반·모델 초기화 오류는 실행 전체 실패로 기록한다.
정책상 AI 미실행은 추론 실패와 다르며 이 도구가 서비스용 미실행 행을 만들지 않는다.
매번 새 run 디렉터리에 같은 입력으로 복원한 독립 세션 2회의 결과를 저장한다.
동일 CPU 환경에서 점수·상태·입력 식별자를 정확히 비교한다. 같은 실패는 성공 재현성으로 세지 않는다.
`verification_passed`는 일치하는 성공 점수가 있고 모든 후보가 성공했을 때만 true다.
실패·불일치가 있으면 결과를 보존하되 종료 코드 2를 반환한다. 다른 기기·GPU의 비트 동일성 보장은 아니다.

| 파일 | 내용 |
| --- | --- |
| launch.json | Docker digest·실제 image ID·명령·launcher hash |
| run/plan.json | 모델·입력·실행 코드 hash, 환경, 반복 횟수, 점수 의미 |
| run/predictions-1.json, predictions-2.json | 후보별 점수·상태·사유·모델/입력 버전·배열 hash |
| run/comparison.json | 반복 비교·불일치 목록 |
| run/manifest.json | 결과 checksum·후보 수·검증 통과 여부 |
| failure.json / launch-failure.json | 실행 실패 기록 |

입력·plan은 종료 전에 hash를 다시 대조한다. 기존 118 run에 쓰지 않는다.
명령·테스트는 [실험 README](../../experiments/astronet-eval/README.md#126-내부-실험-배치)를 따른다.

## 운영 후속 티켓 초안 — 발급·담당 지정 전

기존 Jira 검색에서 초기 운영 재개 전체를 맡는 별도 티켓은 확인하지 못했다. 다음은 생성 전 초안이다.

- 제목: `[ML] AI 운영 재채택·초기 추론·Gold 연결 및 판정 밴드 구현`
- 목적·범위: 재채택 증거, 초기 운영 추론·판정 밴드, 125/79/Publisher 계약 연결, 소비자 노출 경계 검증.
- 담당·일정: 확인 필요. 126 담당자를 자동 지정하지 않는다.
- 재개 조건: 새 미사용 평가 세트, 서비스 FP/FN 기준, 모델·임계값 승인, 코드/checkpoint 사용·재배포 조건 확인, 운영 상태·게시 계약 합의.
- 완료 조건: 운영 후보→입력→추론→Gold·게시 별도 인수, 실패 정책 검증, 과거 판 불변과 새 계산 버전/bundle_version 검증.
- 제외: 130의 변경 후 재평가·과거 결과 보존 구현을 중복하지 않는다.

| 티켓 | 현재 확인 | 변경 제안·미확정 |
| --- | --- | --- |
| 79 | 김동혁: 정책상 미실행 수용·126 선행 해제 동의. 착수일은 78·125 진행 후 결정 | 126→79 링크 해제 승인 확보, 도구에 삭제 기능이 없어 실제 해제 대기. 운영 후속 발급 후 AI 경로와 연결 |
| 130 | 윤성용·해야 할 일·duedate 없음; 125/126 선행 | 재평가·과거 보존 범위 유지. 초기 운영 재개를 맡기지 않으며 새 운영 후속과 선행 관계·일정 확인 필요 |

`ai_results=[]` 및 빈 목록 checksum은 기존 Gold 계약에 존재한다.
79 담당 김동혁의 사용자 전달 리뷰로 정책상 미실행은 실패가 아니며 AI 없이 게시하는 방향을 확정했다. `ai_executions`는 만들지 않고 내부 126 점수는 받지 않는다. ai_model/ai_threshold는 명시적 미실행 값을 쓰되 `none/policy-hold-118` 등 문자열과 Gold QA 반영은 김동혁 후속이며 이 MR에서 구현하지 않는다.
실제 추론 실패는 publication-qa.md 5절의 기존 일시 실패 `PUBLISH_ROLLED_BACK`·반복 실패 `PUBLISH_REJECTED`·부분 공개 없음 규칙을 유지한다는 담당 의견을 기록한다. 정책상 미실행 행 추가와 버전 문자열 확정은 별도 후속이다.
Backend not_evaluated/null과 프론트 미평가 문구 지원은 게시 정책 확정 근거가 아니다.

## 실제 실행과 저장 결과 검산 (2026-09-23)

사용자가 실행한 `20260923T112206Z-ba539ace`를 저장 파일로 대조했다. 기존 118의 55개 변환 입력을 고정 단일 checkpoint로 두 독립 CPU 세션에서 추론했다.

- 후보 55개 모두 completed, 미산출 0개. 후보 ID 중복 0개.
- 두 실행의 후보별 점수·상태·입력 식별자 전체 일치, `verification_passed=true`.
- plan의 입력·모델·실행 코드 100개 hash와 manifest의 출력 4개 hash 불일치 0건. 별도 launcher hash도 일치한다.
- TensorFlow 1.15.5. 정상 점수 범위 [0,1] 확인. 실제 실패·정상 0 구분은 단위 테스트로 검증했으며 실제 입력에 그 경계가 발생했다고 주장하지 않는다.
- 실행 당시 구현은 미커밋 상태다. 실행 코드 정체성은 plan/launch의 파일 hash로 고정했으며 clean commit 실행으로 주장하지 않는다. `repo_commit`은 모델 저장소 commit이다.
- 재현성 검증이며 새 성능 평가·122 운영 ID 연결·운영 채택·DB 적재 검증이 아니다.

| 파일 | SHA-256 |
| --- | --- |
| run/manifest.json | `fb10995b29b74a1bdf5775ceba93d85534c9afb0fb2e46cbb401914578e91d24` |
| 두 predictions JSON 각각 | `3f95c171211f00e15204e7ec6827c6bdad699ce88375bb53f665ec99ee00d987` |
| review-126-ba539ace.zip | `8f6bb6b7194c03fd43aee637f55b86697510fd5c1d68fb146f0087847c455719` |

리뷰 ZIP은 `experiments/astronet-eval/results/review-126-ba539ace.zip`에 준비했으며 Git 제외다. MR 첨부용이고 실제 게시 여부는 별도 확인한다. 9개 항목(launch, plan, manifest, 두 predictions, comparison, verification, verify.py, checksums)을 포함하며 원본 FITS·NPZ·checkpoint는 제외한다.
압축 해제 후 다음 명령으로 내부 hash와 55개 결과 일치를 검산한다.

```powershell
python verify.py
```

ZIP만으로 모델 추론을 재실행할 수는 없다. 원본 입력 100개 대조는 원 실행 PC에서 수행한 검증이며 첨부의 검산과 구분한다.

## 김동혁 리뷰 반영

사용자 전달 리뷰에서 병합 승인을 확인했다. 내부 재현성은 동일 CPU·스레드 환경 범위이며 다른 기기·GPU 재현성으로 확대하지 않는다. 리뷰어는 전용 단위 10개와 lock 정합성을 직접 확인했고, 전체 67개 및 실측은 작성자 검증 범위다. 리뷰어가 ZIP 첨부를 확인했다. ZIP의 verify.py는 원본 입력·checkpoint 없이 실행 가능하며 실제 모델 재실행과 구분한다.

126→79 차단 링크(id 1463076)는 담당자 동의로 해제할 대상이다. 실제 Jira 삭제는 연결 도구 미지원으로 대기이며 126→130은 유지한다. 운영 후속 발급·담당·재개 조건 및 130 인계는 아직 완료하지 않았다.
