# Planetory 서비스 DB ERD v1.17

- 작성일: 2026-09-09 (v0.1 2026-09-04, v0.2·v0.3 2026-09-09, v1.0 2026-09-09, v1.1 2026-09-11, v1.2 2026-09-14, v1.3 2026-09-15, v1.4 2026-09-16, v1.5 2026-09-16, v1.6 2026-09-16, v1.7 2026-09-16, v1.8 2026-09-16, v1.9 2026-09-17, v1.10 2026-09-17, v1.11 2026-09-19, v1.12 2026-09-20, v1.13·v1.14·v1.15·v1.16 2026-09-25, v1.17 2026-09-27)
- v1.3 당시 상태: 개별 별 조회·공간 인덱스 정합화 변경안. 관련 담당 교차 리뷰 후 적용하며 DB 구조/운영 데이터를 그 문서 작업으로 변경하지 않는다.
- 기준 문서: 요구사항 명세서 v1.3(상태표 v1.3 변경안·용어 사전 v1.0·와이어프레임 v1.3), 시스템 아키텍처(불변 규칙 4·5, 데이터 소유권 표). **아키텍처 불변 규칙 5는 이 판의 Gold 저장 방식 변경에 맞춰 수정이 필요하다(서비스 백엔드 정합화 요청 R3).**
- 범위: **EC2 PostgreSQL**에 두는 서비스 데이터. **곡선·주기도·통과 모델 본문도 PostgreSQL 배열 열에 저장한다(v0.3 결정).** Gold 파일 계층은 두지 않고, 배치가 릴리스 전환 때 배열을 적재한다. GCP HDFS(Raw/Bronze/Silver)는 범위 밖.
- 표기: 회원 FK는 역할과 관계없이 `user_id`(두 번째 회원 참조만 역할 이름). 테이블은 snake_case 복수형, PK는 `id BIGINT IDENTITY`(별은 `tic_id`), 시각은 `TIMESTAMPTZ`, 열거형은 `TEXT + CHECK`.
- 상태: **v1.2는 별 자리 저장 계약 변경 검토안.** 추가 좌표 열과 모든 계정의 초기 은하 좌표 생성은 관련 백엔드 리뷰 후 적용한다. 현재 보존할 운영 좌표 데이터는 없다. 나머지 구조와 제약은 기존 백엔드 개발 기준선이며 임계값·대상 데이터 등 수치는 5장 미결에서 실측 후 채운다. `확인 필요`는 이 문서의 임시값, `DEC-nn`은 명세서 미결 항목.

## 0. 변경 요약

### v1.16 → v1.17 (2026-09-27, `S15P21C206-283`)

V30은 챌린지 회차 하나에 대상 별을 여러 개 둔다(요구사항 v1.4 POL-24). `challenge_rounds.target_tic_id`는 대표(첫) 대상으로 그대로 두어 회차마다 대표 대상이 정확히 하나다. 나머지 대상은 새 테이블 `challenge_round_extra_targets(round_id, tic_id)`(PK 두 열, `challenge_rounds`·`stars` FK)에 넣는다. 넣거나 `tic_id`를 바꿀 때 V9 함수 `exploration_target_must_be_published('tic_id')`로 공개 별만 받는다(`trg_challenge_round_extra_targets_published`). 대표 대상과 같이 나중에 숨겨진 별은 회차 수정을 막지 않는다.

대상을 읽는 쪽은 뷰 `challenge_round_targets(round_id, tic_id, is_primary)`만 본다. 대표 대상과 추가 대상의 UNION ALL이며 대표와 같은 추가 대상은 한 번만 나온다. 앱 역할은 새 테이블과 뷰의 SELECT만 가진다(V5의 `challenge_rounds`와 같다). `global_stats`(V21)는 정의를 바꿀 수 없어 지우고 다시 만든다. `rounds`만 이 뷰로 대상 별 전부를 세고 나머지는 V21과 같으며 권한(SELECT·MAINTAIN)도 다시 준다. 운영 MV는 이 시점까지 채운 적이 없다(2026-09-27 `ispopulated` false). 기존 회차 INSERT와 V30 전 앱은 대표 대상만으로 그대로 동작한다. 공유/운영 DB 적용은 별도다.

### v1.15 → v1.16 (2026-09-25, `S15P21C206-270`)

V29는 제출 결과에서 보는 항성별 NASA `ps` 확정 행성 목록을 `nasa_star_catalog`, `nasa_star_planet`, `nasa_star_planet_explanation`에 저장한다. 외부 행성은 내부 후보 FK 없이 TIC·불투명 `planet_id`로 식별한다. 성공 재조회에서 빠지거나 이름이 바뀐 행은 비활성화해 보존하되 현재 응답에서 제외한다. 기존 V25·V26 후보 자료와 Gold·성과는 바꾸지 않으며 V28의 회원별·전체 모델 시도 한도를 공유한다. 구조·상태는 [270 개발 계약](../development/nasa-star-planets-270.md), 적용 절차는 [NASA 운영 가이드](../operations/nasa-planet-info-runbook.md)를 따른다. 공유/운영 DB 적용은 별도다.

### v1.14 → v1.15 (2026-09-25, `S15P21C206-268`)

269의 V27 봉우리 제출 제약 다음 번호인 V28은 모델 생성 시도의 UTC 일별 상한을 DB 전체에서 지키기 위해 `nasa_explanation_daily_usage`(회원별)와 `nasa_explanation_daily_total`(전체)을 추가한다. 두 행의 `attempt_count`는 모델 시도권을 확보할 때 같은 짧은 트랜잭션에서 증가한다. 회원 삭제 시 회원별 행은 정리되지만 전체 행은 남아 비용 상한의 과거 사용량을 보존한다. V25·V26·269의 V27이나 Gold·성과는 변경하지 않는다. 설정·확인 순서는 [운영 가이드](../operations/nasa-planet-info-runbook.md), 요청 계약은 [268 개발 계약](../development/nasa-planet-request-268.md)을 따른다. 공유/운영 DB 적용은 별도다.

### v1.13 → v1.14 (2026-09-25, `S15P21C206-267`)

V26은 `nasa_planet_info` 후보 행 하나에 최대 한 행으로 연결되는 `nasa_planet_explanation`을 추가한다. 설명 본문은 원천 해시·구조 버전, 모델·프롬프트 버전과 생성 시각을 함께 보존한다. DB 임대·시도 순번·횟수·다음 재시도 시각은 동시 생성과 늦은 완료를 제한한다. 기존 NASA 원천·Gold 분류·성과를 변경하지 않는다. 구조와 소비 조건은 [267 내부 계약](../development/nasa-planet-explanation-267.md)을 따른다. V26의 공유/운영 DB 적용은 미실행이다.

### v1.12 → v1.13 (2026-09-25, `S15P21C206-266`)

V25는 Gold와 분리된 서비스 조회 테이블 `nasa_planet_info`를 추가한다. 회원이 실제 매칭한 확정 후보만 NASA PS 기본 해로 조회하고, 후보당 한 행에 정규화값·출처 해시·조회/변경 시각·재확인 상태·경합 순번을 저장한다. Gold·후보 판정·성과는 바꾸지 않는다. 관계·열의 최신 작은 그림은 [NASA 자료 ERD SVG](../images/nasa-planet-info-erd.svg), 상세 상태·필드는 [266 개발 계약](../development/nasa-planet-info-266.md)을 따른다. V25는 격리 DB에서 검증했으며 공유/운영 DB 적용은 미실행이다.

### v1.11 → v1.12 (2026-09-20, `S15P21C206-114`)

