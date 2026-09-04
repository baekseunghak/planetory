# Planetory 시스템 아키텍처 — AI 핵심 지침

> Planetory 설계·구현·리뷰 시 사용하는 기준 컨텍스트다.  
> 원본 구성도: [system-architecture-visual.svg](../images/system-architecture-visual.svg)  
> 상태: 목표 설계이며 실제 배포 완료를 의미하지 않는다. `확정`은 유지할 결정, `가정`은 계산 기준, `후보`는 대안, `미정`은 사용자 결정이 필요한 값이다.

![Planetory 시스템 아키텍처](../images/system-architecture-visual.svg)

## 1. 불변 규칙

1. **AWS EC2는 온라인 서비스, OCI는 저장·배치 처리를 담당한다.**
2. **EC2 API는 OCI HDFS를 실시간 조회하지 않는다.**
3. OCI 결과는 검증된 **Gold 릴리스**로만 EC2에 전달한다.
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
공개:   OCI Gold 후보 → 검증·전송 → EC2 Gold current 전환
관측:   EC2-A/B + OCI A/B/C/D → Prometheus → Grafana
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

### 가용 및 가정 서버 스펙

| 환경 | 수량 | 서버 1대당 사양 | 합계 | 상태 |
| --- | ---: | --- | --- | --- |
| AWS EC2 | 2대 | 4 vCPU · 16GB · 320GB | 8 vCPU · 32GB · 640GB | 확정된 가용량 |
| OCI | 4대 | 12 OCPU · 64GB · 3TB | 48 OCPU · 256GB · 12TB | 기본 가정, 미정 |

Storage는 설치 용량이다. OS, Docker, DB, 로그와 복제본을 제외한 실제 가용량은 더 작다.

### OCI 용량 후보안

기본 가정과 다음 고용량 후보안을 동시에 적용하지 않는다.

**HDFS 고용량 후보:** `VM.Standard.A1.Flex 8 OCPU · 48GB` 4대와 HDFS 20.8TB

HDFS 고용량안을 선택할 때의 노드별 디스크 구성:

- HDFS: Lower Cost 2.6TB × 2개
- Spark shuffle: Balanced 300GB
- Boot: Balanced 100GB
- A·B만 메타데이터용 Balanced 50GB 추가

기본 가정의 총 12TB는 전체 TESS RF3/RF2 보관 계획을 수용하지 못한다. 전체 데이터 보관에는 HDFS 고용량 후보가 필요하다. 용량안이 확정되기 전에는 프로비저닝하지 말고 두 안을 섞어 계산하지 않는다. 아래의 용량 산정과 Spark 워커 할당은 **HDFS 고용량 후보를 선택할 때만** 적용한다.

### AWS

| 노드 | 역할 |
| --- | --- |
| EC2-A | 애플리케이션 노드 + PostgreSQL Primary(Read/Write) |
| EC2-B | 애플리케이션 노드 + PostgreSQL Standby(Read-only) + Prometheus/Grafana |

- Primary → Standby는 WAL streaming으로 복제한다.
- Standby는 복제 지연을 허용할 수 있는 조회만 처리한다.
- 쓰기 직후 조회와 최신성이 필요한 조회는 Primary를 사용한다.
- Primary 장애 시 Standby 자동 승격은 확정되지 않았다.

### OCI

OCI는 동일 리전에 배치된 4개 독립 계정의 노드를 하나의 클러스터로 연결하는 것을 전제로 한다.

| 노드 | Hadoop/YARN 역할 | HDFS 고용량안의 Spark 워커 할당 |
| --- | --- | --- |
| A | NameNode, YARN ResourceManager, Airflow, History Server, DataNode, NodeManager | 약 5 vCore / 28GB |
| B | CheckpointNode, DataNode, NodeManager | 약 6 vCore / 36GB |
| C | DataNode, NodeManager | 약 7 vCore / 40GB |
| D | DataNode, NodeManager | 약 7 vCore / 40GB |

구성도에서는 이 데몬들을 Hadoop/YARN과 Master/Worker로 추상화한다. A도 Worker지만 제어 프로세스용 CPU와 메모리를 남긴다. B는 자동 대기 NameNode가 아니라 CheckpointNode이므로 A 장애 시 데이터는 남아도 제어 역할은 수동 복구해야 한다.

## 5. 데이터 소유권

| 데이터 | 저장 위치 | 온라인 조회 |
| --- | --- | --- |
| FITS 원본·외부 원응답 | OCI HDFS Raw | 금지 |
| Sector Parquet | OCI HDFS Bronze | 금지 |
| 정제곡선·BLS·residual·AI 내부 결과 | OCI HDFS Silver | 금지 |
| 공개 전 축약 데이터 | OCI HDFS Gold 후보(논리 계층, 경로 미정) | 금지 |
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
| Gold | 서비스용 축약 데이터 | 약 20~25GiB | EC2 EBS 100GiB 권장 |

용량 추정치는 HDFS 고용량안의 계획값이며 실제 원천 크기와 Parquet 압축률을 측정해 다시 계산한다. 20.8TB HDFS는 신·구 Silver 동시 보관과 재처리 여유를 포함한다.

### HDFS 경로

```text
/lake
├─ raw/
│  ├─ tess/release=<release>/sector=<sector>/
│  │  ├─ bundle-00001.seq
│  │  └─ manifest.parquet
│  └─ external/source=<tic|tce|toi|archive|exofop>/snapshot_date=<date>/
├─ bronze/tess/sector=<sector>/part-*.parquet
└─ silver/pipeline_version=<version>/run_id=<run>/
   ├─ sector_cleaned/
   ├─ target_combined/
   ├─ periodogram/
   ├─ candidates/
   ├─ ai_input/
   ├─ ai_result/
   └─ internal/
      ├─ residual/
      └─ removal_qa/
```

