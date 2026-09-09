# Planetory 시스템 아키텍처 — AI 핵심 지침

> Planetory 설계·구현·리뷰 시 사용하는 기준 컨텍스트다.  
> 상태: 목표 설계이며 실제 배포 완료를 의미하지 않는다. `확정`은 유지할 결정, `가정`은 계산 기준, `후보`는 대안, `미정`은 사용자 결정이 필요한 값이다.
> 기준 요구사항: [Planetory 요구사항 명세서 v0.12](../requirements/planetory-requirements-spec.md)

```mermaid
flowchart LR
  SRC[MAST TESS FITS] --> ING[Worker 2~6 수집]
  subgraph GCP[GCP asia-east1-b · 6개 프로젝트]
    M[Node 1<br/>Active NameNode · JournalNode<br/>YARN RM · Airflow · Publisher]
    S[Node 2<br/>Standby NameNode · JournalNode<br/>DataNode · NodeManager]
    J[Node 3<br/>JournalNode · DataNode · NodeManager]
    W[Node 4~6<br/>DataNode · NodeManager]
    ING --> H[HDFS Raw → Bronze → Silver]
    M -->|Spark on YARN| H
    H --> P[PublicationBundle 검증]
  end
  P -->|checksum · 증분 전송| E[EC2 Gold release/current]
  U[사용자] --> API[EC2-A/B API]
  API <--> DB[PostgreSQL Primary/Standby]
  E --> API
```

## 1. 불변 규칙

1. **AWS EC2는 온라인 서비스, GCP는 저장·배치 처리를 담당한다.**
2. **EC2 API는 GCP HDFS를 실시간 조회하지 않는다.**
3. GCP 결과는 검증된 **Gold 릴리스**로만 EC2에 전달한다.
4. 회원·제출·분석 이력·커뮤니티 데이터는 **PostgreSQL**에 저장한다.
5. 곡선·주기도·Parquet 본문은 **EC2 Gold 파일**, 검색용 메타데이터는 PostgreSQL에 저장한다.
6. 어느 EC2가 요청을 받아도 쓰기는 PostgreSQL Primary에서 처리한다.
7. **EC2-B Backend가 EC2-A Backend로 쓰기 요청을 전달하지 않는다.** 두 Backend가 Primary에 직접 연결한다.
8. 배치나 Gold 배포가 실패하면 현재 서비스 중인 릴리스를 유지한다.
9. 미확정 기술을 이미 결정된 사실처럼 구현하거나 문서화하지 않는다.

충돌 시 우선순위는 `불변 규칙 → 데이터 소유권 → 사용자가 선택한 용량안 → 미확정 사항` 순이다.

## 2. 시스템 경계

```text
온라인: 사용자 → Cloudflare → EC2-A/B → PostgreSQL + EC2 Gold
배치:   외부 원천 → Airflow → YARN/Spark → HDFS Raw → Bronze → Silver → Gold 후보
공개:   GCP Gold 후보 → 검증·전송 → EC2 Gold current 전환
관측:   EC2-A/B + GCP Node 1~6 → Prometheus → Grafana
```

## 3. 구성과 책임

| 영역 | 구성 | 책임 |
| --- | --- | --- |
| 진입점 | Cloudflare DNS·CDN·Tunnel | HTTPS 진입, 정적 캐시, EC2 요청 분산 |
| EC2-A/B | Docker, Nginx | 실행 환경, 정적 파일, `/api/*` 프록시 |
| Frontend | React, TypeScript, Vite | 사용자 UI |
| Backend | Spring Boot 3 | 회원, 제출, 분석 결과, 커뮤니티, 성과 API |
| 서비스 DB | PostgreSQL | 트랜잭션 및 서비스 메타데이터 |
| 배치 제어 | Airflow | 대상·버전·순서·실패 단계 재처리 |
| 자원 관리 | YARN | Spark 실행 자원 배정 |
| 분산 연산 | Spark | 파싱·정제·결합·BLS·residual·AI 배치 |
| 분산 저장 | Hadoop HDFS | Raw·Bronze·Silver·Gold 후보 저장 |
| 관측 | Prometheus, Grafana | 메트릭 수집 및 시각화 |

EC2-A/B 애플리케이션은 동일하고 무상태로 운영한다. Redis는 공유 세션이나 캐시가 실제로 필요할 때만 추가한다.

Cloudflare Free는 유료 Load Balancing과 동일하다고 가정하지 않는다. 구현 전 다중 Tunnel connector, 상태 확인 및 장애 전환 범위를 검증한다.

## 4. 서버 자원 및 노드 역할

GCP 디스크·네트워크·비용 가정과 검토 결과는 [GCP 분산 인프라 상세](gcp-distributed-infrastructure.md), 생성 명령은 [GCP 준비 절차](../../infra/provisioning/gcp/README.md)를 따른다.

### 가용 및 가정 서버 스펙

