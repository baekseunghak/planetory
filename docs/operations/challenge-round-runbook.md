# 챌린지 별 등록·회차 전환 런북

- 상태: 초안. 명령·Gold 캐시는 구현·격리 검증 완료, 운영 서버 실행은 미검증
- Jira: [S15P21C206-139](https://ssafy.atlassian.net/browse/S15P21C206-139) 회차 전환, [S15P21C206-260](https://ssafy.atlassian.net/browse/S15P21C206-260) Gold 읽기 캐시, [S15P21C206-263](https://ssafy.atlassian.net/browse/S15P21C206-263) 운영 용량·지연 실측
- 상위 정본: [탐사 API 9.4절](../../apps/backend/docs/exploration-api-spec.md), [요구사항 OPS-07·CHL-03](../requirements/planetory-requirements-spec.md)

운영자가 새 주간 챌린지 회차를 등록하고 시작할 때 따르는 절차다. 등록은 운영 화면·API 없이 DB의 `challenge_rounds`에 직접 넣는다(OPS-07). **현재 한 회차의 대상 별은 1개**다. Redis 사전 적재를 예상하는 5개 또는 10개는 캐시 대상 규모이며, 회차당 별 개수가 아니다. 챌린지 등록과 Redis 대상 지정은 별도 작업이다.

회차를 `active`로 바꾼 뒤 아래 명령을 실행해야 튜토리얼 5개를 끝낸 회원이 그 회차 별을 받는다. 명령을 실행하지 않으면 기존 완료 회원은 아무도 받지 않는다.

회차 진행 중에 튜토리얼 5번을 끝내는 회원은 명령과 관계없이 그 시점에 받는다.

## 실행 주기

정기 실행하지 않는다. 회차를 `active`로 바꿀 때마다 한 번 실행한다. 여러 번 실행해도 회원마다 한 번만 열리므로, 결과가 불확실하면 다시 실행한다.

## 0. 회차 등록과 Redis 사전 적재 준비

1. 운영자가 `round_no`, 기간, 한 줄 설명과 대상 TIC를 확정한다. 아래 SQL의 `:...`는 실행 전 DB 클라이언트에서 실제 값으로 바꾸는 자리표시자다. 대상 별이 공개 상태이고 current Gold 판·원본 주기도가 있는지 먼저 확인한다. 공개 상태와 기간은 DB도 검사하지만 미확정·AI 승인 조건은 운영자가 별도로 확인한다.

```sql
SELECT s.tic_id, s.service_status, b.id AS current_bundle_id,
       (p.bundle_id IS NOT NULL) AS periodogram_ready
  FROM stars s
  LEFT JOIN publication_bundles b ON b.tic_id = s.tic_id AND b.status = 'current'
  LEFT JOIN periodograms p ON p.bundle_id = b.id
 WHERE s.tic_id = :target_tic_id;
```

2. 대상·기간·회차 번호를 확인하고, DB 변경 승인을 받은 뒤 `planned` 회차를 등록한다. `round_no`는 중복될 수 없다. 이 단계에서는 회원에게 별을 열지 않는다.

```sql
INSERT INTO challenge_rounds
    (round_no, starts_on, ends_on, target_tic_id, description, status)
VALUES (:new_round_no, :starts_on, :ends_on, :target_tic_id, :description, 'planned');
```

3. 이 별을 Redis에서 우선 읽게 하려면 배포 위치의 `.env`에 아래 두 값을 설정하고 승인된 Backend 재시작 절차를 실행한다. TIC 목록은 운영자가 선택한 사전 적재 대상 전체이며, 새 회차를 등록해도 자동으로 갱신되지 않는다. 실제 목록이 정해지지 않았다면 캐시를 비활성으로 두어도 챌린지 분석은 DB로 동작한다. 비지정 별도 DB에서 분석할 수 있다.

```text
GOLD_CACHE_ENABLED=true
GOLD_CACHE_TIC_IDS=<TARGET_TIC_ID>,<OTHER_TIC_ID>
```

설정 위치·128mb 임시 용량·Redis 장애 시 DB 복구는 [서비스 Redis 운영](../../infra/service/README.md#세션캐시-redis)을 따른다. 변경된 환경변수는 이미 실행 중인 Backend에 바로 반영되지 않는다. 운영 데이터와 캐시 용량을 확인하지 않고 5개 또는 10개를 한꺼번에 활성화하지 않는다.
시작 시 한 별의 사전 적재가 실패해도 Backend는 기동하고 다른 지정 별의 적재를 시도한다. DB 데이터가 정상이라면 실패한 별은 다음 분석 요청에서 DB를 읽어 캐시를 다시 채운다.

```powershell
# 배포 위치의 compose.yaml·.env에서, 승인된 Backend 재시작 시 실행한다.
docker compose up -d --no-deps backend
```

4. 재시작 뒤 Backend 로그의 `Gold 기동 사전 적재 종료`에서 시도 개수와 소요 시간을 확인하고, 배포 헬스 대기 한계(기본 90초) 안에 준비됐는지 기록한다. 실제 TIC 목록과 개수별 기동 시간·응답 지연은 [S15P21C206-263](https://ssafy.atlassian.net/browse/S15P21C206-263)에서 측정한다. current 판의 두 Redis 키도 확인한다. 아래 조회가 `segments_key`·`periodogram_key`를 출력한다. 두 키가 모두 있으면 `EXISTS`가 `2`를 반환한다. Redis가 비거나 키가 축출됐어도 분석 API는 DB로 조회해 다시 채운다. `used_memory`·`used_memory_rss`·`evicted_keys`도 확인해 선택한 별이 128mb 안에 유지되는지 측정한다.

```sql
SELECT 'planetory:gold:v1:segments:' ||
       (SELECT string_agg(seg.id, '-' ORDER BY seg.id::bigint)
          FROM jsonb_array_elements_text(b.manifest->'segment_ids') AS seg(id)) AS segments_key,
       'planetory:gold:v1:bundle' || b.id || ':periodogram' AS periodogram_key
  FROM publication_bundles b
 WHERE b.tic_id = :target_tic_id AND b.status = 'current';
```

EC2-A의 Bash 셸에서 조회한 키를 대입해 확인한다.

```bash
segmentKey='<SQL에서 조회한 segments_key>'
periodogramKey='<SQL에서 조회한 periodogram_key>'
docker compose exec cache-redis redis-cli EXISTS "$segmentKey" "$periodogramKey"
docker compose exec cache-redis redis-cli INFO memory
docker compose exec cache-redis redis-cli INFO stats
```

## 1. 회차 전환

- 대상 별이 공개(`published`)되지 않았거나 기간이 뒤집힌 회차 행은 DB가 저장할 때 거절한다([운영 규칙 변경 런북](operation-rule-runbook.md) 5절). 미확정·AI 승인 조건은 DB도 이 명령도 검증하지 않으므로 회차 행을 넣기 전에 확인한다.
- `active` 회차는 하나만 둘 수 있다(`uq_challenge_rounds_active`). 진행 중인 회차를 `closed`로 바꾼 뒤 새 회차를 `active`로 바꾼다.
- DB 변경은 [운영 문서](README.md)의 원칙대로 대상과 영향을 확인하고 승인받은 뒤 실행한다.

```sql
BEGIN;
SELECT id, target_tic_id FROM challenge_rounds
 WHERE round_no = :new_round_no AND status = 'planned' FOR UPDATE;
UPDATE challenge_rounds SET status = 'closed'
 WHERE status = 'active'
   AND EXISTS (SELECT 1 FROM challenge_rounds
                WHERE round_no = :new_round_no AND status = 'planned');
UPDATE challenge_rounds SET status = 'active'
 WHERE round_no = :new_round_no AND status = 'planned'
 RETURNING round_no, target_tic_id, status;
COMMIT;
```

마지막 `UPDATE`가 한 행을 반환하는지 확인한다. 반환이 없으면 새 회차가 활성화되지 않은 것이므로 원인을 확인한다. 새 `planned` 행이 없을 때는 위 조건 때문에 기존 active 회차도 닫지 않는다.

V23 적용 이후 최초 active 전환은 DB 트리거가 시작 경계와 당시 튜토리얼 완료 회원의 알림 수신 의도를 함께 저장한다. 전환 롤백은 알림도 롤백한다. 이미 대상 별을 가진 회원도 알림 대상이며 늦은 자격 취득자는 소급하지 않는다. 기존 active/closed는 비소급 표시하고 같은 회차 재활성화·설명 편집은 새 사건을 만들지 않는다. 실제 운영 적용은 미실행이다.

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

회차가 실제로 `active`가 됐고 대상 TIC가 의도한 값인지 먼저 조회한다. Redis 설정 여부는 회차 상태를 바꾸지 않는다.

```sql
SELECT round_no, target_tic_id, starts_on, ends_on, status
  FROM challenge_rounds
 WHERE round_no = :new_round_no;
```

| 종료 코드 | 뜻 | 조치 |
| --- | --- | --- |
| 0 | 처리 완료 | 로그의 회원 수를 확인한다 |
| 2 | 진행 회차 없음. 아무것도 바꾸지 않았다 | 1단계를 확인하고 다시 실행한다 |
| 1 | 처리 중 오류 | 원인을 고친 뒤 다시 실행한다. 회원마다 커밋하므로 이미 받은 회원은 건너뛴다 |
| 64 | 명령 인자 오류(알 수 없는 이름·빈 값·인자 두 번). 서버를 띄우지 않아 DB에도 접속하지 않았다 | 출력된 이유를 보고 `--planetory.command=challenge-unlock` 하나로 다시 실행한다 |

완료 로그는 `챌린지 회차 {회차}(id {id}) 대상 별 {TIC}: 새로 연 회원 N명, 건너뛴 회원 M명` 한 줄이다. 건너뛴 회원은 목록을 읽은 뒤 처리 전에 이미 별을 받았거나 탈퇴한 회원이다.

처리 도중 회차가 `active`에서 벗어나면 남은 회원에게 열지 않고 1로 끝난다. 끝난 회차의 별을 계속 열지 않기 위해서다.

Redis 설정에 문제가 생기면 대상 TIC를 `GOLD_CACHE_TIC_IDS`에서 빼거나 `GOLD_CACHE_ENABLED=false`로 바꾸고 승인된 Backend 재시작 절차를 다시 실행한다. 챌린지 회차와 회원의 별 발견 기록은 그대로 두고 분석 데이터만 DB에서 읽는다. 캐시 키는 1일 TTL로 만료되므로 수동 삭제가 필요하지 않다.

## 하지 않는 일

- 명령 자체의 알림 생성과 회차 종료 처리. V23 이후 의도는 1단계 DB 전환에서 기록하고 알림함/벨 조회가 발행한다
- 이미 연 별 닫기. 회차가 끝나도 발견한 별은 남는다(AT-61)
- 대상 별을 이미 다른 경로(성과 발견 등)로 발견한 회원의 기록 바꾸기. 이 회원은 건너뛰고 처음 발견 경로를 유지한다. 빨간 느낌표는 퀘스트 응답의 진행 회차 대상 별로 그리므로 이 회원에게도 그대로 보인다
