# 챌린지 회차 전환 런북

- 상태: 초안. 명령은 구현·통합 테스트 완료, 운영 서버 실행은 미검증
- Jira: [S15P21C206-139](https://ssafy.atlassian.net/browse/S15P21C206-139)
- 상위 정본: [탐사 API 9.4절](../../apps/backend/docs/exploration-api-spec.md), [요구사항 OPS-07·CHL-03](../requirements/planetory-requirements-spec.md)

운영자가 새 주간 챌린지 회차를 시작할 때 따르는 절차다. 회차 설정은 운영 화면 없이 DB에서 직접 바꾸므로(OPS-07) 앱은 전환 순간을 알지 못한다. 회차를 `active`로 바꾼 뒤 아래 명령을 실행해야 튜토리얼 5개를 끝낸 회원이 그 회차 별을 받는다. 명령을 실행하지 않으면 기존 완료 회원은 아무도 받지 않는다.

회차 진행 중에 튜토리얼 5번을 끝내는 회원은 명령과 관계없이 그 시점에 받는다.

## 실행 주기

정기 실행하지 않는다. 회차를 `active`로 바꿀 때마다 한 번 실행한다. 여러 번 실행해도 회원마다 한 번만 열리므로, 결과가 불확실하면 다시 실행한다.

## 1. 회차 전환

- 대상 별 조건(미확정·AI 승인)은 이 명령이 검증하지 않는다. 회차 행을 저장할 때 확인한다.
- `active` 회차는 하나만 둘 수 있다(`uq_challenge_rounds_active`). 진행 중인 회차를 `closed`로 바꾼 뒤 새 회차를 `active`로 바꾼다.
- DB 변경은 [운영 문서](README.md)의 원칙대로 대상과 영향을 확인하고 승인받은 뒤 실행한다.

```sql
BEGIN;
UPDATE challenge_rounds SET status = 'closed' WHERE status = 'active';
UPDATE challenge_rounds SET status = 'active' WHERE round_no = :new_round_no AND status = 'planned';
COMMIT;
```

## 2. 명령 실행

백엔드 jar에 `--planetory.command=challenge-unlock` 인자를 준다. 웹 서버를 띄우지 않고 한 번 실행한 뒤 종료하므로 서버가 떠 있는 호스트에서 실행해도 포트가 겹치지 않는다. DB 접속은 서버와 같은 환경 변수(`DATABASE_URL`, `DATABASE_USER`, `DATABASE_PASSWORD`)를 쓴다.

```powershell
java -jar app.jar --planetory.command=challenge-unlock
```

EC2 서비스 이미지는 진입점이 `java -jar /app/app.jar`이므로 [서비스 Compose](../../infra/service/compose.yaml)의 `backend` 서비스에 인자를 이어 붙일 수 있다. 배포 job과 같은 위치·`.env`에서 EC2 한 대에서만 실행한다. 이 형태는 아직 서버에서 실행해 보지 않았다.

```powershell
docker compose run --rm backend --planetory.command=challenge-unlock
```

## 3. 결과 확인

| 종료 코드 | 뜻 | 조치 |
| --- | --- | --- |
| 0 | 처리 완료 | 로그의 회원 수를 확인한다 |
| 2 | 진행 회차 없음. 아무것도 바꾸지 않았다 | 1단계를 확인하고 다시 실행한다 |
| 1 | 처리 중 오류 | 원인을 고친 뒤 다시 실행한다. 회원마다 커밋하므로 이미 받은 회원은 건너뛴다 |

완료 로그는 `챌린지 회차 {회차}(id {id}) 대상 별 {TIC}: 새로 연 회원 N명, 건너뛴 회원 M명` 한 줄이다. 건너뛴 회원은 목록을 읽은 뒤 처리 전에 이미 별을 받았거나 탈퇴한 회원이다.

처리 도중 회차가 `active`에서 벗어나면 남은 회원에게 열지 않고 1로 끝난다. 끝난 회차의 별을 계속 열지 않기 위해서다.

## 하지 않는 일

- 새 회차 알림 발송(NTF-01, P1)과 회차 종료 처리
- 이미 연 별 닫기. 회차가 끝나도 발견한 별은 남는다(AT-61)
- 대상 별을 이미 다른 경로(성과 발견 등)로 발견한 회원의 기록 바꾸기. 이 회원은 건너뛰고 처음 발견 경로를 유지한다. 빨간 느낌표는 퀘스트 응답의 진행 회차 대상 별로 그리므로 이 회원에게도 그대로 보인다
