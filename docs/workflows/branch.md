# 브랜치 생성·전환 가이드

## 이 문서를 읽는 경우

`브랜치 만들어줘`, `최신 develop에서 분기해줘`, `브랜치 바꿔줘`, `브랜치 삭제해줘`

## 시작 전 확인

1. 현재 브랜치와 `git status`를 확인한다.
2. 변경이 있으면 사용자의 작업인지 확인하고 commit 또는 stash 없이 덮어쓰지 않는다.
3. 일반 작업은 최신 `develop`, Hotfix는 최신 `main`을 기준으로 한다.

## 이름과 기준 브랜치

| 유형 | 생성 기준 | 병합 대상 | 용도 |
| --- | --- | --- | --- |
| `feature/*` | `develop` | `develop` | 기능 추가 |
| `fix/*` | `develop` | `develop` | 개발 중 결함 수정 |
| `experiment/*` | `develop` | 필요 시 `develop` | 실험 |
| `chore/*` | `develop` | `develop` | 환경·도구·설정 |
| `docs/*` | `develop` | `develop` | 문서 |
| `release/*` | `develop` | `main`, 이후 `develop` | 릴리스 안정화 |
| `hotfix/*` | `main` | `main`, 이후 `develop` | 운영 긴급 수정 |

일반 형식은 `<type>/<JIRA-KEY>-<area>-<short-description>`이다. Jira 키는 대문자, 나머지는 영문 소문자와 하이픈을 사용한다.

영역은 `ingestion storage processing spark hadoop streaming schema pipeline analytics ml infra monitoring performance data-quality api web test docs`를 시작점으로 사용한다. 겹치는 영역을 새로 만들지 않으며 새 영역은 MR에 이유를 적는다.

```powershell
git switch develop
git pull --ff-only origin develop
git switch -c feature/S15P21C206-12-spark-daily-aggregation
```

## 문서 예외

일일 KPT·주간 보고서, 요구사항 명세서, Git·Jira 및 개발 컨벤션만 Jira 키 없는 `docs/<short-description>`를 허용한다. 특정 Task의 아키텍처·API·데이터 사전 같은 산출물은 `docs/S15P21C206-35-docs-data-dictionary`처럼 Jira 키를 포함한다.

공동 KPT 브랜치는 [보고서 가이드](reports.md)를 따른다. 브랜치 삭제, 강제 push와 이미 공유한 이력 재작성은 실행 전에 정확한 대상을 확인하고 필요한 승인을 받는다.