`light_curve_segments.flux_scatter`의 의미를 점별 오차 대표값에서 세그먼트 전체 robust 산포로 정정한다. 유한 비닝 flux 전체의 `1.4826 × MAD`이며 통과·별 변동을 포함한다. 부분 bin의 점 수가 달라 같은 측정 오차를 보장하지 않는다. 운영 10분 mean·부분 bin 유지·상한 초과 실패·격리 및 운영 revision은 [Gold 4.1](../../contracts/gold/README.md#41-s15p21c206-114-비닝-운영-채택안)에 둔다.

열 타입·배열·기존 데이터를 변경하지 않는다. 이미 적용된 V1은 수정하지 않으며 DB COMMENT를 정정하는 새 migration과 Java 설명 정정은 123에서 수행한다. 승인 진행 상태는 [정합화 요청](../project/planetory-doc-sync-requests.md)과 MR !101에서 관리한다.

### v1.10 → v1.11 (2026-09-19, `S15P21C206-143`)

V12는 submissions에 `request_hash`(정규화 SHA-256), `request_hash_version`(1), `response_snapshot`(최초 성공 JSON 본문)을 추가한다. 재전송은 판정·성과·진행을 반복하지 않고 보존된 본문을 반환한다. 기존 행은 세 열 모두 NULL로 남겨 가짜 backfill을 하지 않으며 해당 POST 재전송은 503이다. 앱의 기존 submissions UPDATE 권한을 재사용한다. 스냅샷 MAD 산식과 실패 경계는 [143 채택 계약](../api/exploration/submission-readiness.md)을 따른다. 아래 Mermaid/열 표가 최신이며 SVG 열 그림은 v1.10까지의 보조 자료다.

### v1.9 → v1.10 (2026-09-17, `S15P21C206-140`)

`light_curve_segments.gaps` 설명의 "빈 칸은 NaN으로 채운다"를 바로잡는다. 빈 칸은 `flux`의 NULL이다. 저장은 처음부터 `real[]`의 NULL이었고 [Gold 게시 계약](../../contracts/gold/README.md) 4절도 `flux`를 유한수 또는 `null`로 정한다. 문구대로 NaN을 넣으면 `S15P21C206-117`이 제안한 배열 checksum에서 NULL과 같은 바이트가 되어 checksum 검증으로도 걸러지지 않는다.

`periodograms.power`에는 NULL을 두지 않는다. 주기도는 격자 전 점에 값이 있어야 하며 빈 칸은 곡선에만 있다(`S15P21C206-117` 공개 QA 계약).

두 규칙을 마이그레이션 V10의 CHECK로 적재 단계에서 막는다. `ck_light_curve_segments_flux_finite_or_null`은 `flux`의 NaN·±Infinity를, `ck_periodograms_power_all_finite`는 `power`의 NULL·NaN·±Infinity를 거절한다. Publisher 정규화만으로는 부족하다. 정규화를 거치지 않는 경로(수동 적재·복구 스크립트)가 하나만 생겨도 조용히 들어가기 때문이다(v1.6과 같은 이유). 열은 그대로이며 Backend 조회도 같은 값을 한 번 더 거절한다.

### v1.8 → v1.9 (2026-09-17, `S15P21C206-151`)

`operation_settings.values`의 형식 1을 정하고 DB가 저장 순간 검사한다(AT-41). 키 목록·허용 값·입력 절차는 [운영 규칙 변경 런북](../operations/operation-rule-runbook.md)이 정본이다. 모든 키를 요구하고 모르는 키를 거절해 오타 난 설정이 조용히 무시되지 않게 한다. 값 자체(허용 오차·임계값)는 이 판이 정하지 않으며 D20·D11이 정한다.

행 목록이 변경 이력이라는 결정을 DB가 지킨다. 적용된 행의 수정·삭제와 테이블 비우기, 지난 시각이나 다른 행과 같은 시각의 삽입을 거절한다. 적용 시각이 오지 않은 예약 행만 지울 수 있다. v1.4는 `analysis_histories`의 불변을 권한 회수로 정했지만, 규칙은 운영자가 소유자 계정으로 넣어 권한으로는 막을 수 없으므로 트리거를 쓴다.

모든 환경에 초기 규칙 `rule-0`을 넣는다. `submissions.rule_version`이 FK라 규칙 행이 없으면 제출을 저장할 수 없다. 값은 제출 매칭 규칙 v0(`S15P21C206-128`)와 탐사 API 기본값이며, `tutorial.skip_after`만 환경별(로컬 3, 배포 0)로 넣는다.

`tutorial_stars.tic_id`·`challenge_rounds.target_tic_id`는 공개된 별만 받고 `challenge_rounds`는 `starts_on ≤ ends_on`만 받는다(OPS-07·08). 대상 열을 넣거나 바꿀 때만 검사하므로 대상 별이 나중에 숨겨져도 회차 종료·튜토리얼 비활성화는 막지 않는다. 열은 그대로다.

### v1.7 → v1.8 (2026-09-16, `S15P21C206-138`)

미결 9(`stars` 표시 열)를 결정으로 확정한다. 본인 별 상세는 `tmag`·`teff_k`·`radius_rsun` 셋을 모두 제공하고, 타인이 보는 공개 요약은 `tmag`만 준다. 카탈로그에 값이 없으면 필드를 빼지 않고 `null`을 보낸다.

공개 요약에서 온도·반지름을 뺀 것은 비공개 정책이 아니다. 세 값 모두 TESS 카탈로그에서 TIC 번호로 조회할 수 있는 공개 값이라 서버에서 빼도 감춰지지 않는다. 그 응답을 쓰는 게시판 헤더·출처 카드에 놓을 자리가 없어서다. 소비 화면이 필요로 하면 넓힌다.

열은 그대로다. 이 판은 노출 범위만 정하며 마이그레이션을 추가하지 않는다. 상세 규칙은 [탐사 API](../../apps/backend/docs/exploration-api-spec.md) D-18과 4.2·4.5절에 있다.

### v1.6 → v1.7 (2026-09-16, `S15P21C206-69`)

Publisher 멱등 키 `(tic_id, bundle_version)`의 DB 유일 제약은 `S15P21C206-86`에서 추가한다. `bundle_version`은 곡선 원천·외부 참조 snapshot, 세그먼트 자연 키, 계산 버전으로 결정하며 DB 생성 id는 동일성 비교에서 제외한다.

`UNIQUE(tic_id) WHERE status='current'`는 문장마다 즉시 검사되므로 같은 트랜잭션에서 기존 `current`를 먼저 `archived`로 바꾸고 신규 `staging`을 `current`로 올린다. 이 판은 계약만 명시하며 migration이나 운영 DB를 변경하지 않는다.

### v1.5 → v1.6 (2026-09-16, `S15P21C206-230`)

`publication_bundles`에 `UNIQUE (tic_id, bundle_version)`을 둔다. `S15P21C206-69`가 Publisher 적재의 재시도 키를 이 두 열로 확정했지만 제약이 없어 같은 키가 두 번 들어갔다. 그러면 “같은 키의 판을 확인한다”는 조회가 여러 건을 돌려줘 어느 `bundleId`를 반환할지가 정해지지 않는다.

잠금(`pg_advisory_xact_lock(tic_id)`)으로만 막지 않는다. 잠금은 그 코드를 지나는 쪽만 지키는 규약이고 제약은 누가 쓰든 DB가 거절한다.

기존 `uq_publication_bundles_current`와 역할이 다르며 서로 대체하지 않는다. 판 버전이 다른 archived 행이 한 TIC에 여러 개 남는 것은 과거 제출이 참조하므로 계속 허용한다.

### v1.4 → v1.5 (2026-09-16, `S15P21C206-136`)

회원별 지도 개정값을 보관하는 `member_sky_revisions`를 추가한다. 탐사 API 4.1의 `version`은 “동일 시각의 여러 변경도 구분하는 단조 증가 개정값”이라 시각에서 파생할 수 없다. 같은 순간에 일어난 두 발견이 같은 `version`을 내면 프론트가 변경을 놓친다. 응답의 `skyVersion`은 `u-<회원번호>:<개정값>` 문자열이며 프론트는 문자열로만 비교한다.

행이 없는 회원은 개정값 0으로 읽는다. 첫 증가가 1을 만드므로 없는 행을 1로 읽으면 첫 변경이 값을 움직이지 않아 감지되지 않는다.

**배치 버전 `personal-spiral-v1`을 구현으로 확정한다.** v1.2가 정한 좌표 열에 실제 값을 채우는 배치 함수가 프론트 참조 구현과 비트 단위로 일치한다. 자리표시 배치 `bootstrap-0`으로 저장된 행은 좌표가 모두 원점이라 실제 배치와 섞일 수 없으며, 남아 있으면 마이그레이션이 안내와 함께 멈춘다. 지우지 않는 이유는 발견 행을 지우면 그 회원의 별이 0개가 되는데 튜토리얼 1번은 가입 처리에서만 열려 다시 생기지 않기 때문이다.

### v1.3 → v1.4 (2026-09-16, `S15P21C206-135`)

v1.3이 정한 `layout_ordinal` 계약을 후속 마이그레이션으로 구현한다. 열 정의·범위·배정 규칙은 v1.3(`S15P21C206-227`)을 그대로 따르고 여기서 바꾸지 않는다. 기존 행이 있는 DB에도 적용되도록 nullable로 넣고 회원별 발견 순서대로 채운 뒤 `NOT NULL`로 승격한다. 순번이 없던 행에 처음 부여하는 것이며 이미 있는 순번을 재배치하지 않는다.

**미결 5 중 `analysis_histories` 부분을 결정으로 확정한다.** 불변 강제는 트리거가 아니라 **앱 역할의 UPDATE·DELETE 권한 회수**로 처리한다. 트리거는 쓰기마다 비용이 붙고 비활성화로 우회되지만 권한은 DB가 원천 차단한다. `analysis_snapshots`도 같게 처리한다. `published_analyses`는 161에서 앱 역할 INSERT만 허용하고 상태 열의 UPDATE는 162에 남긴다(아래 해당 테이블 설명). 첨부 검증(미결 6)은 불변 강제가 아니라 값 일치 검사라 이 결정의 범위가 아니다.

`submissions`에 정합 CHECK 3종을 더한다. 위상 선택이 없는 제출에는 서버 파생값도 없어야 하고, 성과 결과는 매칭 결과와 함께 성립하며, 고조파 정정 기록은 실제로 정정했을 때만 남긴다. `challenge_rounds`는 `status='active'` 부분 유일 인덱스로 진행 회차를 하나로 묶는다.

다이어그램에만 빠져 있던 열 7개(`submissions`의 `correction_reason`·계산 버전 2종·`memo`·`rule_version`, `user_candidate_achievements.relabel_disposition`, `user_star_progress.reopened_at`)를 본문 기준으로 채웠다.

### v1.2 → v1.3 (2026-09-15, 교차 리뷰 대상)

군집 응답/공식 군집 사전 계산 의무를 제거하고 개별 별 타일·cursor 조회를 위한 회원별 월드 공간 인덱스와 일관된 version 읽기 규칙으로 변경한다. 개인 시제품 배치/연출의 안정 입력인 layout_ordinal과 UNIQUE(user_id,layout_ordinal)을 추가하는 설계다. 5장 항목 8과 탐사 API 4.1절을 따른다. 이번 문서 개정 자체로 실제 좌표·DB 열·운영 데이터를 변경하지 않는다. 스키마 적용은 C04-2의 후속 마이그레이션, 배치와 초기 준비는 C05-1, 발견 호출은 C07/C11이 맡는다.

### v1.1 → v1.2 (2026-09-14, `S15P21C206-33`)

은하 배치 결과를 직접 보존하는 `world_x`, `world_y`, `layout_version`을 `star_unlocks`에 추가한다. `world_x`·`world_y`는 서비스 월드 좌표 단위의 유한 값이고, `depth_z`는 -1.0 이상 1.0 이하의 단위 없는 정규화 깊이다. 현재 보존할 운영 좌표 데이터가 없으므로 모든 계정은 현행 은하 배치로 초기 좌표를 생성하고 종전 방사형 좌표를 유지·이관하지 않는다. 기존 `generation`·`angle_deg`·`radius_jitter`는 nullable 폐기 예정 열이며 신규 좌표 계산과 API 응답의 근거로 삼지 않는다. [별지도 표현 계약](../development/sky-presentation-contract.md) 1절을 따르며 이 문서 수정만으로 DB에 적용되지 않는다.


### v1.0 → v1.1 (2026-09-11, 팀 결정·정합화)

| 항목 | 변경 |
|---|---|
| `challenge_rounds.description` | 열 추가. 명세서 6장 ChallengeRound의 "소개 문구"와 HOME-07·CHL-01의 "한 줄 설명"이 v1.0 ERD에 빠져 있었다 |
| `users` 닉네임 유일성 | 영문 대소문자를 무시한 중복 검사를 위해 `UNIQUE (lower(nickname))` 함수 인덱스. 서비스 API SB-D14 |
| `posts` 검색 인덱스 | `pg_trgm` 확장과 `title`·`body`의 GIN(gin_trgm_ops) 인덱스 추가. COM-03 P0 상향(명세서 v1.1 안건 13)에 따른 제목·본문 부분 일치 검색용. 정합화 요청 R9 |
| 4장 결정 5 | "판 자체는 직전 것만 짧게 보존" → 이전 판은 보존하지 않고 판 행만 제출 참조용으로 남긴다는 v0.3 결정 C와 일치하도록 정정. 정합화 요청 R1 |
| 4장 결정 6 | 축약 스냅샷 용량 ≈1.8KB → ≈1.2KB(float32 150개 배열 2개). 정합화 요청 R2 |
| 별 지도 좌표 | `star_unlocks`의 자리(generation·angle_deg·radius_jitter·depth_z)는 카메라 회전·기울기와 무관한 월드 좌표라는 점을 명시(명세서 v1.1 HOME-01, NFR-20a·d). 열 변경 없음 |

### v0.3 → v1.0 (기준선 확정, MR !16 검토 반영)

명세서 v1.0과 함께 백엔드 개발의 기준선으로 삼는다.

| 항목 | 변경 |
|---|---|
| 세그먼트 revision | `light_curve_segments`에 `binning_revision` 추가, `UNIQUE(tic_id, sector, binning_revision)`. 재비닝은 덮어쓰기가 아니라 새 revision 행 |
| Bundle manifest | 포함 섹터 목록 → **참조할 세그먼트 id 집합**. 어느 판이 어떤 revision을 쓰는지 특정된다 |
| 시각 복원식 | `start_btjd + bin_minutes × i` → `start_btjd + (bin_minutes / 1440.0) × i`. BTJD가 일 단위라 분을 환산해야 한다 |
| star_unlocks | `seq` 열 추가. `UNIQUE(trigger_achievement_id, seq)`가 참조하던 열이 없었고, `stars_per_achievement`가 2 이상이면 중복 방지가 성립하지 않았다 |
| planet_count | "행성 같음으로 **공개한** 미확정" → "**판단한** 미확정". 공개 조건은 HOME-05·결정 22에 없다 |
| evidence_checks | P0 4종 → **3종**(oddeven, secondary, ushape). 품질 플래그는 배치 전처리에서만 쓰고 화면에 전달하지 않는다(명세서 v1.0 POL-13) |
| discoverable | 사용자에게 제공되는 것과 같은 조건(비닝 간격·모델·격자)으로 판정하고 revision이 바뀌면 재계산한다는 기준을 명시(DAT-07) |
| 용량 표기 | "판 2개 보존" → "전환 중 staging+current 2벌". 이전 판을 남기지 않고 세그먼트는 revision이 같으면 판 사이에 공유 |
| tutorial_skip_after | 개발 3 · 운영 0=끔으로 환경 표기 정정 |

### v0.2 → v0.3 (Gold 본문을 DB 배열로)

곡선·주기도·통과 모델을 EC2 Gold 파일이 아니라 PostgreSQL 배열 열(`real[]`)에 저장한다. 조회 API가 파일 경로를 돌려주는 대신 배열을 읽어 내려주고, 릴리스 교체는 파일 전송·링크 전환이 아니라 행 적재와 status 전환이 된다.

| 항목 | 변경 |
|---|---|
| light_curves 분리 | 삭제하고 `light_curve_segments`(별·섹터 단위 곡선, 불변)와 `periodograms`(판 단위)로 나눔. 곡선이 판마다 복제되지 않는다 |
| 저장하지 않는 배열 | 시각은 `start_btjd + (bin_minutes / 1440.0) × i`로 계산(BTJD는 일 단위), 주기 격자는 전 별 공통이라 manifest 규칙으로 생성. 실제로 저장하는 배열은 `flux`와 `power`뿐 |
| 비닝 | 곡선은 섹터 안에서 **10분 고정 간격**, 주기도 격자는 5,000점. 규칙은 manifest |
| candidates | `transit_model_ref`(Gold 파일) → `transit_model` JSONB(모델 파라미터). 잔차 계산은 파라미터로 모델을 생성해 나눈다 |
| publication_bundles | `gold_path` 삭제. manifest는 배열 checksum·계산 버전·주기 격자 규칙만 |
| derived_curve_cache 삭제 | 잔차·주기도 캐시는 Redis로. 상태·결과 모두 Redis, 테이블 없음 |
| analysis_snapshots | PostgreSQL 유지. `data BYTEA` → `folded_flux`·`folded_err` real[], 위상은 계산 |
| pipeline_runs 삭제 | 서비스가 읽지 않고 Airflow와 겹침 |
| 판 갱신 방식 | 새 판이 나오면 진행 중인 세션도 최신 판으로 올린다. 이전 판을 남기지 않으므로 화면과 판정이 항상 같은 판이다(결정 C). status에서 previous·expires_at 제거 |
| operation_settings 추가 | 명세서 v0.13의 OperationSetting. 규칙 버전을 PK로 두고 설정 값을 JSONB 한 묶음으로. submissions.rule_version이 참조 |
| 확정한 것 | 판 단위는 별마다, 비닝 10분, 곡선은 섹터 세그먼트, 밝기 오차는 스칼라, 주기 범위 열 추가, 캐시 Redis, 스냅샷 PostgreSQL |
| 아키텍처 문서 | 불변 규칙 5(곡선 본문은 EC2 Gold 파일)와 데이터 소유권 표 수정 필요 |
| 용량 | 별당 약 70KB(2섹터 기준, 전환 중 staging+current 2벌). 별 20만 개에 약 14GB. 이전 판을 남기지 않고 세그먼트는 revision이 같으면 판 사이에 공유한다. 실측 후 조정(미결 11) |

### v0.1 → v0.2 변경 요약

| 결정 | ERD 반영 |
|---|---|
| 1 등급 = 성과 수 문자, 별 열림 = 성과 1건당 1개 | user_star_progress에서 유형별 등급 열 제거, achievement_count 저장(등급 문자는 계산). star_unlocks.unlock_reason에 achievement, trigger_achievement_id 추가. trigger_grade·completion 삭제 |
| 2 완료 보상 없음 | user_star_progress.discovery_granted 삭제 |
| 3 무신호 별 제외 | completion_reason에서 empty_star 삭제, tutorial_stars.intent empty → multi_fp, fp_success = 실제 FP 판단 성공만 |
| 4 공식 신호 스레드·공개 분석 | posts.kind(user/system_thread)+candidate_id, published_analyses·post_source_links 신설. posts.fixed_block·source_submission_id 삭제(분석글 폐지). 미확정 성과 근거 = recognized_analysis_id |
| 5 번들 보존·재현 | submissions에 절대값(phase·epoch·duration·fold_reference_time·계산 버전) 저장, analysis_snapshots 신설(접힌 곡선 축약), publication_bundles.status에 expired, derived_curve_cache 상태 6단계·결과 참조 2개, submissions.retry_of_submission_id |
| 6 운영 v1 제외 | reports·audit_events·expert_reports 없음. hidden 상태값만 유지 |
| 7 통계 | seq 열 없음(id 순). 채점형 통계는 submissions만으로 계산, 전체 통계는 materialized view |
| 8·9 | 재도전 복원은 snapshot_params JSON + submissions 조인. 미세 조정 범위는 manifest 규칙 + API 계산 |
| v0.11 | light_curves.fold_reference_time_btjd·mask_path, 근거 체크 4종 + centroid_data_status |

## 1. 한눈에 보기

일곱 묶음, 총 38개 테이블 + materialized view 1개. V24의 탈퇴 요청과 정리 함수, V25의 NASA 조회 자료, V26의 한국어 설명, 269의 V27 봉우리 제출 제약, V28의 모델 일별 시도 수, V30의 챌린지 추가 대상은 대상 환경에서 적용 이력을 확인한다.

| 묶음 | 테이블 | 역할 |
|---|---|---|
| A 회원 | users, user_settings, follows, withdrawal_requests | 계정·설정·팔로우(P1)·탈퇴 처리 상태 |
| B 별·공개 데이터 카탈로그 | stars, observation_datasets, publication_bundles, light_curve_segments, periodograms, candidates, candidate_aliases, external_signal_references, candidate_dispositions, candidate_status_history, ai_executions, ai_evaluations | 배치가 적재한 Gold 릴리스의 본문(배열)과 메타데이터. 서비스는 읽기만 |
| C 분석·제출 | submissions, analysis_histories, analysis_snapshots | 제출·불변 히스토리·접힌 곡선 스냅샷 |
| D 성과·진행·발견 | user_candidate_achievements, user_star_progress, star_unlocks | 성과(별 열림의 원인)·별 진행·별 지도 자리 |
| E 커뮤니티 | posts, comments, post_reactions, post_history_attachments, comment_history_attachments, published_analyses, post_source_links | 일반 글·공식 신호 스레드·공개 분석·출처 링크 |
| F 운영·챌린지·알림·통계 | operation_settings, tutorial_stars, challenge_rounds, challenge_round_extra_targets, (view) challenge_round_targets, notifications, notification_outbox, notification_events, notification_signal_state, notification_candidate_changes, stats_snapshots, (mv) global_stats | 운영 설정·파생 데이터 |
| G 외부 조회 자료 | nasa_planet_info, nasa_planet_explanation, nasa_explanation_daily_usage, nasa_explanation_daily_total, nasa_star_catalog, nasa_star_planet, nasa_star_planet_explanation | 266 후보별·270 항성별 NASA PS 정규화 자료, 267·270 설명, 268 모델 시도 한도. Gold와 별도 소유 |

## 2. ERD

아래 기존 전체 SVG는 v1.10 그림에 V23 알림 확장 패널을 덧붙인 보조 자료다. V24~V30 신규 관계와 제약의 최신 본문은 아래 Mermaid·열 표이고, V25·V26·V28·V29의 NASA 자료 관계는 [전용 SVG](../images/nasa-planet-info-erd.svg)로도 그렸다. 기존 전체 SVG의 재생성은 별도 시각 인수 대상이다.

- [관계 개요](../images/database-erd-overview.svg)
- [전체 (열 포함)](../images/database-erd.svg)


관계선은 FK 방향이다. 속성은 핵심만 적었고 전체 열은 3장에 있다. 우선순위: P1 = user_settings·follows·notifications·stats_snapshots, 나머지는 P0. (ER 다이어그램의 classDef 색 지정은 mermaid 11.4까지 파싱 오류를 내므로 넣지 않았다.)

```mermaid
erDiagram
    users ||--o| user_settings : has
    users ||--o{ follows : follows
    users ||--o{ submissions : submits
    users ||--o{ analysis_histories : owns
    users ||--o{ user_candidate_achievements : earns
    users ||--o{ user_star_progress : tracks
    users ||--o{ star_unlocks : discovers
    users ||--o| member_sky_revisions : versions
    users o|--o{ posts : writes
    users ||--o{ comments : writes
    users ||--o{ post_reactions : reacts
    users ||--o{ published_analyses : publishes
    users ||--o{ notifications : receives
    users ||--o{ nasa_explanation_daily_usage : model_attempts

    stars ||--o{ observation_datasets : observed_in
    stars ||--o{ publication_bundles : published_as
    stars ||--o{ light_curve_segments : segments
    publication_bundles ||--o| periodograms : periodogram
    stars ||--o{ candidates : has
    publication_bundles ||--o{ candidates : last_updated_by
    candidates ||--o{ candidate_aliases : aliases
    candidates ||--o{ external_signal_references : matched_to
    candidates ||--o| nasa_planet_info : requested_nasa_info
    stars ||--o{ nasa_planet_info : host
    nasa_planet_info ||--o| nasa_planet_explanation : has_explanation
    stars ||--o| nasa_star_catalog : nasa_catalog
    nasa_star_catalog ||--o{ nasa_star_planet : lists
    nasa_star_planet ||--o| nasa_star_planet_explanation : has_explanation
    candidates ||--o| candidate_dispositions : classified
    candidates ||--o{ candidate_status_history : changes
    candidates ||--o{ ai_evaluations : scored
    ai_executions ||--o{ ai_evaluations : produces

    stars ||--o{ submissions : target
    publication_bundles ||--o{ submissions : fixed_bundle
    candidates o|--o{ submissions : matched
    submissions o|--o{ submissions : retry_of
    submissions ||--|| analysis_histories : creates
    analysis_histories ||--o| analysis_snapshots : folded_snapshot

    candidates ||--o{ user_candidate_achievements : achievement_of
    submissions ||--o{ user_candidate_achievements : recognized_by
    published_analyses o|--o{ user_candidate_achievements : unconfirmed_basis
    user_candidate_achievements ||--o{ star_unlocks : opens
    stars ||--o{ user_star_progress : progress_of
    stars ||--o{ star_unlocks : unlocked
    star_unlocks }o--o| stars : triggered_by

    stars o|--o{ posts : star_board
    candidates o|--o| posts : system_thread
    posts ||--o{ comments : replies
    posts ||--o{ post_reactions : reactions
    posts ||--o{ published_analyses : lists
    candidates ||--o{ published_analyses : signal
    analysis_histories ||--o| published_analyses : published_record
    posts ||--o{ post_history_attachments : attaches
    analysis_histories ||--o{ post_history_attachments : attached
    comments ||--o{ comment_history_attachments : attaches
    analysis_histories ||--o{ comment_history_attachments : attached
    posts o|--o{ post_source_links : from_post
    comments o|--o{ post_source_links : from_comment

    operation_settings ||--o{ submissions : judged_by
    stars ||--o{ tutorial_stars : tutorial
    stars ||--o{ challenge_rounds : target
    challenge_rounds ||--o{ challenge_round_extra_targets : extra_targets
    stars ||--o{ challenge_round_extra_targets : extra_target

    users["users · 회원"] {
        bigint id PK "고유 번호"
        text provider "로그인 제공자 · ssafy/google"
        text provider_user_id "제공자 쪽 회원 ID"
        text nickname UK "닉네임(상시 변경)"
        text role "member/operator"
        text status "active/withdrawn"
        timestamptz created_at "생성 시각"
        timestamptz withdrawn_at "탈퇴 시각"
    }
    user_settings["user_settings · 회원 설정"] {
        bigint user_id PK, FK "회원"
        boolean star_list_public "내 별 목록 공개"
        jsonb notification_prefs "6종 알림 설정"
        jsonb notification_epochs "종류별 OFF 전환 횟수"
        boolean onboarding_done "첫 방문 안내 완료"
    }
    follows["follows · 팔로우(P1)"] {
        bigint id PK "고유 번호"
        bigint user_id FK "팔로우한 회원"
        text target_type "user/star"
        bigint target_id "대상 회원 또는 별"
        timestamptz created_at "생성 시각"
    }
    withdrawal_requests["withdrawal_requests · 탈퇴 처리"] {
        uuid id PK "불투명 요청 ID"
        bigint user_id UK "탈퇴 당시 회원 ID(FK 없음)"
        text policy_version "동의한 버전"
        text receipt_hash "영수증 토큰 해시"
        text status "READY/PROCESSING/COMPLETED/FAILED"
        timestamptz effective_at "T 기록"
        timestamptz completed_at "C 기록"
        int attempts "정리 시도 수"
    }
    stars["stars · 별"] {
        bigint tic_id PK "별(TIC)"
        numeric teff_k "표면 온도(K)"
        numeric radius_rsun "반지름(태양=1)"
        numeric tmag "TESS 밝기 등급"
        smallint confirmed_count "후보표의 확정 행성 수"
        text service_status "hidden/published"
        boolean board_open "한 번 열린 공개 게시판"
    }
    observation_datasets["observation_datasets · 관측 회차"] {
        bigint id PK "고유 번호"
        bigint tic_id FK "별"
        smallint sector "섹터"
        numeric start_btjd "시작(BTJD)"
        numeric end_btjd "끝(BTJD)"
        text cadence "촬영 간격"
        text source_version "원천 버전"
        text time_system "시각 체계"
    }
    publication_bundles["publication_bundles · 공개 데이터 판"] {
        bigint id PK "고유 번호"
        bigint tic_id FK "별"
        text bundle_version "판 버전"
        text status "staging/current/archived"
        jsonb manifest "세그먼트 id 집합·checksum·계산 버전·격자 규칙"
        double fold_reference_time_btjd "위상 접기 기준 시각"
        numeric base_days "관측 기간(일)"
        timestamptz published_at "공개 시각"
    }
    light_curve_segments["light_curve_segments · 섹터별 곡선(revision 단위 불변)"] {
        bigint id PK "고유 번호"
        bigint tic_id FK "별"
        smallint sector "섹터"
        text binning_revision "원천·전처리·비닝 설정 버전"
        double start_btjd "첫 점 시각"
        numeric bin_minutes "비닝 간격(분)"
        integer n_points "점 수"
        real_array flux "정규화 밝기 배열"
        numeric flux_scatter "세그먼트 robust 산포"
        jsonb gaps "빈 구간 인덱스"
    }
    periodograms["periodograms · 판별 주기도"] {
        bigint bundle_id PK, FK "공개 데이터 판"
        numeric period_min_days "주기 축 시작"
        numeric period_max_days "주기 축 끝"
        integer n_periods "격자 점 수"
        real_array power "세기 배열"
    }
    candidates["candidates · 후보(신호)"] {
        bigint id PK "고유 번호 · 판이 바뀌어도 유지"
        bigint tic_id FK "별"
        text status "active/retired"
        bigint updated_bundle_id FK "마지막 갱신 판"
        smallint removal_step "배치 제거 순번"
        numeric period_days "주기(일)"
        numeric epoch_btjd "중심 시각"
        numeric duration_hours "지속시간"
        numeric depth_ppm "깊이"
        numeric bls_power "BLS 세기"
        jsonb transit_model "통과 모델 파라미터"
        boolean discoverable "현재 데이터로 찾을 수 있는지"
        boolean is_confirmed "외부 확정 여부"
    }
    candidate_aliases["candidate_aliases · 배수 별칭"] {
        bigint id PK "고유 번호"
        bigint candidate_id FK "후보"
        numeric multiplier "배수"
        numeric alias_period_days "별칭 주기"
    }
    external_signal_references["external_signal_references · 외부 카탈로그"] {
        bigint id PK "고유 번호"
        bigint candidate_id FK "후보(NULL 가능)"
        text source "원천 표기(고정 enum 아님)"
        text external_id "원천 ID"
        text disposition "원천 판정"
        numeric period_days "주기"
        date fetched_on "조회일"
        bigint tic_id FK "별"
        numeric epoch_btjd "원천 epoch(BTJD·NULL 가능)"
    }
    nasa_planet_info["nasa_planet_info · 요청된 NASA 자료"] {
        bigint candidate_id PK, FK "내부 확정 후보"
        bigint tic_id FK "항성 TIC"
        text archive_planet_name "조회 대상으로 선택한 pl_name"
        text status "ready/not_found/identity_unresolved 등"
        jsonb normalized "PS 기본 해·단위·오차·출처"
        text source_hash "정규화 SHA-256"
        smallint source_version "계약 버전"
        timestamptz fetched_at "정상 조회"
        timestamptz changed_at "정규화 변경"
        timestamptz next_refresh_at "다음 재확인"
        bigint attempt_generation "경합 순번"
    }
    nasa_planet_explanation["nasa_planet_explanation · 검증된 한국어 설명"] {
        bigint candidate_id PK, FK "NASA 자료의 내부 후보"
        text source_hash "설명 원천 SHA-256"
        smallint source_version "정규화 계약 버전"
        text model_name "사용 모델"
        text prompt_version "프롬프트 계약 버전"
        text status "pending/ready/failed"
        jsonb content "검증된 다섯 설명 문장"
        timestamptz generated_at "성공 생성 시각"
        timestamptz next_retry_at "다음 설명 시도 가능 시각"
        timestamptz in_flight_until "생성 임대 만료"
        bigint attempt_generation "경합 순번"
        smallint attempt_count "동일 조합 시도 횟수"
    }
    nasa_star_catalog["nasa_star_catalog · TIC별 NASA 목록"] {
        bigint tic_id PK, FK "항성 TIC"
        text status "pending/ready/empty/partial/일시 장애"
        text host_name "NASA 항성명·NULL 가능"
        timestamptz fetched_at "마지막 성공 조회"
        timestamptz next_refresh_at "다음 재확인"
        timestamptz in_flight_until "목록 조회 임대"
        bigint attempt_generation "늦은 결과 차단"
        text last_refresh_status "최근 시도 상태"
    }
    nasa_star_planet["nasa_star_planet · 외부 행성별 원천"] {
        bigint tic_id PK, FK "목록의 항성"
        text planet_id PK "np-와 SHA-256"
        text planet_name UK "같은 TIC 안의 정확한 pl_name"
        boolean active "현재 목록 포함 여부"
        text status "ready/identity_unresolved/invalid_source"
        jsonb normalized "검증된 PS 기본 해"
        text source_hash "정규화 SHA-256"
        smallint source_version "계약 버전"
        timestamptz fetched_at "해당 행성 조회"
        timestamptz changed_at "정규화 변경"
    }
    nasa_star_planet_explanation["nasa_star_planet_explanation · 외부 행성 설명"] {
        bigint tic_id PK, FK "행성의 항성"
        text planet_id PK, FK "외부 행성 ID"
        text source_hash "설명 원천 SHA-256"
        smallint source_version "정규화 계약 버전"
        text model_name "사용 모델"
        text prompt_version "설명 계약 버전"
        text status "pending/ready/failed"
        jsonb content "검증된 다섯 문장"
        timestamptz generated_at "성공 생성 시각"
        timestamptz next_retry_at "다음 시도 가능 시각"
        timestamptz in_flight_until "설명 생성 임대"
        bigint attempt_generation "늦은 결과 차단"
        smallint attempt_count "동일 조합 1~3회"
    }
    nasa_explanation_daily_usage["nasa_explanation_daily_usage · 회원별 모델 시도"] {
        date usage_day PK "UTC 날짜"
        bigint member_id PK, FK "회원·삭제 시 정리"
        integer attempt_count "양수·일별 시도권 수"
    }
    nasa_explanation_daily_total["nasa_explanation_daily_total · 전체 모델 시도"] {
        date usage_day PK "UTC 날짜"
        integer attempt_count "양수·회원 삭제 뒤에도 보존"
    }
    candidate_dispositions["candidate_dispositions · 통합 분류"] {
        bigint candidate_id PK, FK "후보"
        text disposition "confirmed/fp/pc/none"
        text answer_class "graded/analysis"
        text planet_truth "planet/not_planet/null"
        text rule_version "규칙 버전"
        timestamptz applied_at "적용 시각"
        jsonb source_refs "판정 근거 참조"
    }
    ai_evaluations["ai_evaluations · AI 평가"] {
        bigint id PK "고유 번호"
        bigint candidate_id FK "후보"
        bigint execution_id FK "실행"
        numeric score "점수"
        text verdict "rejected/hold/approved"
        text threshold_version "임계값 버전"
        jsonb raw_output "모델 원본 출력(NULL 가능)"
    }
    submissions["submissions · 제출"] {
        bigint id PK "고유 번호 · 동률 순서"
        bigint user_id FK "회원"
        bigint tic_id FK "별"
        bigint bundle_id FK "판정 당시 판"
        uuid request_id UK "멱등 요청 ID"
        text request_hash "정규화 SHA-256"
        smallint request_hash_version "정규화 버전 1"
        jsonb response_snapshot "최초 성공 응답"
        text submission_kind "candidate/no_candidate/skipped"
        smallint curve_step "곡선 단계"
        bigint_array removed_candidate_ids "뺀 후보(정렬)"
        numeric submitted_period "제출 주기"
        int source_peak_grid_index "선택 봉우리 · 직접 선택은 NULL"
        numeric source_peak_suggested_duration_hours "검증에 쓴 제안값"
        numeric duration_limit_hours "적용한 선택 폭 상한"
        numeric matched_period "정정 대표 주기"
        numeric harmonic_multiplier "배율"
        text correction_reason "정정 사유"
        numeric phase_start "위상 시작"
        numeric phase_end "위상 끝"
        double fold_reference_time_btjd "그때 기준 시각"
        numeric epoch_btjd "서버 파생 epoch"
        numeric duration_hours "서버 파생 지속시간"
        text user_judgment "LIKELY/UNLIKELY/UNSURE"
        jsonb evidence_checks "근거 3종"
        text match_result "판정 결과"
        bigint matched_candidate_id FK "일치 후보"
        text achievement_result "성과 결과"
        bigint retry_of_submission_id FK "재도전 원 제출"
        boolean answer_viewed "상세 열람"
        timestamptz created_at "접수 시각"
        text residual_model_version "그때 잔차 계산 버전"
        text periodogram_config_version "그때 주기도 계산 버전"
        text memo "회원 메모"
        text rule_version FK "판정에 쓴 운영 규칙 버전"
    }
    analysis_histories["analysis_histories · 분석 히스토리(불변)"] {
        bigint id PK "고유 번호"
        bigint submission_id UK, FK "제출"
        bigint user_id FK "회원"
        bigint tic_id FK "별"
        jsonb snapshot_params "재현 파라미터"
        jsonb versions "데이터·계산 버전"
        timestamptz created_at "생성 시각"
    }
    analysis_snapshots["analysis_snapshots · 접힌 곡선 축약"] {
        bigint history_id PK, FK "히스토리"
        smallint bins "구간 수(150)"
        real_array folded_flux "구간별 밝기 중앙값"
        real_array folded_err "구간별 오차"
        timestamptz created_at "생성 시각"
    }
    user_candidate_achievements["user_candidate_achievements · 성과(별 열림 원인)"] {
        bigint id PK "고유 번호"
        bigint user_id FK "회원"
        bigint candidate_id FK "후보"
        text achievement_type "confirmed/unconfirmed/fp"
        bigint recognized_submission_id FK "근거 제출"
        bigint recognized_analysis_id FK "근거 공개 분석(미확정)"
        timestamptz recognized_at "인정 시각"
        timestamptz relabeled_at "라벨 갱신 표식"
        text relabel_disposition "갱신된 외부 판정"
    }
    user_star_progress["user_star_progress · 회원 별 진행"] {
        bigint id PK "고유 번호"
        bigint user_id FK "회원"
        bigint tic_id FK "별"
        smallint planet_count "찾은 행성 수(색·궤도)"
        smallint achievement_count "성과 수(등급 문자)"
        boolean fp_success "FP 판단 성공 있음"
        text progress_stage "unexplored/in_progress/completed"
        smallint current_curve_step "현재 곡선 단계"
        text completion_reason "all_found/undiscoverable_only/skipped"
        boolean reopen_pending "재개 대기"
        timestamptz completed_at "완료 시각"
        timestamptz reopened_at "재개 시각"
    }
    star_unlocks["star_unlocks · 별 발견·자리"] {
        bigint id PK "고유 번호"
        bigint user_id FK "회원"
        bigint tic_id FK "별"
        text unlock_reason "tutorial/achievement/challenge"
        bigint trigger_tic_id FK "발견을 일으킨 별"
        bigint trigger_achievement_id FK "원인 성과"
        smallint seq "한 성과가 연 별 중 순번"
        numeric world_x "은하 월드 X"
        numeric world_y "은하 월드 Y"
        numeric depth_z "정규화 깊이 -1~1"
        text layout_version "배치 버전"
        integer layout_ordinal "회원별 안정 순번 UNIQUE user_id와 조합"
        smallint generation "이전 배치 세대(선택)"
        numeric angle_deg "이전 배치 각도(선택)"
        numeric radius_jitter "이전 배치 지터(선택)"
        timestamptz unlocked_at "발견 시각"
    }
    member_sky_revisions["member_sky_revisions · 회원 지도 개정값"] {
        bigint user_id PK "회원"
        bigint revision "단조 증가 개정값"
        timestamptz updated_at "마지막 증가 시각"
    }
    posts["posts · 일반 글 / 공식 신호 스레드"] {
        bigint id PK "고유 번호"
        text kind "user/system_thread"
        bigint user_id FK "작성자(system_thread는 NULL)"
        bigint candidate_id FK "공식 스레드의 신호"
        text board "star/free"
        bigint tic_id FK "별(free는 NULL)"
        text tag "대표 태그"
        text title "제목"
        text body "본문"
        text status "visible/hidden/deleted"
        timestamptz author_withdrawn_at "원 작성자 탈퇴 시각"
        timestamptz created_at "생성 시각"
    }
    comments["comments · 답글"] {
        bigint id PK "고유 번호"
        bigint post_id FK "원글·스레드"
        bigint user_id FK "회원"
        text body "본문"
        text status "visible/hidden/deleted"
        timestamptz author_withdrawn_at "원 작성자 탈퇴 시각"
        timestamptz created_at "생성 시각"
    }
    post_reactions["post_reactions · 동의·비동의"] {
        bigint id PK "고유 번호"
        bigint post_id FK "일반 글만"
        bigint user_id FK "회원"
        text reaction "agree/disagree"
        timestamptz updated_at "수정 시각"
    }
    published_analyses["published_analyses · 공개 분석"] {
        bigint id PK "고유 번호"
        bigint post_id FK "공식 스레드"
        bigint user_id FK "작성자"
        bigint candidate_id FK "신호"
        bigint history_id UK, FK "본인 히스토리"
        timestamptz published_at "공개 시각"
        timestamptz unpublished_at "본인 취소"
        timestamptz hidden_at "운영 숨김(DB 설정)"
        timestamptz withdrawn_at "탈퇴로 공개 철회"
    }
    post_source_links["post_source_links · 출처 링크 카드"] {
        bigint id PK "고유 번호"
        bigint post_id FK "글(둘 중 하나)"
        bigint comment_id FK "답글(둘 중 하나)"
        text target_type "thread/analysis"
        bigint target_id "대상 ID"
        timestamptz created_at "생성 시각"
    }
    post_history_attachments["post_history_attachments · 글 첨부"] {
        bigint id PK "고유 번호"
        bigint post_id FK "글"
        bigint history_id FK "히스토리"
    }
    comment_history_attachments["comment_history_attachments · 답글 첨부"] {
        bigint id PK "고유 번호"
        bigint comment_id FK "답글"
        bigint history_id FK "히스토리"
    }
    tutorial_stars["tutorial_stars · 튜토리얼 설정"] {
        smallint seq PK "순번 1~5"
        bigint tic_id FK "별"
        text intent "deep_confirmed/shallow_confirmed/fp/deep_fp/multi_fp"
        boolean active "사용 중"
    }
    challenge_rounds["challenge_rounds · 주간 챌린지"] {
        bigint id PK "고유 번호"
        integer round_no UK "회차"
        date starts_on "시작일"
        date ends_on "종료일"
        bigint target_tic_id FK "대표 대상 별"
        text description "한 줄 설명"
        text status "planned/active/closed"
        timestamptz notification_started_at "최초 알림 시작 경계"
    }
    challenge_round_extra_targets["challenge_round_extra_targets · 챌린지 추가 대상"] {
        bigint round_id PK, FK "회차"
        bigint tic_id PK, FK "추가 대상 별"
    }
    notifications["notifications · 알림"] {
        bigint id PK "고유 번호"
        bigint user_id FK "회원"
        text type "종류"
        jsonb payload "내용"
        text event_key "불변 원인 키, 기존 NULL"
        timestamptz published_at "최초 발행 시각"
        bigint publication_seq "회원별 발행 순번"
        timestamptz read_at "읽은 시각"
        timestamptz created_at "생성 시각"
    }
    notification_outbox["notification_outbox · 수신 의도"] {
        bigint id PK "고유 번호"
        text event_key "불변 원인 키"
        bigint user_id "수신자, 발행 시 검사"
        text type "6종 알림"
        jsonb payload "사건 내용"
        bigint preference_epoch "당시 OFF 세대"
        bigint follow_id "당시 관계"
        bigint follow_epoch "별 구독 재개의 FOLLOW 세대"
        bigint source_notification_id "재개 원본"
        text state "pending/delivered/excluded"
        timestamptz recorded_at "기록 시각"
    }
    notification_events["notification_events · 원천 사건"] {
        bigint id PK
        text event_key UK
        text type
        jsonb payload
        timestamptz occurred_at
    }
    notification_signal_state["notification_signal_state · 마지막 유효 판정"] {
        bigint candidate_id PK,FK
        text disposition
        text ai_verdict
    }
    notification_candidate_changes["notification_candidate_changes · 판 게시 전 변화"] {
        bigint bundle_id PK,FK
        bigint candidate_id PK,FK
        boolean was_discoverable
        boolean is_discoverable
    }
    global_stats["global_stats · 전체 통계 MV"] {
        integer singleton UK "한 행 유일 키"
        timestamptz as_of "원천 기준 시각"
        timestamptz generated_at "집계 생성 시각"
        jsonb payload "비식별 전체 통계"
    }
    stats_snapshots["stats_snapshots · 통계 일일 집계"] {
        bigint id PK "고유 번호"
        date snapshot_date "집계일"
        text scope "global/round"
        jsonb metrics "지표"
    }
    operation_settings["operation_settings · 운영 설정(버전별)"] {
        text rule_version PK "규칙 버전"
        jsonb values "설정 값 묶음"
        timestamptz applied_at "적용 시각"
        text note "변경 사유"
    }
    ai_executions["ai_executions · AI 실행"] {
        bigint id PK "고유 번호"
        text model_version "모델 버전"
        text checkpoint "체크포인트"
        text status "상태"
        timestamptz started_at "시작"
        text error "실패 사유(NULL 가능)"
        bigint duration_ms "소요 시간(ms·NULL 가능)"
    }
    candidate_status_history["candidate_status_history · 후보 변경 이력"] {
        bigint id PK "고유 번호"
        bigint candidate_id FK "후보"
        bigint bundle_id FK "판"
        text field "항목"
        text old_value "이전"
        text new_value "이후"
        timestamptz changed_at "변경 시각"
        text rule_version "규칙 버전"
        text reason "사유(NULL 가능)"
    }

```

## 3. 테이블 정의

### A. 회원

**users** (ACC-01·02·05, DEC-11): provider·provider_user_id UNIQUE, nickname UNIQUE + `UNIQUE (lower(nickname))` 함수 인덱스(영문 대소문자 무시 중복 검사, 서비스 API SB-D14. 상시 변경, 게시글에 복사 저장 안 함), role member/operator(운영 화면은 없지만 DB 직접 조작 권한 구분용), status active/withdrawn.

**V24 탈퇴 경계:** T에서 `users.status=withdrawn`으로 차단하고 C에 개인 행을 삭제한다. 일반 글·댓글은 내부 공통 작성자(-1)로 재연결하므로 원 제공자 ID·닉네임과 내부 회원 ID를 공개 작성자 응답에 남기지 않는다. `withdrawal_requests`는 FK 없는 탈퇴 당시 회원 ID, 동의 정책 버전, 영수증 토큰 해시와 T/C·재시도 상태를 신청 후 90일만 보관한다. 실제 실행은 `planetory.withdrawal.enabled=true`를 명시한 환경에서만 가능하며 기본은 비활성이다. C 함수는 withdrawn 회원만 처리하고 앱 역할에 함수 실행 권한만 준다. [정책값](../requirements/planetory-decision-register.md#dec-11)을 따른다.

**user_settings** (MY-04, HOME-09, DEC-34) — 1:1: star_list_public DEFAULT true, notification_prefs JSONB(achievement/reopen/challenge/follow/comment/relabel 6종 true), notification_epochs JSONB(종류별 OFF 전환 횟수, 기본 {}), onboarding_done. V23은 기존 true/false를 보존하고 누락된 지원 키만 true로 보충한다.

**follows** (COM-16, P1): user_id = 팔로우한 회원, target_type user/star, target_id. UNIQUE(user_id, target_type, target_id). target은 다형 참조라 FK 없이 서비스에서 검증하며 user_id는 users FK다. 173은 기존 테이블·IDENTITY·created_at을 재사용한다. V20은 앱 SELECT·INSERT·DELETE만 추가하고 UPDATE·TRUNCATE를 금지한다(V11 sequence 권한 재사용). 반복 PUT은 created_at을 유지한다. 사용자 승인(2026-09-22)에 따른 현재 유효 관계·개인 관리 ID·탈퇴 제외 계약은 [서비스 API 12.1](../../apps/backend/docs/service-api-spec.md#follow-policy)을 따른다. 원천 보관/탈퇴 삭제·익명화·마지막 발견자 공개 자격은 별도 미정이다. 테이블·열·관계선 변경이 없어 ERD SVG는 변경하지 않는다.

### B. 별·공개 데이터 카탈로그 (Gold 메타데이터)

배치가 Gold 릴리스 전환 때 적재하고 서비스 API는 읽기만 한다. 릴리스 교체는 publication_bundles.status를 current로 바꾸는 트랜잭션 하나로 끝낸다.

**stars**: tic_id PK, teff_k·radius_rsun·tmag(본인 상세는 셋 다, 공개 요약은 tmag만. 값이 없으면 `null`. 탐사 API D-18), confirmed_count(후보표의 확정 후보 수, 화면은 0 여부만), service_status hidden/published, `board_open`(첫 발견 시 true, 마지막 발견자 탈퇴·삭제로 닫히지 않음). **자체 BLS 채택 신호가 0개인 별은 배치가 적재하지 않는다(결정 3).**

**observation_datasets**: tic_id, sector, start_btjd, end_btjd, cadence, time_system, source_version. UNIQUE(tic_id, sector, source_version).

**publication_bundles** (DAT-11, POL-03, 결정 5)

| 열 | 비고 |
|---|---|
| tic_id, bundle_version | Publisher 멱등 키. `UNIQUE(tic_id, bundle_version)`가 필요하며 현재 migration에는 없으므로 `S15P21C206-86`에서 추가·검증한다. |
| status | staging / current / archived. `UNIQUE(tic_id) WHERE status='current'`. 즉시 검사되는 부분 유일 인덱스이므로 기존 current를 먼저 archived로 전환한 뒤 신규 staging을 current로 올린다. 그 판의 periodograms 행은 지우고 제출 FK가 참조하는 Bundle 행은 남긴다(v0.3 결정 C) |
| manifest JSONB | **참조할 light_curve_segments id 집합**(섹터 목록이 아니라 revision까지 특정한다), 배열 checksum, residual_model_version, periodogram_config_version, **곡선 비닝 규칙(기본 10분)**, 주기 격자 범위·간격 규칙, 미세 조정 허용 폭(결정 9), 곡선 단계 규칙 |
| fold_reference_time_btjd, base_days | Bundle 공통 위상 접기 기준 시각과 관측 기간. 기준 시각은 포함된 모든 세그먼트에서 품질 필터를 통과하고 중복을 제거한 유한 원본 관측 시각 전체의 중앙값이며, 짝수 표본은 가운데 두 값의 평균을 쓴다. 유효 입력이 없으면 공개를 실패시킨다. `publication_bundles`에 한 번 저장하고 `light_curve_segments`에는 저장하지 않으며, 섹터가 늘면 새 판에서 다시 산정한다 |
| published_at | archived 전환 시 그 판의 periodograms 행과 Redis 캐시를 정리한다. 곡선 세그먼트는 판에 묶이지 않으므로 지우지 않는다. 판 행 자체는 제출이 참조하므로 남긴다(수백 바이트) |

**light_curve_segments** (EXP-01·03·06, DAT-11, v0.3)

곡선을 **별·섹터 단위**로 담는다. 한 섹터의 관측은 끝나면 다시 바뀌지 않으므로 이 행은 불변이고, 새 섹터가 오면 INSERT만 한다. 판(bundle)에 묶지 않아서 판을 여러 개 보존해도 곡선은 한 벌이다.

| 열 | 비고 |
|---|---|
| tic_id, sector, binning_revision | UNIQUE(tic_id, sector, binning_revision). observation_datasets와 같은 섹터 단위이고, 원천·전처리·비닝 설정이 바뀌면 기존 행을 덮어쓰지 않고 새 revision 행을 만든다 |
| start_btjd DOUBLE PRECISION, bin_minutes, n_points | **시각 배열은 저장하지 않는다.** i번째 점의 시각 = `start_btjd + (bin_minutes / 1440.0) × i` (BTJD는 일 단위이므로 분을 일로 환산한다). `start_btjd`는 첫 bin의 시작 시각이다. 섹터 안에서 균등 격자이므로 계산으로 충분하다 |
| flux `real[]` | 품질 필터 후 10분 간격으로 비닝한 밝기. 길이 = n_points. 원소는 유한수 또는 NULL(빈 bin)이며 CHECK가 NaN·±Infinity를 거절한다(V10) |
| flux_scatter | 세그먼트 전체의 robust 산포 하나. 통과 신호·별 변동을 포함하며 점별 측정 오차나 같은 오차를 보장하지 않는다. 식·부분 bin·운영 상한은 [Gold 114 채택안](../../contracts/gold/README.md#41-s15p21c206-114-비닝-운영-채택안)을 따른다(운영 구현은 123 범위) |
| gaps JSONB | 그 섹터 안의 빈 구간 인덱스. `[start, end]` 폐구간 배열이다. 균등 격자를 유지하려고 빈 칸은 `flux`에 NULL로 두며 NaN을 쓰지 않는다 |

섹터 사이의 긴 공백(길게는 수년)은 행을 나눠서 표현한다. 전체 기간에 균등 격자를 걸면 대부분이 빈 칸이 되므로 섹터 단위가 맞다.

**periodograms** (EXP-04, v0.3) — publication_bundles와 1:1

| 열 | 비고 |
|---|---|
| bundle_id | PK 겸 FK. 후보 탐색 결과가 바뀌면 주기도도 바뀌므로 판에 묶는다. **current 판 것만 유지**하므로 별당 한 행이다 |
| period_min_days, period_max_days | 주기 축 범위. 시작은 0.5일로 공통이고 끝은 그 별 후보표의 최장 주기를 덮는 값(최소 40일)이라 별마다 다르다(EXP-04) |
| n_periods, power `real[]` | 화면 표시용 5,000점. **주기 격자 배열은 저장하지 않는다.** 위 두 값과 manifest의 간격 규칙(로그 등간격)으로 i번째 주기를 계산한다. 봉우리의 정확한 주기는 candidates에 있다. power 원소는 격자 전 점에 값이 있는 유한수이며 CHECK가 NULL·NaN·±Infinity를 거절한다(V10) |

**저장하는 배열과 저장하지 않는 배열.** 시각은 시작 시각과 간격에서, 주기 격자는 범위 두 값과 간격 규칙에서 계산되므로 저장하지 않는다. 배열은 PostgreSQL이 TOAST 영역에 열 단위로 압축 저장하므로, 메타데이터만 읽는 조회는 배열을 건드리지 않는다.

| 저장 방식 | 별당 | 별 20만 개 |
|---|---|---|
| 전 점 time·flux·err·quality (v0.2 파일 방식과 같은 내용) | 약 560KB | 약 110GB |
| 10분 비닝, 네 배열 모두 | 약 130KB | 약 26GB |
| 시각·주기 격자 제거, flux + err | 약 100KB | 약 20GB |
| **flux만 + 산포 스칼라, 전환 중 2벌** | **약 70KB** | **약 14GB** |

**비닝 근거.** 점을 k개씩 묶으면 점 수는 1/k, 점당 잡음은 1/√k가 되어 통과의 신호 대 잡음비는 그대로 유지된다. 조건은 비닝 간격이 통과 지속시간보다 충분히 작아야 한다는 것뿐이다. 그래서 점 수를 고정하지 않고 간격을 고정한다. 점 수를 5,000으로 고정하면 관측 기간이 길수록 간격이 벌어져(섹터 8개면 63분) 3시간 통과가 세 점으로 뭉개지고 근거 체크의 통과 모양 판단이 불가능해진다. 섹터 단위로 나누면 이 문제 자체가 없어져 섹터 수와 무관하게 10분이 유지된다.

**candidates** (POL-10, SUB-03, EXP-04)

| 열 | 비고 |
|---|---|
| id | **판이 바뀌어도 유지.** 새 판에서 같은 신호는 값 갱신, 새 신호는 행 추가, 사라진 신호는 status=retired. 동일성 판단은 배치(DEC-03) |
| tic_id, status active/retired, updated_bundle_id | retired는 매칭 대상 제외, 성과·히스토리 연결 위해 삭제 안 함 |
| removal_step, period_days, epoch_btjd, duration_hours, depth_ppm, bls_power, quality | 자체 BLS 대표값. 미세 조정 범위(period_min/max/step)는 열이 아니라 manifest 규칙으로 API가 계산(결정 9) |
| transit_model JSONB | 통과 모델 파라미터(주기·중심 시각·지속시간·깊이·모양·모델 버전). 잔차 계산은 이 파라미터로 모델을 생성해 원본에서 나눈다(DAT-14 입력) |
| discoverable | 현재 데이터로 찾을 수 있는지(SUB-11 (4)). **사용자에게 제공되는 것과 같은 조건**(같은 비닝 간격·모델·주기 격자 설정)으로 계산한 발견 단계 잔차 주기도에서 봉우리가 잡히는지로 판정하며, 비닝 revision이나 격자 규칙이 바뀌면 새 판을 만들 때 다시 계산한다(명세서 v1.0 DAT-07) |
| is_confirmed | 외부 확정 여부 |

**candidate_aliases** (SUB-04): candidate_id, multiplier(0.5/2/3), alias_period_days.

**external_signal_references** (POL-10): candidate_id NULL 허용, tic_id, source, external_id, period_days, epoch_btjd, disposition(원천 표기), fetched_on.

**candidate_dispositions** (DAT-09, DEC-29) — 1:1: disposition confirmed/fp/pc/none(PC·APC = 분석형), answer_class graded/analysis, planet_truth, source_refs JSONB, rule_version, applied_at. 충돌 여부는 external_signal_references 비교로 계산.

**candidate_status_history** (GRD-06, DAT-15): candidate_id, bundle_id, field, old_value, new_value, rule_version, reason, changed_at. 외부 라벨 갱신·AI 재평가·새 판 적재로 바뀐 값 모두.

**ai_executions / ai_evaluations** (AI-01~04): 실행(model_version, checkpoint, status, error, duration_ms)과 후보별 평가(score, raw_output, threshold_version, verdict rejected/hold/approved).

### C. 분석·제출

**submissions** (SUB-01~12, POL-13, 결정 5·7·8·10)

| 열 | 제약 | 비고 |
|---|---|---|
| user_id, tic_id, bundle_id | FK | bundle_id = 이 제출을 판정한 판. 세션을 그 판에 묶어 두는 것이 아니라 판정 시점 기록이다(v0.3 결정 C) |
| request_id UUID | UNIQUE | 멱등(SUB-09) |
| request_hash, request_hash_version, response_snapshot | CHECK 세 열 NULL 또는 64자리 소문자 해시·버전 1·JSON object 응답(저장 중 NULL 허용) | V12. 최초 응답까지 같은 트랜잭션에 저장한다. 신규 처리의 중간 상태는 커밋하지 않는다. legacy NULL 행은 POST 재처리하지 않는다 |
| submission_kind | CHECK candidate/no_candidate/skipped | skipped = 튜토리얼 건너뛰기(SUB-12) |
| curve_step, removed_candidate_ids BIGINT[] | | 정렬 배열. 잔차 캐시 키·재현 입력 |
| submitted_period, matched_period, harmonic_multiplier, correction_reason | | 원본값 보존(SUB-05) |
| source_peak_grid_index, source_peak_suggested_duration_hours, duration_limit_hours | CHECK `ck_submissions_source_peak_all_or_none` | 봉우리 선택이면 같은 곡선 문맥의 grid index와 서버가 검증에 적용한 제안 duration·3배 상한을 저장한다. 판이 제안 duration을 싣지 않으면(탐사 API 5.4) 상한도 없으므로 둘 다 NULL이다. 제안 duration과 상한은 둘 다 NULL이거나 둘 다 양수이며 한쪽만 채울 수 없다(V27, S15P21C206-269). 주기도 직접 선택은 모두 NULL이며 서버가 period로 봉우리를 추정하지 않는다(C02-R3) |
| phase_start, phase_end | CHECK 0≤start<1, start<end<start+1 | 접힌 곡선 위상 구간이 원본 입력(POL-08). selection_space 없음 |
| fold_reference_time_btjd DOUBLE | | 제출 당시 번들의 기준 시각. 현재 판에서 재현할 때 `phase = ((epoch − 현재 기준시각)/period) mod 1`로 재환산 |
| epoch_btjd, duration_hours | | 서버가 위상값에서 파생해 저장(EXP-06·07). 절대값이라 판이 바뀌어도 의미 유지 |
| residual_model_version, periodogram_config_version | | 제출 당시 계산 버전 |
| user_judgment | CHECK LIKELY_PLANET/UNLIKELY_PLANET/UNSURE, candidate에서만 NOT NULL | |
| evidence_checks JSONB | | P0 3종(oddeven, secondary, ushape) + centroid_data_status=unavailable. 품질 플래그는 배치 전처리에서만 쓰고 화면에 전달하지 않으므로 근거 항목이 아니다(명세서 v1.0 POL-13) |
| memo | | |
| match_result | CHECK matched/matched_harmonic/not_matched/duplicate/ambiguous_match/none_wrong/skipped | none_empty·none_complete 삭제(완료는 서버 판정, 제출이 아님) |
| matched_candidate_id | FK NULL | matched·matched_harmonic·duplicate에서만 |
| achievement_result | CHECK recognized/judgment_mismatch/pending_publish/already_recognized/none | 이번 제출의 성과 결과. 채점형 오판 = judgment_mismatch, 미확정 미공개 = pending_publish |
| retry_of_submission_id | FK NULL | [다시 풀기]로 복원한 원 제출(SUB-10) |
| answer_viewed | | |
| rule_version, created_at | | 동률 정렬은 (created_at, id) — 별도 seq 없음(결정 7-1) |
| 인덱스 | (user_id, tic_id, created_at DESC), (matched_candidate_id, user_id, created_at) | 히스토리 조회, 채점형 통계(결정 7-2: 매칭한 회원의 첫 매칭 제출) |

**튜토리얼 건너뛰기 카운트**(결정 10): 같은 tic_id의 본인 제출 중 `match_result IN (not_matched, none_wrong) OR (match_result IN (matched, matched_harmonic) AND achievement_result = judgment_mismatch)` 건수 ≥ tutorial_skip_after.

**analysis_histories** (HIS-01~06) — submissions와 1:1, 불변

| 열 | 비고 |
|---|---|
| submission_id UNIQUE FK, user_id, tic_id | |
| snapshot_params JSONB | 143은 응답 original과 같은 camelCase 객체를 저장한다. viewState 아래 periodogramViewport·foldedXZoomRatio와 원본 선택·판단·근거·메모. 번들·단계·제거 조합·절대 시각은 submissions를 조인한다. centroid는 현재 unavailable 고정 |
| versions JSONB | ruleVersion·bundleVersion·residualModelVersion·periodogramConfigVersion·snapshotVersion. originalMatch는 duplicate 고조파의 최초 정정 정보도 보존한다 |
| created_at | 애플리케이션 역할에서 UPDATE·DELETE 권한 제거 |

**analysis_snapshots** (HIS-03, 결정 5) — analysis_histories와 1:0..1

| 열 | 비고 |
|---|---|
| history_id PK FK | 매칭 성공 제출(matched·matched_harmonic·duplicate)에만 생성. 불일치 제출은 없음 |
| bins SMALLINT DEFAULT 150 | 위상 구간 수. 구간은 위상 -0.5부터 0.5까지 균등하므로 **위상 값은 저장하지 않는다**. i번째 구간의 위상 = `-0.5 + (i + 0.5) / bins` |
| folded_flux `real[]`, folded_err `real[]` | 구간별 밝기 중앙값과 MAD 산포. 새 제출은 bin 중심 기준 folded-mad-v1, 기존 bin 시작 기준 v0는 보존한다(이력 versions.snapshotVersion으로 구분). 각 150개. 빈 구간 양쪽 NULL, 단일 점은 산포 NULL. 원본 제출 주기로 계산하며 재전송 때 재계산하지 않는다. "제출 당시 / 최신 데이터" 토글용 |
| created_at | **PostgreSQL에 둔다(v0.3 결정).** 다시 만들 수 없는 기록이고 작다. 제출 100만 건이어도 1.2GB |

**잔차·주기도 캐시는 Redis에 둔다** (DAT-14, v0.3 결정)

EC2가 계산한 잔차 곡선과 잔차 주기도는 언제든 다시 만들 수 있는 데이터라 PostgreSQL 테이블을 두지 않는다. 상태와 결과를 모두 Redis에 두고, Redis가 재시작되면 다시 계산한다.

| 항목 | 값 |
|---|---|
| 키 | `tic:{tic_id}:b{bundle_id}:rm{removed_candidate_ids 정렬}:{residual_model_version}:{periodogram_config_version}` |
| 값 | 상태(QUEUED / RESIDUAL_CALCULATING / RESIDUAL_READY / PERIODOGRAM_CALCULATING / COMPLETED / FAILED), 잔차 배열, 주기도 배열, 실패 단계 |
| 중복 계산 방지 | 같은 키를 동시에 요청하면 `SETNX`로 한 번만 계산 |
| 만료 | 판이 `archived`가 될 때, 또는 TTL |

### D. 성과·진행·발견

**user_candidate_achievements** (GRD-01~04, SUB-06, 결정 1·4)

행이 있으면 인정된 것이다. 미인정 상태는 행이 없고 submissions.achievement_result로만 남는다.

| 열 | 제약 | 비고 |
|---|---|---|
| user_id, candidate_id | UNIQUE(user_id, candidate_id) | 같은 신호는 회원당 1회. candidate.id가 판 간 유지되므로 이 제약으로 중복이 막힘 |
| achievement_type | CHECK confirmed/unconfirmed/fp | 통계·결과 표시용. 등급에는 유형 구분 없음 |
| recognized_submission_id | FK | 확정·FP: 매칭+올바른 판단 제출. 미확정: 공개한 히스토리의 제출 |
| recognized_analysis_id | FK published_analyses NULL | 미확정의 인정 근거. 공개 취소·숨김돼도 성과는 유지(GRD-06) |
| recognized_at | | |
| relabeled_at, relabel_disposition | | 외부 라벨 갱신 표식(DEC-26 임시 규칙) |

**별 열림 규칙**(결정 1): 이 행이 INSERT될 때마다 운영 설정 `stars_per_achievement`(기본 1)개의 못 찾은 별을 무작위 발견 처리하고 star_unlocks.trigger_achievement_id로 연결한다. 같은 성과 재처리 시 UNIQUE(trigger_achievement_id, seq)로 중복 방지.

**user_star_progress** (SUB-11, DEC-27, 결정 1·2·3) — UNIQUE(user_id, tic_id)

| 열 | 비고 |
|---|---|
| planet_count | 선택 근접 뷰의 내 행성 수 = 맞춘 확인된 행성 + "행성 같음"으로 판단한 미확정(공개 여부와 무관, HOME-05·결정 22). 최신 판단으로 덮어쓰므로 줄어들 수 있음 |
| achievement_count | 이 별에서 인정된 성과 수(user_candidate_achievements COUNT 저장). 등급 문자 A/S/SS/SSS = 1/2/3/4 이상은 계산값이며 열로 두지 않음 |
| fp_success | 실제 FP 신호의 판단 성공 성과가 1건 이상인 이력 값. 완료/행성 0 판정이나 지도 색 계산에 사용하지 않는다. completedWithoutPlanets는 progress_stage=completed AND planet_count=0에서 파생한다 |
| progress_stage | unexplored / in_progress / completed |
| current_curve_step | |
| completion_reason | all_found / undiscoverable_only / skipped / NULL. empty_star 없음 |
| reopen_pending, completed_at, reopened_at | 재개 시 completed → in_progress(DAT-15) |

완료 자체로는 별을 열지 않는다(결정 2). discovery_granted 없음.

**star_unlocks** (HOME-02, GRD-08, NFR-20c, 결정 1) — UNIQUE(user_id, tic_id)

| 열 | 비고 |
|---|---|
| unlock_reason | tutorial / achievement / challenge. grade·completion 없음 |
| trigger_tic_id, trigger_achievement_id, seq | 발견 경로. achievement면 trigger_achievement_id NOT NULL. seq는 한 성과가 연 별의 순번(0부터, stars_per_achievement가 2 이상일 때 사용)이며 UNIQUE(trigger_achievement_id, seq)로 재처리 중복을 막는다 |
| world_x, world_y, depth_z, layout_version | 서버가 한 번 계산·저장한 은하 월드 좌표와 배치 버전. 모든 열린 별 행은 NOT NULL이고 x/y는 유한 숫자, depth_z는 유한한 -1.0 이상 1.0 이하. 클라이언트는 읽기만 하며 같은 (user_id, tic_id)의 모든 API가 같은 값을 반환한다 |
| layout_ordinal | NOT NULL 정수 0~2147483647, UNIQUE(user_id,layout_ordinal). 발견 종류와 무관한 회원별 안정 순번. 다음 순번은 회원 잠금/원자적 카운터 또는 인덱스 끝값으로 배정한다. 좌표와 함께 확정·롤백하며 재처리 시 증가시키지 않는다. personal-spiral-v1 참조 배치와 연출 시드 입력이며 현재 별 수나 부모 세대가 아니다 |
| generation, angle_deg, radius_jitter | 이전 방사형 스키마의 nullable 폐기 예정 열. 부모 관계는 trigger_tic_id로 유지하며 신규 은하 좌표 생성·조회·API 응답에 이 열을 사용하지 않는다. 열 제거는 별도 백엔드 스키마 정리 대상 |
| unlocked_at | |

**member_sky_revisions** (HOME-01, 탐사 API 4.1) — PK user_id

회원 지도의 단조 증가 개정값. 발견·상태 변경 트랜잭션 안에서 같이 올려 발견과 버전이 어긋나지 않게 한다.

| 열 | 제약 | 비고 |
|---|---|---|
| user_id | PK, FK users(id) | 회원당 한 행 |
| revision | NOT NULL, DEFAULT 1, CHECK > 0 | 단조 증가. 시각에서 파생하지 않으므로 같은 순간의 두 변경도 구분된다 |
| updated_at | NOT NULL | 마지막 증가 시각. 버전 비교에 쓰지 않는 관찰용 값 |

행이 없는 회원의 개정값은 **0**으로 읽는다. 첫 증가가 1을 만들기 때문에 없는 행을 1로 읽으면 첫 변경이 감지되지 않는다. API 응답의 `skyVersion`은 `u-<user_id>:<revision>` 문자열이고 프론트는 문자열로만 비교한다. 앱 역할은 SELECT·INSERT·UPDATE만 가지며 DELETE·TRUNCATE는 회수한다.

### E. 커뮤니티 (결정 4·6)

**posts** (COM-01·04·05·15·17, POL-16)

| 열 | 제약 | 비고 |
|---|---|---|
| kind | CHECK user/system_thread | system_thread = 공식 신호 스레드(첫 공개 분석 등록 시 SYSTEM 생성) |
| user_id | FK, kind=user면 NOT NULL, system_thread면 NULL | SYSTEM은 계정이 아님(OPS-01) |
| candidate_id | FK, `UNIQUE(candidate_id) WHERE kind='system_thread'` | 신호당 스레드 하나. kind=user는 NULL |
| board | CHECK star/free | star면 tic_id NOT NULL, free면 NULL |
| tag | ANALYSIS/QUESTION/DISCUSSION/INFORMATION/GENERAL. system_thread는 NULL | |
| title, body | | system_thread는 공개 후보 네 수치 요약을 V19 트리거로 생성·동기화한다. [검색 본문 계약](../api/community/README.md#공식-제목본문의-구현-차이) |
| status | visible / hidden / deleted | hidden은 DB 직접 설정(운영 화면 없음, 결정 6) |
| author_withdrawn_at | NULL 가능 | 원 작성자 T. C에 공통 작성자로 옮긴 글의 1년 본문 파기 기준 |
| created_at, updated_at | | fixed_block·source_submission_id 없음(분석글 폐지) |
| 인덱스 | (tic_id, kind, created_at DESC), (user_id, created_at DESC), `pg_trgm` GIN(title gin_trgm_ops), GIN(body gin_trgm_ops) | 뒤의 둘은 COM-03 P0 제목·본문 부분 일치 검색용(v1.1). board·tag 필터 인덱스는 실측 후 결정 |

**comments**: post_id(일반 글 또는 공식 스레드의 토론 영역), user_id, body, status visible/hidden/deleted, created_at, updated_at, `author_withdrawn_at`(T+1년 본문 파기). parent_id 없음(1단계).

**post_reactions** (COM-08): UNIQUE(post_id, user_id), reaction agree/disagree, updated_at. **kind=user 글에만 허용(API 검사).** 반응자 목록은 조인으로 공개.

**published_analyses** (COM-18·19, GRD-04, COM-14 (1))

161의 등록 경로는 V1의 테이블·유일 제약을 재사용한다. V14에서 앱 역할에 SELECT·INSERT만 허용해 공개의 원본 참조와 최초 시각을 변경하지 못하게 한다. 취소·재공개용 상태 열의 제한된 UPDATE 권한은 162에서 실제 경로와 함께 추가한다. 현재 라벨이 바뀐 과거 기록의 첫 공개 자격은 [서비스 API 9.1절](../../apps/backend/docs/service-api-spec.md#publication)의 제출 당시 기준을 따른다. 테이블·열 변경이 없어 ERD 그림은 바뀌지 않는다.

| 열 | 제약 | 비고 |
|---|---|---|
| post_id | FK posts(kind=system_thread) | 소속 공식 스레드 |
| user_id, candidate_id | FK | |
| history_id | UNIQUE FK analysis_histories | 히스토리당 공개 기록 하나. 같은 신호의 새 제출은 새 행 |
| published_at | | 첫 등록 시각. 이 시각에 미확정 성과 인정(최초 1회) |
| unpublished_at | NULL | 본인 취소. 재공개 시 NULL로 되돌림 |
| hidden_at | NULL | 운영 숨김(DB 설정). 본인 취소와 독립 |
| withdrawn_at | NULL | 탈퇴에 따른 공개 철회. 본인 취소와 구별하며 C에 개인 공개 분석 행 삭제 |
| 유효 공개 조건 | | unpublished_at IS NULL AND hidden_at IS NULL AND 스레드 status=visible |
| 인덱스 | (candidate_id, user_id, published_at DESC) | 판단 통계 |

**판단 통계 쿼리**(COM-14 (1)): 유효 공개 분석을 candidate_id로 모아 `DISTINCT ON (user_id) ORDER BY user_id, s.created_at DESC, s.id DESC`로 회원당 최신 제출 1건을 고르고 submissions.user_judgment를 집계한다. N=0이면 "아직 공개된 분석이 없습니다".

**채점형 통계**(결정 7-2): submissions에서 matched_candidate_id = 후보, 회원당 첫 매칭 제출(`DISTINCT ON (user_id) ORDER BY user_id, created_at, id`)의 판단이 planet_truth와 일치하는 비율. "이 신호를 찾은 사람 중 기록과 일치 N% · M명". user_candidate_achievements는 쓰지 않는다.

**post_source_links** (COM-20): post_id 또는 comment_id 중 하나 NOT NULL(CHECK), target_type thread/analysis, target_id(posts.id 또는 published_analyses.id), created_at. 조회 시 대상의 공개 상태·같은 TIC를 매번 검사. 다형 참조라 FK 없음.

**post_history_attachments / comment_history_attachments** (COM-07, HIS-05): (post_id|comment_id), history_id, attached_at. UNIQUE 쌍. 히스토리 소유자 = 작성자, 히스토리 tic_id = 글 tic_id. 160은 기존 테이블을 재사용하며 서비스 계층에서 부모 잠금과 함께 소유자·TIC·최대 3개를 검증한다. V13은 앱 역할에 첨부 SELECT·INSERT·DELETE와 identity 시퀀스 USAGE·SELECT만 허용한다. 트리거 추가 여부는 미결 6에 남는다. board=free면 첨부 불가. 공식 스레드의 토론 답글에도 첨부 가능하지만 성과·통계와 무관. 교체·부모 TIC 변경 및 공개 조회 규칙은 [서비스 API 5~7장](../../apps/backend/docs/service-api-spec.md#attachments)을 따른다.

### F. 운영·챌린지·알림·통계

- **tutorial_stars** (HOME-06, SUB-12): seq 1~5 PK, tic_id, intent(deep_confirmed / shallow_confirmed / fp / deep_fp / **multi_fp**), active. 5종 TIC은 109(!104)가 확정했다: 1 149603524 · 2 307210830 · 3 279569718 · 4 300871545 · 5 278956474. 운영 등록은 [Publisher 「튜토리얼 5종」](../../distributed-system/publisher/README.md#튜토리얼-5종-s15p21c206-272)(272). 순차 열림·건너뛰기(상세 보기 경유, `tutorial_skip_after` 개발 3·운영 0=끔)·챌린지 노출은 명세서 v0.10·결정 10 그대로. 변경 이력 없음(결정 6). `tic_id`는 공개된 별만(v1.9 트리거).
- **operation_settings** (OPS-04·08, 명세서 v0.13): `rule_version` PK, `values` JSONB, `applied_at`, `note`. 매칭 허용 오차, 고조파 배율, BLS 품질, AI 임계값, `stars_per_achievement`(기본 1), `tutorial_skip_after`(개발 환경 3, 운영 환경 0=끔), 무작위 시드 정책을 한 행에 묶는다. 값을 하나만 바꿔도 새 버전 행을 만들고 이전 행은 지우지 않으므로 행 목록이 곧 변경 이력이다. `submissions.rule_version`이 이 행을 가리켜 그 제출이 어떤 설정으로 판정됐는지 되살릴 수 있다. 운영 화면이 없으므로 값 변경은 DB에서 직접 한다(결정 11). 주기 미세 조정 범위는 여기가 아니라 판별 manifest에 있다(OPS-04). **v1.9:** `values`는 형식 1(`format_version`과 `selection`·`matching`·`peaks`·`discovery`·`tutorial`·`ai`·`bls` 묶음, 예: `tutorial_skip_after` → `tutorial.skip_after`)만 받는다(CHECK `ck_operation_settings_values_valid`). 적용 시각 유일(`uq_operation_settings_applied_at`), 적용된 행 수정·삭제·비우기와 지난 시각 삽입 거절(트리거), 초기 규칙 `rule-0`. 상세는 [운영 규칙 변경 런북](../operations/operation-rule-runbook.md).
- **challenge_rounds** (CHL-01·03, HOME-07, POL-24): round_no UNIQUE, starts_on, ends_on, target_tic_id, description(한 줄 설명, v1.1 추가), status planned/active/closed. active는 하나(v1.4), `starts_on ≤ ends_on`·대상은 공개된 별만(v1.9). `target_tic_id`는 대표 대상이다(v1.17). 달성 조건·보상 없음. 참여 수는 열이 아니라 회차 대상 별 전부의 공식 스레드에서 유효 공개 분석을 가진 참여자 수(COM-14 (1)의 N, 회원당 1)를 조회한다(명세서 v1.1 안건 15, v1.4).
- **challenge_round_extra_targets** (V30, 283): round_id·tic_id PK, 각각 `challenge_rounds`·`stars` FK. 대표 대상 밖의 추가 대상이며 공개된 별만 받는다(`trg_challenge_round_extra_targets_published`, V9 함수 재사용). 운영자가 소유자 계정으로 넣고 앱 역할은 SELECT만 가진다. 운영값은 회차당 추가 4개(대표 포함 5개)이며 DB 상한은 없다.
- **challenge_round_targets (view)** (V30): `(round_id, tic_id, is_primary)`. 대표 대상과 추가 대상을 합치며 대표와 같은 추가 대상은 한 번만 나온다. 튜토리얼 5번 완료·`challenge-unlock`·무작위 발견 제외·퀘스트·회차 조회·`global_stats`가 모두 이 뷰로 대상을 읽는다. 앱 역할은 SELECT만 가진다.
- **notifications** (NTF-01): user_id, type(achievement/reopen/challenge/comment/relabel/follow), payload JSONB, read_at, created_at. 인덱스 (user_id, read_at, created_at DESC). **150 구현:** 판 전환 재개 사건(탐사 API 9.3절)이 이 테이블의 첫 쓰기 경로다. `type='reopen'`, payload는 `{ticId, bundleId, newDiscoverableCount}`이며 `reason`은 근거가 되는 `candidate_status_history`를 남길 Publisher(S15P21C206-87)가 없어 아직 싣지 않는다. V22가 `(user_id, payload->>'ticId', payload->>'bundleId') WHERE type='reopen'` 부분 유일 인덱스로 같은 판의 중복 사건을 DB에서 막고, 앱 역할에 SELECT·INSERT만 준다. V23은 event_key·published_at·publication_seq를 추가한다. 세 열은 모두 NULL(기존 원본/미발행)이거나 모두 유효한 발행 값이다. UNIQUE(user_id,event_key), UNIQUE(user_id,publication_seq), 발행 행의 (user_id,published_at DESC,id DESC) 부분 인덱스를 사용한다. 앱에는 read_at·세 발행 열의 UPDATE만 추가하며 원본 payload·created_at·DELETE 권한을 주지 않는다. 기존 행은 비소급 보존한다.
- **notification_events / notification_signal_state / notification_candidate_changes** (V23, 175): 불변 원천 event_key·payload·occurred_at, 후보별 마지막 유효 disposition/AI verdict, 판×후보별 최초/최종 탐색 가능 여부다. Gold·앱 직접 쓰기는 허용하지 않고 승인된 DB 트리거만 관리한다. state와 changes의 candidate_id는 후보 FK(삭제 cascade), changes.bundle_id는 판 FK다. 출처 사건과 수신 의도는 자동 정리하지 않는다.
- **challenge_rounds.notification_started_at** (V23): 최초 시작 경계. 기존 active/closed는 -infinity 비소급 표시이며 시작 트리거가 당시 참여 가능한 회원·설정을 outbox에 저장한다. 반복 전환에도 경계를 보존한다.
- **notification_outbox** (V23, 175): 사건 원인·수신자 UNIQUE, type·payload·당시 설정 세대·follow_id·source_notification_id·pending/delivered/excluded·recorded_at. 작성자 잠금과 수신자 FK 잠금의 교착을 피하려고 FK를 두지 않으며 발행 시 회원 유효성·소유권·관계·현재 접근을 재검사한다. 앱은 SELECT/INSERT, state 및 본인 재개 사유 결합에 필요한 payload/source_notification_id/follow_id/follow_epoch/preference_epoch UPDATE, identity sequence 사용이 가능하다. 원본 notifications payload는 수정할 수 없다. 자동 정리는 없다. 원본/발행 분리와 재처리 상세는 [F15.7](../development/service-backend/community.md#notification-policy)을 따른다.
- **stats_snapshots** (STA-03, DAT-13): snapshot_date, scope global/round, round_id, metrics JSONB. `metrics` 컬럼에는 지표 map만이 아니라 상태·기준/관측/생성 시각·코호트 메타데이터·지표 map을 포함한 `ComparisonSnapshot` 전체 JSON을 저장한다. 비교 기준선(90일 중앙값) 일 1회.
- **global_stats (materialized view)** (STA-02, 결정 7-3): 전체 통계를 10분마다 REFRESH CONCURRENTLY. 테이블 아님.

**178 구현(사용자 승인 2026-09-22):** V21이 `stats_snapshots(snapshot_date,scope,round_id) NULLS NOT DISTINCT` 유일 인덱스를 추가하여 global의 NULL 회차도 멱등 키로 보호한다. 기존 중복이 있으면 migration을 실패시키고 성공본을 임의 삭제하지 않는다. 별도 개인 Snapshot 테이블은 없다. `global_stats`는 `singleton` 유일 인덱스와 `as_of/generated_at/payload`를 가진 한 행 MV이며 `WITH NO DATA`로 생성한다. 최초 명시적 적재 뒤 CONCURRENTLY를 사용한다. 앱 역할은 두 집계의 SELECT만, `planetory_stats_job`은 MV MAINTAIN·Snapshot SELECT/INSERT와 필요한 원천 SELECT만 가진다. UPDATE/DELETE 없이 성공본을 보존한다. MV 계산은 소유자 권한으로 수행되지만 잡 계정에는 소유권·역할 상속·원천 쓰기를 주지 않는다.

Snapshot JSON에는 `asOf`(KST D 자정·기록 종료 경계), `sourceObservedAt`(실제 일관된 원천 조회 시작), `generatedAt`(집계 완료), D-1인 `snapshotDate`, 90일 모수 창, `cohortMemberCount`와 지표별 `median/sampleCount/status/reason`만 저장한다. 회원 ID·닉네임·회원별 원자료는 저장하지 않는다. **일별 값은 D 이전 기록을 실행 시점에 확인한 상태로 계산한 값이며 정확한 D 상태의 복원이 아니다**(2026-09-22 추가 사용자 승인). 지연 커밋·라벨/회원 상태 변경은 원천 조회 전에 반영될 수 있다. 과거 날짜의 성공본 없는 재실행은 거절한다. 현재 회원 통계는 active만, 과거 비식별 성공본은 보존한다. 탈퇴 원천 보관·삭제 정책은 별도 미정이다. [통계 정책](../requirements/planetory-statistics-policy.md)과 [통계 실행 런북](../operations/statistics-runbook.md)을 따른다. 공유/운영 DB 적용과 스케줄 활성화는 미실행이다.
- **제외(결정 6):** reports, audit_events, expert_reports. 도입 시 v0.1 정의를 되살린다.

### G. 요청된 외부 조회 자료와 한국어 설명 (V25·V26·V28·V29, 266~270)

**nasa_planet_info**는 `candidate_id` PK/FK와 `tic_id` FK로 요청된 내부 확정 후보 하나에만 붙는다. `archive_planet_name`은 공급 단계의 검증을 전제로 Gold의 `external_signal_references(source='archive')`에서 선택한 정확한 `pl_name`이며, 별칭·이름 유사도로 채우지 않는다. 이 source 문자열은 검증 수준을 저장하지 않는다. 262 목업의 `source='nasa_exoplanet_archive'`는 별도 `pscomppars` 참고 행성명을 더미 TIC에 복사한 외부 참조이므로 현행 266의 조회 자격으로 간주하지 않는다([원천 구분](../development/nasa-planet-info-266.md#2-식별자와-요청-흐름)). `status`는 `pending/ready/not_found/identity_unresolved/temporarily_unavailable`, `last_refresh_status`는 최근 시도 이유다. `normalized` JSONB·`source_hash` SHA-256·`source_version` 1은 정상 `ps` 기본 해의 데이터와 구조 버전이며, `fetched_at`은 마지막 정상 조회, `changed_at`은 정규화값 변경 시각이다. `last_attempt_at`·`next_refresh_at`·`in_flight_until`·`attempt_generation`은 재확인과 늦은 응답 방지용이다. FK 이외의 Gold 쓰기 권한은 추가하지 않는다. 서비스 앱 역할에는 이 테이블만 SELECT/INSERT/UPDATE를 준다. 저장·상태 전이·보관 정책은 [266 개발 계약](../development/nasa-planet-info-266.md#4-저장-구조와-상태-전이), 배포는 [운영 가이드](../operations/nasa-planet-info-runbook.md)를 따른다.

**nasa_planet_explanation**은 `candidate_id` PK/FK로 `nasa_planet_info`에 0~1개만 붙는다. `source_hash`·`source_version`은 설명이 근거로 삼은 266 정규화값, `model_name`·`prompt_version`은 생성 계약, `content` JSONB·`generated_at`은 검증을 통과한 성공 설명과 생성 시각이다. `status`는 `pending/ready/failed`이고, `ready`일 때에만 `content`·`generated_at`이 함께 있으며 임대는 비어 있어야 한다. `last_attempt_at`·`next_retry_at`·`in_flight_until`·`attempt_generation`·`attempt_count`·`last_failure`는 모델 시도·경합·실패 추적용이다. 횟수 CHECK는 1~3이고 실제 재시도 정책은 [267 내부 계약](../development/nasa-planet-explanation-267.md)에 있다. 앱 역할에는 신규 테이블의 SELECT/INSERT/UPDATE만 추가한다. 이 FK는 자료 계보를 고정하고, 최신 원천 해시와 같은지 확인하는 조건부 저장은 서비스 SQL이 맡는다. 공유/운영 DB 적용은 별도다.

**nasa_explanation_daily_usage**는 `(usage_day, member_id)` 복합 PK로 한 회원의 UTC 날짜별 모델 생성 시도권 예약 수를 보관한다. `member_id`는 `users(id)` FK이고 탈퇴로 회원 행이 삭제되면 관련 회원별 행도 삭제된다. `attempt_count`는 양수이며 외부 모델 호출 직전 새 시도권을 예약할 때만 증가한다. **nasa_explanation_daily_total**은 `usage_day` PK의 전체 예약 수다. 회원별 행과 같은 짧은 트랜잭션에서 증가하고 회원 삭제 뒤에도 남으므로 전체 비용 상한이 되돌아가지 않는다. 예약 뒤 모델 실패·권한 철회가 있어도 카운터를 되돌리지 않는다. 두 테이블에 앱 역할 SELECT/INSERT/UPDATE만 주고 DELETE는 주지 않는다. GET 저장 조회, 재사용 POST, NASA TAP 조회를 모델 시도로 세지 않는다. 일별 한도 수치는 미지정이며 기본값은 회원별·전체 모두 0이다. 설명 활성화 전에 운영 승인된 양의 정수 두 개를 명시 주입한다([268 계약](../development/nasa-planet-request-268.md)). 공유/운영 DB 적용과 실제 비용 확인은 별도다.

**nasa_star_catalog**는 `tic_id` PK/FK로 항성마다 하나의 NASA 목록 조회 상태를 둔다. `status=pending/ready/empty/partial/temporarily_unavailable`, `host_name`, 마지막 성공 `fetched_at`, 다음 `next_refresh_at`, 임대 `in_flight_until`, 증가하는 `attempt_generation`, 최근 `last_refresh_status`가 있다. 정상 0행은 `empty`다. 65행·본문 상한·JSON 숫자 파싱 장애나 늦은 응답은 이전 행성 snapshot을 삭제하지 않는다. **nasa_star_planet**은 `(tic_id,planet_id)` 복합 PK로 외부 행성을 보관하며 `(tic_id,planet_name)` 유일 제약과 `np-`+SHA-256 형식 CHECK를 둔다. 내부 candidate FK는 없다. `active`는 마지막 성공 재조회에 속한 행성만 현재 응답에 노출한다. `status=ready/identity_unresolved/invalid_source`, `normalized` JSONB·`source_hash`·`source_version`, `fetched_at`·`changed_at`을 보존한다. `ready`일 때에만 정규화 JSON·해시·버전이 모두 있어야 한다. `fetched_at`은 상태와 무관하게 마지막 완전 응답에서 해당 이름을 관찰한 시각이고, `changed_at`은 정규화 자료 또는 상태 변경 시각이다. 같은 정확 이름의 확정·비확정 기본 해가 함께 온 경우도 그 이름을 식별 보류 상태로 남기며 다른 행성은 유지한다. 이름 정정·삭제로 비활성화한 옛 행을 새 이름으로 추측 연결하지 않는다.

**nasa_star_planet_explanation**은 `(tic_id,planet_id)` PK이자 행성 FK다. 원천 `source_hash/source_version`, `model_name/prompt_version`, `status=pending/ready/failed`, 다섯 문장의 `content` JSONB와 `generated_at`을 보관한다. `ready`에는 본문과 시각이 필수이고 임대가 없어야 한다. `next_retry_at/in_flight_until/attempt_generation/attempt_count(1~3)/last_failure`는 설명의 실패·중복·늦은 완료를 제어한다. 현재 원천과 버전이 일치하지 않거나 행성이 비활성화되면 옛 설명은 응답에 싣지 않는다. 세 V29 테이블 모두 앱 역할에 SELECT/INSERT/UPDATE만 허용하며, Gold·V25·V26 수정 권한을 추가하지 않는다. V28의 동일한 일별 집계를 268·270 설명 시도가 공유한다. 상세 상태·응답은 [270 계약](../development/nasa-star-planets-270.md)을 따른다.

## 4. 설계 결정과 근거

1. **Gold 본문은 DB 배열이다(v0.3).** 곡선·주기도는 배치가 만든 뒤 읽기만 하는 데이터라 파일이 가장 단순하지만, 팀이 운영 편의(SQL로 바로 확인, 별 단위 부분 갱신)를 택했다. 처음 근거에 있던 "Standby 복제로 자동 동기화"와 "덤프 하나로 백업"은 2026-09-17 단일 노드 확정(D6·D7)으로 성립하지 않으나, 나머지 근거로 결정은 유지한다. 대가는 조회가 Spring·JDBC를 타면서 붙는 수 ms, CDN 캐시 불가, DB 용량 증가다. 조회 API는 어차피 Spring 엔드포인트이므로 인증·오류 형식은 그대로 유지된다. 저장은 두 원칙으로 줄인다. 규칙에서 계산되는 배열(시각, 주기 격자)은 저장하지 않고, 한 번 확정되면 안 바뀌는 곡선은 판이 아니라 별·섹터에 묶어 판 사이에 복제하지 않는다.
2. **후보는 교체·유지한다.** candidates.id는 별에 고정된 신호 식별자다. 판이 바뀌면 값 갱신·추가·retired로 처리하고 옛 값은 candidate_status_history에 남긴다. 공식 스레드(UNIQUE candidate_id)·성과(UNIQUE user×candidate)·재현(removed_candidate_ids)이 모두 이 전제 위에 있다.
3. **별 열림의 원인은 성과 행이다.** user_candidate_achievements INSERT → star_unlocks(trigger_achievement_id). 등급 상승·완료는 트리거가 아니다. 등급 문자는 achievement_count에서 계산한다.
4. **판이 바뀌면 세션도 따라 올린다(v0.3 결정 C).** 후보표는 판마다 이력을 남기지 않고 값을 갱신한다. 그래서 이전 판 화면을 보여주면 판정만 최신 표로 이뤄져 어긋난다. 이전 판을 남기지 않고 진행 중인 회원에게 갱신을 알리는 쪽을 택했다. 화면과 판정이 항상 같은 판이고, previous 보존과 판별 후보 이력이 둘 다 필요 없어진다. 대가는 분석 도중 한 번 다시 불러오는 것인데, 그 별에 새 섹터가 들어오는 27일에 한 번, 야간 배치 시점에만 생긴다.
5. **제출은 절대값을 저장한다.** 위상 구간이 입력이지만 epoch·duration·기준 시각·계산 버전을 함께 저장해, 판이 바뀐 뒤에도 현재 번들 위에 재환산해 그릴 수 있다. 이전 판은 보존하지 않는다. 판 행은 제출이 참조하므로 남기고, 이전 판의 주기도 행과 캐시는 archived 전환 시 정리한다(결정 C, v1.1 정정).
6. **히스토리는 제출과 1:1, 불변. 스냅샷은 매칭 성공에만.** 축약 스냅샷(float32 150개 배열 2개, 본문 ≈1.2KB, 메타데이터·행 오버헤드 별도)은 "제출 당시" 토글용이며 원본 재현은 파라미터로 한다.
7. **공식 스레드는 SYSTEM이 쓴 원글이다.** posts.kind로 구분해 댓글·숨김·피드 로직을 재사용하고, 공개 분석만 별도 테이블로 두어 "히스토리당 하나·취소·숨김·통계 대상" 제약을 표현한다. 반응은 일반 글에만.
8. **판단 분포는 쿼리다.** 미확정은 published_analyses + submissions, 채점형은 submissions만. 전체 통계만 materialized view.
9. **닉네임은 복사하지 않는다.** 게시글·반응·답글은 user_id만.
10. **열거형은 TEXT + CHECK.** 다형 참조(follows.target, post_source_links.target, notifications.payload)는 FK 없이 서비스 계층 검증.
11. **운영 화면은 v1에 없다.** hidden 상태값만 두고 DB 직접 조작으로 처리한다.
12. **Gold 적재는 Publisher가 DB에 직접 쓴다(2026-09-15).** `planetory_gold_writer`가 곡선·주기도·후보·manifest 적재와 판 전환을 한 트랜잭션으로 수행한다. 기존 `current`를 `archived`로 바꾼 뒤 신규 `staging`을 `current`로 올린다. Backend는 Gold를 읽고 커밋 후 `bundleId` 알림에 따른 캐시·재개·라벨 후처리만 맡는다. `(tic_id, bundle_version)` 유일 제약과 `pg_advisory_xact_lock(tic_id)`이 동시 재시도를 직렬화하며, DB 생성 id는 payload 동일성 비교에서 제외한다(`S15P21C206-69`, migration은 `S15P21C206-86`).

## 5. 미결·확인 필요

| # | 항목 | 관련 |
|---|---|---|
| 1 | operation_settings 기본값 확정. 항목 목록은 v1.9 형식 1로 정했고 `rule-0`은 개발용 v0 값이다. 확정 값은 새 규칙 버전으로 넣는다 | OPS-04·08, DEC-03, D20·D11 |
| 2 | 새 판 적재 시 후보 동일성 판단 기준(주기·중심 시각 허용 오차) | DEC-03, DAT-05·08 |
| 3 | 채택 신호 0개 별 비율 실측 결과에 따른 BLS 임계값 조정 | DEC-01·03 |
| 4 | 탈퇴 시 users·OAuth 식별자·게시물·History·공개 분석·관계·통계·백업 처리와 기간. NO ACTION FK·제공자 UNIQUE·History 불변 권한을 유지한 상태로 정책/정리 권한·순서를 후속 검토. snapshot_params의 메모와 재현 필드를 분리하며 당시 표시/재계산 보장 수준은 DEC-11 3.1절에서 결정한다. 공개 철회는 기존 unpublished_at 재사용/전용 열 추가와 식별 연결 정리 후 제외 근거를 Q1에서 선택하며 전용 열의 DDL·GRANT는 180 범위다. 179에서는 DDL을 변경하지 않음 | [DEC-11 결정표](../requirements/planetory-decision-register.md#dec-11), 제안·승인 대기 |
| 5 | published_analyses는 161에서 앱 역할 INSERT만 허용해 원본 참조·최초 시각을 보호한다. 162에서 상태 열의 UPDATE 권한을 추가한다. analysis_histories·analysis_snapshots의 기존 불변 권한은 유지한다 | HIS-06, S08·S09 |
| 6 | 히스토리 첨부의 소유자·TIC 일치 검증을 트리거로 둘지 | COM-07 |
| 8 | 별 지도는 user_id·layout_version으로 격리한 world_x/world_y 공간 인덱스와 타일 캐시로 개별 별을 조회한다. 서버 공식 군집/군집 통계 응답을 만들지 않는다. 새 발견/표시 상태 변경 시 영향받은 인덱스·타일 캐시와 회원 version을 갱신한다. 조회/범위 수/version은 일관된 DB 스냅샷으로 읽고 cursor는 회원·version·level·bbox·limit에 묶는다. 인덱스 구조·쿼리 계획·rangeStarCount 집계 비용은 10만 별 실측으로 검증하며 generation만으로 조회하지 않는다 | NFR-20a·d, SRS v1.3, 탐사 API 4.1 |
| ~~9~~ | ~~stars 표시 열(teff·radius·tmag) 확정~~ | 해소(v1.8, 탐사 API D-18) |
| 10 | **비닝 간격 실측.** 기본 10분으로 잡았으나 대상 별의 가장 짧은 통과 지속시간을 실측해 조정한다. 비닝 후 discoverable을 다시 계산해야 사용자가 못 찾는 신호가 완료 판정에 걸리지 않는다 | DEC-01·03, DEC-16 |

| 11 | **갱신 정책.** v1 대상 별 목록을 고정할지, 새로 관측된 별을 계속 추가할지. 27일 주기 갱신은 세그먼트 INSERT와 후보표 재계산으로 처리한다 | DAT-06·15, DEC-27 |
