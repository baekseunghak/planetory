# KPT·주간 보고서 가이드

## 이 문서를 읽는 경우

`KPT 작성해줘`, `팀원 회고 작성해줘`, `주간 보고서 작성해줘`, `주차 공동 브랜치 만들어줘`

## 문서 위치

```text
docs/
├─ daily-report/
│  └─ YYYY-MM-DD/
│     └─ <이름>-kpt.md
└─ weekly-report/
   └─ week-NN.md
```

- `daily-report/`는 팀원별 KPT 전용 공간이다. 기술 결정과 문서 변경 이력은 [변경 이력](../changes/README.md)에 기록한다.
- 일일 회고는 KPT만 작성하며 형식은 `Keep`, `Problem`, `Try` 세 절이다.
- 각 팀원은 자신의 KPT 파일만 수정한다.
- 주간 보고서는 주차 담당자 한 명이 팀원 KPT와 Jira 완료 작업을 취합해 작성하고, 담당자는 팀에서 정한 순서로 교대한다.
- 보고서 전용 Jira Task는 만들지 않고 [브랜치 가이드](branch.md)의 문서 작업 예외를 사용한다.

## 주차별 공동 브랜치 운영

KPT와 주간 보고서는 개인 브랜치나 개인 MR을 만들지 않는다. 이 운영은 `Jira Task 1개 = 브랜치 1개 = MR 1개` 원칙의 명시적인 예외다. 한 주 동안 모든 팀원이 공동 `docs/week-NN-report` 브랜치 하나와 Draft MR 하나를 사용한다. 같은 브랜치를 쓰되 각 팀원은 자신의 KPT 파일만, `docs/weekly-report/week-NN.md`는 해당 주차 담당자만 수정한다.

### 월요일: 담당자가 공동 브랜치와 Draft MR 생성

주차 담당자는 최신 `develop`에서 해당 주차의 공동 브랜치를 만들어 원격에 올린다.

```powershell
git switch develop
git pull --ff-only origin develop
git switch -c docs/week-02-report
git push -u origin docs/week-02-report
```

GitLab에서 Draft MR을 만든다.

```text
Source: docs/week-02-report
Target: develop
제목: Draft: [Week 02] KPT 및 주간 보고서
템플릿: Docs
```

### 팀원: 공동 브랜치 참여

처음 참여할 때 원격 공동 브랜치를 받아 로컬 추적 브랜치를 만든다.

```powershell
git fetch origin
git switch --track origin/docs/week-02-report
```

이미 로컬 브랜치가 있으면 해당 브랜치로 이동한 뒤 최신 변경을 받는다.

```powershell
git switch docs/week-02-report
git pull --rebase origin docs/week-02-report
```

### 매일: 자신의 KPT만 작성하고 push

작업 시작 전과 push 직전에 공동 브랜치의 최신 변경을 받는다. 다른 팀원의 KPT와 주간 보고서 파일은 수정하지 않는다. 커밋 메시지는 Jira 키 예외 형식인 `docs: <summary>`를 사용한다.

```powershell
git switch docs/week-02-report
git pull --rebase origin docs/week-02-report

# docs/daily-report/2026-08-25/백지웅-kpt.md 작성
git add docs/daily-report/2026-08-25/백지웅-kpt.md
git commit -m "docs: add 2026-08-25 백지웅 KPT"
git pull --rebase origin docs/week-02-report
git push origin docs/week-02-report
```

다른 팀원이 먼저 push해 `non-fast-forward`로 거절되면 강제로 push하지 않고 최신 변경을 다시 받은 뒤 재시도한다.

```powershell
git pull --rebase origin docs/week-02-report
git push origin docs/week-02-report
```

rebase 중 충돌이 나면 임의로 다른 팀원의 내용을 선택하지 않는다. 자신의 변경만으로 안전하게 해결할 수 없으면 rebase를 중단하고 충돌 파일과 상황을 팀에 공유한다.

```powershell
git rebase --abort
```

### 금요일: 담당자가 주간 보고서 작성 및 병합

담당자는 최신 공동 브랜치를 받은 뒤 각 팀원의 KPT와 Jira 완료 작업을 바탕으로 `docs/weekly-report/week-02.md`를 작성한다.

```powershell
git switch docs/week-02-report
git pull --rebase origin docs/week-02-report
git add docs/weekly-report/week-02.md
git commit -m "docs: add week 02 report"
git pull --rebase origin docs/week-02-report
git push origin docs/week-02-report
```

모든 팀원의 KPT와 주간 보고서가 포함되었는지 확인한 뒤 Draft를 해제한다. 최소 1명의 승인을 받아 `develop`에 병합하고 공동 브랜치를 삭제한다.

## 공동 브랜치 필수 규칙

- 개인 KPT용 브랜치와 개인 MR을 별도로 만들지 않는다. KPT만을 위한 별도 브랜치 정책도 만들지 않는다.
- 각 팀원은 자신의 `<이름>-kpt.md` 파일만 수정하고 다른 팀원의 KPT를 덮어쓰거나 임의로 정리하지 않는다.
- `week-NN.md`는 해당 주차 담당자만 수정한다.
- push 전에 항상 실제 주차 번호를 넣어 `git pull --rebase origin docs/week-NN-report`를 실행한다. 2주차는 `docs/week-02-report`를 사용한다.
- 공동 브랜치에는 force push하지 않으며 이미 push한 commit을 amend하거나 rebase해 다시 올리지 않는다.
- 충돌이 나면 force push로 덮어쓰지 않고 충돌 파일과 상황을 공유한 뒤 해당 파일 작성자와 함께 해결한다.
- 금요일 병합이 끝나기 전에는 공동 브랜치를 삭제하지 않는다.
- 비밀정보, 개인정보와 원본 데이터를 기록하지 않는다.

MR 제목과 템플릿은 [MR 가이드](merge-request.md), 커밋 형식은 [커밋 가이드](commit.md)를 따른다.
