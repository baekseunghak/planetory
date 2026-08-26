# Jira-GitLab-Mattermost 알림 자동화 초안

> 상태: Draft 0.2  
> 기준: 기존 프로젝트에서 확인한 Jira GitLab 연동 댓글 3종  
> 스쿼시 커밋 분기는 실제 댓글 원문을 확보한 뒤 확정합니다.

## 1. 목적

GitLab 활동이 Jira 이슈에 연결될 때 Jira가 생성하는 댓글을 감지하여 Mattermost에 전달합니다. 커밋, MR 및 병합 커밋은 서로 다른 이벤트로 표시합니다.

```text
GitLab 활동
   -> Jira GitLab 연동 댓글
   -> Jira Automation: Issue commented
   -> 댓글 종류 판별 및 값 추출
   -> Mattermost Incoming Webhook
```

이 자동화는 Jira의 Incoming Webhook 트리거가 아니라 `Issue commented` 또는 `Work item commented` 트리거를 사용합니다.

## 2. 확인된 Jira 댓글 형식

### 일반 커밋

```text
백지웅 mentioned this issue in a commit of s15-webmobile3-sub1 / C103 on branch feature/S15P11C103-99-keyboard-teleop:

feat(teleop): implement keyboard hand control S15P11C103-99: thing_teleop: 7논리축 키보드 제어 노드 구현
Done
```

### Merge Request

```text
백지웅 mentioned this issue in a merge request of s15-webmobile3-sub1 / C103 on branch feature/S15P11C103-99-keyboard-teleop:

S15P11C103-99: thing_teleop: 7논리축 키보드 제어 노드 구현
Done
7논리축 키보드 텔레옵 구현
```

### 병합 커밋

```text
이정빈 mentioned this issue in a commit of s15-webmobile3-sub1 / C103 on branch develop:

Merge branch 'feature/S15P11C103-99-keyboard-teleop' into 'develop'
```

위 내용은 기존 프로젝트의 GitLab 기본 메시지 사례입니다. 새 프로젝트에서는 병합 커밋이 Jira 댓글상 일반 커밋과 동일한 `in a commit` 유형으로 들어오는 점만 참고하고, 확정한 `merge:` 접두사로 구분합니다.

## 3. 메시지 컨벤션

새 프로젝트의 Jira 키는 `S15P21C206-#` 형식을 사용합니다.

### 일반 커밋

```text
<type>(<area>): <summary> [JIRA-KEY]
```

```text
feat(spark): add daily aggregation job [S15P21C206-18]
```

### MR 제목

```text
[JIRA-KEY] <summary>
```

```text
[S15P21C206-18] 일별 데이터 집계 작업 추가
```

### 병합 커밋

```text
merge: %{title}

Source: %{source_branch}
Target: %{target_branch}
See merge request %{reference}
```

### 스쿼시 커밋

GitLab의 `Squash commit message template`은 다음으로 확정합니다.

```text
squash: %{title}

Source: %{source_branch}
Target: %{target_branch}
See merge request %{reference}
```

MR 제목에 Jira 키를 포함하므로 merge와 squash 커밋의 첫 줄에도 Jira 키가 유지됩니다.

## 4. Automation 전체 구조

```text
Trigger: Issue commented
|
+- If: comment contains "mentioned this issue in a merge request"
|  +- MR 변수 생성
|  +- Mattermost: MR 연결 알림
|
+- Else-if: comment contains "mentioned this issue in a commit"
   +- 커밋 공통 변수 생성
   |
   +- If: commitMessage starts with "merge:"
   |  +- Mattermost: 병합 커밋 알림
   |
   +- Else-if: commitMessage starts with "squash:"
   |  +- Mattermost: 스쿼시 완료 알림
   |
   +- Else
      +- Mattermost: 일반 커밋 알림
```

MR 조건을 커밋 조건보다 먼저 검사합니다. `merge request` 댓글과 `commit` 댓글의 판별 문구가 현재는 겹치지 않지만, 구체적인 유형을 먼저 처리하면 규칙을 읽고 수정하기 쉽습니다.

