# 데이터 문서 안내

데이터 저장·재현성, Hadoop·Spark 배치, TESS 처리와 AI 조사 자료를 관리한다.

| 확인할 내용 | 문서 | 역할·상태 |
| --- | --- | --- |
| 저장·파티션·보존·재현성 | [데이터 관리](data-guidelines.md) | 데이터 상세 규칙 |
| 수집·Hadoop·Spark 배치 | [Hadoop·Spark 개발 규칙](spark-hadoop-guidelines.md) | 배치 구현·검증 규칙 |
| 공통 실험 입력 | [TESS fixture 세트](tess-fixture-set.md) | 실험용 고정 입력 계약 |
| 서비스 TESS 범위 시나리오·대표 표본·초기 예산 | [서비스 범위 초안](tess-service-scope-v1.md) | 초안, I03 결과·김동혁 검토로 승인 전 |
| 현재 구현과 목표의 차이, 처리 단계별 설계·검증 | [TESS 파이프라인 분석](tess-pipeline/README.md) | 팀 검토용 제안과 상세 문서 지도 |
| 모델 후보 실행 가능성 | [AI 모델 조사](tess-ai-model-feasibility.md) | 조사·실험 결과 |
| 전처리·detrending 설정 비교 | [전처리 벤치마크](tess-preprocess-benchmark.md) | 실행 결과·제안, 팀 리뷰 전 |

저장 위치와 시스템 경계는 [아키텍처](../architecture/README.md), 서비스 정책은 [요구사항](../requirements/README.md)이 우선한다. fixture와 조사 결과를 전체 데이터 범위나 운영 완료 증거로 사용하지 않는다.

운영에 채택한 실험 결과는 담당 규칙 문서와 실제 코드 위치로 옮기고, 과거 실험 문서는 근거로 보존한다.