Gold 후보는 PublicationBundle이라는 논리 계층이다. OCI 내 실제 staging 경로는 아직 정하지 않았으므로 AI가 `/lake/gold` 같은 경로를 임의로 만들지 않는다.

약 171만 개로 예상되는 작은 FITS는 개별 파일로 저장하지 않는다. 원본 바이트를 512MB~1GB SequenceFile 묶음으로 보존하고 `manifest.parquet`에 파일명, TIC, Sector, 크기, checksum, 묶음 위치를 기록한다. 원본을 삭제하거나 컬럼을 제거하지 않는다.

배치 순서:

1. Airflow가 TIC·Sector·원천 릴리스·파이프라인 버전을 고정한다.
2. 네 노드가 다운로드 대상을 나눠 각자의 임시 영역에 저장한다.
3. 크기와 checksum을 검증한 원본만 Raw HDFS에 RF3로 기록한다.
4. Spark가 Raw를 Bronze Parquet으로 변환한다.
5. Sector별 품질 필터, 정규화, 연속 구간 디트렌딩을 수행한다.
6. TIC 기준으로 Sector를 결합해 Silver 정제곡선을 만든다.
7. 원본 periodogram과 BLS 후보를 생성한다.
8. 통과 신호를 제거하고 residual BLS를 반복한다.
9. 제거 품질과 원본 곡선을 재검증한 뒤 후보를 병합한다.
10. TCE·TOI·NASA Archive·ExoFOP 상태를 연결한다.
11. AI 입력과 추론 결과를 생성한다.
12. 화면용 곡선·주기도·후보표를 PublicationBundle로 검증한다.
13. EC2의 새 release 디렉터리로 전송한다.
14. 모든 checksum이 일치할 때만 `current`를 새 릴리스로 전환한다.

외부 원천은 TESS/MAST FITS, TIC, TCE, TOI, NASA Exoplanet Archive, ExoFOP이다.

## 7. Gold 공개 규칙

```text
OCI Gold 후보 → 검증 → EC2 임시 release → 재검증 → current 원자적 전환 → API 공개
```

- 전송 중인 디렉터리를 공개하지 않는다.
- 검증 실패 시 `current`를 바꾸지 않는다.
- 기존 릴리스를 덮어쓰지 않는다.
- 실패한 TIC와 단계만 재처리한다.
- EC2 API는 `current`가 가리키는 Gold만 읽는다.

```text
/gold
├─ releases/<bundle_id>/
│  ├─ stars.parquet
│  ├─ candidates.parquet
│  ├─ ai_results.parquet
│  ├─ external_status.parquet
│  ├─ lightcurve-ui/
│  ├─ periodogram-ui/
│  └─ manifest.json
└─ current -> releases/<bundle_id>
```

PublicationBundle 검증은 경로, 파이프라인 버전, 파일 목록과 checksum을 확인한다. 압축 전송 후 EC2에서 다시 검증하며 실패 시 기존 `current`를 유지한다.

## 8. 관측·보안·호환성

- Prometheus는 node exporter, Spring Actuator, JMX exporter를 통해 EC2와 OCI 메트릭을 수집한다.
- Grafana는 Prometheus를 조회한다.
- API 오류율·지연, DB 복제 지연, HDFS 사용률, YARN 자원, Spark/Airflow 상태, Gold 버전을 관측한다.
- EC2-B 장애 시 관측성도 중단되는 구조는 현재 비용 제약상 허용한다.
- PostgreSQL, HDFS, YARN, Spark 관리 포트를 인터넷에 공개하지 않는다.
- AWS–OCI 전송과 메트릭 수집은 인증·암호화된 경로만 사용한다.
- EC2 x86_64와 OCI ARM64용 이미지를 `linux/amd64`, `linux/arm64`로 빌드한다.
- ARM64 호환성은 CI 빌드뿐 아니라 실제 OCI 실행으로 검증한다.

## 9. 미확정 사항

AI가 임의로 확정하지 말고 구현 티켓 또는 사용자 결정을 요구한다.

- Cloudflare Free 기반 요청 분산과 장애 감지 방식
- 서로 다른 OCI 계정의 사설망 또는 오버레이 네트워크
- Redis 도입 여부와 위치
- PostgreSQL 자동 승격 및 복구 절차
- OCI Gold 후보의 실제 staging 경로
- EC2 Gold 저장 경로와 릴리스 보존 수
- AWS–OCI 전송 프로토콜과 방화벽 규칙
- 백업·복구 목표와 로그 보존 기간

## 10. AI 판단 체크리스트

1. 변경 영역을 온라인, 배치, 저장, 관측 중 하나로 분류한다.
2. 데이터 소유권 표로 저장 위치와 조회 경로를 확인한다.
3. 온라인 HDFS 조회가 생기면 Gold 배포 방식으로 수정한다.
4. EC2별 애플리케이션 차이를 만들지 않는다. DB 역할 차이만 유지한다.
5. 쓰기가 Standby나 다른 Backend가 아니라 Primary로 향하는지 확인한다.
6. 배치 산출물에 버전, checksum, 재처리 단위를 포함한다.
7. OCI 용량안이 선택되지 않았다면 수치를 섞지 말고 사용자 결정을 요구한다.
8. 새 기술과 미정 경로는 확정된 요구가 있을 때만 추가한다.
9. 설계, 구현 완료, 검증 완료를 구분해서 보고한다.
