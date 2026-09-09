# 윤성용 천문 데이터 처리·AI 역할 명세

작성일: 2026-09-09  
담당: 윤성용  
연결 Jira: S15P21C206-29  
상태: 로컬 `develop@352290f5`의 요구사항 명세서 v0.12 기반 작업 안내서, 팀 리뷰 전

이 문서는 팀 요구사항을 바꾸지 않는다. 요구사항 명세서 v0.12와 팀 역할 분배에서 윤성용에게 배정된 일을 실제 작업 순서로 풀어 쓴다. 상세한 근거·스키마·실험안은 [TESS 파이프라인 갭 분석](tess-pipeline-gap-analysis.md), Jira 완료 조건과 리뷰 질문은 [TESS 파이프라인 리뷰 체크리스트](tess-pipeline-review-checklist.md)에서 관리한다.

## 1. 역할을 한 문장으로 설명

TESS Light Curve를 재현 가능한 방식으로 정제하고, Silver 내부 반복 BLS로 후보와 transit model을 만들며, 외부 카탈로그와 AI 결과를 연결해 검증된 Gold 입력을 서비스 팀에 전달하는 책임을 맡는다.

윤성용이 과학적 계산 의미와 검증 기준을 책임지고, 저장·분산 실행·온라인 API·화면 구현은 각 담당자와 데이터 계약으로 연결한다.

## 2. 현재 기준에서 확정된 흐름

```text
MAST FITS·외부 원천
→ Raw/Bronze 등록·파싱
→ Sector별 품질 필터·정규화·연속 구간 detrending
→ TIC별 정제곡선 결합
→ 원본 BLS
→ transit model 적합·제거 QA
→ Silver 내부 잔차 BLS 반복
→ 모든 단계 후보의 원본 재검증
→ 고조파·중복 병합·discoverable 판정
→ TCE·TOI·Archive·ExoFOP 연결
→ 후보별 AI 입력·추론
→ Gold PublicationBundle 검증·전달
```

사용자 분석은 별도 온라인 흐름이다.

```text
세션에 고정된 Gold Bundle
+ 사용자가 매칭한 후보 모델 조합
→ EC2 잔차곡선 계산
→ EC2 잔차 주기도 계산
→ 화면 제공·Bundle별 캐시
```

사용자는 현재 곡선의 전체 유효 관측점을 브라우저에서 선택 주기로 접고, 접힌 곡선에서만 `phase_start`·`phase_end`를 선택한다. 브라우저는 Bundle의 `fold_reference_time_btjd`로 epoch·duration을 미리보기하고 서버가 같은 공식으로 최종값을 다시 계산한다. 시간 영역 곡선에서 transit 구간을 고르거나 epoch·duration을 숫자로 직접 입력하지 않는다.

EC2 온라인 계산은 새 Candidate를 만들거나 AI를 다시 실행하지 않는다. 새 Bundle은 새 cache key를 사용하고, 진행 중 세션은 시작 Bundle에 고정한다. 구버전 Bundle과 cache는 즉시 폐기하지 않고 DEC-35에서 정할 보존기간이 끝날 때 함께 만료한다.

## 3. 단계별 담당 업무와 산출물

| 단계 | 윤성용이 할 일 | 만들어야 할 산출물 | 함께 확인할 사람 |
|---|---|---|---|
| 원천 계약 | TESS 제품·cadence·Sector 범위, FITS HDU·헤더·필수 컬럼·단위 확인 | 입력 manifest·FITS 파싱 계약 | 김동혁 |
| 외부 원천 | TIC·TCE·TOI·Archive·ExoFOP 식별자와 갱신·매칭 규칙 정의 | 외부 snapshot·후보 연결 계약 | 강재민 |
| 전처리 | 품질·결측·이상치·추가 마스크·정규화·구간 분리·detrending 검증 | 정제곡선 schema, 제외 사유, 전처리 버전, 벤치마크 | 김동혁·백지웅 |
| BLS | 주기·지속시간 격자, SDE·SNR·transit 수·Sector 일관성 계산 | 원본/반복 periodogram, 설정 버전, 품질 결과 | 김동혁 |
| 반복 제거 | 후보 transit model 적합, 제거 전후 QA, 종료 사유 기록 | 실행 중 Silver residual·periodogram, 지속 저장할 removal QA 요약·반복 이력 | 김동혁·강재민 |
| 후보 통합 | 원본 재검증, 고조파·중복 병합, 안정 ID와 discoverable 판정 | Candidate·CandidateAlias·TransitModel | 강재민 |
| AI | 적용 가능한 모델·체크포인트·라이선스 확인, 입력 생성·추론·평가 | AI 입력 버전, 점수·상태·모델 버전, 검증 보고서 | 김동혁·강재민 |
| Gold 계약 | 서비스에 필요한 전 점·마스크·주기도·후보·모델·버전 검증 | PublicationBundle 과학 schema·QA 결과 | 김동혁·강재민·백지웅 |
| 온라인 일치 | 같은 모델·설정에서 Silver와 EC2 잔차·주기도 비교 | fixture, 허용 오차 근거, 회귀 결과 | 김동혁·강재민 |
| 갱신 | 새 Sector·원천·설정·모델 변경의 재처리 범위 산정 | 변경 영향표, 후보 추가·discoverable 변경 목록 | 강재민·백승학·하서진 |

