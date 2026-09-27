# 시연 발표자 계정 준비 계획

- 상태: 계획. 문서 리뷰 승인(김동혁, 2026-09-27, MR !247). 운영 DB 실행은 6절 결정과 실행 직전 승인 전이며 아직 실행하지 않았다.
- Jira: [S15P21C206-281](https://ssafy.atlassian.net/browse/S15P21C206-281) (에픽 [S15P21C206-224](https://ssafy.atlassian.net/browse/S15P21C206-224))
- 상위 정본: [운영 규칙 변경 런북](operation-rule-runbook.md), [탐사 API 9.2절](../../apps/backend/docs/exploration-api-spec.md#92-내부-계약-성과-지급별-열림), [요구사항 POL-27·HOME-02](../requirements/planetory-requirements-spec.md)
- 관련: 최종 발표 시연 런북(S15P21C206-225, MR !180 병합 전), [발표 시연 서버 안내](../../apps/frontend/src/cinema/DEMO.md)

최종 발표 시연에서 별 약 1,000개가 열린 발표자 계정을 실서비스(`app.planetory.space`)로 보여 주기 위한 준비 계획이다. 운영 DB에 쓰므로 인프라 담당 리뷰와 실행 직전 승인을 받은 뒤에만 실행한다. 실행 결과는 7절에 기록한다.

## 1. 방식

성과가 1건 인정될 때마다 서버는 현재 운영 규칙의 `discovery.stars_per_achievement`만큼 아직 못 찾은 별을 무작위로 연다(POL-27, `AchievementService.recognize`). 이 값을 몇 분만 K로 올려 두고 발표자 계정이 성과를 1건 내면, 서버가 평소 경로 그대로 별 K개를 연다. 원래 값으로 돌아가는 버전은 같은 트랜잭션에서 미래 시각으로 예약한다.

- 무작위 선택은 `AchievementRepository.pickUndiscoveredStar`가 한다. 공개(`published`) 별에서 이미 연 별, 사용 중인 튜토리얼 별, 진행 중인 챌린지 대상을 뺀 후보 가운데 회원·성과·순번 시드로 고른다.
- 자리와 기록은 `StarDiscoveryService`가 남긴다. 회원별 순번으로 은하 좌표를 계산하고 `star_unlocks`(`unlock_reason = achievement`, 원인 성과·순번)와 `user_star_progress`를 쓴 뒤 지도 버전을 올린다. 정상 가입자와 같은 기록이 남는다.

쓰지 않는 방법은 다음과 같다.

| 방법 | 쓰지 않는 이유 |
| --- | --- |
| `star_unlocks` 직접 INSERT | 좌표는 `PersonalSpiralGalaxyLayout`이 회원별 순번으로 계산한다. 성과로 연 별은 원인 성과 ID와 순번이 필수(V1 CHECK)이고 진행 행과 지도 버전도 맞춰야 한다. 같은 코드를 태우는 이 방식보다 틀릴 곳만 많다 |
| 성과 1,000건 자동 생성 | 확인 안 된 신호는 공개해야 성과가 되므로 공식 신호 스레드와 통계가 자동 공개 분석으로 채워진다 |

실서비스에 장애가 나면 [발표 시연 서버](../../apps/frontend/src/cinema/DEMO.md)의 `?as=veteran&stars=1000`을 대체 수단으로 쓴다. 노트북 메모리 안의 합성 세계이므로 실서비스 시연과 구분해 설명한다.

## 2. 전제와 사전 확인

읽기 전용이다. EC2-A의 서비스 compose 폴더에서 소유자 계정으로 접속한다([EC2 서비스 배포](../../infra/service/README.md)).

```bash
docker compose exec service-db psql -U planetory -d planetory_poc
```

```sql
-- ① 무작위로 열 수 있는 별 (pickUndiscoveredStar와 같은 조건, 별을 하나도 열지 않은 회원 기준)
SELECT count(*)                                               AS pool,
       count(*) FILTER (WHERE b.id IS NULL)                   AS no_current_bundle,
       count(*) FILTER (WHERE b.bundle_version LIKE 'mock-%') AS mock
  FROM stars s
  LEFT JOIN publication_bundles b ON b.tic_id = s.tic_id AND b.status = 'current'
 WHERE s.service_status = 'published'
   AND NOT EXISTS (SELECT 1 FROM tutorial_stars t WHERE t.active AND t.tic_id = s.tic_id)
   AND NOT EXISTS (SELECT 1 FROM challenge_rounds r
                    WHERE r.status = 'active' AND r.target_tic_id = s.tic_id);

-- ② 진행 중인 챌린지
SELECT round_no, target_tic_id, starts_on, ends_on FROM challenge_rounds WHERE status = 'active';

-- ③ 규칙 버전 목록과 현재 값
SELECT rule_version, applied_at, "values"->'discovery' AS discovery
  FROM operation_settings ORDER BY applied_at;

-- ④ 최근 30분 제출·공개 수 (조용한 시각을 고르는 근거, 실행 직전에 다시 본다)
SELECT (SELECT count(*) FROM submissions WHERE created_at > now() - interval '30 minutes') AS submissions_30m,
       (SELECT count(*) FROM published_analyses WHERE published_at > now() - interval '30 minutes') AS publications_30m;
```

| 확인 | 통과 기준 |
| --- | --- |
| `pool` | `pool` − 발표자 계정이 성과로 이미 연 별 수 ≥ K. 발표자 계정이 이미 연 별은 무작위 후보에서 빠진다(`pickUndiscoveredStar`). 2026-09-27 기준 운영 DB의 공개 별은 약 2,800개다(사용자 확인) |
| `no_current_bundle`·`mock` | 0이어야 한다. 아니면 분석할 수 없는 별이나 목업 별이 섞여 열린다. 먼저 정리할지 리뷰에서 정한다 |
| 진행 중인 챌린지 | 1건. 있어야 튜토리얼 5번을 끝낼 때 챌린지 별이 열린다 |
| 현재 규칙 | `stars_per_achievement`가 1이고, 다음에 쓸 버전 이름이 비어 있다 |
| 최근 30분 제출·공개(④) | 0에 가깝다. 팀 공지는 팀원만 막고 외부 회원의 제출·공개는 막지 못하므로, 이 값으로 조용한 시각을 고른다 |

## 3. 절차

1. **발표자 계정 만들기.** 시크릿 창에서 팀 공용 OAuth 계정으로 가입하고 닉네임을 정한다. 시크릿 창을 쓰는 이유는 5절의 화면 항목에 있다. 회원 id는 `SELECT id, nickname, created_at FROM users WHERE nickname = '<닉네임>';`으로 확인한다.
2. **튜토리얼 풀기.** 튜토리얼 1~4번과 5번의 첫 신호를 정상적으로 푼다. 확인된 행성은 `행성 같음`, 3~5번은 `아닌 것 같음`이다. 모두 인정되면 별은 12개다(튜토리얼 별 5개와 성과 7건으로 연 별 7개). 5번의 두 번째 신호는 `제출값 확인`까지만 해 두고 멈춘다.
   - 마지막 성과를 트리거로 쓰는 이유: 규칙이 올라가 있는 동안 성과가 한 번 더 나면 별이 K개 더 열린다. 마지막 성과 뒤에는 낼 성과가 없다.
3. **실행 직전 준비.** 2절 ④로 최근 제출·공개가 없는지 다시 보고, 팀 채널에 "3분간 제출·공개 금지"를 공지한 뒤 백업을 받는다. 백업에는 회원 정보가 들어 있으므로 [서비스 DB 백업 규칙](../../infra/service/README.md#튜토리얼-5종)을 따른다. 권한 600으로 두고 서버 밖으로 옮기지 않으며, 사후 확인이 끝나면 지운다. 삭제는 실행 직전에 승인받는다.

   ```bash
   (umask 077; mkdir -p ~/backups && docker compose exec -T service-db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > ~/backups/planetory-pre281-$(date -u +%Y%m%dT%H%M%SZ).dump)
   ```

   K는 목표 별 수에서 현재 별 수와 챌린지 별 1개를 뺀 값이다. 목표 1,000개, 현재 12개면 987이다.

   ```sql
   SELECT count(*) FROM star_unlocks WHERE user_id = <회원 id>;
   ```

4. **규칙 올리기와 복귀 예약.** 두 버전을 한 트랜잭션에 넣는다. 두 INSERT가 각각 `INSERT 0 1`인지 바로 확인한 뒤 COMMIT한다. `INSERT 0 0`이면 버전 이름이 틀린 것이므로 ROLLBACK한다. `now()`는 BEGIN 시각이라 확인이 늦으면 창이 그만큼 짧아진다.

   ```sql
   -- rule-0/1/2는 예시다. 2절 ③에서 본 현재 버전과 다음 번호로 바꾼다.
   BEGIN;
   INSERT INTO operation_settings (rule_version, "values", applied_at, note)
   SELECT 'rule-1', jsonb_set("values", '{discovery,stars_per_achievement}', '987'), now(),
          '시연 발표자 계정 준비: 성과 1건에 별 987개 [S15P21C206-281]'
     FROM operation_settings WHERE rule_version = 'rule-0';
   INSERT INTO operation_settings (rule_version, "values", applied_at, note)
   SELECT 'rule-2', "values", now() + interval '3 minutes',
          '시연 발표자 계정 준비 끝: rule-0 값으로 복귀 [S15P21C206-281]'
     FROM operation_settings WHERE rule_version = 'rule-0';
   -- 두 INSERT가 모두 INSERT 0 1이면
   COMMIT;
   ```

5. **트리거 제출.** COMMIT 뒤 3분 안에 `제출하기`를 누른다. 발견 카드가 뜨면 은하로 돌아가지 않고 창을 닫는다(5절).
6. **사후 확인.**

   ```sql
   SELECT count(*) FROM star_unlocks WHERE user_id = <회원 id>;
   SELECT user_id, count(*) FROM star_unlocks
    WHERE unlocked_at >= (SELECT applied_at FROM operation_settings WHERE rule_version = 'rule-1')
    GROUP BY user_id ORDER BY 2 DESC;
   SELECT rule_version FROM operation_settings
    WHERE applied_at <= now() ORDER BY applied_at DESC LIMIT 1;
   ```

| 확인 | 기대 |
| --- | --- |
| 발표자 계정 별 수 | 목표 수. 모자라면 후보가 부족해 덜 열린 것이다(`unlockShortfall`) |
| 창 동안 발견한 회원 | 발표자 계정뿐이다 |
| 현재 규칙 | 3분 뒤 복귀 버전(`rule-2`)이다 |

트리거가 성과로 인정되지 않으면(판단 불일치, 창을 놓침) 별은 더 열리지 않고 3분 뒤 자동으로 복귀한다. 다른 성과를 트리거로 3~6단계를 다시 한다. 판단이 달랐던 경우에는 같은 신호를 `다시 풀기`로 맞게 다시 제출해도 된다. 그 신호의 성과는 아직 인정되지 않았으므로 이때 처음 인정된다. 다시 할 때마다 규칙 이력이 두 행 더 남는다.

다시 할 때 K는 3단계 식으로 구하지 않는다. 첫 트리거가 창을 놓쳤거나 판단이 달랐어도, 매칭만 되면 같은 요청에서 튜토리얼 5번이 끝나 챌린지 별이 이미 열린다(`TutorialProgressService.onTutorialCompleted`는 성과 인정과 관계없이 완료만 본다). 3단계 count에 챌린지 별이 들어 있으면 K = 목표 별 수 − 현재 별 수로 구한다.

## 4. 시연 별 고르기

열리는 별은 무작위이므로 시연에서 분석할 별은 실행 뒤에 고른다. 발표자 계정의 미탐사 별 가운데 확인된 행성 신호가 있는 별을 깊이 순으로 본다. 첫 봉우리와 다음 곡선 단계까지 보여 주려면 `removal_step`이 0이고 `signals`가 2 이상인 별을 고르고, 실제 봉우리 순서는 리허설에서 확인한다.

```sql
SELECT c.tic_id, c.removal_step, round(c.period_days, 3) AS period_d, round(c.depth_ppm) AS depth_ppm,
       (SELECT count(*) FROM candidates x
         WHERE x.tic_id = c.tic_id AND x.status = 'active' AND x.discoverable) AS signals
  FROM star_unlocks u
  JOIN user_star_progress p ON p.user_id = u.user_id AND p.tic_id = u.tic_id
  JOIN candidates c ON c.tic_id = u.tic_id AND c.status = 'active' AND c.discoverable
  JOIN candidate_dispositions d ON d.candidate_id = c.id AND d.disposition = 'confirmed'
 WHERE u.user_id = <회원 id> AND p.progress_stage = 'unexplored'
 ORDER BY c.depth_ppm DESC
 LIMIT 20;
```

고른 별은 시연 준비(S15P21C206-225)에 넘긴다.

## 5. 영향과 위험

| 항목 | 내용 | 대응 |
| --- | --- | --- |
| 전 회원 적용 | 창이 열린 동안에는 다른 회원의 성과에도 별이 K개씩 열린다. 성과는 제출과 공개 두 경로에서만 인정된다 | 2절 ④로 조용한 시각을 고르고, 복귀를 3분 뒤로 예약하고, 제출·공개 중지를 공지한다. 공지는 팀원만 막는다. 3절 6단계로 점검하며, 발생하면 되돌릴 앱 기능이 없으므로 별도 승인 뒤 처리한다 |
| 규칙 이력 | 적용된 규칙 행은 고치거나 지울 수 없다(V9 트리거) | note에 목적과 Jira를 남긴다. [공개 범위 결정](../data/tess-service-scope-v1.md#71-dec-01-초기-공개-결정-2026-09-24-정책-승인)은 이 값을 공급 부족 대응으로 바꾸지 않는다고 적었다. 이번 변경은 공급 대응이 아니라 계정 하나를 준비하려는 몇 분짜리 변경이다 |
| 요청 처리 시간 | 제출 한 번에 별 K개를 고르고 저장한다. 프론트 기본 제한 15초(`apps/frontend/src/api/client.ts`)를 넘기면 화면은 접수 확인 흐름으로 넘어가지만 서버는 처리를 끝낸다 | 필요하면 로컬 DB에서 같은 별 수로 먼저 잰다. 길면 K를 나눠 성과 여러 건에 건다. 그만큼 창도 길어진다 |
| 시네마 화면 | 은하로 돌아가면 새 별을 하나씩 차례로 점화한다(`apps/frontend/src/cinema/shell/CinemaLayout.tsx`). 새 별 목록은 그 브라우저의 localStorage `planetory:new-stars`에 최대 200개 남아 "새 별 N개" 칩과 고리로 보인다 | 트리거는 시크릿 창에서 하고 결과를 확인한 뒤 창을 닫는다. 일반 창에서 했다면 그 키를 지운다 |
| 무작위 | 어떤 별이 열릴지 고를 수 없다. 같은 별을 가진 복제 계정도 만들 수 없다 | 시연 별은 4절로 실행 뒤에 고른다. 리허설은 이 계정의 다른 별이나 발표 시연 서버로 한다 |
| 부수 효과 | 열린 별의 별 게시판이 열리고(V24 트리거) 통계의 발견 수에 섞인다 | 수용 여부를 리뷰에서 정한다 |
| 되돌리기 | `cleanup_withdrawn_member(<회원 id>)`로 계정째 지울 수 있다. 공개 분석까지 지워지고 되돌릴 수 없으며 규칙 이력은 남는다 | 되돌림이 필요하면 별도 승인을 받는다 |

## 6. 실행 전에 정할 것

문서 리뷰(MR !247) 승인은 이 계획 문서를 병합하는 데 대한 것이며 운영 DB 실행 승인이 아니다. 아래 항목은 실행 전에 인프라 담당과 정한다.

- 운영 DB에 규칙 두 행을 남기는 데 동의하는지, 실행 시각과 실행자(소유자 계정)
- 3분 창과 제출·공개 중지 공지로 충분한지. 2절 ④의 최근 30분 제출·공개 수를 근거로 본다
- `no_current_bundle`·`mock` 별을 실행 전에 정리할지
- 한 요청에서 별 K개를 여는 시간을 먼저 측정할지

백업은 [서비스 DB 백업 규칙](../../infra/service/README.md#튜토리얼-5종)을 따른다(권한 600, 서버 밖으로 옮기지 않음, 사후 확인 뒤 삭제하되 삭제는 실행 직전 승인).

## 7. 실행 기록

실행 뒤 채운다.

| 일시 | 실행자 | 규칙 버전 | K | 발표자 계정 별 수 | 창 동안 다른 회원 발견 | 비고 |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |
