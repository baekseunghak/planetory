# Git·Jira 협업 컨벤션

> 버전: Draft 0.6  
> 대상: 6인 빅데이터 분산 처리 프로젝트  
> Jira 프로젝트 키: `S15P21C206`

이 문서는 Jira와 GitLab을 이용한 작업 관리, 브랜치, 커밋, Merge Request(MR), 릴리스 및 보고서 규칙을 정의합니다. Jira는 작업 관리의 단일 기준이며 GitLab Issues는 사용하지 않습니다.

시스템 설계와 데이터·개발 규칙은 다음 문서에서 관리합니다.

- [시스템 아키텍처](development/system-architecture.md)
- [데이터 관리 및 재현성](development/data-guidelines.md)
- [Hadoop·Spark 개발 규칙](development/spark-hadoop-guidelines.md)
- [CI/CD 결정 대기 사항](operations/cicd.md)
- [Jira-GitLab-Mattermost 자동화](jira-mattermost-automation.md)

## 1. 기본 원칙

- `main`과 `develop`에는 직접 push하지 않고 반드시 MR을 통해 반영합니다.
- 일반 개발 작업은 Jira Task에서 시작합니다.
- Jira와 GitLab Issue에 같은 작업을 중복 등록하지 않습니다.
- 원칙적으로 `Jira Task 1개 = 브랜치 1개 = MR 1개`로 관리합니다.
- Epic, 일부 문서 작업, `release/*`와 `hotfix/*`는 예외 규칙을 따릅니다.
- 본인이 작성한 MR의 셀프 승인은 인정하지 않습니다.
- 일반 `feature/*`, `fix/*`, `experiment/*`, `chore/*`와 문서 MR은 최소 1명의 승인을 받습니다.
- `release/* -> main` MR은 최소 2명의 승인을 받습니다.
- `release/* -> develop` MR은 최소 1명의 승인을 받습니다.
- `hotfix/* -> main` MR은 긴급 상황을 고려하되 최소 1명의 승인을 받습니다.
- 비밀번호, API 키, AWS 자격 증명, 개인정보, 원본 데이터 및 대용량 결과 파일을 commit하지 않습니다.

## 2. Jira 이슈 구조

Jira는 다음 2-depth 구조만 사용합니다.

```text
Epic
└─ Task
```

- Epic은 여러 Task를 묶는 목표 단위이며 Epic 자체로 작업 브랜치를 만들지 않습니다.
- 기능, 개발 중 결함, 문서, 조사 및 실험은 Task로 만듭니다.
- Story와 Sub-task는 사용하지 않습니다.
- Bug는 `main`의 배포 버전에서 발견되어 `hotfix/*`가 필요한 긴급 문제에만 사용합니다.
- 개발 중 발견한 결함은 Bug가 아니라 수정 Task로 등록합니다.

## 3. Jira 상태

```text
해야 할 일 -> 진행 중 -> 완료
```

- 작업과 브랜치를 시작하면 `진행 중`으로 변경합니다.
- MR 생성과 리뷰 중에도 `진행 중`을 유지합니다.
- MR 병합, 인수 조건 확인 및 결과물 등록이 모두 끝난 뒤 `완료`로 변경합니다.
- MR이 병합되었더라도 검증 자료가 없으면 완료하지 않습니다.

## 4. Jira 제목과 설명

### Task 제목

```text
[영역] 작업 목적
```

예시:

```text
[기획] 프로젝트 주제 및 핵심 기능 확정
[데이터] 후보별 데이터셋 품질 조사
[수집] 원천 데이터 적재 파이프라인 구현
[Spark] 일별 사용자 통계 집계
[인프라] EC2 Spark 클러스터 구성
[문서] 데이터 사전 작성
```

영역 후보는 다음과 같으며 기술 스택과 아키텍처에 따라 팀 합의로 추가하거나 제거할 수 있습니다.

```text
기획 데이터 수집 저장 Hadoop Spark 분석 ML 인프라 백엔드 프론트 테스트 문서
```

### Task 설명 템플릿

