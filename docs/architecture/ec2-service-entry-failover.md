# EC2 서비스 진입·장애 전환 경계

> 대표 Jira: `S15P21C206-82`
>
> 상태: 채택 (결정 반영 완료. 구현·실측은 83·84·93 후속)
>
> 상위 정본: [시스템 아키텍처](system-architecture.md) 8장

두 EC2의 무료 범위 안에서 외부 진입, TLS 종료, app A/B 라우팅, PostgreSQL Primary·Redis 장애의 수동 대응 범위와 포트·신뢰 경계를 정한다. 유료 LB, 자동 DB failover, 실제 서버 구성은 범위 밖이며 구현은 83·84·93이 맡는다.

## 1. 결정

| # | 결정 | 상태 |
| --- | --- | --- |
| D1 | Redis 단일 인스턴스는 EC2-B에 둔다. 쓰기축(A)과 계산축(B)의 장애를 분리한다 | 확정 |
| D2 | 사용자 구간 TLS는 Cloudflare edge에서 종료하고, edge→origin은 Nginx가 Cloudflare Origin CA 인증서로 다시 종료한다(SSL Full strict). 인터넷 구간 평문은 금지한다 | 확정 |
| D3 | 진입은 proxied A 레코드 2개(EC2-A·B) 라운드로빈이다. 비정상 노드 제외·복귀는 두 EC2의 상호 감시가 Cloudflare DNS API로 수행한다 | 확정 |
| D4 | 자체 LB 서버를 두지 않는다. 오사카 CI/CD 노드는 알림 전용 외부 관찰자로만 쓴다(100) | 확정 |
| D5 | 테이블 소유자·마이그레이션 계정·런타임 계정을 분리한다(83) | 확정 |
| D6 | Standby 자동 승격을 도입하지 않는다. 자동화는 앱 진입 계층에 한정한다 | 확정 |
| D7 | RPO/RTO 분 단위 목표는 97이 정한다 | 이관 |
| D8 | Cloudflare Load Balancing(유료, 공식 표기 "Starting at $5/mo")은 도입하지 않는다. 상호 감시의 오탐·플래핑이 반복되거나 102 실부하에서 진입 계층이 병목이면 별도 티켓으로 재검토한다 | 확정 |

기각 근거: Tunnel replica는 가장 가까운 connector 하나로만 보내 분산하지 않는다(실측 10/10 단일 노드, 공식 문서 동일). 오사카 노드를 LB로 두면 단일 장애점이 생기고 서울↔오사카 왕복(EC2→해당 노드 최소 RTT 26.7ms 실측, tailnet 경유 측정이므로 공용 경로의 하한)이 매 요청에 더해지며 배포 자격증명 보유 노드가 공개 진입점이 된다. 오사카 단독 헬스체크는 감시자 장애 시 제외가 불가능하고 경로 흔들림이 오탐이 된다.

## 2. 단일 경로

```text
사용자 → Cloudflare edge(TLS 종료, proxied)
       → A 레코드 라운드로빈 → EC2-A:443 / EC2-B:443 (Cloudflare 대역만 허용)
       → Nginx(Origin CA로 재종료, 정적·/api/* 프록시) → app(frontend·backend, A/B 동일·무상태)
app → PostgreSQL Primary(EC2-A, 쓰기) / Standby(EC2-B, 지연 허용 조회) / Redis(EC2-B) / Python Worker
상호 감시: EC2-A ⇄ EC2-B → Cloudflare DNS API
외부 관찰: 오사카 CI 노드 → 두 EC2 → 알림만
GCP Node 1 Publisher → EC2-A PostgreSQL 5432 (경로 보류, 시스템 아키텍처 10장)
```

## 3. 포트·신뢰 경계

| 구간 | 포트 | 허용 범위 |
| --- | --- | --- |
| 인터넷 → EC2-A/B | 443 | Cloudflare IP 대역만. Authenticated Origin Pulls 권고 |
| 인터넷 → EC2 | 22, 80, 3000, 5432, 6379, 8080, 9090, 헬스 관리 포트 | 개방 없음 |
| EC2 → Cloudflare API | 443 outbound | 상호 감시 |
| EC2 내부 | frontend·backend 8080 | `127.0.0.1` 전용. Nginx만 프록시한다 |
| EC2-B → EC2-A | 5432 | 동일 VPC 사설. WAL streaming |
| EC2-A → EC2-B | 6379 | 동일 VPC 사설 |
| EC2-A ⇄ EC2-B | 헬스 전용 관리 포트 `/actuator/health` | 동일 VPC 사설 대역만. **Nginx를 경유하지 않는다**(R2 경로 독립). 포트 번호와 `server.address`·`management.server.port` 설정은 84 |
| EC2-B → EC2-A | node exporter·Actuator | 동일 VPC 사설. Prometheus |
| 오사카 CI 노드 → EC2-A/B | 443 | 관찰 전용. DNS 편집 권한 없음 |
| 관리 SSH | 22 | tailnet 전용 |
| GCP Node 1 → EC2-A | 5432 | 보류([시스템 아키텍처](system-architecture.md) 10장) |