## 5. 댓글 판별 조건

MR 분기:

```text
First value: {{comment.body.text}}
Condition: contains
Second value: mentioned this issue in a merge request
```

커밋 분기:

```text
First value: {{comment.body.text}}
Condition: contains
Second value: mentioned this issue in a commit
```

병합 커밋 하위 분기:

```text
First value: {{commitMessage}}
Condition: starts with
Second value: merge:
```

스쿼시 하위 분기:

```text
First value: {{commitMessage}}
Condition: starts with
Second value: squash:
```

## 6. 공통 변수

Jira Automation의 `Create variable` 작업으로 생성합니다.

### eventAuthor

```text
{{comment.body.text.match("(?m)^(.+?) mentioned this issue")}}
```

### repository

```text
{{comment.body.text.match("(?m)of (.+?) on branch")}}
```

### branchName

```text
{{comment.body.text.match("(?m)on branch (.+?):")}}
```

### eventTitle

콜론 다음의 빈 줄을 건너뛰고 첫 번째 내용 줄을 가져옵니다.

```text
{{comment.body.text.match("(?m)on branch .+?:\\r?\\n(?:\\r?\\n)*([^\\r\\n]+)")}}
```

커밋 분기에서는 같은 값을 읽기 쉽게 `commitMessage`라는 이름으로 만들어도 됩니다.

```text
{{comment.body.text.match("(?m)on branch .+?:\\r?\\n(?:\\r?\\n)*([^\\r\\n]+)")}}
```

MR 분기에서는 `mrTitle`이라는 이름을 사용합니다.

```text
{{comment.body.text.match("(?m)on branch .+?:\\r?\\n(?:\\r?\\n)*([^\\r\\n]+)")}}
```

`Done`과 그 아래 설명은 GitLab/Jira 상태에 따라 달라질 수 있으므로 Draft 0.1에서는 추출하지 않습니다.

## 7. Mattermost Webhook 공통 설정

```text
HTTP method: POST
Webhook body: Custom data
Content-Type: application/json
```

Webhook URL은 비밀정보로 취급합니다. 저장소, Jira 댓글, 문서 또는 화면 캡처에 실제 URL을 남기지 않습니다.

### 일반 커밋 payload

```json
{
  "username": "Jira GitLab Bot",
  "icon_emoji": ":jigsaw:",
  "text": "🧩 새로운 커밋이 Jira 작업에 연결되었습니다.\n\n🎫 **{{issue.key}} · {{issue.summary.jsonEncode}}**\n📌 Jira 상태: {{issue.status.name.jsonEncode}}\n👤 커밋 작성자: {{eventAuthor.jsonEncode}}\n📦 저장소: {{repository.jsonEncode}}\n🌿 브랜치: {{branchName.jsonEncode}}\n📝 변경: {{commitMessage.jsonEncode}}\n\n🔗 [Jira 작업 바로가기]({{issue.url.jsonEncode}})"
}
```

### MR payload

```json
{
  "username": "Jira GitLab Bot",
  "icon_emoji": ":twisted_rightwards_arrows:",
  "text": "🔀 Merge Request가 Jira 작업에 연결되었습니다.\n\n🎫 **{{issue.key}} · {{issue.summary.jsonEncode}}**\n📌 Jira 상태: {{issue.status.name.jsonEncode}}\n👤 MR 작성자: {{eventAuthor.jsonEncode}}\n📦 저장소: {{repository.jsonEncode}}\n🌿 소스 브랜치: {{branchName.jsonEncode}}\n📋 MR: {{mrTitle.jsonEncode}}\n\n🔗 [Jira 작업 바로가기]({{issue.url.jsonEncode}})"
}
```

현재 Jira 댓글 예시에는 대상 브랜치와 GitLab MR URL이 포함되어 있지 않습니다. 따라서 Jira 댓글만 파싱하는 이 자동화에서는 해당 정보를 안정적으로 표시할 수 없습니다.

### 병합 커밋 payload