## 4. Silver와 Gold에서 책임질 범위

### Silver 내부

윤성용은 다음 계산의 의미·버전·검증 기준을 정의한다.

- Sector별 정제곡선과 행 대응
- trend·정규화 통계·품질 마스크·제외 사유
- 원본 BLS periodogram과 반복 단계의 실행 중 periodogram
- 단계별 transit model과 실행 중 residual
- 제거 전후 power·경계 돌출·다른 후보 훼손·겹침 왜곡 QA
- 품질 실패 후보와 반복 종료 사유
- 원본 재검증·고조파·중복 병합 근거
- AI 입력·결과와 실행 실패 상태

DAT-05에 따라 단계별 residual·periodogram 배열은 지속 저장하지 않는다. 윤성용은 Spark 실행 중 필요한 계산 흐름과 지속 저장할 제거 QA 요약·종료 사유·후보·모델·설정 버전을 정의하고, 김동혁은 이를 만족하는 실행·저장 구조를 설계한다.

### Gold PublicationBundle

요구사항 명세서 v0.12 기준 최소 항목은 다음과 같다.

- 원본 정제곡선 전체 관측점
- 품질 마스크
- 각 LightCurve의 `fold_reference_time_btjd`
- 원본 periodogram
- 사용자에게 제공할 후보표
- 후보별 transit model과 `residual_model_version`
- 외부 상태
- AI 결과와 모델·입력·임계값 버전
- 입력·처리·schema·파일 hash를 가진 manifest

사용자용 단계별 잔차곡선과 잔차 주기도는 Gold에 넣지 않고, 검증된 Bundle만 원자적으로 공개하며 실패 시 기존 공개본을 유지한다. 여기까지는 요구사항 명세서 v0.12의 확정 범위다. 이를 만족하는 실제 파일 배치·직렬화 형식·전송 및 release 전환 구현·용량은 DEC-35의 별도 아키텍처 Task에서 김동혁·강재민과 확정한다.

`fold_reference_time_btjd`는 DAT-02 품질 필터 후 time·flux가 유한한 원본 정제곡선 시각을 정렬한 중앙값으로 한 번 계산해 float64 정밀도로 저장한다. 브라우저·서버·모든 잔차 단계는 이 값을 상속하고 다시 산정하지 않는다.

## 5. 명세서가 미결정 또는 후속 Task로 남긴 항목

- 전체 TESS 제품·cadence·Sector·대상 수
- 품질 bit 정책과 Sector 시작·궤도 근점 마스크 범위
- 최종 detrending 방법·창 길이·fallback
- BLS 격자, SDE·SNR·transit 수, 반복 상한과 종료 기준
- 제거 QA와 Silver–EC2 수치 허용 오차
- 고조파 추가 배율과 후보 매칭 허용 오차
- AI 모델·체크포인트·입력 곡선 단계·승인 구간
- Silver 단계별 배열을 저장하지 않는 조건을 만족할 Spark 실행 방식과 Gold 실제 파일 schema
- 온라인 계산 위치, 캐시 저장소, 큐·동시 실행 상한과 시간 목표
- EC2 cache와 구버전 Bundle의 보존기간

Silver 내부 반복 BLS, 단계별 배열 비저장, Gold 필수 구성, EC2 온라인 잔차 계산·캐시 키·상태 전이·Bundle 고정은 위 목록의 미결정 항목이 아니라 v0.12 확정 요구사항이다. 윤성용은 위에 열거한 미결정 항목에만 실험 근거와 권장안을 제시하고, 관련 담당자 리뷰 결과를 문서와 Jira에 남긴다.

## 6. 지금까지 완료한 일