| 환경 | 수량 | 서버 1대당 사양 | 합계 | 상태 |
| --- | ---: | --- | --- | --- |
| AWS EC2 | 2대 | 4 vCPU · 16GB · 320GB | 8 vCPU · 32GB · 640GB | 확정된 가용량 |
| GCP Node 1 | 1대 | 6 vCPU · 36GiB · Data 200GiB | 동일 | 생성 계획 |
| GCP Node 2 | 1대 | 6 vCPU · 36GiB · HDFS 2,000GiB · Metadata 100GiB | 동일 | 생성 계획 |
| GCP Node 3~6 | 4대 | 6 vCPU · 36GiB · HDFS 각 2,000GiB | 24 vCPU · 144GiB · HDFS 8,000GiB | 생성 계획 |

Storage는 설치 용량이다. OS, Docker, DB, 로그와 복제본을 제외한 실제 가용량은 더 작다.

GCP는 `asia-east1-b` 한 존의 6개 프로젝트를 full-mesh VPC Peering으로 연결한다. 생성 전 각 계정의 결제·할당량·Trial 적용 여부를 확인하며, 위 수치는 실제 생성 완료 상태를 의미하지 않는다.

### AWS

| 노드 | 역할 |
| --- | --- |
| EC2-A | 애플리케이션 노드 + PostgreSQL Primary(Read/Write) |
| EC2-B | 애플리케이션 노드 + PostgreSQL Standby(Read-only) + Prometheus/Grafana |

- Primary → Standby는 WAL streaming으로 복제한다.
- Standby는 복제 지연을 허용할 수 있는 조회만 처리한다.
- 쓰기 직후 조회와 최신성이 필요한 조회는 Primary를 사용한다.
- Primary 장애 시 Standby 자동 승격은 확정되지 않았다.

### GCP

| 노드 | Hadoop/YARN 역할 | YARN 컨테이너 한도 |
| --- | --- | --- |
| 1 | Active NameNode, JournalNode, ResourceManager, Airflow, Publisher | NodeManager 미실행 |
| 2 | Standby NameNode, JournalNode, DataNode, NodeManager | 16GiB / 2 vCore |
| 3 | JournalNode, DataNode, NodeManager | 24GiB / 3 vCore |
| 4~6 | DataNode, NodeManager | 24GiB / 3 vCore |

Node 1~3은 QJM edit log를 구성한다. ZooKeeper와 ZKFC는 사용하지 않으며 HDFS 전환은 수동이다. 계획된 전환은 기존 Active를 먼저 Standby로 내리고, 장애 전환은 기존 Active VM이 완전히 중지됐음을 확인한 뒤 Standby를 직접 승격한다. 자동 fencing은 없으므로 응답 없는 Active를 대상으로 `haadmin -failover`를 실행하지 않는다. ResourceManager는 Node 1 단일 인스턴스로 두고 장애 시 실행 중인 작업을 실패 처리한 뒤 복구 후 Airflow에서 해당 단계만 재시도한다.

JournalNode는 Node 1의 200GiB 데이터 디스크, Node 2의 100GiB 메타데이터 디스크, Node 3의 30GiB 부팅 디스크를 사용한다. HDFS DataNode 설치 용량은 Worker 5대의 2,000GiB를 합한 **10,000GiB(약 9.77TiB)**다. Boot 30GiB도 지역 `pd-standard` 2,048GiB 할당량에 포함된다. 이 POC에서는 HA 메타데이터 외부 백업을 두지 않는다.

## 5. 데이터 소유권

| 데이터 | 저장 위치 | 온라인 조회 |
| --- | --- | --- |
| FITS 원본·외부 원응답 | GCP HDFS Raw | 금지 |
| Sector Parquet | GCP HDFS Bronze | 금지 |
| 정제곡선·BLS·residual·AI 내부 결과 | GCP HDFS Silver | 금지 |
| 공개 전 축약 데이터 | GCP PublicationBundle staging | 금지 |
| 검증된 곡선·주기도·후보·AI 결과 | EC2 Gold | 허용 |
| 회원·제출·이력·커뮤니티·성과 | PostgreSQL | 허용 |
| Gold 릴리스·검색·정렬 메타데이터 | PostgreSQL | 허용 |

`HDFS → Backend API` 화살표는 실시간 조회가 아니라 **Gold 배치 전달**을 뜻한다.

## 6. 데이터 레이크 및 배치

| 계층 | 내용 | 논리 용량 추정 | 저장 용량 추정 |
| --- | --- | ---: | ---: |
| Raw | 원본 FITS·외부 원응답 | 약 3.031TiB | RF3 약 9.09TiB |
| Bronze | 파싱된 관측 Parquet | 약 0.52TiB | RF2 약 1.04TiB |
| Silver | 정제·BLS·잔차·AI 내부 산출물 | 약 0.50~0.70TiB | RF2 약 1.0~1.4TiB |
| Gold | 서비스 공개·온라인 계산 입력 | PoC 후 산정 | EC2 저장량 PoC 후 결정 |

용량 추정치는 계획값이며 실제 원천 크기와 Parquet 압축률을 측정해 다시 계산한다. 현재 약 9.77TiB 설치 용량은 예상 저장물 11.13~11.53TiB보다 작으므로 전체 TESS 보관이 불가능하다. 초기에는 Sector 범위를 제한하고 사용률 70%를 운영 목표, 75%를 신규 수집 중단선으로 둔다. 전체 범위를 처리하려면 실측 후 중간 산출물 보존·복제 범위를 줄이거나 DataNode를 추가한다. 현재 추정치에서 75% 중단선까지 고려하면 동일 디스크의 Worker 8대 이상이 필요하다.

