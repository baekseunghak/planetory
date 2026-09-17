# EC2 서비스 배포

Frontend, Backend와 온라인 계산기의 공통 Docker Compose 설정을 둘 위치다.

`compose.yaml`은 Registry의 Frontend·Backend 이미지를 실행한다. 로컬 빌드는 하지 않으며 실제 DB 주소, Gold 경로와 비밀 값은 각 서버의 `.env`에서 주입한다.

GitLab의 EC2-A 수동 배포 job이 이 Compose를 사용해 선택한 서비스만 갱신한다. EC2-B는 사용하지 않으므로 `ec2-b/`에는 설정을 두지 않는다(시스템 아키텍처 8장 D4). 노드별 차이가 필요하면 `ec2-a/`에 둔다.

## service-db

PostgreSQL 18.6을 같은 Compose 안에서 `service-db`로 띄운다. Backend는 `service` 네트워크로 `service-db:5432`에 붙으며 호스트 포트를 열지 않는다. 외부 인바운드는 0개다.

`.env`에 `POSTGRES_PASSWORD`가 없으면 기동이 실패한다. `POSTGRES_DB`, `POSTGRES_USER`와 Backend의 `DATABASE_*`는 기본값을 쓰면 서로 맞는다.

데이터는 named volume `planetory-service-db-data`에 있다. 이 볼륨이 회원·제출·히스토리의 유일한 사본이다(복제·백업 없음, ADR D6·D7). `docker compose down -v`와 볼륨 이름 변경은 곧 데이터 상실이다. 재배포·이미지 교체는 볼륨을 지우지 않는다.

마운트 경로 `/var/lib/postgresql`은 postgres:18에서 바뀐 규약이다. 17 이하의 `/var/lib/postgresql/data`로 되돌리면 깨진다.

현재는 소유자 겸 서비스 계정 하나(`planetory`)로 접속한다. `planetory_app`·`planetory_gold_writer` 역할 분리는 `S15P21C206-238`의 `users` GRANT가 들어온 뒤에 적용한다.

## 최초 가입에 필요한 초기 데이터

빈 DB에서는 **아무도 가입할 수 없다.** 가입 트랜잭션이 튜토리얼 1번 별을 지급하는데, 마이그레이션의 시드가 `operation_settings` 한 건뿐이라 `tutorial_stars`가 비어 있기 때문이다. 이때 콜백은 `503 DEPENDENCY_UNAVAILABLE`이 되고 회원 생성까지 롤백된다(자세한 조건은 [OAuth 설정](../../apps/backend/docs/oauth-setup.md)).

화면에는 이 503이 `/oauth/callback?error=authentication_failed`로 보인다. `apps/frontend/nginx.conf`가 `/login/oauth2/`의 401·403·503을 같은 경로로 모으기 때문이며, 인증 정보 문제로 오인하기 쉽다.

넣는 순서가 정해져 있다. `tutorial_stars.tic_id`는 `stars`를 참조하고(`fk_tutorial_stars_tic_id`), `trg_tutorial_stars_published` 트리거가 `service_status='published'`를 요구한다. 순서를 뒤집으면 거절된다.

```sql
BEGIN;
INSERT INTO stars (tic_id, confirmed_count, service_status)
VALUES (<운영 TIC>, 1, 'published')
ON CONFLICT (tic_id) DO UPDATE SET service_status = 'published';

INSERT INTO tutorial_stars (seq, tic_id, intent, active)
VALUES (1, <운영 TIC>, 'deep_confirmed', true)
ON CONFLICT (seq) DO NOTHING;
COMMIT;
```

로그인에는 `seq=1` 하나면 된다. 2~5번은 튜토리얼 완료·챌린지 자격 판정에 쓰인다. 어떤 TIC을 쓸지는 운영이 정하며 이 저장소는 값을 정하지 않는다.

## ERD

ERD를 두 벌 낸다. 둘 다 호스트 포트를 열지 않고 `service` 네트워크 안에만 뜬다.
외부 인바운드는 0개로 유지되며 Tunnel이 origin으로 잡는다.

| 호스트 | origin | 도구 | 쓰임 |
| --- | --- | --- | --- |
| `erd.planetory.space` | `http://erd:80` | Liam ERD | 캔버스에서 관계 탐색 |
| `erd-schema.planetory.space` | `http://erd-schema:80` | SchemaSpy | 인덱스·제약·이상징후 상세 |

### 한국어 설명은 DB가 갖는다

설명은 도구가 아니라 `pg_description`에 있다. `COMMENT ON TABLE`·`COMMENT ON COLUMN`을
한 번 쓰면 두 사이트가 같은 값을 읽는다. 도구를 바꿔도 설명이 따라가므로 ERD 도구에
설명을 직접 적어 넣지 않는다. 테이블 설명은 `V10__table_comments.sql`에 있다.

SchemaSpy 7.0.2에는 `-lang` 옵션도 번역 번들도 없다. UI 라벨은 영어로 남고 한국어는
데이터(테이블·컬럼 설명)로만 들어간다. Liam은 이 제약이 없다.

### 생성

