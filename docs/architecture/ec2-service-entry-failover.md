# EC2 서비스 진입·장애 전환 경계

> 대표 Jira: `S15P21C206-82`
>
> 상태: 채택 (2026-09-17 사용자 결정으로 단일 노드 구성 전면 재작성. 구현·실측은 83·84·93 후속)
>
> 상위 정본: [시스템 아키텍처](system-architecture.md) 8장

**초기 서비스 구성은 EC2-A 단일 노드이며 EC2-B는 사용하지 않는다. EC2-A 장애는 서비스 전면 중단이고 복구 수단을 두지 않는다.** 이 문서는 그 전제 위에서 외부 진입, TLS 종료, 포트·신뢰 경계, 장애 시 대응 범위와 데이터 손실 경계를 정한다. 유료 LB, 자동 DB failover, 실제 서버 구성은 범위 밖이며 구현은 83·84·93이 맡는다.

## 1. 결정

| # | 결정 | 상태 |
| --- | --- | --- |
| D1 | Redis는 EC2-A loopback에 둔다. 온라인 계산 상태·결과·키별 잠금과 **로그인 세션**을 담는다(D10) | 확정 |
| D2 | 진입은 Cloudflare Tunnel 단일 connector다. 사용자 구간 TLS는 edge에서 종료하고 인터넷 구간 평문은 금지한다. **외부 인바운드 개방은 0개다** | 확정 |
| D3 | 서비스 앱 인스턴스는 1개다. A 레코드 라운드로빈과 노드 상호 감시를 도입하지 않는다 | 확정 |
| D4 | **EC2-B는 사용하지 않는다.** 앱·복제·백업·관측 어느 역할도 맡기지 않는다 | 확정 |
| D5 | 테이블 소유자·마이그레이션 계정·서비스 런타임(`planetory_app`)·Publisher(`planetory_gold_writer`)를 분리한다(83) | 확정 |
| D6 | **PostgreSQL Standby를 두지 않는다.** 승격 선택지가 없고 EC2-A 장애는 서비스 전면 중단이다 | 확정 |
| D7 | **백업을 두지 않는다.** 볼륨 상실·논리 오류에서 서비스 도메인 데이터 복구 수단이 없다(PoC 수용) | 확정 |
| D8 | 배포·재시작은 전면 중단을 동반하지만 **로그인은 유지된다**(세션이 Redis에 있다, D10). 무중단 배포를 목표로 두지 않는다 | 확정 (2026-09-17 리뷰 반영으로 개정) |
| D9 | 자체 LB 서버와 Cloudflare 유료 Load Balancing을 도입하지 않는다 | 확정 |
| D10 | **로그인 세션을 EC2-A Redis에 둔다.** 목적은 인스턴스 간 공유가 아니라 재시작 생존이다. 그 대가로 Redis는 인증 경로의 필수 의존이 되고, Redis 장애 시 인증 요청은 503으로 응답한다 | 확정 (2026-09-17 리뷰 반영, 구현은 237) |

### 기각한 후보

