# KPT 작성 가이드

## 이 문서를 읽는 경우

`KPT 작성해줘`, `팀원 회고 작성해줘`

## 문서 위치

```text
docs/daily-report/YYYY-MM-DD/<이름>-kpt.md
```

- `daily-report/`는 팀원별 KPT 전용 공간이다. 기술 결정과 문서 변경 이력은 [변경 이력](../changes/README.md)에 기록한다.
- 각 팀원은 자신의 KPT 파일만 수정한다.
- KPT 형식은 `Keep`, `Problem`, `Try` 세 절이다.

## 협업 안전 규칙

- 현재 Jira 작업과 브랜치 범위를 따른다. KPT만을 위해 별도 브랜치 정책을 만들지 않는다.
- 다른 팀원의 KPT를 덮어쓰거나 임의로 정리하지 않는다.
- 충돌이 나면 해당 파일 작성자와 확인하고 force push하지 않는다.

커밋과 MR이 필요하면 [커밋](commit.md)과 [MR](merge-request.md) 가이드를 따른다.