디렉터리·파티션, FITS 묶음 저장과 EC2 Gold 파일 구조는 [데이터 관리 및 재현성](./data-guidelines.md)을 따른다. 외부 원천별 수집부터 PublicationBundle 배포까지의 상세 순서는 [Hadoop·Spark 개발 규칙](./spark-hadoop-guidelines.md)을 따른다.

Gold 후보는 `PublicationBundle`이라는 논리 계층이다. 배치는 원천·파이프라인 버전을 고정하고 단계별 재처리가 가능해야 하며, 검증된 결과만 EC2에 전달한다. v0.12가 요구하는 원본 정제곡선 전 점·품질 마스크·`fold_reference_time_btjd`·원본 주기도·후보별 통과 모델·계산 버전은 포함하되, 파일 스키마와 용량은 미니 파이프라인 PoC 결과를 보고 별도 Task에서 확정한다.

## 7. Gold 공개 규칙

```text
GCP PublicationBundle → 검증 → EC2 임시 release → 재검증 → current 원자적 전환 → API 공개
```

- 전송 중인 디렉터리를 공개하지 않는다.
- 검증 실패 시 `current`를 바꾸지 않는다.
- 기존 릴리스를 덮어쓰지 않는다.
- 실패한 TIC와 단계만 재처리한다.
- EC2 API는 `current`가 가리키는 Gold만 읽는다.
- 분석 시작 시 `publication_bundle_id`를 고정하며 진행 중 세션에 새 릴리스를 섞지 않는다.
- 구버전 Bundle과 해당 캐시는 정해진 보존기간 동안 함께 유지한다. 보존기간은 DEC-35의 미정 항목이다.

Gold 릴리스의 파일 구조와 전송 전후 검증 기준은 [데이터 관리 및 재현성](./data-guidelines.md)을 따른다.

## 8. 관측·보안·호환성

- Prometheus는 node exporter, Spring Actuator, JMX exporter를 통해 EC2와 GCP 메트릭을 수집한다.
- Grafana는 Prometheus를 조회한다.
- API 오류율·지연, DB 복제 지연, HDFS 사용률, YARN 자원, Spark/Airflow 상태, Gold 버전을 관측한다.
- 온라인 계산은 `QUEUED`, `RESIDUAL_CALCULATING`, `RESIDUAL_READY`, `PERIODOGRAM_CALCULATING`, `COMPLETED`, `FAILED` 상태별 대기·처리 시간과 실패율을 관측한다.
- EC2-B 장애 시 관측성도 중단되는 구조는 현재 비용 제약상 허용한다.
- PostgreSQL, HDFS, YARN, Spark 관리 포트를 인터넷에 공개하지 않는다.
- GCP–AWS 전송과 메트릭 수집은 인증·암호화된 경로만 사용한다.
- EC2와 GCP는 x86_64(`linux/amd64`) 이미지를 사용한다. 이미지 빌드와 실제 실행 검증 기준은 [CI/CD](../operations/cicd.md)를 따른다.
- 30일 POC의 Hadoop 내부 통신은 방화벽에 등록된 6개 사설 IP만 신뢰하는 경계로 제한한다. Kerberos와 HDFS wire encryption은 이번 범위에 넣지 않으므로 피어링에 다른 VM을 추가할 때 보안 결정을 다시 검토한다.

## 9. 미확정 사항

AI가 임의로 확정하지 말고 구현 티켓 또는 사용자 결정을 요구한다.

- Cloudflare Free 기반 요청 분산과 장애 감지 방식
- Redis 도입 여부와 위치
- PostgreSQL 자동 승격 및 복구 절차
- PublicationBundle 내부 파일 스키마·용량과 구버전 Bundle·캐시 보존기간
- EC2 Gold 저장 경로와 릴리스 보존 수
- GCP–AWS Gold 전송 프로토콜과 방화벽 규칙
- 서비스 DB·Gold의 백업/복구 목표와 로그 보존 기간(HDFS HA 메타데이터 외부 백업은 제외 확정)

## 10. AI 판단 체크리스트

1. 변경 영역을 온라인, 배치, 저장, 관측 중 하나로 분류한다.
2. 데이터 소유권 표로 저장 위치와 조회 경로를 확인한다.
3. 온라인 HDFS 조회가 생기면 Gold 배포 방식으로 수정한다.
4. EC2별 애플리케이션 차이를 만들지 않는다. DB 역할 차이만 유지한다.
5. 쓰기가 Standby나 다른 Backend가 아니라 Primary로 향하는지 확인한다.
6. 배치 산출물에 버전, checksum, 재처리 단위를 포함한다.
7. GCP의 실제 할당량·Trial·생성 상태를 계획값과 구분한다.
8. 새 기술과 미정 경로는 확정된 요구가 있을 때만 추가한다.
9. 설계, 구현 완료, 검증 완료를 구분해서 보고한다.
