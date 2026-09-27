# 서비스 배포·CI/CD 현재 상태

`S15P21C206-84` 작업의 인계 문서다. 절차와 근거는 담당 정본에 있고 여기에는 **현재 상태, 검증 경계, 남은 결정**만 둔다.

- 배포·롤백 절차와 초기 데이터: [EC2 서비스 배포](../../infra/service/README.md)
- CI/CD 정본: [CI/CD](../operations/cicd.md)
- 결정 근거와 날짜별 기록: [2026-09-18](../changes/2026-09-W3/2026-09-18.md), [2026-09-21](../changes/2026-09-W4/2026-09-21.md)

## 한 줄 요약

실제 앱은 `app.planetory.space`다. `planetory.space`도 같은 프론트 컨테이너로 연결된다. 목업 컨테이너는 2026-09-27에 내렸다(아래 「터널 호스트 배치」).

**프론트엔드와 백엔드 모두 CI 이미지로 돌고 있다(2026-09-21·22).** 두 컨테이너 다 커밋 SHA 태그를 달아 어느 커밋인지 추적된다. 손으로 빌드한 `:local` 이미지는 더 이상 쓰이지 않는다. Google·SSAFY 로그인 진입과 API 응답을 실환경에서 확인했다.

아래 본문에서 **「develop의 배포 job」이라고 적은 것은 MR `!161` 병합 전의 동작**이다. 병합되면 헬스 확인·롤백·`.env` 기록이 배포 경로에 들어온다.

## 실환경에서 확인된 것 (2026-09-18)

| 항목 | 상태 |
| --- | --- |
| 도메인 진입 | `planetory.space` → Cloudflare Tunnel → EC2-A. 외부 인바운드 개방 0개 |
| Tunnel connector | EC2-A 한 곳. 여러 곳에 붙여도 분산되지 않으므로 EC2-B에는 두지 않는다(D4) |
| 로그인 | Google·SSAFY 둘 다 성공. 회원 생성·튜토리얼 별 지급까지 동작 |
| DB | `service-db`(PostgreSQL 18.6), Flyway 마이그레이션 적용, 영속 볼륨 `planetory-service-db-data` |
| 별지도 | 렌더러를 켠 이미지로 교체(2026-09-23, `S15P21C206-254`). 아래 「수동 배포한 렌더러 이미지」 참고 |

**프론트엔드와 백엔드 모두 CI 이미지로 교체됐다(2026-09-21·22).** 두 컨테이너 다 커밋 SHA 태그를 달고 있어 어느 커밋인지 추적된다. 손으로 빌드한 `:local` 이미지는 더 이상 쓰이지 않는다.

## 터널 호스트 배치

한 인스턴스에서 여러 호스트를 서빙한다.

| 호스트 | 연결 대상 |
| --- | --- |
| `app.planetory.space` | 실제 앱(프론트 컨테이너) |
| `planetory.space` | 실제 앱(프론트 컨테이너, `http://frontend:8080`) |
| `erd.planetory.space` | ERD |
| `api-docs.planetory.space` | API 문서 |
| `wireframe.planetory.space` | 와이어프레임 |

백엔드가 발급하는 OAuth 리다이렉트 주소는 `app.planetory.space`다. 배포 검증도 이 주소로 한다.

**목업 컨테이너 철거(2026-09-27, 17:29 KST 확인, 사용자 요청).** 예전에는 `planetory.space`가 은하 서비스 시제품(`experiment/S15P21C206-45-web-galaxy-service-prototype`) 컨테이너 `http://mockup:8080`으로 연결됐다. 그 컨테이너는 운영 스택과 별개인 compose 프로젝트 `planetory-mockup`(EC2-A `/home/ubuntu/mockup-deploy/compose.yaml`, 이미지 `planetory-mockup:local`, Vite dev 서버)였다. 철거 전에 Cloudflare Tunnel의 `planetory.space` origin은 이미 `http://frontend:8080`으로 바뀌어 있어 외부에서 닿지 않았다. `docker compose down`으로 컨테이너만 지웠고 운영 스택 컨테이너 10개는 그대로다. 철거 뒤 `planetory.space`와 `app.planetory.space`가 같은 운영 번들로 200이다. 이어서 이미지 `planetory-mockup:local`과 빌드 원본 `/home/ubuntu/planetory_mockup`(42 MB)도 지웠다(사용자 승인). 빌드 원본은 커밋 안 한 변경이 없었고 HEAD `03e749e`가 원격 브랜치에 있어 저장소에서 다시 받을 수 있다. 마지막으로 `/home/ubuntu/mockup-deploy`(compose 파일·Vite 설정)도 지웠다(사용자 승인). 목업 컨테이너·이미지·파일은 남지 않았다. Docker 빌드 캐시는 확인하지 않았다.

## develop 배포가 요구하는 설정 둘 (S15P21C206-254)

MR `!161` 병합 뒤 develop 배포에서 두 가지가 깨졌다. 코드가 먼저 들어오고 배포 설정이 따라오지 않은 경우다. 브랜치 `fix/S15P21C206-254-infra-deploy-config-gaps`에 구현했고, **병합 전에 EC2-A에 수동으로 반영했다(2026-09-23).**

### 백엔드: Redis가 없어 기동 실패 → 롤백

`RedisSessionConfig`가 세션·캐시 Redis 주소 넷을 필수로 읽는데 `compose.yaml`에 Redis도 주소도 없었다. `deploy.sh`의 헬스 확인이 실패를 잡아 직전 이미지로 되돌렸고(실환경 첫 롤백), 서비스는 유지됐다.

- `session-redis`·`cache-redis` 두 서비스를 compose에 넣었다. 두 인스턴스는 host+port가 달라야 하며, 같으면 앱이 기동을 거부한다.
- 주소는 **`.env`가 아니라 compose가 서비스 이름으로 직접 준다.** 티켓은 `.env`에 넣도록 적었지만, 그러면 `.env`에서 하나만 빠져도 같은 기동 실패가 되풀이된다.
- 세션은 볼륨·RDB 저장, 64mb 상한에 `noeviction`(상한에 닿으면 새 로그인이 503). 캐시는 저장 없음, 128mb(임시) `volatile-lru`. 캐시는 Backend의 기동 의존성이 아니다(리뷰 반영, 아래).
- 캐시 소비처는 아직 없다. 지금은 기동 요건만 채운다.

EC2-A에서 서비스와 분리된 임시 프로젝트로 검증했다(2026-09-23). 두 컨테이너 healthy, 설정값이 위와 일치, 재시작 후 세션 키 유지·캐시 키 소실, 호스트 포트 게시 없음. 백엔드 앱과 붙인 검증은 배포 때 한다.