두 EC2는 동일 VPC 사설 대역에 있으며 사설 도달과 RTT 평균 약 0.8ms(최소 0.5·최대 1.1ms)를 실측했다(2026-09-16). 실제 IP·대역은 문서에 적지 않는다.

애플리케이션 포트를 loopback으로 조이는 것은 새 제약이다. 현재 Backend는 `server.address`를 두지 않아 모든 인터페이스에 바인드한다(2026-09-16 Backend 확인). 84에서 애플리케이션 포트는 loopback, 헬스 관리 포트는 사설 대역으로 각각 바인드한다.

## 4. 상호 감시 규칙

| # | 규칙 | 막는 문제 |
| --- | --- | --- |
| R1 | 등록은 자기 자신만 한다. 자기 `/actuator/health`와 Cloudflare API 도달이 모두 정상일 때만 자기 A 레코드를 넣는다 | 복구 노드 재등록 책임 |
| R2 | 제거는 상대만 한다. 상대의 사설 헬스(관리 포트)와 공개 443이 둘 다 연속 N회 실패할 때만 뺀다. 두 경로는 서로 독립이어야 한다 | 사설 링크 단일 장애 오탐 |
| R3 | 행동 전 자기 egress를 확인한다. Cloudflare API에 못 닿으면 아무것도 바꾸지 않는다 | 고립 노드가 정상 노드 제거 |
| R4 | 마지막 1개는 제거하지 않는다. 삭제 직전 레코드를 다시 읽어 1개면 중단한다 | 레코드 0개 |

- 주기·임계 초안값은 10초 × 연속 3회다. 93에서 조정한다.
- proxied 라운드로빈은 origin 연결 실패 시 다른 A 레코드로 자동 재시도한다(공식 문서). 포트는 열렸으나 앱이 오류를 내는 경우는 재시도 대상이 아니므로 R2가 그 구간을 맡는다.
- 자격증명은 `Zone: DNS: Edit`를 해당 zone 하나로 제한한 토큰을 파일로 주입한다. 명령줄 인자로 주지 않는다(84).
- **R2 두 경로의 독립성이 전제다.** 사설 헬스가 Nginx를 지나면 Nginx 단일 장애로 두 경로가 동시에 실패해 R2가 막으려던 오탐이 그대로 난다. 그래서 사설 헬스는 Nginx를 우회하는 전용 관리 포트로 받는다(3절).
- `/actuator/health`는 현재 `show-details=never`로 UP/DOWN만 반환한다. R2 판정에는 충분하다(2026-09-16 Backend 확인).
- **공유 의존성 장애는 양쪽 노드를 동시에 DOWN으로 만든다.** Actuator health 집계에 DB·Redis 지표가 포함되면 Primary(EC2-A)나 Redis(EC2-B) 하나가 죽어도 A·B 두 Backend가 모두 DOWN이 되어 상호 감시가 멈춘다(5절). liveness와 readiness를 나눠 앱 장애와 공유 의존성 장애를 구분하는 일은 93이 맡는다.
- 잔여 위험: 사설·공개 경로가 동시에 끊기면서 양쪽 모두 인터넷은 되는 이중 장애. R4가 0개를 막고 다음 주기에 R1로 복귀한다.

## 5. 장애 시나리오

| 시나리오 | 자동 대응 | 수동 대응 | 허용 중단 |
| --- | --- | --- | --- |
| 정상 | A 레코드 2개 라운드로빈 | 없음 | — |
| app 1대 장애 | 상대가 R2~R4로 레코드 제거. 복구 시 R1로 자기 재등록 | 없음. 플래핑 반복 시 체커 정지 후 원인 조사 | 제거까지 초안값 30초 + 반영. 연결 실패는 자동 재시도로 영향 축소 |
| Primary(EC2-A) 노드 장애 | **없음.** Backend health에 DB 지표가 포함되어 A·B가 모두 DOWN이 되고, R2 제거가 R4(마지막 1개)에서 멈추며 R1도 자기 health 정상을 요구해 재등록이 없다 | Standby 수동 승격. 진행 중 Gold 적재 트랜잭션은 롤백되어 `current`는 이전 판 유지, Publisher가 재시도한다 | **전면 중단 허용**(쓰기·조회 모두). 분 단위 목표는 97 |
| Redis(EC2-B) 노드 장애 | A가 B 레코드 제거. 진입은 A 단독 | Redis 재시작. 계산 상태·결과·잠금은 복구하지 않고 재계산 | 온라인 계산 전면 중단 허용(app A도 Redis 불가), 조회·쓰기 유지. 관측 동반 중단은 허용([시스템 아키텍처](system-architecture.md) 9장) |
| A↔B 사설 링크만 단절 | 없음(R2 이중 실패 미충족) | VPC 경로 점검 | 쓰기 유지, 온라인 계산 정지, Standby 지연 증가 |

Standby 승격 조건: Primary 노드가 사설·공개 경로 모두 응답하지 않고 재기동으로 복구되지 않을 때 담당자가 판단한다. 자동 판정은 두지 않는다. 승격 전에 Standby replay 위치를 확인하고, 기존 Primary가 되살아나 이중 쓰기가 되지 않도록 먼저 완전 정지를 확인한다. 판단까지 허용하는 시간은 97이 정한다.

