# Planetory 문서 인덱스

이 문서는 작업 목적에 맞는 정본과 상세 문서를 찾는 진입점이다. 상위 문서에는 요약과 링크만 두고, 상세 규칙은 아래 담당 문서 한 곳에서 관리한다.

## 작업 유형별 먼저 읽을 문서

| 작업 유형 | 먼저 확인할 정본·상세 문서 |
| --- | --- |
| 서비스 기능, 정책, 인수 조건 | [요구사항 명세서](requirements/planetory-requirements-spec.md), [후보·별 상태표](requirements/planetory-status-table.md), [용어 사전](requirements/planetory-glossary.md) |
| 서비스 백엔드·API | [서비스 DB ERD](development/database-erd.md), [백엔드 기능 분석](development/planetory-service-backend-feature-analysis.md), [서비스 API 명세](../apps/backend/docs/service-api-spec.md) |
| 분석 프론트엔드·API 연동 | [분석 프론트엔드 상세 명세](development/analysis-frontend-spec.md), [API v1.0 전환 기준](api/analysis/v1-migration.md), [Frontend 경계](../apps/frontend/README.md) |
| 시스템 경계, AWS·GCP 역할 | [시스템 아키텍처](development/system-architecture.md), [GCP 분산 인프라](development/gcp-distributed-infrastructure.md) |
| PostgreSQL 모델·제약 | [서비스 DB ERD](development/database-erd.md) |
| 데이터 저장, 파티션, 재현성 | [데이터 관리 및 재현성](development/data-guidelines.md) |
| 수집, Hadoop·Spark, PublicationBundle | [Hadoop·Spark 개발 규칙](development/spark-hadoop-guidelines.md), [분산 시스템 운영 경계](../distributed-system/README.md) |
| 온라인 잔차·주기도 계산 | [EC2 온라인 파생 계산](development/online-derived-compute.md), [요구사항 명세서](requirements/planetory-requirements-spec.md), [서비스 DB ERD](development/database-erd.md) |
| 코드·설정의 배치 위치 | [저장소 구조](development/repository-structure.md), 변경 대상과 가장 가까운 `README.md` |
| Docker 로컬 실행·배포 | [Docker 개발·배포 기준](operations/docker.md) |
| 빌드, CI/CD, 배포 경계 | [GitLab CI/CD](operations/cicd.md) |
| 브랜치, 커밋, MR, Jira | [Git·Jira 협업 컨벤션](git-jira-convention.md) |
| Jira·GitLab·Mattermost 알림 | [자동화 초안](jira-mattermost-automation.md) |
| 담당 범위와 협업 경계 | [팀 역할 분배](team-role-allocation.md) |
| TESS 처리·AI 연구 또는 실험 | 아래 [조사·실험 문서](#조사실험-문서)와 해당 `experiments/`의 `README.md` |

기능이 여러 영역을 통과하면 표의 문서를 함께 읽는다. 예를 들어 데이터 파이프라인 변경은 시스템 아키텍처, 데이터 규칙, Hadoop·Spark 규칙, 관련 계약과 실행 디렉터리의 `README.md`를 확인한다.

## 문서의 역할과 우선순위

### 정본과 기준선

- [요구사항 명세서](requirements/planetory-requirements-spec.md): 서비스 정책, 기능, 비기능 요구사항과 인수 조건의 정본이다.
- [시스템 아키텍처](development/system-architecture.md): 온라인·배치 시스템 경계와 AWS·GCP 책임의 정본이다. 목표 설계와 실제 구축 상태를 구분한다.
- [서비스 DB ERD](development/database-erd.md): EC2 PostgreSQL 테이블, 관계와 제약의 백엔드 기준선이다.
- [저장소 구조](development/repository-structure.md): 배포 단위와 디렉터리 책임을 정한다.
- [Git·Jira 협업 컨벤션](git-jira-convention.md): Jira, 브랜치, 커밋, MR과 릴리스 규칙의 정본이다.

### 정본을 상세화하는 문서

- [후보·별 상태표](requirements/planetory-status-table.md)는 요구사항의 상태 전이를, [용어 사전](requirements/planetory-glossary.md)은 화면 표기를 상세화한다. 충돌하면 요구사항 명세서가 우선한다.
- [데이터 관리 및 재현성](development/data-guidelines.md), [Hadoop·Spark 개발 규칙](development/spark-hadoop-guidelines.md), [GCP 분산 인프라](development/gcp-distributed-infrastructure.md), [EC2 온라인 파생 계산](development/online-derived-compute.md)은 담당 영역의 구현·검증 기준을 상세화한다.
- [Docker 개발·배포 기준](operations/docker.md)과 [GitLab CI/CD](operations/cicd.md)는 실행·배포 경계를 관리한다. 정적 검사 통과와 실제 배포 검증을 구분한다.
- [백엔드 기능 분석](development/planetory-service-backend-feature-analysis.md), [서비스 API 명세](../apps/backend/docs/service-api-spec.md), [분석 프론트엔드 상세 명세](development/analysis-frontend-spec.md)는 팀 협의용 초안이다. 요구사항과 ERD를 구체화하지만 구현 완료나 최종 API 합의를 뜻하지 않는다.
- `apps/`, `contracts/`, `distributed-system/`, `infra/`, `libs/` 아래 `README.md`는 해당 디렉터리의 책임, 현재 구현 상태와 실행 방법을 관리한다.

### 조사·실험 문서

- [TESS 파이프라인 갭 분석](development/tess-pipeline-gap-analysis.md)과 [리뷰 체크리스트](development/tess-pipeline-review-checklist.md)는 제안과 검토 근거다.
- [TESS 처리·AI 역할 명세](development/tess-processing-ai-role-spec.md)는 담당 범위와 실행 순서를, [AI 모델 실행 가능성](development/tess-ai-model-feasibility.md)은 조사 결과를 기록한다.
- [TESS 고정 fixture](development/tess-fixture-set.md)는 후속 실험의 고정 입력 계약이며 서비스 전체 데이터 범위를 정하지 않는다.
- [분석 API·Mock](api/analysis/README.md)과 JSON 예제는 v0.12 실험 재현 자료다. 새 연동에는 [v1.0 전환 기준](api/analysis/v1-migration.md)을 먼저 적용한다.
- [실험 문서 안내](experiments/README.md), `docs/experiments/`와 저장소 `experiments/` 아래 문서는 PoC 범위·명령·결과의 근거다. 운영 규칙으로 채택하기 전에는 정본보다 우선하지 않는다.
- `docs/requirements/prototype/`은 화면 흐름 검증용 산출물이다. 요구사항과 다르면 요구사항 명세서를 따른다.
- `docs/daily-report/`와 `docs/weekly-report/`는 작업 당시의 기록이며 현재 기술 결정의 근거로 단독 사용하지 않는다.

## 알려진 동기화 충돌

현재 문서 조사에서 다음 충돌을 확인했다. 관련 구현 전에 Jira 범위에서 문서를 먼저 동기화하거나 팀 결정을 요청한다.

전체 위치와 수정 제안은 [원본 문서 정합화 요청](development/planetory-doc-sync-requests.md)에서 추적한다.

- `system-architecture.md`와 `online-derived-compute.md`에는 요구사항 v0.12의 EC2 Gold 파일, 분석 세션 Bundle 고정과 Redis 후보 설명이 남아 있다.
- 요구사항 명세서 v1.0과 `database-erd.md`는 Gold 본문의 PostgreSQL 배열 저장, 새 `current` 공개 시 진행 세션 갱신, Redis 캐시를 기준선으로 기록한다.
- `database-erd.md` 자체도 시스템 아키텍처의 Gold 저장 규칙을 갱신해야 한다고 명시한다.

따라서 AWS·GCP 시스템 경계는 시스템 아키텍처를 따르되, Gold 저장 형태·세션 전환·캐시는 요구사항 v1.0과 DB ERD를 함께 대조한다. 충돌을 해소하는 Jira 결정 없이 기존 문구 중 하나를 임의로 구현하지 않는다.

## 문서 검색·수정·생성 규칙

1. `rg --files -g "*.md"`로 문서 위치를 찾고, `rg -n "검색어" docs README.md CONTRIBUTING.md AGENTS.md`로 관련 결정을 검색한다.
2. 이 인덱스의 정본을 먼저 읽고 변경 대상과 가장 가까운 `README.md`, 코드, 설정과 테스트를 함께 확인한다.
3. 같은 규칙이 여러 문서에 있으면 담당 정본만 갱신하고 다른 문서는 요약과 상대 링크로 연결한다. 이력·근거 문서는 과거 사실을 보존한다.
4. 확정되지 않은 값은 `가정`, `후보`, `미정` 또는 `TBD`로 표시하고 결정할 Jira·담당자·완료 조건을 남긴다.
5. 기존 문서의 책임 안에 넣을 수 없을 때만 새 문서를 만든다. 목적, 범위, 상태, 관련 Jira, 상위 정본과 검증 방법을 적고 이 인덱스에 등록한다.
6. 문서를 이동하거나 이름을 바꾸면 모든 상대 링크를 함께 갱신한다. 저장소 내부 파일은 상대 링크, 외부 자료는 HTTPS 링크를 사용한다.

## 변경 후 확인

- `git diff --check`로 공백과 Markdown diff 오류를 확인한다.
- 변경한 Markdown의 상대 링크가 실제 파일 또는 디렉터리를 가리키는지 확인한다. `http(s)`, `mailto:`, 문서 내부 `#anchor`, Jira 자동화의 `{{...}}` 템플릿은 로컬 경로 검사 대상이 아니다.
- 코드·설정 변경이 API, 계약, DB, 데이터 흐름, 배포 또는 사용자 동작에 미치는 문서를 갱신했는지 확인한다.
- 변경하지 않은 문서가 있다면 영향이 없는 이유를 MR 검증 결과에 적는다.
- 계획, 구현, 정적 검사, 실제 환경 검증을 각각 구분해 보고한다.
