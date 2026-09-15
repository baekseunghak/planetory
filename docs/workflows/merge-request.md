# Merge Request 작성·생성 가이드

## 이 문서를 읽는 경우

`MR 작성해줘`, `MR 메시지 만들어줘`, `MR 생성해줘`, `리뷰 준비해줘`, `병합해줘`

## 실행 경계

- “MR 내용·메시지 작성” 요청이면 복사할 제목과 본문만 제공한다.
- “MR 생성”을 명시한 경우에만 원격 MR을 만든다. 병합은 별도의 명시적 요청과 승인 조건 확인이 필요하다.

## 제목과 Jira 연결

일반 MR 제목은 `[JIRA-KEY] 작업 요약`이다. Jira 키 예외 문서는 `[Docs] 작업 요약`, 공동 보고서는 `[Week NN] KPT 및 주간 보고서`, 릴리스 MR은 `[Release vX.Y.Z] 요약`을 사용한다.

- 대표 Jira Task 하나만 평문으로 작성한다. Jira 키 예외 문서 MR에 대표 Task가 없으면 `대표 Jira: 없음`으로 적고 언급할 키는 모두 참고 Jira로 둔다.
- 참고 Jira 키는 `` `S15P21C206-28` ``처럼 백틱으로 감싸 자동 연결을 막는다.
- `Closes`, `Fixes`, `Resolves`에는 이 MR이 실제 완료하는 대표 Task만 적는다.
- 참고 Jira에 전체 Jira URL을 함께 적지 않는다. 링크 주소 안의 평문 키도 자동 연결 대상으로 인식될 수 있다.
- 릴리스 MR처럼 여러 Jira 작업에 의도적으로 연결해야 하는 경우에만 연결할 키를 평문으로 적는다.

```text
대표 Jira: S15P21C206-35
참고 Jira: `S15P21C206-26`

Closes S15P21C206-35
```

## 템플릿과 검수

- 일반 기능·수정: [Default](../../.gitlab/merge_request_templates/Default.md)
- 문서: [Docs](../../.gitlab/merge_request_templates/Docs.md)
- 데이터 파이프라인: [Data-Pipeline](../../.gitlab/merge_request_templates/Data-Pipeline.md)
- 릴리스: [Release](../../.gitlab/merge_request_templates/Release.md)

MR에는 목적, 주요 변경, 영향 범위, 검증 방법·실제 결과, 문서 갱신, 롤백 또는 미확정 사항을 구체적으로 작성한다. 일반 MR과 문서 MR은 최소 1명의 비작성자 승인을 받는다. `release/* → main`은 최소 2명, Hotfix의 `main`·`develop` MR은 각각 최소 1명이다.

일반 MR은 필요하면 Squash하고 병합 후 소스 브랜치를 삭제한다. Release와 Hotfix는 Squash하지 않는다. 상세 알림 동작은 [Jira 자동화](jira-mattermost-automation.md)를 따른다.

GitLab 메시지는 `merge: %{title}`, `squash: %{title}` 형식을 사용한다.
