# Mattermost 메시지 직접 전송

> 상태: 구현 완료, 실제 webhook 전송 미검증  
> 범위: 로컬 Codex 또는 PowerShell에서 프로젝트 Mattermost 채널로 메시지를 직접 보낸다.

## 이 문서를 읽는 경우

`mm에 보내줘`, `Mattermost에 보내줘`, `리뷰 요청 mm에 보내줘`, `특정 채널에 메시지 보내줘`

## 최초 설정

Mattermost에서 대상 채널용 Incoming Webhook을 만든 뒤 저장소 루트의 `.env`에 URL을 직접 입력한다. 실제 URL은 비밀정보이므로 대화, 문서, 커밋, 로그에 붙이지 않는다. `.env`는 Git에서 제외된다.

```text
MATTERMOST_WEBHOOK_URL=https://mattermost.example/hooks/replace-with-webhook-token
MATTERMOST_CHANNEL=
```

`MATTERMOST_CHANNEL`을 비우면 webhook에 지정된 기본 채널로 보낸다. 다른 채널로 재정의하려면 표시명이 아닌 채널 URL 이름을 입력한다. Mattermost 설정에 따라 webhook 생성자가 접근할 수 없는 채널로는 보낼 수 없다.

## 직접 실행

저장소 루트에서 다음 명령을 실행한다.

```powershell
.\scripts\send-mattermost.ps1 -Message '수집 검증이 완료되었습니다.'
```

특정 채널을 일회성으로 지정한다.

```powershell
.\scripts\send-mattermost.ps1 -Channel 'team-data' -Message '수집 검증이 완료되었습니다.'
```

네트워크 전송 없이 JSON만 확인한다.

```powershell
.\scripts\send-mattermost.ps1 -Message '전송 전 확인' -DryRun
```

성공하면 `PASS: Mattermost message sent.`를 출력한다. HTTP 오류는 숨기지 않고 실패로 반환한다.

## Codex 요청 규칙

사용자가 아래처럼 명시적으로 `보내줘`라고 요청하면 외부 메시지 전송을 승인한 것으로 보고 이 스크립트를 실행한다.

```text
다음 내용을 mm에 보내줘: 수집 검증이 완료됐어.
현재 MR 리뷰 요청을 mm에 보내줘.
이 내용을 team-data 채널에 Mattermost로 보내줘.
```

Codex는 다음 순서로 처리한다.

1. 일반 메시지는 사용자가 지정한 내용을 의미가 달라지지 않게 짧게 다듬는다.
2. `리뷰 요청`이면 현재 브랜치와 MR의 실제 제목·URL·검증 결과를 먼저 확인한다. 확인하지 못한 항목은 만들지 않고 생략하거나 미확인으로 적는다.
3. 대상 채널을 사용자가 지정하지 않았으면 `.env`의 `MATTERMOST_CHANNEL`, 그 값도 없으면 webhook 기본 채널을 사용한다.
4. webhook URL은 읽어서 전송에만 사용하며 출력, 인용, 문서화하지 않는다.
5. `보낼 문구 작성해줘`, `초안 만들어줘`처럼 작성만 요청한 경우에는 전송하지 않는다.
6. 실행 후 성공 또는 오류만 보고한다. URL과 응답에 포함될 수 있는 비밀값은 보고하지 않는다.

## 리뷰 메시지 컨벤션

`리뷰 요청 mm에 보내줘`, `리뷰 완료 mm에 보내줘`라고 요청하면 다음 한 줄 형식을 사용한다.

```text
<대상 멘션> <상태 이모지> <MR 번호> | [<Jira 키>] <간략한 요청 내용>
```

리뷰 요청은 `:merge_please:`, 리뷰 완료는 `:review_complete_shake:` 이모지를 사용한다.

```text
@dndwlqor :merge_please: !97 | [S15P21C206-75] 리뷰 부탁드립니당.
@yunsy :review_complete_shake: !102 | [S15P21C206-75] 리뷰 완료 했습니다.
```

Codex는 대상 멘션, MR 번호와 Jira 키를 현재 대화, 브랜치 및 MR에서 확인한다. 확인하지 못한 값은 추측해서 보내지 않고 사용자에게 필요한 값만 묻는다. 요청 내용은 한 줄로 간결하게 작성하며 코드 변경 요약이나 검증 상세는 사용자가 별도로 요청한 경우에만 덧붙인다.

일반적인 상세 리뷰 요청 메시지가 필요하다고 사용자가 명시한 경우에만 확인된 정보로 다음 형식을 사용한다.

```text
🔍 MR 리뷰 요청

- MR: <제목과 링크>
- Jira: <키와 링크>
- 주요 변경: <한두 줄>
- 검증: <실행해 통과한 검사>
- 확인 요청: <리뷰어가 중점 확인할 내용>
```

## 보안과 장애 처리

- `.env`와 실제 webhook URL을 Git에 추가하지 않는다. 공유가 필요하면 팀 비밀 저장소를 사용한다.
- 전송 전에 메시지에 토큰, 비밀번호, 개인정보, 내부 자격 증명이 없는지 확인한다.
- `401`, `403`, `404`는 URL·권한·webhook 활성 상태를 확인한다. URL 자체를 출력해 진단하지 않는다.
- 중복 전송을 막기 위해 실패 원인이 불명확한 요청은 자동 반복하지 않는다. Mattermost 채널에서 도착 여부를 확인한 뒤 재시도한다.
- 이 스크립트는 메시지 전송만 담당한다. Mattermost 게시글 수정·삭제·조회에는 REST API 또는 별도 도구가 필요하다.
