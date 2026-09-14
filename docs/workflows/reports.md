# KPT·주간 보고서 가이드

## 이 문서를 읽는 경우

`KPT 작성해줘`, `주간 보고서 만들어줘`, `공동 보고서 브랜치 참여해줘`

## 문서와 브랜치

```text
docs/daily-report/YYYY-MM-DD/<이름>-kpt.md
docs/weekly-report/week-NN.md
```

- 보고서 전용 Jira Task와 개인별 브랜치·MR을 만들지 않는다.
- 한 주 동안 공동 `docs/week-NN-report` 브랜치와 Draft MR 하나를 사용한다.
- 각 팀원은 자신의 KPT만, 주간 담당자는 `week-NN.md`만 수정한다.
- KPT 형식은 `Keep`, `Problem`, `Try` 세 절이다.

## 공동 브랜치 안전 규칙

- 작업 전과 push 직전에 `git pull --rebase origin docs/week-NN-report`로 최신화한다.
- 다른 팀원이 먼저 push했으면 force push하지 않고 다시 pull한 뒤 재시도한다.
- 공유 브랜치에서 이미 push한 commit을 amend하거나 rebase해 다시 올리지 않는다.
- 충돌을 자신의 변경만으로 해결할 수 없으면 `git rebase --abort` 후 파일과 상황을 작성자에게 공유한다.
- 금요일에 전체 KPT와 보고서를 확인하고 최소 1명의 승인 후 `develop`에 병합한 다음 브랜치를 삭제한다.

커밋은 `docs: add YYYY-MM-DD <이름> KPT`, MR은 `Draft: [Week NN] KPT 및 주간 보고서` 형식을 사용한다.