```json
{
  "username": "Jira GitLab Bot",
  "icon_emoji": ":white_check_mark:",
  "text": "✅ GitLab 병합 커밋이 Jira 작업에 연결되었습니다.\n\n🎫 **{{issue.key}} · {{issue.summary.jsonEncode}}**\n📌 Jira 상태: {{issue.status.name.jsonEncode}}\n👤 병합 실행자: {{eventAuthor.jsonEncode}}\n📦 저장소: {{repository.jsonEncode}}\n🌿 대상 브랜치: {{branchName.jsonEncode}}\n📝 병합: {{commitMessage.jsonEncode}}\n\n🔗 [Jira 작업 바로가기]({{issue.url.jsonEncode}})"
}
```

### 스쿼시 payload

```json
{
  "username": "Jira GitLab Bot",
  "icon_emoji": ":package:",
  "text": "📦 Squash commit이 Jira 작업에 연결되었습니다.\n\n🎫 **{{issue.key}} · {{issue.summary.jsonEncode}}**\n📌 Jira 상태: {{issue.status.name.jsonEncode}}\n👤 병합 실행자: {{eventAuthor.jsonEncode}}\n📦 저장소: {{repository.jsonEncode}}\n🌿 대상 브랜치: {{branchName.jsonEncode}}\n📝 최종 변경: {{commitMessage.jsonEncode}}\n\n🔗 [Jira 작업 바로가기]({{issue.url.jsonEncode}})"
}
```

## 8. 먼저 Log action으로 검증

각 Webhook 앞에 임시 `Log action`을 추가합니다.

```text
type={{comment.body.text}}
author={{eventAuthor}}
repository={{repository}}
branch={{branchName}}
title={{eventTitle}}
```

테스트 결과에서 다음 값을 확인합니다.

- 일반 커밋의 `eventTitle`이 커밋 메시지 한 줄인가
- MR의 `eventTitle`이 MR 제목 한 줄인가
- 병합 커밋의 `eventTitle`이 `merge:`로 시작하는가
- 스쿼시 커밋의 `eventTitle`이 `squash:`로 시작하는가
- 한글, 콜론, 슬래시가 포함되어도 정상 추출되는가
- Windows 및 Unix 줄바꿈 모두 처리되는가

추출값 검증이 끝난 뒤 Mattermost Webhook 작업을 활성화합니다.

## 9. merge와 squash 운영 검증

1. 테스트 Jira 작업을 만듭니다.
2. Jira 키가 포함된 브랜치와 MR을 생성합니다.
3. MR 안에 커밋을 두 개 이상 추가합니다.
4. `Squash commits`를 선택하고 `develop`에 병합합니다.
5. Jira에 생성된 댓글 원문 전체를 복사합니다.
6. 작성자, 저장소, 브랜치와 첫 메시지 줄이 어떻게 표시되는지 확인합니다.
7. `commitMessage`가 `squash:`로 추출되고 스쿼시 분기로 들어가는지 확인합니다.
8. 별도의 비-Squash MR에서는 `commitMessage`가 `merge:`로 추출되는지 확인합니다.

확보할 때 Jira 화면에 보이는 날짜와 사용자 UI 라벨보다, `mentioned this issue ...`부터 시작하는 댓글 본문 원문이 중요합니다.

## 10. 알려진 제한사항

- Jira/GitLab 연동 언어 또는 버전이 바뀌면 영문 판별 문구와 정규식이 깨질 수 있습니다.
- MR 생성과 개별 커밋 push, 병합이 각각 댓글을 만들면 한 Jira 작업에 여러 Mattermost 알림이 발생합니다. 이는 서로 다른 개발 이벤트이므로 Draft 0.1에서는 정상 동작으로 간주합니다.
- 동일 댓글이 여러 번 생성되면 Jira Automation도 중복 실행될 수 있습니다.
- `Done`은 Jira 상태인지 GitLab MR 상태인지 댓글만으로 단정하지 않으므로 별도 변수로 사용하지 않습니다.
- GitLab MR 링크는 제공된 Jira 댓글에 없어 현재 payload에는 포함하지 않습니다.
- GitLab 템플릿이 변경되면 `merge:`와 `squash:` 판별 조건도 함께 변경해야 합니다.