생성기는 `erd-refresh` profile에 묶여 평시 `docker compose up -d` 대상이 아니다.
스키마나 코멘트가 바뀌었을 때만 수동으로 돌린다.

```
docker compose --profile erd-refresh run --rm erd-generator         # Liam
docker compose --profile erd-refresh run --rm erd-schema-generator  # SchemaSpy
```

`erd-generator`는 `erd-dump`를 먼저 끝내고 시작한다(`service_completed_successfully`).
`erd-dump`는 서버와 같은 `postgres:18.6-alpine`으로 뜬다. 하위 버전 클라이언트는 상위
서버를 덤프하지 못하고 거부하므로 이미지 버전을 서버와 따로 올리지 않는다.

### Liam 코멘트 보정

Liam v0.7.24의 postgres 파서는 `COMMENT ON TABLE` 일부를 흘린다. 34개 중 9개
(`users`, `posts`, `comments`, `submissions` 등)가 누락되는 것을 실측했다. 원인은
SQL 형태가 아니다. 같은 구조의 테이블이 붙기도 하고 빠지기도 한다.

그래서 `erd-dump`가 `pg_description`을 `comments.json`으로 따로 뜨고, 빌드 뒤
`schema.json`에 덮어쓴다. 파서 결과가 아니라 DB가 정본이다. 생성 로그의
`merged from pg_description: tables=34 columns=264`이 이 단계가 돈 증거다.
Liam을 올릴 때 이 보정이 불필요해졌는지 확인하고, 그래도 두는 편이 안전하다.

### 산출물

`planetory-erd-output`(Liam)과 `planetory-erd-schema-output`(SchemaSpy)에 있다. 둘 다
재생성 가능한 파생물이라 지워져도 데이터 손실이 아니다. `service-db-data`와 혼동하지
않는다. `erd-scratch`·`erd-work`·`erd-npm-cache`는 빌드 중간물이다.

DB 비밀번호는 명령줄 인자에 두지 않는다. 환경변수로 받아 SchemaSpy는 컨테이너 안에서
`chmod 600` properties 파일로 쓰고 실행 후 지우며, 덤프는 `PGPASSWORD`로 넘긴다.
`docker inspect`와 `ps`에 노출되지 않는다.

읽기 계정은 분리하지 않았다. 소유자 `planetory`로 접속한다. `planetory_app`·
`planetory_gold_writer` 역할 분리가 들어오면 ERD 생성기를 읽기 전용 역할로 옮긴다.

행 수는 `schemaspy.norows=true`로 끄고 구조만 낸다. 공개 호스트에 데이터 규모를 싣지
않기 위함이다.

## Cloudflare Tunnel 진입 (S15P21C206-84, 부분)

`cloudflared`는 외부 인바운드 포트를 열지 않고 edge에서만 트래픽을 받는다. 서비스 컨테이너는 같은 `service` 네트워크에 있으므로 Tunnel의 public hostname은 `http://frontend:8080`을 origin으로 지정한다.

도메인은 `planetory.space`이며 Cloudflare zone에 등록되어 있다. Tunnel 이름은 `planetory-service`다.

1. Cloudflare Zero Trust에서 Tunnel을 만들고 connector 토큰을 발급한다.
2. 서버의 `$DEPLOY_PATH/.env`에 `CLOUDFLARE_TUNNEL_TOKEN=<토큰>`을 추가한다. 토큰은 Git·이미지·명령줄 인자에 두지 않는다.
3. `docker compose up -d cloudflared`로 기동한다. GitLab 배포 job은 `frontend`·`backend`만 갱신하므로 `cloudflared`를 내리지 않는다.
4. Tunnel의 public hostname → service `http://frontend:8080`을 연결하고 도메인으로 접속을 확인한다.

connector는 EC2-A에만 둔다. 같은 Tunnel에 커넥터를 여럿 붙여도 Cloudflare는 가장 가까운 하나로만 보내고 분산하지 않으므로(2026-09-16 실측 10/10), EC2-B가 선택되면 전면 장애가 된다.

2026-09-17 확인: EC2-A에서 Cloudflare edge(`icn06`)로 QUIC egress가 열려 있고, 보안그룹 인바운드 개방 없이 `planetory.space` 응답까지 확인했다.

Backend가 아직 배포되지 않은 단계에서도 frontend는 기동한다. `apps/frontend/nginx.conf`가 backend를 요청 시점에 해석하고, 세션 조회(`/api/v1/me`)가 502·504면 401로 낮춰 SPA가 로그인 화면을 보여준다. 다른 `/api/*`는 502를 그대로 전달한다.

Tunnel → nginx 구간은 평문이므로 nginx의 `$scheme`은 항상 `http`다. Cloudflare가 준 `X-Forwarded-Proto`를 그대로 넘기고 Backend는 `server.forward-headers-strategy=framework`로 이를 반영한다. 둘 중 하나라도 빠지면 Tomcat이 상대 리다이렉트를 `http://planetory.space:8080/...`로 절대화해 OAuth 로그인 복귀가 깨진다.

미완료: Redis runtime, 메모리 상한·eviction 정책, health/readiness, 남용 제어 위치, connector 지속 처리량 실측은 이 변경에 포함되지 않았다.