```markdown
## 목적
이 작업이 필요한 이유를 작성합니다.

## 작업 내용
- 구현하거나 조사할 내용을 작성합니다.

## 완료 조건
- [ ] 확인 가능한 완료 조건을 작성합니다.
- [ ] 결과물 또는 문서 위치를 작성합니다.

## 검증 방법
실행 명령, 테스트 방법 또는 리뷰 방법을 작성합니다.

## 관련 정보
- 선행 작업:
- 관련 문서:
- 데이터 또는 환경:
```

### Bug 설명 템플릿

```markdown
## 발생 환경

## 재현 방법

## 예상 결과

## 실제 결과

## 영향 범위

## 수정 및 검증 방법
```

## 5. Story Point

Story Point 산정 방식은 기능 명세가 나온 뒤 팀 회의에서 확정합니다. 다음 두 안을 후보로 유지하며 확정 전에는 Jira에 임의로 강제 적용하지 않습니다.

### 후보 A: 시간과 규모를 함께 사용하는 기준

| 점수 | 기준 |
| --- | --- |
| `1` | 매우 작고 명확하며 수 시간 이내에 끝낼 수 있습니다. |
| `2` | 작은 작업이며 영향 범위가 제한적입니다. |
| `3` | 일반적인 하루 단위 작업입니다. |
| `5` | 여러 파일 또는 구성요소에 영향을 주거나 불확실성이 있습니다. |
| `8` | 복잡한 통합·실험 작업이며 여러 날이 필요합니다. |

- `8`을 초과할 것으로 예상되는 작업은 여러 Task로 분리합니다.

### 후보 B: 상대 복잡도 기준

| 점수 | 기준 예시 |
| --- | --- |
| `1` | 문구, 작은 설정 또는 단일 조건 수정 |
| `2` | 영향 범위가 제한된 단일 로직 구현 |
| `3` | 단일 처리 기능 구현과 테스트 |
| `5` | 데이터 파이프라인 한 단계 또는 여러 구성요소 연동 |
| `8` | 여러 시스템을 연결하는 통합·실험 작업 |

후보 B는 시간 대신 구현 복잡도, 불확실성과 조사량, 테스트 및 연동 범위를 함께 고려합니다. 어느 안을 선택하든 `8`을 초과하는 작업은 분리하고, 의견이 다르면 가장 높은 점수를 제시한 팀원이 위험 요소를 설명한 뒤 다시 산정합니다.

## 6. Git Flow

### 영구 브랜치

| 브랜치 | 역할 |
| --- | --- |
| `main` | 최종 검증을 통과한 공식 릴리스 이력을 보관합니다. |
| `develop` | 기능과 문서 작업을 통합하는 기본 개발 브랜치입니다. |

### 임시 브랜치

| 브랜치 | 생성 기준 | 병합 대상 | 용도 |
| --- | --- | --- | --- |
| `feature/*` | `develop` | `develop` | 기능을 추가합니다. |
| `fix/*` | `develop` | `develop` | 개발 중 결함을 수정합니다. |
| `experiment/*` | `develop` | 필요 시 `develop` | 알고리즘과 성능을 실험합니다. |
| `chore/*` | `develop` | `develop` | 환경, 의존성 및 저장소 설정을 변경합니다. |
| `docs/*` | `develop` | `develop` | 문서, KPT 및 보고서를 작성합니다. |
| `release/*` | `develop` | `main`, 이후 `develop` | 버전별 통합 테스트와 안정화를 수행합니다. |
| `hotfix/*` | `main` | `main`, 이후 `develop` | 운영 버전의 긴급 문제를 수정합니다. |

```text
feature/fix/experiment/chore/docs
                 |
                 v
              develop
                 |
                 v
           release/v0.1.0
             /       \
            v         v
          main      develop
            |
            v
        tag v0.1.0
```

`main`과 `develop`만 영구 브랜치로 유지합니다. 임시 브랜치는 필요한 대상에 병합한 뒤 삭제합니다. `experiment/*`의 결과를 반영하지 않기로 결정한 경우에는 병합하지 않고 삭제할 수 있습니다.

## 7. 브랜치 이름

### 일반 작업

```text
<type>/<JIRA-KEY>-<area>-<short-description>
```