| 작업 | 상태 | 현재 근거와 한계 |
|---|---|---|
| Jira 29 완료 조건·첨부·댓글 확인 | 완료 | 실제 Jira 기준을 리뷰 체크리스트에 기록 |
| TOI-270 Sector 3·4·5 FITS 구조 확인 | 완료 | TIC 259377017 샘플 한 개 기준 |
| 품질·결측 필터와 정규화 확인 | 완료 | 서비스 정책의 최종 수치는 미확정 |
| Sector·공백 구간 처리 설계 | 초안 완료 | 추가 마스크 범위 실험 필요 |
| detrending 설계·주입 비교안 | 초안 완료 | 최종 방법·창·통과 수치 미확정 |
| 최초 원본 BLS 재현 | 완료 | 약 5.6593일, 반복 후보 회수 검증은 아님 |
| BLS 품질·고조파·벤치마크 설계 | 초안 완료 | 실제 고정 평가 세트 실행 필요 |
| Silver 내부 반복 BLS 설계 | v0.12 반영 | 자동 반복 구현·제거 QA 실험 미완료 |
| 외부 원천 연결 설계 | 초안 완료 | 실제 export 컬럼·매칭 실측 필요 |
| AI 모델·입력·평가 설계 | 초안 완료 | 체크포인트 실행·라이선스 검증 미완료 |
| Silver·Gold·EC2 논리 경계 | v0.12 확정 요구사항 반영 완료 | 실제 파일 schema·계산 위치·cache 저장소/보존기간·용량·허용 오차는 DEC-35 후속 Task |
| 노트북 환경 재현 | 29번 완료 필수에서 제외 | 집에서 기존 PoC와 테스트를 확인했으며, 다른 환경 반복 실행은 구현·회귀 검증 Task에서 필요할 때 수행 |
| Draft MR | 생성 완료 | 최신 명세 반영 커밋과 팀 리뷰 필요 |

## 7. Jira 29번을 마치는 순서

### 1단계 — 기획 문서 정합화

- 요구사항 명세서 v0.12의 DAT-01~15, AI-01~05를 상세 기획에 연결한다.
- 확인한 사실, 현재 요구사항, 윤성용 제안, TBD를 구분한다.
- Silver 반복 BLS와 EC2 온라인 잔차의 목적을 분리한다.
- Silver 단계별 잔차·주기도 배열 비저장과 Gold의 사용자용 잔차 제외를 적용한다.
- Gold 필수 필드는 v0.12를 그대로 적용하고, 물리 파일 schema와 소비자 직렬화 계약만 후속 인터페이스 리뷰에서 확인한다.
- 접힌 곡선의 위상 구간 선택과 `fold_reference_time_btjd` 기반 epoch·duration 계산 계약을 확인한다.

### 2단계 — 수치가 필요한 실험을 후속 Task로 분리

- 전처리·detrending 벤치마크
- BLS 격자·품질·반복 종료·제거 QA 벤치마크
- 고조파·후보 병합·discoverable 검증
- 외부 원천 schema·매칭 검증
- AI 모델 실행 가능성·입력·임계값 검증
- Silver–EC2 잔차·주기도 일치 검증

각 Task에는 입력 fixture, 설정 버전, 실행 명령, 통과 기준과 작은 리뷰 산출물을 적는다.

### 3단계 — 인터페이스 리뷰

- 김동혁: 확정된 Silver 비저장 조건을 만족하는 Spark 실행, Gold 물리 파일·전달·용량
- 강재민: Candidate/TransitModel 직렬화 계약, DEC-35 온라인 계산 위치·cache 저장소/보존기간, 재개 이벤트 구현
- 백지웅: 전 점·마스크·단위·fold 기준 시각과 화면 파생물
- 백승학·하서진: 후보 추가·discoverable 변경 이후 알림·발견 영향

### 4단계 — MR과 Jira 완료

- 리뷰 결정을 상세 기획과 체크리스트에 반영한다.
- 결정하지 못한 수치는 담당·후속 Task·검증 방법·결정 시점을 남긴다.
- Draft MR을 Ready로 전환하고 작성자 외 최소 1명 승인을 받는다.
- MR 병합, 완료 조건 확인, 최종 문서·검증 링크 Jira 등록 뒤 완료 처리한다.

## 8. 기획 이후 구현 권장 순서

1. 고정 FITS·합성 주입 fixture와 실행 manifest를 만든다.
2. 전처리·detrending 후보를 같은 fixture에서 비교한다.
3. BLS 격자·품질 게이트·반복 종료·제거 QA를 벤치마크한다.
4. Candidate ID·고조파·원본 재검증·TransitModel 계약을 구현한다.
5. TCE·TOI·Archive·ExoFOP snapshot과 후보 연결을 구현한다.
6. AI 모델 실행 가능성을 확인하고 선택 모델 입력·추론·평가를 구현한다.
7. Silver 결과를 Gold PublicationBundle로 검증·직렬화한다.
8. 같은 Gold 모델로 Silver–EC2 잔차와 periodogram 일치를 검증한다.
9. 검증된 커널을 Spark/Airflow 배치에 연결하고 실패 단계 재처리를 확인한다.

## 9. 매 작업에서 남길 증거

- 사용한 Git commit과 의존성 lock
- 입력 URI·snapshot·checksum과 대상 TIC·Sector
- 전처리·BLS·후보·모델·AI 설정 버전
- 실행 명령과 환경 CPU·아키텍처·Python/Java 버전
- 행 수·마스크 수·후보 수·반복 수·종료 사유
- 성공·실패 사례와 허용 오차 판정
- 대용량 원본이 아닌 작은 표·요약·그림과 실제 결과 위치

PoC 한 번의 성공이나 알려진 행성 한 개의 회수만으로 전체 정확도·성능·서비스 준비 완료를 주장하지 않는다.