| 후보 | 기각 사유 |
| --- | --- |
| EC2-B를 앱 노드로 쓰는 2노드 구성 | 세션·CSRF·OAuth 인가 상태 공유를 백엔드 계약으로 요구하고, 노드 로컬 상태 판정을 이후 모든 개발에 부과한다. 단일 인스턴스 전제는 [서비스 백엔드 계약](../development/service-backend/contracts-and-acceptance.md)의 SB-D07이 이미 확정한 입장이며 이 결정은 그 확인이다 |
| EC2-B 콜드 백업(복제 수신·덤프) | 복구 능력은 오르지만 상시 기동이 필요하고, 복제 슬롯이 Primary 디스크를 채워 유일한 서비스 노드를 죽이는 경로가 생긴다. 향후 선택지로만 남긴다 |
| Cloudflare 미사용(A 레코드 직접 노출 + Let's Encrypt) | 암호화 강도는 같으나 443을 인터넷 전체에 열고 공인 IP를 노출한다. 저장소에 rate limit이 0건이고 `permitAll` 경로가 미인증 호출마다 세션을 만드는 상태라 단일 노드에서 위험이 크다(3.1절) |
| 오사카 CI/CD 노드를 LB·단독 헬스체크로 사용 | 단일 장애점을 새로 만든다. EC2→해당 노드 최소 RTT 26.7ms 실측(tailnet 경유 측정이므로 공용 경로의 하한)이 매 요청에 더해지고, 배포 자격증명 보유 노드가 공개 진입점이 된다. 단독 헬스체크는 감시자 장애 시 판정이 불가능하고 경로 흔들림이 오탐이 된다. **노드 수와 무관하게 유지되는 기각이다** |

Tunnel replica를 여러 노드에 두는 방식도 분산 수단이 아니다. replica는 가장 가까운 connector 하나로만 보내며 분산하지 않는다(2026-09-16 실측 10/10 단일 노드, 공식 문서 동일).

## 2. 단일 경로

```text
사용자 → Cloudflare edge(TLS 종료)
       → Cloudflare Tunnel(단일 connector, outbound 연결만)
       → cloudflared(EC2-A)
       → frontend nginx(EC2-A, 정적 서빙 + /api 프록시)
       → backend(EC2-A)
backend → PostgreSQL(EC2-A) · Redis(EC2-A) · Python Worker(EC2-A)   ← 전부 loopback

GCP Node 1 Publisher → EC2-A PostgreSQL 5432 (경로 보류, 시스템 아키텍처 10장)
외부 관찰: 오사카 CI 노드 → 공개 URL → 알림만. DNS 편집·진입 개입 권한 없음(100)
관리 접속: 담당자 → tailnet SSH(22) → EC2-A

EC2-B: 사용하지 않는다(D4). 앱·복제·백업·관측 어느 역할도 없다
```

사용자 요청 경로의 모든 구성요소가 EC2-A 한 대 안에 있다. 진입 계층에도 앱 계층에도 대체 경로가 없다.

호스트 Nginx는 만들지 않는다. `apps/frontend/nginx.conf`가 정적 서빙과 `/api` 프록시를 이미 수행하고, Tunnel 채택으로 origin TLS 재종료가 사라져 호스트 Nginx가 추가로 할 일이 없다. 84 범위가 그만큼 줄어든다.

## 3. 포트·신뢰 경계

**핵심은 외부 인바운드 개방을 0개로 둔다는 것이다.** cloudflared가 edge로 여는 outbound 연결이 유일한 인터넷 경로다. 보안그룹 적용과 인터넷 측 확인은 84에서 하며 아직 실측하지 않았다.

| 구간 | 포트 | 허용 범위 |
| --- | --- | --- |
| 인터넷 → EC2-A | 없음 | **개방 0개로 둔다**(84에서 적용·확인). 443을 포함해 인터넷을 향한 인바운드 허용 규칙을 두지 않는다 |
| EC2-A → Cloudflare edge | 443 outbound | cloudflared 단일 connector. 진입의 유일한 경로 |
| EC2-A 내부 | frontend nginx ↔ backend, PostgreSQL 5432, Redis 6379, Worker | loopback·컨테이너 네트워크 전용. 호스트 외부로 바인드하지 않는다 |
| 관리 SSH | 22 | tailnet 전용 |
| GCP Node 1 → EC2-A | 5432 | 보류([시스템 아키텍처](system-architecture.md) 10장) |
| 오사카 CI 노드 → 공개 URL | 443 | 관찰 전용. DNS 편집 권한 없음 |

바인드 주소는 84에서 확인한다. 현재 Backend는 `server.address`를 두지 않아 모든 인터페이스에 바인드한다(2026-09-16 Backend 확인). 인바운드가 0개이므로 이는 방어선이 아니라 심층 방어이며, 84에서 애플리케이션 포트를 loopback으로 조인다.

### 3.1 남용 제어 부재

정직하게 기록한다. 저장소 전수 확인에서 `limit_req`·bucket4j·로그인 잠금이 **0건**이다.

- `GET /api/v1/auth/csrf`와 `/oauth2/authorization/*`는 `permitAll`이고 **미인증 호출마다 세션을 만든다.**
- 단일 노드이므로 남용 부하는 앱·DB·Redis·Worker를 한꺼번에 멈춘다. 장애 축이 분리되어 있지 않다.
- 현재 유일한 방어선은 Cloudflare edge의 기본 차단이다. 애플리케이션 계층 제한의 위치는 84에서 정한다.
- Tunnel 아래서 `getRemoteAddr()`는 컨테이너 IP가 되고 `apps/frontend/nginx.conf`가 `X-Forwarded-For`를 설정하지 않는다. IP 기반 제한이 필요하면 `CF-Connecting-IP` 전달을 함께 설계한다(84).

## 4. 장애 시나리오

자동 대응은 **컨테이너 재기동뿐이다.** 노드 장애에는 자동 복구가 없다.

아래 표의 「자동 대응」 열은 **목표 동작**이다. 현재 `infra/service/compose.yaml`에는 frontend·backend 두 서비스만 있고, PostgreSQL·Redis·cloudflared의 컨테이너화와 재기동·헬스체크 정책은 84·93에서 확정한다(미실측).

| 시나리오 | 자동 대응 | 수동 대응 | 허용 중단 |
| --- | --- | --- | --- |
| 정상 | 없음 | 없음 | — |
| 앱 프로세스(backend·frontend) 장애 | 컨테이너 재기동 | 반복되면 재기동을 멈추고 로그로 원인을 조사한다 | 재기동 동안 전면 중단 |
| cloudflared 장애·터널 단절 | cloudflared 재기동(재연결 동작은 미실측, 84) | 자격증명·egress 점검. 우회 진입 경로는 없다 | 재연결까지 **전면 중단** |
| Redis 장애 | 컨테이너 재기동 | 계산 상태·결과·잠금은 복구하지 않고 재계산한다. 세션 생존은 persistence 설정에 달렸다(84) | **인증 전면 중단**(D10, 503 응답). 온라인 계산도 중단. 세션 이관 전에는 조회·쓰기가 유지됐으나 이관 후에는 아니다 |
| PostgreSQL 장애 | 컨테이너 재기동 | 볼륨이 살아 있으면 재기동으로 복구한다. 진행 중 Gold 적재 트랜잭션은 롤백되어 `current`는 이전 판을 유지하고 Publisher가 재시도한다 | **전면 중단**(조회·쓰기 모두). Standby가 없어 승격 선택지가 없다 |
| **EC2-A 노드 장애** | **없음** | 인스턴스 복구를 시도한다. Standby·백업·대체 노드가 없으므로 그 외 수단이 없다 | **전면 중단. 자동 복구 없음** |
| 배포·재시작 | 없음 | 계획된 중단으로 공지한다 | 전면 중단. Redis를 함께 재시작하지 않으면 **로그인은 유지된다**(D8·D10) |

DB 장애를 전면 중단으로 두는 근거는 Standby 부재 이전에 Backend 구조에 있다. 읽기·쓰기 분리가 없고 `spring.datasource.url` 하나만 있으며 라우팅 DataSource나 replica 설정이 없다(2026-09-16 Backend 확인). DB가 죽으면 조회도 함께 멈춘다.

### 4.1 데이터 손실 경계

| 데이터 | 사본 | 복구 |
| --- | --- | --- |
| Gold 카탈로그 | GCP HDFS에 PublicationBundle이 RF2로 보관 | **재게시로 복구 가능** |
| 회원·제출·분석 히스토리·커뮤니티 데이터 | **없음** | **복구 불가능** |

서비스 도메인 데이터는 사본이 없다. 볼륨 상실이나 논리 오류가 나면 되돌릴 방법이 없으며 PoC 범위에서 이를 수용한다(D7). 가장 싼 완화는 EBS 스냅샷이고 도입 여부는 별도 결정으로 남긴다.

RPO·RTO는 협의해서 조정할 수치가 아니다. 복구 수단이 없으므로 RPO는 "마지막 쓰기까지 전부", RTO는 "복구 불가"다. 남는 측정 대상은 **재구축 시간** 하나뿐이며, 볼륨을 잃었을 때 빈 DB로 다시 세워 서비스를 기동하는 데 걸리는 시간이다. 데이터 복구 시간이 아니고 아직 실측하지 않았다. 이 판단으로 `S15P21C206-97`(RPO/RTO·보존·수동 전환 기준)과 `S15P21C206-98`(backup·격리 복원)은 대상을 잃어 취소했다. EBS 스냅샷을 도입하면 보존 주기와 격리 복원 검증이 다시 필요해지므로 그때 새 티켓을 만든다.

재기동 후 각 저장소가 돌아오는 상태는 서로 다르다. 같은 복구 정책으로 묶지 않는다.

| 저장소 | 재기동 후 상태 |
| --- | --- |
| PostgreSQL | 볼륨이 살아 있으면 데이터 유지. 볼륨을 잃으면 빈 DB |
| Redis | 비어서 시작한다. 계산 상태·결과는 재계산하고 키별 잠금은 자연 해제된다 |
| 로그인 세션 | EC2-A Redis에 있다. 앱만 재기동하면 유지되고, Redis가 함께 재기동하면 persistence 설정에 따른다(D10) |

## 5. DB 계정 분리

| 계정 | 역할 | 비고 |
| --- | --- | --- |
| 테이블 소유자 | 스키마 소유 | REVOKE 영향을 받지 않으므로 런타임과 분리한다 |
| 마이그레이션 계정 | Flyway 실행 | DB `CREATE` 필요(V1 `CREATE EXTENSION pg_trgm`). `CREATEROLE`은 V2 `gold_roles`의 `CREATE ROLE` 때문에 필요하며, 운영 프로비저닝에서 `planetory_gold_writer`·`planetory_app`을 `NOLOGIN`으로 미리 만들면 `CREATEROLE` 없이 통과한다(V2 우회 경로) |
| 서비스 런타임 | 서비스 실행 | `planetory_app`. Gold는 읽기만 한다 |
| Publisher | GCP 배치 적재 | `planetory_gold_writer`. 서비스 런타임과 분리한다 |

`planetory_gold_writer`는 GCP Publisher의 역할이며 **서비스 런타임 역할이 아니다**([시스템 아키텍처](system-architecture.md) 7장, V2 `gold_roles`의 `REVOKE`). 두 역할을 한 계정에 합치면 V2가 회수한 Gold 쓰기 권한이 서비스 런타임에 되돌아온다.

**미해결 사실(83에서 닫는다):** `users` 테이블에 `planetory_app` GRANT가 V1~V9 어디에도 없다(V9 `operation_rules` 유입 후 재확인). 매 요청 `members.requireActive`가 `users`를 SELECT하므로, 계정을 분리하는 시점에 모든 인증이 42501로 실패한다.

## 6. 애플리케이션 전제

앱은 단일 인스턴스다. 조사 결과 `apps/backend/src/main`의 노드 로컬 상태는 로그인 세션 한 곳뿐이고, 인메모리 캐시·`@Scheduled`·`@Async`·로컬 파일·SSE·정적 가변 필드가 0건이며 상호배제는 이미 DB에 있다(`FOR UPDATE`·`ON CONFLICT`·Flyway advisory lock).

그 유일한 노드 로컬 상태인 로그인 세션을 2026-09-17 리뷰 반영으로 EC2-A Redis로 옮긴다(D1·D8·D10). **목적은 인스턴스 간 공유가 아니라 재시작 생존이다.** 인스턴스는 그대로 1개이고 EC2-B도 그대로 미사용이다. 따라서 이 결정은 D3·D4를 바꾸지 않는다. 대신 **애플리케이션 코드 변경이 생긴다**(아래, 구현은 `S15P21C206-237`).

### 지켜야 할 것

1. DB·Redis 주소와 자기 URL을 코드·기본 프로필에 박지 않는다(이미 충족, 회귀 금지).
2. 요청 간 상태를 프로세스 메모리에 새로 두지 않는다(현재 위반 0건). 세션을 Redis로 옮겨도 이 규칙은 그대로다.
3. `@Scheduled`를 추가하면 멱등성 또는 DB 잠금 단일 실행 보장을 PR에 한 줄로 적는다.

### 세션 저장소를 바꿀 때 지불할 것 — 인스턴스가 1개여도 지금 지불한다

2026-09-17 이전 판은 아래 1·2번을 「인스턴스를 늘리게 될 때」로 분류했다. **틀린 분류였다.** 둘 다 인스턴스 수가 아니라 세션 저장소를 바꿀 때 발생한다. 구현은 237이 맡는다.

1. **`AuthSessionService`의 `synchronized (session)` 2곳.** 지금은 Tomcat이 같은 세션에 같은 `StandardSessionFacade`를 돌려주므로 락이 실제로 걸린다. Spring Session을 적용하면 요청마다 새 `HttpSessionWrapper`가 만들어져 **모니터가 요청마다 달라지고 상호배제가 조용히 사라진다.** 기본 `ON_SAVE` 플러시라 병렬 요청이 각자 사본을 쓰고 마지막 쓰기가 이긴다. `touch()`의 「마지막 접수 시각을 과거로 되돌리지 않는다」가 깨진다. 컴파일도 테스트도 통과하므로 놓치기 쉽다.
2. **세션 기반 저장소 동반 이동.** `CsrfTokenRepository`·`AuthorizationRequestRepository`·`HttpSessionOAuth2AuthorizedClientRepository`·`HttpSessionSecurityContextRepository`가 모두 세션 기반이라 함께 Redis로 간다. `lastActivity`의 `Instant`도 같다. 직렬화가 실제로 되는지는 단위 테스트가 아니라 **실제 로그인·OAuth 콜백·로그아웃으로** 확인한다.
3. **Redis 장애 시 인증 응답 정책.** 예외를 500으로 흘리지 않고 503으로 내린다. 401로 보내면 재로그인해도 복구되지 않아 무한 로그인 루프가 된다.
4. **TTL 분리.** 세션 TTL(30분 idle, SB-D14)과 계산 캐시 TTL을 같은 값으로 묶지 않고 키 네임스페이스도 분리한다.
5. **persistence 범위.** 앱만 재배포하면 Redis가 살아 있으므로 persistence 없이도 세션이 유지된다. persistence가 필요한 경우는 **Redis 컨테이너 재시작과 호스트 재부팅뿐이다.** 어디까지 보장할지와 설정은 84에서 정한다.

현재 `apps/backend/build.gradle`에 `spring-boot-starter-data-redis`·`spring-session-data-redis`가 없고 `apps/backend/src/main`의 Redis 참조가 0건이다. 설정 스위치가 아니라 앱의 첫 Redis 연동이다.

**수용한 저하를 숨기지 않는다.** 이관 전에는 Redis가 죽어도 조회·쓰기가 살아 있었다. 이관 후에는 Redis 장애가 인증 전면 중단이다. 재시작 후 로그인 유지는 요구사항이 아니므로(ACC-03·04는 인증 검사와 로그아웃만, SB-D11·14는 30분 idle 창만 정한다) 비용이 예상보다 크면 되돌리는 것이 정당한 선택이다.

### 인스턴스를 늘리게 될 때 먼저 지불할 것

지금 구현하지 않는다. 문서로만 보존한다.

1. `SecurityConfig`의 로그아웃 CSRF 면제 수정(234). 면제 조건이 세션 부재 기준이라 **저장소와 무관하며** 단일 노드에서는 Redis 이관 후에도 멱등이다. 두 번째 인스턴스가 생기면 검사 우회가 된다. **순서상 선행 조건이다.**
2. 쿠키 CSRF로 전환하는 경우의 프론트 변경. 프론트가 `X-CSRF-TOKEN`을 하드코딩하고 있다. 세션을 Redis로 옮기는 데는 필요 없다.
3. 노드 시계 동기와 허용 skew.
4. `server.forward-headers-strategy`. 부재 시 쿠키 `Secure`가 조용히 빠질 수 있다.
5. **진입 계층 재구축.** Tunnel replica는 가장 가까운 connector 하나로만 보내고 분산하지 않으므로(2026-09-16 실측 10/10) 두 번째 노드는 트래픽을 받지 못한다. 계약으로 막을 수 없는 재구축이며 이 결정의 가장 큰 숨은 비용이다.

## 7. 후속 인계

| 티켓 | 인계 |
| --- | --- |
| 83 | 계정 4분리(서비스 런타임·Publisher 분리 포함), 마이그레이션 계정 권한. `CREATEROLE`을 주지 않으려면 V2 우회 경로로 역할을 미리 만든다. **`users` 테이블의 `planetory_app` GRANT 누락을 함께 닫는다**(5절, V9까지 미해소) |
| 84 | Cloudflare Tunnel 단일 connector 세팅과 자격증명 파일 주입, 무료 플랜 제약 확정(실패 시 대안은 proxied A 레코드 1개 + 443 개방), 인바운드 0개 보안그룹, 애플리케이션 포트 loopback 바인드, 애플리케이션 계층 남용 제어 위치와 `CF-Connecting-IP` 전달(3.1절). 호스트 Nginx는 만들지 않는다. **Redis 컨테이너·persistence·볼륨**을 함께 정한다 — 세션이 Redis로 가므로(D10) 어디까지 재시작 생존을 보장할지가 여기서 결정된다 |
| 93 | 컨테이너 재기동 정책과 헬스체크 연동. liveness와 readiness를 나눠 앱 장애와 공유 의존성 장애를 구분한다. 구현은 contributor 비활성(`management.health.*.enabled=false`)이 아니라 `management.endpoint.health.group.*`이어야 한다 — contributor를 끄면 빈 자체가 사라져 어떤 group에도 넣을 수 없다. 착수 시 Boot 버전에서 확인한다. `/actuator/health`는 현재 `show-details=never`로 UP/DOWN만 반환한다(2026-09-16 Backend 확인) |
| 100 | 오사카 노드 알림 전용 외부 관찰. 진입·DNS 개입 권한은 주지 않는다 |
| 234·235 | 로그아웃 CSRF 면제 조건 수정(6절 1번의 선행 조건)과 prod 유사 `Set-Cookie`·DB 중단 응답 실측. 인스턴스 수와 무관하게 유효하다 |
| 237 | 로그인 세션 Redis 이관 구현. `synchronized (session)` 2곳 재설계, 세션 기반 저장소 직렬화 실제 검증, Redis 장애 시 503, TTL·네임스페이스 분리. 84가 사실상 선행이다(Redis가 떠야 검증 가능) |
| 102 | 실부하에서 단일 connector와 단일 노드가 병목인지 확인한다. 병목이면 진입 계층 재구축 비용(6절 6번)을 포함해 별도 티켓으로 재검토한다 |

**이 Task에서 실측한 것:** 두 EC2 SSH 접속과 동일 VPC 사설 도달, 사설 RTT 평균 약 0.8ms(최소 0.5·최대 1.1ms), tailnet 노출 포트가 22만 응답하는 것, Cloudflare Tunnel egress 동작과 replica 라우팅 10/10 단일 노드, 오사카 노드 RTT 26.7ms(tailnet 경유). 실제 IP·대역은 문서에 적지 않는다.

**실측하지 않은 것:** 단일 connector의 지속 처리량·재연결 동작·무료 플랜 제약(84에서 확정하며, 실패 시 대안은 proxied A 레코드 1개 + 443). Cloudflare proxied 라운드로빈의 실제 교대 동작은 과제 전제로 받은 사실이며 확인하지 않았다.

**문서·화면 근거:** Free 플랜에서 Origin CA 발급과 Full (strict) 선택이 가능하다(대시보드 확인). Tunnel 채택으로 사용하지 않는다.
