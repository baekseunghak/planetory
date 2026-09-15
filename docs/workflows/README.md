# 워크플로 문서 안내

> 버전: Draft 0.8<br>
> Jira 프로젝트 키: `S15P21C206`

이 문서는 Jira·Git·개발·문서 요청의 공통 규칙과 상황별 가이드 진입점이다. 에이전트는 아래 표에서 현재 요청에 해당하는 가이드만 읽고, 관련 없는 가이드를 미리 불러오지 않는다.

## 핵심 규칙

- Jira가 작업 관리의 정본이다. 같은 작업을 GitLab Issue에 중복 등록하지 않는다.
- 일반 작업은 `Jira Task 1개 = 브랜치 1개 = MR 1개`로 관리한다. Release, Hotfix와 공동 보고서는 해당 가이드의 예외를 따른다.
- `main`과 `develop`에는 직접 push하지 않고 MR로 반영한다.
- 일반 MR과 문서 MR은 최소 1명의 비작성자 승인을 받는다.
- 비밀번호, API 키, 자격 증명, 개인정보, 원본 데이터와 대용량 결과 파일을 커밋하지 않는다.
- 사용자가 “내용·메시지 작성”을 요청하면 복사할 문안만 제공한다. 생성, commit, push, MR 병합과 상태 변경은 명시적으로 요청된 경우에만 실행한다.
- 요청 범위 밖의 파일과 기존 변경을 stage, 수정, 삭제하거나 되돌리지 않는다.

## 입력 → 참조 매칭

| 사용자 입력 예시 | 작업 유형 | 읽을 가이드 |
| --- | --- | --- |
| 티켓·이슈·Task 만들어줘 | Jira Task | [Jira Task·Bug](jira-task.md) |
| Bug 등록해줘, Jira 상태 바꿔줘 | Jira Bug·상태 | [Jira Task·Bug](jira-task.md) |
| 에픽 만들어줘, 작업을 묶어줘 | Jira Epic | [Jira Epic](jira-epic.md) |
| 브랜치 만들어줘, 최신 develop에서 분기해줘 | Git 브랜치 | [브랜치](branch.md) |
| 기능 만들어줘, 버그 고쳐줘, 설정 바꿔줘 | 개발 | [기능·수정 작업](development.md) |
| 문서 찾아줘, 만들거나 수정·이동·삭제해줘 | 문서 | [문서 생명주기](documentation.md) |
| 왜 바뀌었어, 이전 판단 찾아줘, 변경 이력 남겨줘 | 변경 이력 | [변경 이력 규칙](../changes/README.md) |
| 커밋 메시지 작성해줘, 커밋해줘 | Git 커밋 | [커밋](commit.md) |
| MR 내용 작성해줘, MR 생성·병합해줘 | Merge Request | [MR](merge-request.md) |
| 릴리스·Hotfix 준비해줘 | Release·Hotfix | [Release·Hotfix](release-hotfix.md) |
| 팀원 KPT 작성해줘, 주간 보고서 써줘, 주차 공동 브랜치 만들어줘 | KPT·주간 보고서 | [KPT·주간 보고서](reports.md) |
| Jira 알림·Mattermost 자동화 수정해줘 | 자동화 | [Jira-GitLab-Mattermost 자동화](jira-mattermost-automation.md) |
| 자주 쓰는 명령 알려줘, 이 절차 또 해줘 | 반복 절차 | [반복 절차 모음](routines.md) |

하나의 요청이 여러 단계라면 현재 단계의 가이드부터 읽고 다음 행동이 필요할 때만 다음 가이드를 읽는다. 예를 들어 “기능 구현 후 커밋해줘”는 `기능·수정 작업 → 커밋` 순서다.

## 공통 흐름

```text
Jira 범위 확인
→ 목적별 정본 참조
→ 현재 코드·호출 경로 확인
→ 최소 범위 변경
→ 검증
→ 관련 문서와 필요한 변경 이력 갱신
→ 요청받은 경우에만 commit·push·MR
```

기술 주제별 정본은 [문서 인덱스](../README.md), 저장소 전체 안전 규칙은 [AGENTS.md](../../AGENTS.md)를 따른다. 서로 충돌하면 임의로 해결하지 않고 파일·항목과 실제 상태를 함께 보고한다.

## GitLab 저장소 설정

- 기본 브랜치는 `develop`으로 둔다.
- `main`, `develop`, `release/*`는 Protected Branch로 지정하고 직접 push를 금지한다.
- `main` 병합 권한은 Maintainer로 제한한다.
- CI가 안정화되면 `Pipelines must succeed`, 리뷰 정책에는 `All threads must be resolved`를 적용한다.
- Squash는 `Allow`로 시작하고 운영이 안정되면 `Encourage`를 검토한다. `Require`는 사용하지 않으며 Release와 Hotfix는 Squash하지 않는다.