Primary 승격 뒤 EC2-B는 Primary·Redis·관측·유일 진입점을 모두 갖는 단일 집약 상태가 되므로 원복 절차를 반드시 둔다(97·98).

### Primary 장애를 전면 중단으로 두는 근거

Backend에 읽기·쓰기 분리가 없다. `spring.datasource.url` 하나만 있고 라우팅 DataSource나 replica 설정이 없다(2026-09-16 Backend 확인). 따라서 Primary가 죽으면 조회도 함께 멈춘다. 2절 경로의 "Standby 지연 허용 조회"는 복제 역할을 뜻하며 현재 서비스 조회 경로가 아니다.

Standby로 조회를 라우팅하는 방향은 채택하지 않는다. 자동 승격을 두지 않기로 했으므로(D6) Primary 장애는 어차피 수동 개입 구간이고, Primary에서 받은 버전 라벨과 Standby에서 읽은 이전 시점 데이터가 섞이면 `skyVersion` 계약이 깨진다(`S15P21C206-137`의 단일 스냅샷 읽기와 같은 이유). 도입하려면 별도 티켓에서 `skyVersion`·`rangeStarCount` 계약 유지 방법을 먼저 정한다.

### 노드 로컬 상태 위험 — 로그인 세션

현재 Backend는 서블릿 세션을 각 노드 메모리에 둔다. `spring-session`·Redis 의존성이 없고 `HttpSessionSecurityContextRepository`와 `HttpSessionOAuth2AuthorizedClientRepository`를 쓴다(`S15P21C206-156` 구현, 2026-09-16 확인). 라운드로빈에서는 로그인 후 다른 노드로 간 요청의 세션 유실, OAuth 인가 시작 노드와 콜백 노드 불일치로 인한 로그인 실패, 노드 재시작 시 해당 노드 세션 소실이 발생한다.

이 Task는 "로그인 세션 저장 방식 확정"을 제외 범위로 두므로 결정하지 않고 위험으로만 기록한다. 후보는 Spring Session + Redis(EC2-B, D1)이며 소유자와 시점은 S03·84에서 정한다. 세션 어피니티는 Cloudflare 무료 플랜의 proxied 레코드로 제공되지 않는다.

## 6. DB 계정 분리

| 계정 | 역할 | 비고 |
| --- | --- | --- |
| 테이블 소유자 | 스키마 소유 | REVOKE 영향을 받지 않으므로 런타임과 분리한다 |
| 마이그레이션 계정 | Flyway 실행 | DB `CREATE` 필요(V1 `CREATE EXTENSION pg_trgm`). `CREATEROLE`은 V2 `gold_roles`의 `CREATE ROLE` 때문에 필요하며, 운영 프로비저닝에서 `planetory_gold_writer`·`planetory_app`을 `NOLOGIN`으로 미리 만들면 `CREATEROLE` 없이 통과한다(V2 우회 경로) |
| 서비스 런타임 | 서비스 실행 | `planetory_app`. Gold는 읽기만 한다 |
| Publisher | GCP 배치 적재 | `planetory_gold_writer`. 서비스 런타임과 분리한다 |

`planetory_gold_writer`는 GCP Publisher의 역할이며 서비스 런타임 역할이 아니다([시스템 아키텍처](system-architecture.md) 7장, V2 `gold_roles`의 `REVOKE`). 두 역할을 한 계정에 합치면 V2가 회수한 Gold 쓰기 권한이 서비스 런타임에 되돌아온다.

## 7. 후속 인계

| 티켓 | 인계 |
| --- | --- |
| 83 | 계정 4분리(서비스 런타임·Publisher 분리 포함), 마이그레이션 계정 권한. `CREATEROLE`을 주지 않으려면 V2 우회 경로로 역할을 미리 만든다 |
| 84 | Nginx Origin CA 종료, Full strict, Authenticated Origin Pulls, Cloudflare 대역 보안그룹 유지보수, DNS 토큰 파일 주입, Cloudflare 수동 세팅, `server.address`(loopback)와 헬스 전용 관리 포트(사설 대역) 바인드 |
| 93 | 상호 감시 체커(R1~R4, 주기·임계), health gate 연동, liveness·readiness 분리로 공유 의존성 장애와 앱 장애 구분 |
| 97 | RPO/RTO |
| 100 | 오사카 노드 알림 전용 관찰 |
| S03·84 | 로그인 세션의 노드 간 공유 방식(후보: Spring Session + Redis). 소유자·시점 미정 |

이 Task에서 실측한 것: 두 EC2 접속·동일 VPC·사설 RTT, tailnet 포트 노출(22만 응답), Tunnel egress와 replica 동작. DNS 라운드로빈 자동 재시도는 공식 문서, Free 플랜의 Full (strict)·Origin CA 발급 가능은 대시보드 화면 근거다(현재 SSL 모드는 Full, strict 전환은 84에서 Origin CA 설치 후). 실제 전환 동작은 84·93 구현 시 실측한다.
