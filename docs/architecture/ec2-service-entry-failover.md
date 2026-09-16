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

기각 근거: Tunnel replica는 가장 가까운 connector 하나로만 보내 분산하지 않는다(실측 10/10 단일 노드, 공식 문서 동일). 오사카 노드를 LB로 두면 단일 장애점이 생기고 서울↔오사카 왕복(EC2→해당 노드 최소 RTT 26.7ms 실측)이 매 요청에 더해지며 배포 자격증명 보유 노드가 공개 진입점이 된다. 오사카 단독 헬스체크는 감시자 장애 시 제외가 불가능하고 경로 흔들림이 오탐이 된다.

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
| 인터넷 → EC2 | 22, 80, 3000, 5432, 6379, 8080, 9090 | 개방 없음 |
| EC2 → Cloudflare API | 443 outbound | 상호 감시 |
| EC2 내부 | frontend·backend 8080 | `127.0.0.1` 전용 |
| EC2-B → EC2-A | 5432 | 동일 VPC 사설. WAL streaming |
| EC2-A → EC2-B | 6379 | 동일 VPC 사설 |
| EC2-A ⇄ EC2-B | backend `/actuator/health` | 동일 VPC 사설. 상호 감시 |
| EC2-B → EC2-A | node exporter·Actuator | 동일 VPC 사설. Prometheus |
| 오사카 CI 노드 → EC2-A/B | 443 | 관찰 전용. DNS 편집 권한 없음 |
| 관리 SSH | 22 | tailnet 전용 |
| GCP Node 1 → EC2-A | 5432 | 보류([시스템 아키텍처](system-architecture.md) 10장) |

두 EC2는 동일 VPC 사설 대역에 있으며 사설 도달과 RTT 약 1.2ms를 실측했다(2026-09-16). 실제 IP·대역은 문서에 적지 않는다.

## 4. 상호 감시 규칙

| # | 규칙 | 막는 문제 |
| --- | --- | --- |
| R1 | 등록은 자기 자신만 한다. 자기 `/actuator/health`와 Cloudflare API 도달이 모두 정상일 때만 자기 A 레코드를 넣는다 | 복구 노드 재등록 책임 |
| R2 | 제거는 상대만 한다. 상대의 사설 헬스와 공개 443이 둘 다 연속 N회 실패할 때만 뺀다 | 사설 링크 단일 장애 오탐 |
| R3 | 행동 전 자기 egress를 확인한다. Cloudflare API에 못 닿으면 아무것도 바꾸지 않는다 | 고립 노드가 정상 노드 제거 |
| R4 | 마지막 1개는 제거하지 않는다. 삭제 직전 레코드를 다시 읽어 1개면 중단한다 | 레코드 0개 |

- 주기·임계 초안값은 10초 × 연속 3회다. 93에서 조정한다.
- proxied 라운드로빈은 origin 연결 실패 시 다른 A 레코드로 자동 재시도한다(공식 문서). 포트는 열렸으나 앱이 오류를 내는 경우는 재시도 대상이 아니므로 R2가 그 구간을 맡는다.
- 자격증명은 `Zone: DNS: Edit`를 해당 zone 하나로 제한한 토큰을 파일로 주입한다. 명령줄 인자로 주지 않는다(84).
- 잔여 위험: 사설·공개 경로가 동시에 끊기면서 양쪽 모두 인터넷은 되는 이중 장애. R4가 0개를 막고 다음 주기에 R1로 복귀한다.

## 5. 장애 시나리오

| 시나리오 | 자동 대응 | 수동 대응 | 허용 중단 |
| --- | --- | --- | --- |
| 정상 | A 레코드 2개 라운드로빈 | 없음 | — |
| app 1대 장애 | 상대가 R2~R4로 레코드 제거. 복구 시 R1로 자기 재등록 | 없음. 플래핑 반복 시 체커 정지 후 원인 조사 | 제거까지 초안값 30초 + 반영. 연결 실패는 자동 재시도로 영향 축소 |
| Primary(EC2-A) 노드 장애 | B가 A 레코드 제거. 진입은 B 단독 | Standby 수동 승격. 진행 중 Gold 적재 트랜잭션은 롤백되어 `current`는 이전 판 유지, Publisher가 재시도한다 | 쓰기 중단 허용, 조회 유지. 분 단위 목표는 97 |
| Redis(EC2-B) 노드 장애 | A가 B 레코드 제거. 진입은 A 단독 | Redis 재시작. 계산 상태·결과·잠금은 복구하지 않고 재계산 | 온라인 계산 전면 중단 허용(app A도 Redis 불가), 조회·쓰기 유지. 관측 동반 중단은 허용([시스템 아키텍처](system-architecture.md) 9장) |
| A↔B 사설 링크만 단절 | 없음(R2 이중 실패 미충족) | VPC 경로 점검 | 쓰기 유지, 온라인 계산 정지, Standby 지연 증가 |

Standby 승격 조건: Primary 노드가 사설·공개 경로 모두 응답하지 않고 재기동으로 복구되지 않을 때 담당자가 판단한다. 자동 판정은 두지 않는다. 승격 전에 Standby replay 위치를 확인하고, 기존 Primary가 되살아나 이중 쓰기가 되지 않도록 먼저 완전 정지를 확인한다. 판단까지 허용하는 시간은 97이 정한다.

Primary 승격 뒤 EC2-B는 Primary·Redis·관측·유일 진입점을 모두 갖는 단일 집약 상태가 되므로 원복 절차를 반드시 둔다(97·98).

## 6. DB 계정 분리

| 계정 | 역할 | 비고 |
| --- | --- | --- |
| 테이블 소유자 | 스키마 소유 | REVOKE 영향을 받지 않으므로 런타임과 분리한다 |
| 마이그레이션 계정 | Flyway 실행 | `CREATEROLE`, DB `CREATE`(V1 `CREATE EXTENSION pg_trgm`) 필요 |
| 런타임 계정 | 서비스 실행 | `planetory_app` 읽기 · `planetory_gold_writer` 쓰기 |

## 7. 후속 인계

| 티켓 | 인계 |
| --- | --- |
| 83 | 계정 분리, 마이그레이션 계정 권한 |
| 84 | Nginx Origin CA 종료, Full strict, Authenticated Origin Pulls, Cloudflare 대역 보안그룹 유지보수, DNS 토큰 파일 주입 |
| 93 | 상호 감시 체커(R1~R4, 주기·임계), health gate 연동 |
| 97 | RPO/RTO |
| 100 | 오사카 노드 알림 전용 관찰 |

이 Task에서 실측한 것: 두 EC2 접속·동일 VPC·사설 RTT, tailnet 포트 노출(22만 응답), Tunnel egress와 replica 동작. DNS 라운드로빈 자동 재시도는 공식 문서, Free 플랜의 Full (strict)·Origin CA 발급 가능은 대시보드 화면 근거다(현재 SSL 모드는 Full, strict 전환은 84에서 Origin CA 설치 후). 실제 전환 동작은 84·93 구현 시 실측한다.