- Jira 키는 `S15P21C206-12`처럼 대문자를 유지합니다.
- 나머지는 영문 소문자와 하이픈을 사용합니다.
- 한글, 공백, 언더바, 팀원 이름 및 의미 없는 이름을 사용하지 않습니다.

예시:

```text
feature/S15P21C206-12-ingestion-load-source-data
feature/S15P21C206-18-spark-daily-aggregation
fix/S15P21C206-27-schema-handle-null-values
experiment/S15P21C206-31-performance-partition-count
chore/S15P21C206-6-infra-add-ec2-deployment
hotfix/S15P21C206-42-api-fix-health-check
release/v0.1.0
```

작업 영역은 다음 목록을 시작점으로 사용합니다.

```text
ingestion storage processing spark hadoop streaming schema pipeline analytics ml
infra monitoring performance data-quality api web test docs
```

- 새 영역이 필요하면 MR에서 추가 이유를 설명합니다.
- 기존 영역과 의미가 겹치면 새로 만들지 않습니다.
- 사용하지 않는 영역은 팀 합의 후 제거합니다.
- 기존 브랜치와 커밋 이름에는 변경된 목록을 소급 적용하지 않습니다.

### 문서 작업 예외

다음 문서만 Jira 키 없이 생성할 수 있습니다.

- 일일 KPT와 주간 보고서
- 요구사항 명세서
- Git·Jira 및 개발 컨벤션

```text
docs/<short-description>
```

```text
docs/add-git-jira-convention
docs/week-02-report
```

일일 KPT는 개인 브랜치를 만들지 않고 해당 주차의 공동 `docs/week-NN-report` 브랜치에서 작성합니다.

기능 명세, 데이터 사전, 아키텍처, API 명세처럼 특정 개발 Task의 산출물인 문서는 일반 규칙을 적용합니다.

```text
docs/S15P21C206-35-docs-data-dictionary
docs/S15P21C206-42-docs-spark-architecture
```

예외 문서는 브랜치, 커밋과 MR 제목의 Jira 키 필수 규칙에서 제외됩니다. 관련 Jira Task가 있다면 MR 설명에 링크를 기록합니다.

## 8. 작업 시작

```bash
git switch develop
git pull --ff-only origin develop
git switch -c feature/S15P21C206-12-spark-daily-aggregation
```

다른 작업으로 전환하기 전에 현재 변경 사항을 commit 또는 stash합니다.

## 9. 커밋 메시지

### 일반 작업

```text
<type>(<area>): <summary> [JIRA-KEY]
```

| 종류 | 용도 |
| --- | --- |
| `feat` | 기능을 추가합니다. |
| `fix` | 오류를 수정합니다. |
| `docs` | 문서를 추가하거나 수정합니다. |
| `test` | 테스트 코드와 검증 자료를 추가합니다. |
| `refactor` | 동작 변경 없이 구조를 개선합니다. |
| `perf` | 성능을 개선합니다. |
| `build` | 빌드와 의존성을 변경합니다. |
| `chore` | 환경, 도구 및 저장소 설정을 변경합니다. |

```text
feat(spark): add daily aggregation job [S15P21C206-18]
fix(schema): handle missing identifiers [S15P21C206-27]
perf(processing): reduce unnecessary shuffle [S15P21C206-31]
```

### 문서 작업 예외

```text
docs: <summary>
```

```text
docs: add git and Jira convention
docs: add week 02 report
docs: add 2026-08-25 백지웅 KPT
```

특정 Jira Task의 산출물인 문서는 일반 커밋 형식을 사용합니다.

```text
docs(docs): add data dictionary [S15P21C206-35]
```

한 커밋에는 하나의 논리적인 변경만 포함합니다.

## 10. Merge Request

### 일반 MR 제목

```text
[JIRA-KEY] 작업 요약
```

```text
[S15P21C206-18] 일별 데이터 집계 작업 추가
```

### docs MR 제목

```text
[Docs] 협업 컨벤션 수정
[Week 02] KPT 및 주간 보고서
```

변경 유형에 맞는 GitLab MR 템플릿을 사용합니다.