**최초 기동은 수동이다.** `deploy.sh`는 `--no-deps`로 교체하므로 의존 서비스를 만들지 않는다. 절차는 [EC2 서비스 배포](../../infra/service/README.md#세션캐시-redis).

**배포 결과(2026-09-23).** 브랜치의 `compose.yaml`로 교체하고(직전 파일은 `compose.yaml.bak-before-254`) 두 Redis를 띄운 뒤 `deploy.sh`로 Backend `e510d1da`를 올렸다. 헬스 200, 기동 로그 예외 0건, Backend 환경변수가 두 인스턴스를 따로 가리킨다. V20·V21·V22·R__이 적용돼 V22다. `planetory_stats_job`은 마이그레이션 계정이 슈퍼유저라 V21이 직접 만들었다. `cache-redis`에는 연결이 없다. 소비처가 없어 팩토리가 연결하지 않는다. 로그인 뒤 Backend만 재시작해도 세션이 유지됐고, 세션 키는 `session-redis`에만 있다(`cache-redis` 0개).

첫 시도는 compose 교체 없이 배포만 돌려 같은 `SESSION_REDIS_HOST` 오류로 롤백됐다. Redis 설정 단계에서 죽어 마이그레이션 전이었고 DB는 V19 그대로였다. 롤백 로그의 "스키마는 그대로" 문구는 롤백마다 붙는 일반 경고다.

**리뷰 반영(2026-09-23).** 백승학·하서진 P2 두 건과 강재민 제안 둘을 받았다. 세션에 64mb 상한(`noeviction` 유지), Backend `depends_on`에서 `cache-redis` 제거, 캐시 정책 `allkeys-lru`→`volatile-lru`, `requirepass` 재검토 조건을 "우리가 만들지 않은 컨테이너가 네트워크에 붙을 때"로 좁혔다. EC2-A에 재반영했고(직전 compose는 `compose.yaml.bak-before-254-review`) 두 Redis 재생성 뒤에도 세션 키가 남았다. 근거와 관측 명령은 [EC2 서비스 배포](../../infra/service/README.md#세션캐시-redis).

**병합 전에 develop Backend를 CI로 배포하면 `compose.yaml`이 Redis 없는 판으로 덮여 다시 롤백된다.** 컨테이너는 남지만 주소가 사라진다. 이 브랜치를 먼저 병합한다.

### 프론트: 별지도 렌더러가 꺼진 채 빌드

`Dockerfile`의 `VITE_SKY_RENDERER_ENABLED` 기본값이 `false`이고 CI의 `BUILD_ARGS`가 비어 있었다. 별지도 자리에 "지도 시각화 연결을 준비하고 있습니다" 문구만 나온다.

- `build:frontend`·`web:image`가 `--build-arg VITE_SKY_RENDERER_ENABLED=true`로 빌드한다. MR의 `web:build`도 같은 값으로 번들링한다.
- `build:frontend`·`deploy:frontend:ec2-a` 규칙에 `.gitlab/ci/apps/frontend.yml`을 넣었다. 빌드 인자가 이 파일에 있어 이 파일만 바뀌어도 이미지가 달라진다.
- 빌드 시점 값이다. 서버 환경변수나 재시작으로는 적용되지 않는다.

**판별 기준을 바꿨다.** 티켓을 쓸 때의 근거였던 WebGL 호출(`createShader` 등) 개수는 이제 쓸 수 없다. 로그인 화면과 미리보기가 렌더러 모델을 가져오면서 플래그와 무관하게 번들에 들어가기 때문이다. 대신 **메인 청크가 `GalaxyPage`와 `GalaxyScene` 청크를 참조하는지** 본다. 로컬 빌드에서 켜면 3회·1개, 끄면 0·0이다.

**배포 헬스가 렌더러를 본다(리뷰 반영).** `/`는 렌더러가 빠져도 200이라 회귀를 못 잡았다. 켠 빌드에만 생기는 `/health/renderer-enabled`를 헬스 경로로 바꿨다. EC2-A에서 ON/OFF 이미지를 비교해 200/404, SPA 경로는 둘 다 200임을 확인했다. 과도기 롤백 주의는 [EC2 서비스 배포](../../infra/service/README.md#배포와-롤백).

켜더라도 계정이 가진 별만 보인다. 시제품처럼 수천 개가 나타나지 않는다.

### 수동 배포한 렌더러 이미지 (2026-09-23)

브랜치 병합을 기다리지 않고 프론트만 먼저 켰다. **운영 중이던 커밋 `80a860fa` 그대로에 플래그만 더해** EC2-A에서 빌드했다. 코드 차이는 렌더러 하나다.

- 이미지: `frontend:80a860fa…-sky`. CI가 같은 SHA로 만든 이미지를 덮어쓰지 않도록 접미사를 붙였다.
- `deploy.sh`로 교체했다. 헬스 통과, `.env`에 기록됐다.
- 공개 주소 확인: 메인 청크가 `GalaxyPage`를 3회 참조하고 렌더러 청크가 200으로 내려온다. 교체 전 이미지는 0회였다.

**이 브랜치가 병합되기 전에 develop 프론트를 CI로 배포하면 렌더러가 다시 꺼진다.** 병합 뒤부터는 CI가 항상 켜서 빌드한다.

레지스트리의 `frontend:ed7d72d2…-sky`는 잘못 고른 기준으로 만든 이미지다. 쓰이지 않는다.

### 배포 경로를 혼동하지 않는다

CI가 배포하는 곳은 **`/home/deploy/planetory`**(`deploy` 계정)다. `deploy.sh`, 실제 `.env`, `backups/`가 여기 있다. `~ubuntu/planetory/infra/service`는 09-21 이전 수동 기동 때의 사본이라 `.env`의 이미지 선언이 낡았다. 같은 compose 프로젝트 이름을 쓰므로 거기서 `docker compose ps`를 쳐도 컨테이너가 보여 오인하기 쉽다. 도는 버전은 컨테이너 라벨 `com.docker.compose.project.working_dir`과 이미지로 확인한다.

## 병합 후 CI 배포 결과 (2026-09-23)

`S15P21C206-254`(`!199`)와 `S15P21C206-261`(`!204`)은 병합 후 CI 경로로 배포됐다.

| 파이프라인 | Frontend | Backend | 확인 |
| --- | --- | --- | --- |
| `219740` (`a9e567db`, 254) | `80a860fa-sky` → `a9e567db` | 변경 없음 | 헬스가 렌더러 표식 경로에서 통과 |
| `220055` (`70126dcb`, 261) | `a9e567db` → `70126dcb` | `f6379f5b` → `70126dcb` | 앱 변경 없는 병합에도 두 빌드·두 버튼, Environments `ec2-a`에 배포 2건 |

운영 DB는 V29다(2026-09-26). V23·V24는 261 전에 수동 배포한 `f6379f5b`에서, V25(266 NASA 행성 정보)는 파이프라인 `222444`(`a8fb6667`, 262 병합)에서, V26~V29는 `222918`(`6d1926d5`)의 Backend 배포(2026-09-26 01:10 KST)에서 한꺼번에 적용됐다. 그중 V27은 `submissions`의 `ck_submissions_source_peak_all_or_none`을 교체한 되돌리기 어려운 마이그레이션이다(`S15P21C206-269`). 교체 뒤 운영 제약 정의를 확인했고, 같은 날 88 동작 확인에서 봉우리 제출 3건이 접수돼 500이 풀린 것을 확인했다(아래 「온라인 계산 Worker」).

Backend 배포 버튼은 그 커밋까지 쌓인 마이그레이션을 함께 적용한다. 누르기 전에 운영 `flyway_schema_history`의 마지막 버전과 `db/migration`을 대조한다.

**옛 배포 버튼 시험 (2026-09-26, `S15P21C206-262` 항목 2).** 한 번도 실행하지 않은 옛 manual job의 Play는 403으로 막혔다(`222890` `deploy:backend:ec2-a`). 반면 옛 job의 Retry는 막히지 않는다. `220924`의 취소된 `deploy:frontend:ec2-a`를 Retry하자 옛 Frontend `e9835da5`가 01:18:58~01:19:45 KST 약 1분 운영에 올라갔고, `222444`의 성공 job Retry로 `a8fb6667`에 되돌렸다. `ci_forward_deployment_rollback_allowed: true` 때문이며 정본은 [CI/CD](../operations/cicd.md)다. 이 설정을 끌지는 `S15P21C206-93`에서 정한다.

**시험의 부작용(88 세션 확인).** 되돌리기 Retry가 서버 `compose.yaml`을 `a8fb6667` 판으로 덮어 `derived-compute` 서비스와 Backend `DERIVED_COMPUTE_URL`이 01:19~02:51 KST 동안 compose에서 빠졌다. 컨테이너는 재생성되지 않아 동작했고, 02:51 `222918`의 성공 job Retry(641678)로 되살렸다. 또 옛 job Retry가 더 새 deployment 기록이 되면서 `222918`의 미실행 `deploy:frontend:ec2-a`가 `blocked`다. Frontend는 그 뒤 새 develop 파이프라인 `224322`(`50e13981`)의 버튼으로 올렸다(2026-09-26 22:29 KST, 헬스 통과).

같은 날 `222918`(`6d1926d5`)의 derived-compute(01:08:27~01:08:42 KST)와 Backend(01:10:03~01:10:37 KST)가 배포됐다(GitLab job 시작·종료 시각). **2026-09-27 19:15 KST 기준 운영은 Backend `aa77f460`(280 병합 commit, 19:01 KST 기동), Frontend `e47f384e`(274 후속 병합 commit, 19:14 KST 기동), derived-compute `6d1926d5`다(서버 컨테이너 이미지 태그로 확인).** 그 전 Backend는 develop 파이프라인 `225105`의 `deploy:backend:ec2-a`(job `650656`, 15:38 KST, 교체 전 덤프 `backups/service-db-20260927-063745.sql`, 헬스 통과)로 올린 `59419ec0`이었고 그 직전은 `6d1926d5`였다. Frontend는 같은 파이프라인 job `650655`로 `59419ec0`(274)에 올라간 뒤 `7c86ccef`(279, 16:56 KST)를 거쳐 `e47f384e`가 됐다. 06:12 KST 기준으로는 Backend·derived-compute `6d1926d5`, Frontend `0d2d2afa`(85 병합 commit)였다. Frontend는 develop 파이프라인 `224779`의 `deploy:frontend:ec2-a`(job `649089`, 06:12:04~06:12:12 KST)로 올렸고 `/health/renderer-enabled`가 200이었다. 그 전에는 `c3d8ba85`(272 병합 commit, 2026-09-27 05:25 KST, job `648986`), 더 전(2026-09-26 22:29 KST)에는 `50e13981`이었다.

## 분석 화면 503과 Gold 목업 (S15P21C206-262)

별 분석을 열면 "일시적으로 처리할 수 없습니다"가 떴다. `analysis-context`가 503(`DEPENDENCY_UNAVAILABLE`)을 냈기 때문이다. 구현·API 연결·배포 문제가 아니었다. 서비스 DB에 Gold가 한 번도 적재되지 않아 `publication_bundles`·`light_curve_segments`·`candidates`가 모두 0행이었다. 더미 별에는 판이 없다. 이 경로는 예외로 처리해 오류 로그가 남지 않는다. 화면 문구는 일시 장애처럼 읽히지만 몇 번을 다시 해도 같다. 원인을 가르는 오류 코드 분리는 Backend 담당 사항이다.

Publisher의 적재 단계를 실제 코드로 만들고 입력만 계약 예시 payload로 두었다(`distributed-system/publisher`). 서비스 노드에서 `gold-mock` profile로 돌린다. 절차는 [EC2 서비스 배포](../../infra/service/README.md) 「Gold 목업」에 있다. 목업으로 열리는 것은 분석 진입부터 원본 주기도·후보 목록까지였다. 잔차 단계는 2026-09-26 88 Worker 배포로 열렸다(아래 「온라인 계산 Worker」).

**운영 적재를 마쳤다(2026-09-25).** `a8fb6667` Frontend·Backend를 배포한 뒤 같은 커밋의 Publisher 이미지로 적재했다.

- 계정: `planetory_publisher`(`planetory_gold_writer` 멤버, `flyway_schema_history`·`operation_settings` SELECT, public CREATE 회수). 비밀번호는 서버에서 무작위로 만들어 `.env`의 `PUBLISHER_DB_PASSWORD`에만 두었다.
- 적재: `261136679`·`900000008`·`900000027`·`900000002`에 판 `b-1`~`b-4`가 current다. 별마다 세그먼트 1(2,919점)·주기도 1(5,000칸)·후보 3이다. `INTERNAL_SERVICE_TOKEN`이 없어 Backend 알림은 생략됐다.
- 확인: `app.planetory.space`에서 튜토리얼 별의 분석 화면이 열리고 주기도·봉우리 10개가 보인다. 봉우리에서 시작한 제출은 V4 제약(강재민 인계)으로 500이었고, V27 적용(2026-09-26) 뒤 접수되는 것을 확인했다.
- 적재 중 `--no-deps` 없는 `run`이 `service-db`를 한 번 재생성했다. 볼륨이 그대로라 회원 7·별 41·발견 46이 남았고 몇 초 동안 DB 연결이 끊겼다. README 명령을 고쳤다.

### 튜토리얼 5종 등록 (S15P21C206-272, 2026-09-26)

전에는 `tutorial_stars`에 임시 1번(`261136679`)만 있었다. 그래서 별지도에 "튜토리얼 번호를 확인하지 못했습니다"가 떴고(화면은 5칸을 요구한다), 1번을 끝내는 제출은 다음 순번이 없어 503이었다. 109 확정 5종의 실제 Gold를 싣고 전환했다. 절차는 [EC2 서비스 배포](../../infra/service/README.md) 「튜토리얼 5종」에 있다.

- **실행 방식.** 272가 develop에 병합되기 전이라 운영 Publisher 이미지 `a8fb6667`에 272 브랜치의 `publisher` 패키지와 V29 마이그레이션 목록을 읽기 전용으로 덮어 실행했다. payload는 로컬 `tutorial-build`로 만들었다(판정 규칙 승인 `2026-09-26-23:04 김동혁 승인`). 파일 44개는 checksum을 대조한 뒤 서버 작업 폴더로 옮겼다.
- **백업.** 적재 전 `pg_dump -Fc`를 EC2-A `~/backups/planetory-pre272-20260926T140808Z.dump`에 받았다(390 KB, 테이블 데이터 47개, 권한 600, 2026-09-27 삭제). 회원 정보가 들어 있어 서버 밖으로 옮기지 않았다.
- **적재.** `149603524`·`307210830`·`279569718`·`300871545`·`278956474`에 판 `b-5`~`b-9`가 current다(V29, `planetory_gold_writer`). 활성 후보는 각각 1·3·1·1·2이고 모두 처분·주기도가 있다. `INTERNAL_SERVICE_TOKEN`이 없어 Backend 알림은 생략됐다.
- **전환.** 모의 실행에서 회원 7·제출 3·분석 기록 3·성과 2·성과로 연 별 2·목업 판 1·목업 후보 3을 보고했다. 사전 조회와 같아 적용했다. 적용 뒤 상태는 다음과 같다.
  - `tutorial_stars` 1~5가 활성이다.
  - 회원 7명의 튜토리얼 1번이 `149603524`(순번 0, `unexplored`)로 옮겨졌다. 성과로 별 2개를 더 열었던 회원은 별 1개가 됐다.
  - `261136679`는 `hidden`이고 제출·진행도·해금·판이 모두 0이다. 더미 별 목업 `b-2`~`b-4`는 남았다.
- **운영 동작.** 전환 뒤 회원 한 명이 1번 WASP-62 b를 맞혀(`matched`, 성과 인정) 2번이 열렸다. 전에는 이 제출이 다음 순번 부재로 503이었다.
- **더미 별 완전 삭제(같은 날, 사용자 요청).** 성과 지급 후보는 공개 별이면 Gold 유무를 보지 않는다. 그래서 더미 별 40개가 남아 있으면 튜토리얼에서 성과를 얻은 회원이 Gold 없는 별(37개)이나 가짜 곡선 별(3개)을 받는다. 삭제 전 `pg_dump`를 `~/backups/planetory-pre-dummy-purge-20260926T142850Z.dump`에 받았다(507 KB, 2026-09-27 삭제). 이어서 일회성 SQL로 모의 실행을 거쳐 적용했다. 대상은 별 40, 목업 판 `b-2`~`b-4`와 후보 9, 해금 40, 진행 40(테스트 회원 1명)이고 팔로우와 회원 제출은 0이었다. 적용 뒤 운영 별은 튜토리얼 5종과 숨긴 `261136679`, 모두 6개다. 목업 판은 0이다. 이제 성과 지급 후보가 비어 있어 튜토리얼 뒤에는 새 별이 열리지 않는다(오류 없이 빈 값). 일반 탐사 별은 실제 Gold 공급(79·85)이 들어와야 생긴다.
- **브라우저 확인(2026-09-27 0시대 KST, 옮긴 기존 계정).** 결과는 다음과 같다.
  - 별지도: 튜토리얼 경고가 없고 배지 1이 보인다.
  - 퀘스트: 0/5(1번 시작 가능)였다.
  - 1번 분석 화면: 곡선·주기도·봉우리 10개가 뜨고 API는 모두 200, 콘솔 오류는 0이다.
  - 1번 제출: 추천 1위 봉우리 4.4118일, 위상 0.6967–0.7313, "행성 같음"으로 냈다. 결과는 `matched` `c-13`, CONFIRMED(`archive` / `WASP-62 b` / `CP`), 판단 `AGREES`, 성과 인정(등급 A)이다. 새로 열린 별은 없다(지급 후보 없음). 진행은 `completed`(`all_found`)가 됐다.
  - 제출 뒤: 퀘스트가 1/5가 되고 2번이 열렸다. 2번 분석 화면(b-6)도 열렸다.
  - NASA 설명(268): 목록에 `c-13`이 연결돼 `not_requested`로 나온다. 설명 요청 자체는 하지 않았다.
- **잔차 단계(Worker).** 같은 계정으로 2번에서 첫 추천 봉우리 3.6894일을 내 `matched` `c-14`(CONFIRMED, `archive` / `L 98-59 c`)가 됐다. 이어서 「다음 곡선 단계로」로 c를 뺀 잔차 작업을 요청했다. 결과는 다음과 같다.
  - 작업은 `COMPLETED`였고, 다른 회원이 먼저 진행할 때 Worker가 계산한 결과(`computedAt` 15:13:50Z)를 캐시로 재사용했다.
  - 잔차 1단계 곡선(3797점)·주기도·봉우리가 모두 200이다.
  - 봉우리 1위는 7.4519일(L 98-59 d), 4위는 2.2543일(L 98-59 b)이다. 실제 튜토리얼 판에서 Worker 잔차가 다음 행성을 드러냄을 확인했다.
- **서버 작업물 삭제(2026-09-27, 사용자 승인).** 서버 작업 폴더 `~/tutorial-272`(1.2 MB)와 백업 두 개(위 390 KB·507 KB)를 지웠다. 재실행 확인은 병합 전에 요약값 대조로 대신했다. 병합될 `load.payload_digest`(develop과 같은 코드)로 계산한 5종 요약값이 운영 current 판 `b-5`~`b-9`에 저장된 값과 모두 같아, 병합 뒤 `load-payload`를 다시 돌리면 `ALREADY_PUBLISHED`가 된다(운영 DB는 읽기 전용 조회). 운영 백업의 보관 기간·접근자·파기 방식이 정해지지 않았고(의사결정 기록부 「운영 기록·백업」) 덤프에 회원 정보가 들어 있어 목적을 다한 뒤 남기지 않았다. 전환으로 지운 회원 기록은 목업 곡선에서 나온 것이라 복원 대상이 아니다. 이제 2026-09-26 이전 상태로 되돌릴 수단은 없다. payload 5개와 일회성 SQL은 작업자 로컬 인계 폴더에만 있다.
- **남은 알림 정리(2026-09-27, 사용자 승인).** 전환이 성과를 지웠지만 그 성과 알림이 `notification_outbox`에 남아 있었다. `achievement:1`·`achievement:2`(회원 1명, `pending`)이고 payload `ticId`가 숨긴 `261136679`를 가리켰다. 전달되면 누를 때 `STAR_LOCKED`가 난다(!226 강재민 리뷰). 전달된 `notifications`는 0건이었다. 두 행을 일회성 SQL로 지웠고 남은 것은 0건이다. 전환 SQL에도 같은 삭제를 넣었다.

### EC2-B 레지스트리 매일 정리 (2026-09-25 설치)

`/opt/planetory/registry-prune-daily.sh`와 `/etc/cron.d/planetory-prune`(매일 19:40 UTC, `--apply --gc`)을 설치했다. 모의 실행은 배포 중인 `a8fb6667`을 보호하고 삭제 예정 15·유지 65였다. 첫 실제 실행(2026-09-26 04:40 KST)은 `in_use=6d1926d5…,a8fb6667…`로 돌아 **삭제 23·유지 68**이었고 가비지 수집 뒤 레지스트리가 다시 떴다. 모의 실행보다 삭제가 많은 것은 그 사이 develop 병합으로 태그가 쌓였기 때문이다. 운영 이미지 backend·derived-compute `6d1926d5`와 frontend `a8fb6667`의 매니페스트가 남아 있음(200)을 확인했다. 로그는 `/var/log/planetory-prune.log`.

## 온라인 계산 Worker (S15P21C206-88, 2026-09-26)

`222918`(`6d1926d5`, !216 병합)로 [EC2 서비스 배포](../../infra/service/README.md) 「온라인 계산 Worker」의 첫 배포 절차를 밟았다. 운영에서 잔차·주기도 계산이 열렸다.

**계산이 맞는 답을 냈다.** 후보 `c-2`·`c-3`(TOI-270 c·d)을 뺀 잔차 주기도에서 최고 봉우리가 3.3591일로 올라와 남은 후보 b(3.35992일)와 맞았다. 응답이 온 것만이 아니라 Gold → Backend 조립 → Worker 계산 → 응답 해석이 수치적으로 이어졌다는 근거다. 비트 단위 수치 대조는 131이 한다.

| 항목 | 값 |
| --- | --- |
| Worker 이미지 | `planetory/derived-compute:6d1926d5d5936eff895fcc817584aa350961c616`, digest `sha256:a34915dbca19631cb5f902840ca425fc52da726cb6ab200d679f08773fc90538` |
| runtime | python 3.12.14, numpy 2.5.3, astropy 7.2.2, astro_kernel 0.1.0 |
| `.env` | 배포 job이 `DERIVED_COMPUTE_IMAGE`를 기록했고, `DERIVED_COMPUTE_URL=http://derived-compute:8090` 한 줄을 손으로 넣었다. 동시 계산 수는 compose 기본값 `PLANETORY_RESIDUAL_MAXRUNNING=1` |
| Backend 재배포 | 배포 전 DB 덤프 `backups/service-db-20260925-161014.sql`, 헬스 통과. 이 배포에서 V26~V29가 적용됐다(위 「병합 후 CI 배포 결과」) |

- Worker 확인: `healthy`. Backend 컨테이너에서 `http://derived-compute:8090/healthz`가 응답했고, `runtime.worker_image` 태그가 병합 commit과 같았다.
- 동작 확인: 튜토리얼 별 `261136679`(판 `b-1`)에서 김동혁 계정으로 봉우리를 제출하고 잔차를 요청했다. `rj-1`(후보 `c-2` 제거, 01:26 KST)과 `rj-2`(`c-2`·`c-3` 제거, 18:44 KST) 모두 Backend 로그에 `RESIDUAL 완료`·`PERIODOGRAM 완료`가 남았다.
- 131 인계: `DERIVED_COMPUTE_CAPTURE_DIR`를 18:35 KST에 켜고, `rj-2`의 `{request, response}` 두 건을 받은 직후 껐다. 서버에는 사본을 남기지 않았다. 파일은 프로젝트 비공개 스니펫 `$193`에, 설명은 !211 note 2872124에 있다. 스니펫은 저장소 이력 밖이라 131이 기준 입력을 고정할 때까지 지우지 않는다. 고정한 뒤의 정본 위치는 131이 정한다.
- 시험 흔적: 김동혁 계정에 제출 `sub-1`(매칭 안 됨)·`sub-2`(`c-2`)·`sub-3`(`c-3`), 성과 2건, 새로 열린 별 `900000020`·`900000011`이 남았다. 아래 「손으로 넣은 데이터」 표에도 적었다. 이 흔적은 같은 날 272 전환과 더미 별 삭제로 모두 지웠다(위 「튜토리얼 5종 등록」). 잔차 작업과 결과는 Backend 메모리 저장소(`InMemoryResidualJobStore`)에 있어 Backend를 다시 띄우면 사라진다. Redis 저장은 `S15P21C206-89`다.
- 동작 확인은 Frontend `a8fb6667`에서 했다. 같은 날 22:29 KST에 Frontend를 `50e13981`로 올렸고(위 절), 이 판에서 잔차 화면은 다시 확인하지 않았다.
- 되돌리기는 [EC2 서비스 배포](../../infra/service/README.md) 「온라인 계산 Worker」의 되돌리기 표를 따른다.

## Publisher 운영 적재 경로 (S15P21C206-85, 2026-09-27)

GCP Node 1 Publisher가 tailnet으로 EC2-A 서비스 DB에 적재하고 Backend에 알리는 경로를 열었다. 구성·ACL·검증은 [EC2 서비스 배포](../../infra/service/README.md) 「Publisher 운영 적재 경로」에 있다.

| 항목 | 값 |
| --- | --- |
| 배포 경로 `compose.yaml` | 85 브랜치 판(`d146e104`, `service-db` `127.0.0.1:5432`)으로 손으로 교체. 이전 판은 `compose.yaml.bak-85-20260926-191132` |
| `service-db` | 04:11 KST 재생성. 직전 덤프 `backups/service-db-20260926-191132.sql` |
| `.env` | `INTERNAL_SERVICE_TOKEN`을 새로 만들어 넣었다. 값은 EC2-A `.env`와 Node 1 env 파일에만 있다 |
| Backend | 04:12 KST 같은 이미지로 재생성해 토큰을 읽혔다. 헬스 UP, 토큰 없는 내부 호출 401 |
| `tailscale serve` | `--tcp 5432`·`--tcp 8080` → loopback(`--bg`, 재부팅 뒤에도 유지) |
| Tailscale | `ec2-a` `tag:hadoop` → `tag:service`, `node-1`에 `tag:publisher` 추가 |
| Node 1 | `/etc/planetory/publisher/env`(root `0600`), 이미지 `planetory/publisher:50e13981b036aa1378d8ca0d1624641cfc9d48ab`(V29) |

- **MR 병합 전 주의.** CI 배포 job은 자기 파이프라인 commit의 `compose.yaml`을 올린다. 병합 전 develop 판에는 `service-db` 포트가 없다. 그 뒤 `service-db`가 재생성되면(인자 없는 `up -d`, `--no-deps` 없는 `run`) loopback 포트가 사라져 적재 경로가 끊긴다. 도는 컨테이너는 배포만으로는 바뀌지 않는다.
- **실제로 덮였다(2026-09-27 05:25 KST).** develop `c3d8ba85`의 Frontend 배포(job `648986`)가 서버 `compose.yaml`을 포트 없는 판으로 올렸다. 도는 `service-db`는 `127.0.0.1:5432`를 그대로 물고 있고 serve도 살아 있어 경로는 동작한다. **06:12 KST에 되돌렸다.** 85 병합 뒤 첫 배포(Frontend `0d2d2afa`, job `649089`)가 포트 줄이 있는 `compose.yaml`을 올렸다. `service-db`·Backend는 재생성되지 않았고, 새 ACL(`tag:service`)에서 CI의 `deploy@ec2-a` 접속도 성공했다. 이제 `service-db`를 재생성해도 포트가 유지된다.
- Backend 재생성으로 메모리 저장소의 잔차 작업 `rj-1`·`rj-2`가 사라졌다(`InMemoryResidualJobStore`, 위 88 절).
- 시험은 임시 `hidden` 별 `900000099`로 했고 목업 판·별을 모두 지웠다. 시험 전후 운영 DB는 별 6개, current 판 5개(튜토리얼 `b-5`~`b-9`)로 같다.

## NASA 정보·AI 설명 운영 적용 (S15P21C206-277, 2026-09-27)

266~270의 NASA 원천과 AI 설명을 운영에서 처음 실제로 돌렸다. 상세는 [NASA 운영 가이드](../operations/nasa-planet-info-runbook.md) 11절.

- 268: 화면의 「NASA 자료 요청」 POST로 `c-13`(`WASP-62 b`)의 NASA 자료가 `ready`로 저장됐고, 설명은 `disabled`로 모델을 부르지 않았다. 재조회·재요청은 NASA를 다시 부르지 않았다(`attempt_generation=1`).
- 270: 결과 목록 POST도 `ready`(행성 1개)로 저장됐다. 화면 위젯은 아직 없어(271) API로 확인했다.
- **설명 생성은 켜 두었다(07:25 KST 적용, 07:32 KST부터 연속, 남은 1주 운영).** EC2-A `.env`에 `NASA_EXPLANATION_ENABLED=true`, `NASA_EXPLANATION_CHAT_MODEL=openai`, 회원별 20·전체 300회/일, `GMS_KEY`(사용자가 직접 넣음). 예산 상한은 약 30,000크레딧이고, 매일 GMS 대시보드를 보고, 결정 시점 잔여 99,795 기준 누적 사용이 10,000크레딧(경보선)을 넘거나 급증하면 `NASA_EXPLANATION_ENABLED=false`로 끈다.
- 설명 실측: 270 WASP-62 b 설명 성공(2.3초), 재요청 재사용. 268 `c-13`은 모델 출력이 서버 검증에서 떨어져 `invalid_output`(간헐적, 1시간 뒤 재시도 가능). 모델 호출 2회·약 28크레딧. `ENABLED=false` 되돌리기에서 기존 설명 보존·새 호출 차단을 확인하고 다시 켰다.
- **원인 수정(프롬프트 v5)은 MR `!230` 병합 뒤 Backend `59419ec0`로 배포했다(15:38 KST).** 배포 전 다른 회원의 `c-16`(L 98-59 b) 설명이 v4 `invalid_output`으로 실패해 버그 재발을 보였고 `c-14`(L 98-59 c)는 v4 `ready`였다. 배포 뒤 `c-13`(WASP-62 b) 설명이 `nasa-ko-v5` `ready`(시도 1회, 16:10 KST, 출력 약 77토큰)다. v4 행은 조회에서 빠지고 다시 요청하면 v5로 만든다(runbook 11.2). 일일 집계는 UTC 2026-09-27 3회(다른 회원 2, 확인 1)다.
- Backend는 이 작업에서 07:25·07:31경·07:32 KST에 같은 이미지로 재생성됐다(설정 적용·끄기·다시 켜기). 로그인 세션은 유지된다.

## 시네마 화면 운영 기본 (S15P21C206-274, 2026-09-27)

- `build:frontend`·`web:image`가 `--build-arg VITE_CINEMA=true`로 빌드하고 MR `web:build`도 같은 값으로 번들링한다. 운영 번들에는 시네마 앱만 들어가므로 운영에서 기존 화면과 `?ui=legacy`는 쓸 수 없다.
- 분석 화면은 새 디자인이다(2026-09-27 팀 결정, 코드 기본값). `VITE_CINEMA_ANALYSIS`를 주지 않는 운영 빌드가 새 디자인을 싣고 기존형 화면 코드는 번들에서 빠진다(기존형 스타일시트는 남지만 `.pc-classic-analysis` 아래에만 걸려 화면에 영향이 없다). `VITE_CINEMA_ANALYSIS=classic`일 때만 기존형이며(Dockerfile ARG는 두지 않았다), 운영을 되돌릴 때는 해당 MR을 revert한다.
- 되돌리기는 빌드 인자를 빼고 병합·배포하거나, 직전 이미지의 `deploy:frontend:ec2-a`를 다시 실행한다(프로젝트 설정이 롤백 재실행을 허용한다).
- P1 중 운영 API가 응답하는 것(2026-09-27 조회 확인: 공개 은하 정보·타일·별 상세, 팔로우 요약·목록·팔로잉 피드, 내 통계)은 `VITE_P1_ENABLED` 없이도 시네마 앱에서 켠다(`apps/frontend/src/features/p1.ts`). 알림은 목록 조회가 503 `DEPENDENCY_UNAVAILABLE`(안 읽은 수·설정은 200), 전체 통계는 `AGGREGATE_NOT_READY`, 탈퇴는 신청 흐름을 확인하지 않아 `VITE_P1_ENABLED`를 켤 때까지 끈다. 팔로우 추가·해제(쓰기)는 운영에서 시험하지 않았다.
- 스모크(`web:e2e:smoke`)와 `test:docker-defaults`는 `VITE_CINEMA` 없는 빌드(기존 화면)를 본다. 시네마 전용 운영 번들을 여는 브라우저 검사는 아직 없다.
- 상태: 병합·배포했다. 시네마 기본은 Frontend `59419ec0`(job `650655`)부터, 분석 새 디자인 기본(`058a9f42` 병합)은 지금 운영 Frontend `e47f384e`(19:14 KST 기동)에 들어 있다.

## 손으로 넣은 데이터 (운영 값 아님)

로그인을 뚫기 위해 EC2-A DB에 직접 넣었거나, 배포를 확인하려고 화면에서 만든 값이다. **운영이 정한 값이 아니다.**

| 대상 | 내용 |
| --- | --- |
| 옛 임시 튜토리얼 1번 별 | TIC `261136679`. 272 전환으로 `hidden`이 됐고 목업 판·회원 기록을 지웠다. 별 행만 남는다 |
| 88 동작 확인 기록 | 2026-09-26 김동혁 계정이 TIC `261136679`에 낸 제출 `sub-1`~`sub-3`, 그로 인정된 성과 2건, 열린 별 `900000020`·`900000011`. 제출과 성과는 별 결과 페이지와 통계 집계(V21)의 입력에 들어간다. 별 열림 2건은 아래 더미 별 정리 명령에 함께 걸린다. 272 전환에서 제출·분석 기록·성과를 지웠고 열린 별 2건은 272 더미 별 삭제로 함께 지웠다(위 「튜토리얼 5종 등록」) |
| 277 동작 확인 기록 | 2026-09-27 김동혁이 로그인한 시험 계정이 튜토리얼 1번(TIC `149603524`)에 낸 제출 `sub-10`(미매칭, 지속 시간 비율 초과)·`sub-11`(`c-13` 매칭), 그로 인정된 성과 1건(A), 이어 열린 별 1개. NASA 원천 `nasa_planet_info` 1행(`c-13`, `WASP-62 b`)과 270 항성 목록 1건(TIC `149603524`). 설명 행 2개(`c-13` 실패 1, 270 행성 성공 1)와 일일 한도 집계 2. 제출·성과는 88 기록처럼 별 결과 페이지와 통계(V21) 입력에 들어가지만 실제 사용자 흐름으로 만든 정상 기록이라 남긴다. NASA 자료와 설명은 운영 기능이 만드는 캐시라 지우지 않아도 된다 |

더미 별 `900000002`~`900000041`과 목업 Gold 판 `b-1`~`b-4`는 2026-09-26에 모두 지웠다(위 「튜토리얼 5종 등록」). 튜토리얼 5종(`b-5`~`b-9`)은 운영 값이다. 빈 DB에서 가입이 막히는 조건과 시드 순서는 [EC2 서비스 배포](../../infra/service/README.md)에 있다.

## 계정 분리 적용 — 소유자·런타임 (2026-09-21)

develop의 계정 분리(`S15P21C206-238`)가 들어오면서 배포 계약이 바뀌었고, EC2-A에 적용을 마쳤다. 절차는 [EC2 서비스 배포](../../infra/service/README.md)의 「계정 분리」 절을 따랐다.

| 항목 | 상태 |
| --- | --- |
| `planetory_service` 계정 | 기존 볼륨에 수동 생성. `planetory_app` 부여, `public` 스키마 `CREATE` 회수 |
| `.env`의 `DATABASE_PASSWORD` | 추가. `POSTGRES_PASSWORD`와 다른 값 |
| CI 배포 경로 `/home/deploy/planetory` | `.env`와 `service-db-init/`를 배치. `deploy` 계정 소유 |
| `docker compose config -q` | `deploy` 계정으로 통과 |

**계정 전환이 2026-09-22 백엔드 배포로 완료됐다.** Flyway가 소유자로 V10~V19를 적용하며 `planetory_app` GRANT를 채웠고, 앱은 `planetory_service`로 붙는다. 한 번의 기동 안에서 처리됐고 실패한 마이그레이션은 없다.

| 확인 | 결과 |
| --- | --- |
| 앱 접속 계정 | `planetory_service` |
| 마이그레이션 계정 | `planetory` (소유자) |
| 적용 버전 | V9 → V19, 10건 적용, 실패 0 |
| 런타임 계정 조회 | 회원·별 테이블 정상 조회 |
| 런타임 계정 `CREATE` | 거부 유지 |

**배치 적재 계정은 아직 갈리지 않았다.** 접속 계정은 셋이 아니라 둘이다.

| 역할 | 상태 |
| --- | --- |
| 소유자·마이그레이션 `planetory` | 적용 |
| 런타임 `planetory_service` (`planetory_app` 보유) | 적용 |
| 배치 적재 `planetory_gold_writer` | **역할만 생성, 부여받은 계정 없음** |

`service-db-init/10-app-account.sh`가 `planetory_gold_writer` 역할을 만들기는 하지만 그 역할을 부여받은 계정이 어디에도 없다. 후보 정정 계약의 「배치 역할은 회원 데이터를 고칠 수도 셀 수도 없다」는 권한 경계는 배치가 그 역할을 가진 계정으로 붙어야 성립한다. 지금은 Publisher가 소유자로 붙으면 경계가 무력화된다. 부여 대상 계정을 만드는 일은 남은 항목이다.

## CI push 차단과 해소 (2026-09-21)

`build:frontend`는 이미지 빌드까지 성공하고 **레지스트리 push에서 실패했다.** 아래 조치로 해소했고 지금은 통과한다.

```text
Get "https://<레지스트리 호스트>:<포트>/v2/": net/http: request canceled
while waiting for connection (Client.Timeout exceeded while awaiting headers)
```

원인은 **EC2-B의 컨테이너가 자기 호스트에 닿지 못하는 것**이다. 호스트에서는 레지스트리가 정상 응답하지만(`200`), 같은 호스트의 컨테이너가 호스트 주소로 접근하면 막힌다. 인터넷과 tailnet 피어로는 나간다.

| 경로 | 결과 |
| --- | --- |
| EC2-B 호스트 → 레지스트리 | 200 |
| EC2-A → 레지스트리 | 200. 인증서 유효, `docker pull` 경로 정상 |
| EC2-B 컨테이너 → 호스트 주소의 레지스트리 포트 | 차단 |
| EC2-B 컨테이너 → 레지스트리 컨테이너 주소 | 200 |
| EC2-B 컨테이너 → EC2-A의 `deploy` 계정 SSH | 정상. 배포 경로에서 `config -q`까지 통과 |
| EC2-B 컨테이너 → 인터넷 | 200 |

측정 주의. `curl telnet://`은 연결에 성공해도 세션을 닫지 않아 `--max-time`에 걸린다. 연결 여부 판정에 쓰면 정상 경로를 차단으로 오판한다. 포트 도달만 볼 때는 `tcpdump`로 핸드셰이크를 보거나 실제 프로토콜로 확인한다.

차단 주체는 UFW다. 커널이 직접 남긴 기록이 있다.

```text
[UFW BLOCK] IN=docker0 SRC=<컨테이너> DST=<EC2-B tailnet 주소> DPT=<레지스트리 포트>
[UFW BLOCK] IN=docker0 SRC=<컨테이너> DST=<docker0 게이트웨이> DPT=<레지스트리 포트>
```

Tailscale 문제가 아니다. 호스트의 어느 주소로 가든 똑같이 막히며, tailnet과 무관한 도커 게이트웨이도 마찬가지다. 반대로 tailnet 피어로 나가는 경로는 정상이다.

### 적용한 해법: 방화벽을 건드리지 않는다

컨테이너에서 **레지스트리 컨테이너로 직접 가면 통한다.** 같은 브리지 위라 호스트 `INPUT`을 거치지 않는다. Runner 설정의 호스트 매핑을 레지스트리 컨테이너 주소로 바꿨다.

```toml
# /srv/gitlab-runner/config/config.toml
extra_hosts = ["<레지스트리 호스트>:<레지스트리 컨테이너 주소>"]
```

인증서는 이름으로 검증하므로 그대로 유효하고, push가 호스트 밖으로 나가지 않아 「이미지 레지스트리」가 적어둔 의도에 더 맞는다.

적용 후 `build:frontend`를 재실행해 **push 성공과 레지스트리 태그 등록을 확인했다.** EC2-A에서도 같은 태그가 조회된다. 되돌리려면 EC2-B의 `config.toml.bak-20260921`을 복원하고 Runner를 재시작한다.

**한계.** 레지스트리 컨테이너 주소는 기본 브리지가 순서대로 준 값이라 레지스트리 컨테이너를 다시 만들면 바뀔 수 있다. 바뀌면 push가 같은 방식으로 다시 깨진다. 고정이 필요해지면 사용자 정의 네트워크에 네트워크 별칭으로 붙여 Docker DNS가 이름을 풀게 한다.

### 배포 경로에서 확인한 것

컨테이너에서 EC2-A로 나가는 경로는 막혀 있지 않다. `tcpdump`로 보면 출발지가 EC2-B의 tailnet 주소로 masquerade되어 나가고 handshake가 완료된다. 컨테이너에서 `deploy` 계정으로 실제 SSH가 붙고, 배포 경로에서 `docker compose config -q`까지 통과한다.

따라서 `.remote-compose-deploy`의 "job 컨테이너의 연결은 Runner 호스트의 tailnet 신원으로 나간다"는 주석은 **맞다.** masquerade로 성립한다.

Runner 자체는 문제가 없다. `planetory-docker-runner`는 online이고 `amd64-docker` 태그와 `run_untagged=true`를 갖는다. CI 변수 `DEPLOY_USER`·`EC2_A_HOST`·`EC2_A_DEPLOY_PATH`·`REGISTRY_IMAGE_PREFIX`도 실제 서버 구성과 일치한다.

## CI/CD 구성

| job | 언제 | 무엇 |
| --- | --- | --- |
| `web:build` | 프론트 변경 | `npm run build` + 단위 테스트 `npm test`(448개) |
| `web:e2e:smoke` | develop 병합 뒤 자동, MR에서는 수동 | 브라우저 스모크 `test:e2e:smoke`(production·docker-defaults·auth) |
| `web:e2e` | 수동 | 브라우저 테스트 전체 `test:e2e`(505개, 동시 2) |
| `web:image` | `Dockerfile`·`nginx.conf` 변경 | 이미지 빌드 + 이미지 안에서 `nginx -t` |
| `backend:schema` | 마이그레이션 변경 | 버전 선점·중복, 되돌릴 수 없는 변경 |
| `backend:build` | 백엔드 소스·테스트 변경 | `./gradlew bootJar test -PmrTests` (DB 없는 테스트 + `GoldCatalogSchemaTest`, PostgreSQL 서비스) |
| `backend:image` | `Dockerfile` 변경 | 이미지 빌드. `backend:build`가 실패하면 돌지 않는다 |
| `backend:test` | develop 병합 뒤 자동, MR에서는 수동 | 백엔드 테스트 전체(PostgreSQL 서비스 + dind). 이미지 빌드·배포를 막지 않는다 |
| `build:*` | 기본 브랜치 | 레지스트리 이미지 빌드·푸시 |
| `deploy:*:ec2-a` | 기본 브랜치, 수동 버튼 | 교체 → 헬스 확인 → 실패 시 롤백 |

검증 job은 전부 `needs: []`라 파이프라인 시작과 동시에 병렬로 뜨고, 각자 자기 경로가 바뀔 때만 돈다.

넣지 않은 것과 이유. **CI는 배포를 막을 수 있는 것만 본다.**

- 포맷 검사 — 빌드·배포·동작과 무관하다. LF 기준으로 이미 16개 파일이 실패하기도 한다.
- 브라우저 테스트 전체 — 동시 2로도 약 26분이라 관문이 아니라 수동 job(`web:e2e`)으로 둔다. 근거는 [CI/CD 「프론트 테스트」](../operations/cicd.md#프론트-테스트-mr-관문과-브라우저-테스트-s15p21c206-91).

## 검증 경계

**실행해서 확인한 것.** 프론트 `npm test` 343개와 `npm run build` 통과. 배포 스크립트는 가짜 `docker`·`curl`로 정상 배포, `up -d` 실패 시 롤백, 복수 서비스 교체, `curl` 부재 시 교체 전 중단, 덤프 실패 시 중단, 이미지 변수 오타 검출을 확인했다. 스키마 검사는 **로컬에서** 실제 저장소로 선점 차단·통과·건너뛰기를 확인했고, 되돌릴 수 없는 구문 6종 차단과 한국어 주석 오탐 없음을 확인했다. 이미지 빌드 두 개는 로컬 Docker에서 실제로 실행했다. 수정 전 `nginx.conf`로 `nginx -t`가 `host not found in upstream`으로 실패하는 것도 확인했다.

**실환경에서 확인한 것(2026-09-21).** GitLab 파이프라인은 실행되고 있다. develop의 `build:frontend`는 Runner를 잡고 dind에서 이미지 빌드까지 마치며 커밋 SHA 태그도 정확히 붙는다. `rules: changes` 판정과 dind 기동도 동작한다. EC2-A의 배포 경로는 `deploy` 계정으로 `docker compose config -q`를 통과하고, 레지스트리 인증서는 EC2-A에서 유효하다.

**MR 단계 검증 job이 실제로 돌았다(2026-09-22).** MR 파이프라인에서 `backend:schema`, `backend:build`, `backend:image`, `web:build`, `web:image`가 모두 통과했다. 스키마 검사는 타깃 브랜치를 가져와 develop의 최대 버전 `V19`와 대조하고 선점 검사를 통과했다. 그 전까지 이 job은 **추가된 뒤 한 번도 실행되지 않았다.** 원인은 아래 「MR 단계 검사가 실행되지 않던 결함」에 있다.

**배포까지 확인한 것(2026-09-21).** `deploy:frontend:ec2-a`를 실행해 성공했다. 프론트엔드 컨테이너가 레지스트리의 커밋 SHA 이미지로 교체됐고 `planetory.space`와 로컬 오리진이 모두 200을 반환한다. 다른 컨테이너는 영향받지 않았다.

**롤백까지 확인한 것(2026-09-21).** 이 브랜치의 `deploy.sh`를 EC2-A의 격리 프로젝트에서 실제 docker·curl로 돌려 헬스 실패 시 되돌리기와 `.env` 기록을 확인했다. 자세한 결과는 위 표에 있다.

**백엔드 배포까지 확인한 것(2026-09-22).** `build:backend`와 `deploy:backend:ec2-a`를 실행해 성공했다. 백엔드가 커밋 SHA 이미지로 교체되고 V19까지 마이그레이션이 적용됐다. 헬스 200, OAuth 진입 302, 기동 로그 오류 0건이다. 배포 전에 DB를 덤프해 두었다. develop의 배포 job은 덤프를 뜨지 않으므로 손으로 받았다.

배포한 커밋은 develop 최신보다 5개 뒤지만 **그 사이에 `apps/backend` 변경이 없어** 백엔드 코드는 최신과 같다.

**확인하지 못한 것.** 운영 배포에서의 **롤백**은 여전히 관찰하지 않았다. 두 배포 모두 성공해 롤백 경로가 밟히지 않았고, develop의 배포 job에는 그 로직이 아예 없다. 캐시 적중도 관찰하지 않았다.

## 남은 결정 (MR에서 확인)

1. ~~**프론트 단위 테스트를 CI 관문으로 세울지.**~~ 2026-09-25 결정: 세운다(`web:build`에 `npm test`, S15P21C206-91). 448개가 수 초이고 모두 통과해, 깨진 채 병합되는 쪽이 더 비싸다고 봤다.
2. **`-- IRREVERSIBLE:` 방식이 적절한지.** 되돌릴 수 없는 마이그레이션을 금지하지 않고 파일에 근거를 요구한다. 세 배포로 나눌 수 있는지 한 번 묻는 것이 목적이다.
3. **EC2-B 배포 job 제거.** [CI/CD](../operations/cicd.md)가 이 티켓에 지정했고 실제로 지웠다. 확인이 필요하다.

## 이관한 결함

배포 과정에서 찾은 프론트·백엔드 결함은 담당자 버그 티켓으로 넘겼다. 이 티켓에서 고치지 않는다.

| 티켓 | 내용 |
| --- | --- |
| `S15P21C206-239` | 401·403과 502·503·504를 분리하는 Nginx·로그인 화면 수정 및 로컬 프록시 검증 완료. [239 검증 기록](../../apps/frontend/docs/ticket-239-readiness.md)을 따르며 리뷰·병합·실제 배포 반영은 별도다 |
| `S15P21C206-240` | OAuth `failureHandler`가 실패 원인을 기록하지 않는다. 초기 데이터가 없을 때 가입이 막히는 증상도 진단이 어렵다 |

## 84에 남은 범위

Tunnel 진입과 프론트·백엔드 기동만 구현했다. 티켓의 나머지는 손대지 않았다.

- ~~Redis runtime, 메모리 상한·eviction 정책~~ → `S15P21C206-254`로 옮겼다
- health/readiness 설계(`S15P21C206-93`)
- 애플리케이션 계층 남용 제어 위치
- 단일 connector 지속 처리량·재연결 실측

## MR 단계 검사가 실행되지 않던 결함 (2026-09-22 해소)

`backend:schema`가 `alpine/git` 이미지를 쓰는데 이 이미지의 `ENTRYPOINT`가 `["git"]`이다. Runner가 붙이는 셸이 `git sh -c ...`로 조립되고 git이 `sh`를 하위 명령으로 오인해 죽었다.

```text
git: 'sh' is not a git command. See 'git --help'.
```

**스크립트가 한 줄도 실행되지 않았다.** 검사 로직에는 문제가 없었고, 빨강이 떠서 MR이 막혀 있었다. `entrypoint: [""]`로 비워 해소했다.

같은 함정이 있는 이미지는 이것뿐이다. 나머지 job은 `docker:cli`, `alpine`, `node`, `eclipse-temurin`, `python`을 쓰며 모두 셸을 기본 진입점으로 삼는다.

**교훈.** 로컬에서 스크립트를 돌려 통과한 것은 CI에서 그 스크립트가 실행된다는 뜻이 아니다. 이미지의 진입점이 다르면 스크립트에 도달하지도 못한다. 검증을 적을 때 실행 위치를 함께 남긴다.

## develop의 배포 job은 구버전이다

지금 develop에 있는 `.remote-compose-deploy`는 `deploy.sh` 없이 ssh 한 줄로 교체만 한다. 헬스 확인, 실패 시 롤백, 배포한 이미지를 `.env`에 기록하는 일이 모두 빠져 있다. 이 브랜치가 그 셋을 넣는다.

기록이 빠진 결과가 실제로 나타났다. 2026-09-21 프론트 배포와 2026-09-22 백엔드 배포 **두 번 모두** 도는 이미지는 CI 이미지인데 `.env`의 선언은 `:local`로 남았다. 그 상태로 누가 인자 없이 `docker compose up -d`를 실행하면 추적되지 않는 옛 이미지로 조용히 되돌아간다. 두 번 다 값을 손으로 맞춰 해소했다. **병합 전까지는 배포할 때마다 반복되므로 배포 후 `.env`를 확인한다.**

### 이 브랜치의 deploy.sh를 실제 서버에서 검증했다 (2026-09-21)

운영 서비스를 건드리지 않도록 EC2-A에 격리된 compose 프로젝트를 띄워, 가짜 명령이 아닌 **실제 docker와 curl**로 돌렸다. 확인 후 프로젝트는 지웠다.

| 시나리오 | 결과 |
| --- | --- |
| 정상 배포 | 헬스 통과 후 `.env`에 배포한 이미지가 기록된다. 선언과 실행이 일치한다 |
| 헬스 실패 | 제한 시간 뒤 직전 이미지로 되돌리고 서비스가 200을 회복한다. 종료코드 `1`로 실패를 알린다 |
| 이미지 변수 불일치 | 교체가 일어나지 않은 것을 잡아내고 변수 이름을 지목하며 실패한다 |

세 번째는 의도한 시험이 아니라 하네스 실수로 드러났다. compose가 이미지 변수를 읽지 않는 상태였는데, 교체가 없었으므로 헬스는 통과했다. 그 가드가 없었다면 **배포하지 않고 성공을 보고했을 것이다.**
