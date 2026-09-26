# 데이터 문서 안내

데이터 저장·재현성, Hadoop·Spark 배치, TESS 처리와 AI 조사 자료를 관리한다.

| 확인할 내용 | 문서 | 역할·상태 |
| --- | --- | --- |
| 저장·파티션·보존·재현성 | [데이터 관리](data-guidelines.md) | 데이터 상세 규칙 |
| 수집·Hadoop·Spark 배치 | [Hadoop·Spark 개발 규칙](spark-hadoop-guidelines.md) | 배치 구현·검증 규칙 |
| 감사 완료 FITS의 HDFS Raw 적재·복원 | [TESS HDFS Raw 적재](../../distributed-system/ingestion/hdfs/README.md) | S15P21C206-76 실행·복구 절차 |
| 공통 실험 입력 | [TESS fixture 세트](tess-fixture-set.md) | 실험용 고정 입력 계약 |
| 외부 TCE·TOI·Archive·ExoFOP 계약 | [외부 카탈로그 검증](tess-external-catalog-contract.md) | 116 네 원천 감사·9별 실측 완료, 소비자·처리 운영 리뷰 승인. 운영 구현은 124 |
| 서비스 TESS 범위 시나리오·대표 표본·초기 예산 | [서비스 범위 초안](tess-service-scope-v1.md) | 초안, I03 결과·김동혁 검토로 승인 전 |
| 현재 구현과 목표의 차이, 처리 단계별 설계·검증 | [TESS 파이프라인 분석](tess-pipeline/README.md) | 팀 검토용 제안과 상세 문서 지도 |
| 모델 후보 실행 가능성 | [AI 모델 조사](tess-ai-model-feasibility.md) | 조사·실험 결과 |
| 전처리·detrending 설정 비교 | [전처리 벤치마크](tess-preprocess-benchmark.md) | 실행 결과·제안, 팀 리뷰 전 |
| 42/D03 기본 전처리 커널·119 회귀 계약 | [astro-kernel](../../libs/astro-kernel/README.md#silver-전처리-119) | 기본 커널·4별 회귀 완료, 재리뷰 대기. DAT-02 불량 구간 마스킹은 245 |
| AI 평가용 PC/EB/junk 세트·201/61 입력 변환 | [AstroNet 평가 세트](tess-astronet-eval-set.md) | 1차 세트 생성·변환 완료, 팀 리뷰 전 |
| 단일 AstroNet 성능·임계값 검토 | [AstroNet 성능 평가](tess-astronet-benchmark.md) | 실측 완료·팀 최종 운영 채택 보류, 내부 검토 자료 보존 |
| 126 내부 실험 배치·운영 후속 경계 | [내부 AstroNet 배치](tess-astronet-internal-batch.md) | 단위·55개 반복 추론 검증 완료, 후속 추적·MR 대기 |
| BLS 탐색 격자·품질 게이트 비교 | [BLS 벤치마크](tess-bls-benchmark.md) | 조정·평가・holdout 실행 결과와 채택 근거 |
| 반복 BLS·고정 모델 제거 루프의 종료·제거 QA·복구 | [반복 제거 벤치마크](tess-bls-iteration-benchmark.md) | 코드·합성 테스트와 fixture 실행 결과, 최종 검증 정리 중 |
| 고조파·판 사이 후보 ID 동일성 | [후보 동일성 벤치마크](tess-candidate-identity-benchmark.md) | 112 v3 계약 리뷰 준비·69 tests, 자동 고조파 병합 운영 미채택·계약 미승인 |
| 사용자 제출 매칭 수치·공통 fixture | [제출 매칭 검증](tess-submission-matching-benchmark.md) | 128 최신 계약 정합화·111 부분 검산, rule-1 미확정 |
| 세그먼트·비닝 해상도 비교 | [비닝 벤치마크](tess-binning-benchmark.md) | 9별 실측·3차 화면 검토 완료, 부분 bin 근거·운영 채택안 및 후속 인계 기록 |

저장 위치와 시스템 경계는 [아키텍처](../architecture/README.md), 서비스 정책은 [요구사항](../requirements/README.md)이 우선한다. fixture와 조사 결과를 전체 데이터 범위나 운영 완료 증거로 사용하지 않는다.

운영에 채택한 실험 결과는 담당 규칙 문서와 실제 코드 위치로 옮기고, 과거 실험 문서는 근거로 보존한다.

245 구간 마스크의 실제 근거와 검증은 [관측 구간 마스킹](../../experiments/tess-bench/README.md#245-근거-구간-마스크-검증)을 참조한다.

115 제공 해상도 판정의 설계·실행·승인 경계는 [discoverable 벤치마크](tess-discoverability-benchmark.md)를 참조한다. 현재 9별 실측·검산 완료, 규칙 승인 전이다.

124 운영 커널의 입력·출력과 검증 한계는 [외부 스냅샷·후보 조인 구현](tess-external-catalog-implementation.md)을 참조한다. 122 산출물의 후보 ID·실제 관측 시각 연결 회귀와 검산을 완료했으며 리뷰 대기 중이다. 운영 DB ID 검증은 포함하지 않으며 미확인 외부 시간 척도는 보류한다.

- [130 AI 재평가·과거 결과 보존](tess-ai-reevaluation-history.md): 공용 순수 커널·저장 점수 연결 검증, 운영 연결 전.
- [79 게시 후보 집계](../../contracts/gold/README.md#43-s15p21c206-79-게시-후보-집계): run 단위 TIC 상태·후보 계보·manifest 계약. 커널·합성 fixture 검증, 실제 Silver·80 연결 전.