- [일반 기능 및 수정](../.gitlab/merge_request_templates/Default.md)
- [문서](../.gitlab/merge_request_templates/Docs.md)
- [데이터 파이프라인](../.gitlab/merge_request_templates/Data-Pipeline.md)
- [릴리스](../.gitlab/merge_request_templates/Release.md)

MR 생성 전 확인합니다.

- 일반 작업의 Jira 키가 브랜치, 커밋 및 MR 제목에 포함되어 있는가
- 변경 목적, 영향 범위와 검증 방법이 작성되어 있는가
- 비밀정보, 개인정보, 원본 데이터 또는 대용량 파일이 포함되지 않았는가
- 스키마나 설정 변경을 문서화했는가
- 필요한 승인 수와 CI 조건을 충족했는가

일반 작업 MR은 필요하면 Squash하여 병합하고 소스 브랜치를 삭제합니다. `release/*`와 `hotfix/*`는 브랜치 관계와 수정 이력을 보존하기 위해 Squash하지 않습니다.

GitLab 메시지 템플릿과 Jira 알림은 다음 A안으로 확정합니다.

```text
Merge commit message:  merge: %{title}
Squash commit message: squash: %{title}
```

상세 자동화는 [Jira-GitLab-Mattermost 자동화](jira-mattermost-automation.md)를 따릅니다.

## 11. Release

릴리스 후보 범위가 정해지면 최신 `develop`에서 생성합니다.

```bash
git switch develop
git pull --ff-only origin develop
git switch -c release/v0.1.0
git push -u origin release/v0.1.0
```

- 새로운 기능을 추가하지 않습니다.
- 통합 테스트, 릴리스 차단 결함 수정, 버전 조정과 릴리스 문서만 변경합니다.
- EC2 스테이징 환경에서 실제와 유사한 데이터 규모로 검증합니다.
- 테스트 결과와 포함된 Jira 작업을 릴리스 MR에 기록합니다.

완료 순서:

1. `release/vX.Y.Z -> main` MR을 병합합니다.
2. `main`의 릴리스 커밋에 `vX.Y.Z` tag를 남깁니다.
3. `release/vX.Y.Z -> develop` MR로 릴리스 중 수정 사항을 반영합니다.
4. 두 MR과 배포 검증 완료 후 release 브랜치를 삭제합니다.

```text
[Release v0.1.0] 1차 통합 버전 배포
```

릴리스 브랜치와 두 MR은 Jira 단일 MR 규칙의 예외이며 Squash하지 않습니다.

`release/* -> main` MR은 [Release 템플릿](../.gitlab/merge_request_templates/Release.md)의 완료 조건을 모두 확인하고 최소 2명의 승인을 받아야 합니다.

## 12. Hotfix

`main`의 배포 버전에서 긴급 문제가 발견되면 Jira Bug를 만들고 `main`에서 `hotfix/*`를 생성합니다.

1. `hotfix/* -> main` MR을 최소 1명의 승인 후 병합하고 patch tag를 남깁니다.
2. 같은 `hotfix/* -> develop` MR을 생성하고 최소 1명의 승인 후 병합합니다.
3. 진행 중인 `release/*`가 있으면 해당 브랜치에도 반영합니다.
4. 모든 반영이 끝난 뒤 hotfix 브랜치를 삭제합니다.

두 Hotfix MR은 `Jira Task 1개 = 브랜치 1개 = MR 1개` 원칙의 예외이며 Squash하지 않습니다. 별도 Hotfix 템플릿은 두지 않고 [일반 기능 및 수정 템플릿](../.gitlab/merge_request_templates/Default.md)을 사용하되, MR 설명에 발생 환경, 재현 방법, 영향 범위, 롤백 방법과 각 대상 브랜치의 검증 결과를 기록합니다.

## 13. KPT와 주간 보고서

보고서 전용 Jira Task는 만들지 않으며 문서 작업 예외를 사용합니다.

```text
docs/
├─ daily-report/
│  └─ YYYY-MM-DD/
│     └─ <이름>-kpt.md
└─ weekly-report/
   └─ week-NN.md
```

일일 회고는 KPT만 작성합니다.

