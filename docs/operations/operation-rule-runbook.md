# 운영 규칙 변경 런북

- 상태: 초안. DB 검증·초기 규칙은 구현·통합 테스트 완료, 운영 DB 적용은 미검증
- Jira: [S15P21C206-151](https://ssafy.atlassian.net/browse/S15P21C206-151)
- 상위 정본: [요구사항 OPS-04·07·08](../requirements/planetory-requirements-spec.md), [인수 기준 AT-41](../requirements/planetory-acceptance-criteria.md), [DB ERD](../architecture/database-erd.md) `operation_settings`, [탐사 API 5.1·6.2절](../../apps/backend/docs/exploration-api-spec.md)

운영 화면이 없어(OPS-06) 판정 규칙은 운영자가 SQL로 새 버전 행을 넣어 바꾼다. 앱은 읽기만 한다. 형식에 맞지 않는 값은 DB가 저장 순간 거절한다(AT-41). 그래서 잘못된 규칙으로 제출이 판정되는 일이 없다.

## 1. 규칙 버전

- 한 행이 규칙 버전 하나다. 값을 하나만 바꿔도 새 `rule_version` 행을 넣는다. 이름은 `rule-0`, `rule-1`처럼 순서대로 붙인다.
- 현재 규칙은 `applied_at`이 지금 이전인 행 중 가장 늦은 것이다. 앞으로의 시각으로 넣으면 그때부터 적용된다.
- 적용된 행은 고치거나 지울 수 없고 테이블을 비울 수도 없다. 제출이 `submissions.rule_version`으로 그 판정 근거를 되살리기 때문이다.
- 적용 시각이 오지 않은 예약 행은 지울 수 있다. 고칠 수는 없으므로 지우고 다시 넣는다.
- 지난 시각이나 다른 행과 같은 시각으로는 넣을 수 없다. 지난 시각을 허용하면 그 사이 제출을 판정한 버전과 이력이 어긋난다.
- 되돌리기는 이전 값을 담은 새 버전을 넣는 것이다.

## 2. 값 형식 1

`values`는 아래 키를 모두, 그리고 이 키만 가진 JSON 객체다. 빠진 키, 오타 난 키, 자료형이 다른 값은 거절된다. 정수 항목은 소수점 없이 쓰며 2147483647 이하여야 한다.

| 키 | 뜻 | 허용 값 | `rule-0` |
|---|---|---|---|
| `format_version` | 값 형식 | 1 | 1 |
| `selection.phase_width_max` | 공통 위상 폭 상한(탐사 API 5.1 `phaseWidthMax`) | 0 초과 1 미만 | 0.25 |
| `selection.max_duration_multiple_of_suggested` | 봉우리 추천 duration 대비 선택 폭 상한 배수(C02-R3) | 0 초과 | 3 |
| `selection.allow_empty_phase_span` | 관측점 없는 구간 선택 허용(Q03) | `true`, `false` | `false` |
| `matching.harmonic_multipliers` | 허용 배율(SRS 5.1) | 1·2·0.5 중 중복 없이, 1 포함 | `[1, 2, 0.5]` |
| `matching.n_transits_cap` | 관측 통과 수 N 상한(DEC-03) | `null`(상한 없음) 또는 1 이상 정수 | `null` |
| `matching.duration_ratio_min`, `matching.duration_ratio_max` | 지속시간 비율 범위 | 0 < 하한 < 상한 | 0.5, 2 |
| `matching.min_overlap_transits` | 최소 중첩 통과 수 | 1 이상 정수 | 1 |
| `matching.dominance_ratio` | 우세 판정 점수 비 | 0 초과 1 이하 | 0.5 |
| `matching.min_score_gap` | 우세 판정 최소 점수 차 | 0 이상 | 0.1 |
| `matching.overlap_ratio_tolerance` | 중첩 비율 허용 차 | 0 이상 1 이하 | 0.1 |
| `peaks.top_n` | 봉우리 표시 수(탐사 API 5.4) | 1 이상 정수 | 10 |
| `discovery.stars_per_achievement` | 성과 1건당 발견 수(OPS-08) | 0 이상 정수 | 1 |
| `discovery.seed_policy` | 무작위 시드 정책(탐사 API 9.2) | `hash-user-achievement-seq-v1` | 같음 |
| `tutorial.skip_after` | 튜토리얼 건너뛰기 기준(SUB-12). 0이면 끈다 | 0 이상 정수 | 환경별(6절) |
| `ai.lower_threshold`, `ai.upper_threshold` | AI 판정 하한·상한(AI-04) | 둘 다 `null`, 또는 0 ≤ 하한 < 상한 ≤ 1 | `null`, `null` |
| `bls` | BLS 품질. D13이 값을 정하기 전이라 자리만 둔다 | `null` | `null` |

- 매칭 값의 뜻과 출처는 [제출 매칭 수치 규칙 v0](../api/exploration/README.md)이 정본이다. `rule-0`은 그 v0와 탐사 API 기본값이며 운영 확정값이 아니다. 확정은 D20·D11 뒤 새 버전으로 한다.
- 최소 선택 폭(`minWindowDays`)은 별의 케이던스로, 미세 조정 폭(`fineTune`)은 판 manifest로 정해지므로 여기 없다(OPS-04).
- 키를 더하거나 허용 값을 넓히려면 형식 번호를 올리는 마이그레이션과 앱 수정이 함께 필요하다. 앱은 모르는 형식의 행을 읽지 않는다.

## 3. 새 버전 넣기

DB 변경은 [운영 문서](README.md)의 원칙대로 대상과 영향을 확인하고 승인받은 뒤 실행한다. 현재 값을 복사해 바꿀 키만 고친다.

```sql
-- 1) 현재 규칙 확인
SELECT rule_version, applied_at, "values"
  FROM operation_settings
 WHERE applied_at <= now()
 ORDER BY applied_at DESC
 LIMIT 1;

-- 2) 바꿀 키만 고쳐 새 버전으로 넣는다. 예: 봉우리 표시 수 10 → 8
INSERT INTO operation_settings (rule_version, "values", applied_at, note)
SELECT 'rule-1', jsonb_set("values", '{peaks,top_n}', '8'), now(), '봉우리 표시 수 조정 [JIRA-KEY]'
  FROM operation_settings
 WHERE rule_version = 'rule-0';
```

앞으로의 시각에 적용하려면 `now()` 대신 `TIMESTAMPTZ '2026-09-21 00:00+09'`처럼 쓴다. 잘못 예약했으면 적용 시각 전에 지우고 다시 넣는다.

```sql
DELETE FROM operation_settings WHERE rule_version = 'rule-1' AND applied_at > now();
```

## 4. 거절 메시지

| 메시지 | 원인 | 조치 |
|---|---|---|
| `operation_settings.values.<키>: <이유>` | 형식 1과 다르다. 틀린 키 경로와 이유가 함께 나온다 | 2절 허용 값으로 고친다 |
| `운영 규칙 <버전>의 적용 시각(…)이 이미 지났습니다` | 지난 시각으로 넣었다 | `now()` 또는 앞으로의 시각을 쓴다 |
| `uq_operation_settings_applied_at` 중복 | 다른 버전과 적용 시각이 같다 | 시각을 바꾼다 |
| `운영 규칙 버전은 고치거나 지울 수 없습니다(<버전>)` | 적용된 행을 고치거나 지웠다. 또는 예약 행을 고쳤다 | 새 버전을 넣는다. 예약 행은 지우고 다시 넣는다 |
| `운영 규칙 이력은 비울 수 없습니다` | `TRUNCATE`를 실행했다 | 실행하지 않는다 |
| `operation_settings_pkey` 중복 | 같은 버전 이름이 있다 | 다음 번호를 쓴다 |

## 5. 튜토리얼 별·챌린지 회차

`tutorial_stars`와 `challenge_rounds`도 SQL로 넣는다. DB가 저장할 때 다음을 거절한다.

- 대상 TIC이 없거나 `stars.service_status`가 `published`가 아니다. 공개 대상이 아닌 별은 발견에서 빠지므로(OPS-08) 회원에게 열 대상으로도 넣을 수 없다. 메시지는 `공개된 별만 <테이블>.<열>에 넣을 수 있습니다`다. 대상 열을 넣거나 바꿀 때만 검사하므로, 대상 별이 나중에 숨겨져도 회차를 닫거나 튜토리얼을 끄는 수정은 된다.
- 회차 기간이 뒤집혔다(`ck_challenge_rounds_period`, `starts_on > ends_on`). 하루짜리 회차는 된다.
- `active` 회차가 둘이 된다(`uq_challenge_rounds_active`). 전환 절차는 [챌린지 회차 전환 런북](challenge-round-runbook.md)을 따른다.

튜토리얼 별의 정답 라벨과 챌린지 대상의 미확정·AI 승인 조건(OPS-07, POL-24)은 DB가 검사하지 않으므로 넣기 전에 운영자가 확인한다. AI 임계값(D11)이 정해지기 전이라 검사 규칙을 둘 수 없다.

## 6. 환경별 초기값과 적용

- V9 마이그레이션이 처음 적용될 때 `rule-0`을 넣는다. `submissions.rule_version`이 FK라 규칙 행이 없으면 제출을 저장할 수 없다.
- `tutorial.skip_after`만 환경마다 다르다. V9는 마이그레이션 연결의 세션 설정 `planetory.tutorial_skip_after`를 읽고, 설정이 없으면 0이다. `local` 프로필만 `spring.flyway.init-sqls`로 3을 주고, 배포 이미지(`prod` 프로필)는 설정이 없어 0이다.
- 이 설정은 V9가 처음 적용될 때만 쓰인다. 이미 적용된 DB에서 값을 바꾸려면 새 버전을 넣는다. 설정은 파일 내용에 들어가지 않으므로 환경이 달라도 Flyway 체크섬은 같다.
- 마이그레이션 SQL에는 Flyway placeholder 같은 전용 문법을 쓰지 않는다. Gold 적재 왕복 도구(`experiments/gold-roundtrip`)처럼 파일을 Flyway 없이 그대로 실행하는 도구도 적용할 수 있어야 하기 때문이다. 이런 도구로 적용하면 설정이 없으므로 0이 들어간다.
- 기존 DB에 형식 1에 맞지 않는 규칙 행, 공개되지 않은 대상 별, 기간이 뒤집힌 회차가 있으면 V9는 무엇이 몇 건 틀렸는지 알리고 통째로 되돌아간다. 행을 고친 뒤 다시 기동하면 적용된다. 개발 DB에서 형식 이전 규칙 행을 지울 때는 그 행을 참조하는 제출도 함께 정리한다.