```markdown
# YYYY-MM-DD KPT

## Keep

## Problem

## Try
```

- 각 팀원은 자신의 일일 KPT를 작성합니다.
- 주간 보고서는 주차별 담당자 한 명이 KPT와 Jira 완료 작업을 취합해 작성합니다.
- 주간 담당자는 팀에서 정한 순서로 교대합니다.

### 주차별 공동 브랜치 운영

KPT와 주간 보고서는 개인별 브랜치나 MR을 만들지 않습니다. 이 운영은 `Jira Task 1개 = 브랜치 1개 = MR 1개` 원칙의 명시적인 예외입니다. 한 주 동안 모든 팀원이 공동 `docs/week-NN-report` 브랜치 하나와 Draft MR 하나를 사용합니다. 같은 브랜치를 사용하되 각 팀원은 자신의 KPT 파일만 수정하고, `docs/weekly-report/week-NN.md`는 해당 주차 담당자만 수정합니다.

#### 월요일: 담당자가 공동 브랜치와 Draft MR 생성

주간 담당자는 최신 `develop`에서 해당 주차의 공동 브랜치를 생성해 원격 저장소에 올립니다.

```bash
git switch develop
git pull --ff-only origin develop
git switch -c docs/week-02-report
git push -u origin docs/week-02-report
```

GitLab에서 다음과 같이 Draft MR을 생성합니다.

```text
Source: docs/week-02-report
Target: develop
제목: Draft: [Week 02] KPT 및 주간 보고서
템플릿: Docs
```

#### 팀원: 공동 브랜치 참여

처음 참여할 때 원격 공동 브랜치를 받아 로컬 추적 브랜치를 만듭니다.

```bash
git fetch origin
git switch --track origin/docs/week-02-report
```

이미 로컬 브랜치가 있다면 해당 브랜치로 이동한 뒤 최신 변경을 받습니다.

```bash
git switch docs/week-02-report
git pull --rebase origin docs/week-02-report
```

#### 매일: 자신의 KPT만 작성하고 push

작업을 시작하기 전과 push 직전에 공동 브랜치의 최신 변경을 받습니다. 다른 팀원의 KPT와 주간 보고서 파일은 수정하지 않습니다.

```bash
git switch docs/week-02-report
git pull --rebase origin docs/week-02-report

# docs/daily-report/2026-08-25/백지웅-kpt.md 작성
git add docs/daily-report/2026-08-25/백지웅-kpt.md
git commit -m "docs: add 2026-08-25 백지웅 KPT"
git pull --rebase origin docs/week-02-report
git push origin docs/week-02-report
```

다른 팀원이 먼저 push하여 `non-fast-forward`로 거절되면 강제로 push하지 않고 최신 변경을 다시 받은 뒤 push를 재시도합니다.

```bash
git pull --rebase origin docs/week-02-report
git push origin docs/week-02-report
```

rebase 중 충돌이 발생하면 임의로 다른 팀원의 내용을 선택하지 않습니다. 자신의 변경만으로 안전하게 해결할 수 없다면 rebase를 중단하고 충돌 파일과 상황을 팀에 공유합니다.

```bash
git rebase --abort
```

#### 금요일: 담당자가 주간 보고서 작성 및 병합

담당자는 최신 공동 브랜치를 받은 뒤 각 팀원의 KPT와 Jira 완료 작업을 바탕으로 `docs/weekly-report/week-02.md`를 작성합니다.

```bash
git switch docs/week-02-report
git pull --rebase origin docs/week-02-report
git add docs/weekly-report/week-02.md
git commit -m "docs: add week 02 report"
git pull --rebase origin docs/week-02-report
git push origin docs/week-02-report
```

모든 팀원의 KPT와 주간 보고서가 포함되었는지 확인한 뒤 Draft를 해제합니다. 최소 1명의 승인을 받고 `develop`에 병합한 다음 공동 브랜치를 삭제합니다.

#### 공동 브랜치 필수 규칙

- 개인 KPT용 브랜치와 개인 MR을 별도로 만들지 않습니다.
- 각 팀원은 자신의 `<이름>-kpt.md` 파일만 수정합니다.
- `week-NN.md`는 해당 주차 담당자만 수정합니다.
- push 전에 항상 실제 주차 번호를 넣어 `git pull --rebase origin docs/week-NN-report`를 실행합니다. 예를 들어 2주차에는 `docs/week-02-report`를 사용합니다.
- 공동 브랜치에는 force push하지 않으며, 이미 push한 commit을 amend하거나 rebase해 다시 올리지 않습니다.
- 충돌이 발생하면 force push로 덮어쓰지 않습니다. 충돌 파일과 상황을 팀에 공유한 뒤 관련 작성자와 함께 해결합니다.
- 금요일 병합이 끝나기 전에는 공동 브랜치를 삭제하지 않습니다.

## 14. GitLab 설정

- 기본 브랜치를 `develop`으로 설정합니다.
- `main`, `develop`과 `release/*`를 Protected Branch로 지정합니다.
- Protected Branch의 직접 push를 금지하고 MR로만 병합합니다.
- `main` 병합 권한은 Maintainer로 제한합니다.
- 일반 MR은 최소 1명, `release/* -> main` MR은 최소 2명, `hotfix/* -> main`과 `hotfix/* -> develop` MR은 각각 최소 1명의 승인 규칙을 적용합니다.
- 일반 MR은 병합 후 소스 브랜치를 삭제합니다.
- `release/* -> main`과 `release/* -> develop` MR은 릴리스 담당자가 생성합니다.
- CI가 안정화되면 `Pipelines must succeed`를 활성화합니다.
- 리뷰가 끝나지 않은 변경을 막기 위해 `All threads must be resolved`를 활성화합니다.
- Squash 옵션은 `Allow`로 시작하고 운영 방식이 안정되면 `Encourage`를 검토합니다. `Require`는 사용하지 않습니다.

## 15. 변경 이력

### Draft 0.6 — 2026-08-25

- 공동 KPT 브랜치의 `non-fast-forward` 재시도와 rebase 충돌 중단 절차를 추가했습니다.
- Hotfix의 `main`, `develop` 대상 MR 모두 최소 1명의 승인과 Squash 금지를 적용했습니다.
- 공동 KPT 운영과 Hotfix의 두 MR 생성을 단일 브랜치·MR 원칙의 예외로 명시했습니다.
- 실험 브랜치의 미병합 삭제 조건과 KPT 커밋·MR 제목 예시를 실제 운영 방식에 맞게 정리했습니다.

### Draft 0.5 — 2026-08-25

- 개인 KPT 브랜치와 개인 MR을 만들지 않는 것으로 명확히 했습니다.
- 주차별 공동 `docs/week-NN-report` 브랜치와 Draft MR의 생성, 참여, 일일 push 및 금요일 병합 절차를 추가했습니다.
- 공동 브랜치의 파일 소유 범위, 최신화, force push 금지 및 충돌 대응 규칙을 추가했습니다.

### Draft 0.4 — 2026-08-25

- merge/squash 메시지를 A안으로 확정했습니다.
- MR 유형별 승인 수를 확정했습니다.
- Jira 키가 없는 문서 예외를 KPT, 보고서, 요구사항 명세서와 컨벤션으로 제한했습니다.
- 일일 KPT 경로를 `docs/daily-report/YYYY-MM-DD/<이름>-kpt.md`로 변경했습니다.
- Story Point 산정 후보 두 안을 기록했습니다.
- MR 템플릿을 일반, 문서, 데이터 파이프라인과 릴리스로 분리했습니다.

### Draft 0.3 — 2026-08-25

- Jira 구조를 `Epic -> Task`로 단순화했습니다.
- Bug를 Hotfix 상황으로 제한했습니다.
- Jira 상태를 세 단계로 단순화했습니다.
- Jira 제목, 설명과 Story Point 규칙을 추가했습니다.
- `docs/*`의 Jira 키 예외를 추가했습니다.
- KPT와 주간 보고서 규칙을 추가했습니다.
- 데이터, 개발 및 CI/CD 규칙을 별도 문서로 분리했습니다.
- GitLab MR 템플릿을 추가했습니다.
