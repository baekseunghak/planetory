# 데이터 관리 및 재현성

> 데이터 저장 위치와 계층 경계의 정본은 [시스템 아키텍처](../architecture/system-architecture.md)입니다. 이 문서는 디렉터리, 파티션, 보존 및 재현성 규칙을 상세화합니다.

## 데이터 관리

- 원본 데이터는 불변으로 취급하며 직접 수정하지 않습니다.
- 목표 저장 위치와 계층은 시스템 아키텍처를 따르며, 실제 프로비저닝 경로와 보존 정책은 확정 후 기록합니다.
- 원본 데이터와 대용량 결과 파일은 Git 저장소에 추가하지 않습니다.
- 저장소에는 테스트에 필요한 최소 크기의 익명화된 샘플만 포함할 수 있습니다.
- 샘플 데이터도 사용 권한과 민감정보 포함 여부를 확인합니다.
- 스키마에는 필드명, 타입, nullable 여부, 의미와 예시를 기록합니다.
- 스키마 변경 시 하위 호환성과 기존 데이터 재처리 필요 여부를 MR에 작성합니다.
- 생성 가능한 데이터와 결과물에는 생성 명령 또는 파이프라인을 함께 제공합니다.

## 데이터 레이크 디렉터리와 파티션

```text
/lake
├─ raw/
│  ├─ tess/release=<release>/sector=<sector>/
│  │  ├─ bundle-00001.seq
│  │  └─ manifest.parquet
│  └─ external/source=<tic|tce|toi|archive|exofop>/snapshot_date=<date>/
├─ bronze/tess/sector=<sector>/part-*.parquet
├─ silver/pipeline_version=<version>/run_id=<run>/
│  ├─ sector_cleaned/
│  ├─ target_combined/
│  ├─ periodogram/
│  ├─ candidates/
│  ├─ ai_input/
│  ├─ ai_result/
│  └─ internal/
│     ├─ residual/
│     └─ removal_qa/
└─ publication-bundle-backup/bundle_id=<bundle_id>/
   ├─ <PublicationBundle 파일>
   └─ manifest + checksum
```

Gold 후보는 `PublicationBundle`이라는 논리 계층입니다. GCP의 실제 staging 경로는 아직 정하지 않았으므로 `/lake/gold` 같은 경로를 임의로 만들지 않습니다.

PublicationBundle은 최소한 다음 입력을 포함합니다.

- 품질 필터와 비닝이 끝난 별·섹터 곡선 세그먼트
- `fold_reference_time_btjd`
- 원본 주기도
- 후보별 통과 모델
- 계산 버전

온라인 Gold의 열·제약은 [서비스 DB ERD](../architecture/database-erd.md), manifest 최소 형태는 DB 마이그레이션을 정본으로 사용합니다.

EC2에 공개한 PublicationBundle은 HDFS의 `publication-bundle-backup`에 RF2로 보관합니다.

- 용도: manifest와 checksum을 검증한 EC2 릴리스 복구
- 보존: 30일 PoC 기간
- 용량 관리: HDFS 사용률 75% 신규 수집 중단선에 포함
- 온라인 조회: 사용하지 않음

> 이 백업은 같은 HDFS 클러스터 안의 복사본입니다. EC2 릴리스 삭제·손상은 복구할 수 있지만, HDFS 클러스터 전체 손실과 NameNode 메타데이터 손실은 보호하지 않습니다.

약 171만 개로 예상되는 작은 FITS는 개별 파일로 저장하지 않습니다. 원본 바이트를 512MB~1GB SequenceFile 묶음으로 보존하고 `manifest.parquet`에 파일명, TIC, Sector, 크기, checksum과 묶음 위치를 기록합니다. 원본을 삭제하거나 컬럼을 제거하지 않습니다.

## PostgreSQL Gold 공개

```text
Publisher 검증 → planetory_gold_writer로 PostgreSQL Primary 접속
→ BEGIN
→ 신규 곡선 revision·주기도·후보·manifest 적재
→ 기존 current를 archived, 새 staging 판을 current로 전환
→ archived 판 주기도 정리
→ COMMIT
→ Backend에 bundleId 알림
```

- 적재와 판 전환은 한 PostgreSQL 트랜잭션입니다. 실패하면 전체를 롤백하고 기존 `current`를 유지합니다.
- 서비스의 `planetory_app` 역할은 Gold 테이블을 읽기만 하며, 적재 API를 제공하지 않습니다.
- 바뀌지 않은 곡선 세그먼트는 별·섹터·revision으로 재사용하고 manifest의 `segment_ids`가 이번 판의 입력을 특정합니다.
- 판 행은 과거 제출의 참조를 위해 남기지만 이전 판의 주기도와 Redis 계산 캐시는 재생성 가능한 데이터로 정리합니다.
- Publisher는 커밋 뒤 전환된 `bundleId`만 Backend에 알립니다. 같은 알림을 다시 받아도 결과가 달라지지 않아야 합니다.
- 알림 실패는 DB 커밋을 되돌리는 사유가 아닙니다. Publisher가 재시도하고, Backend는 요청마다 PostgreSQL의 `current`를 확인해 누락된 알림에 의존하지 않습니다.
- Backend는 알림을 계기로 Redis 캐시 정리, 완료 별 재개 판정, 외부 라벨 갱신 표식을 실행합니다.
- 진행 중 분석은 판 변경을 감지하면 최신 판으로 다시 불러오며 archived 판 계산 결과를 채택하지 않습니다.

## 재현성

- 입력 및 출력 경로를 코드에 하드코딩하지 않고 설정이나 실행 인자로 전달합니다.
- 실행 명령, 환경 변수 이름, 의존성 버전과 필요한 리소스를 문서화합니다.
- 비밀 값은 GitLab CI/CD Variables 또는 EC2의 안전한 비밀 관리 수단으로 주입합니다.
- 랜덤 연산이 있다면 seed를 명시합니다.
- 동일 작업을 재실행해도 데이터 중복이나 손상이 발생하지 않도록 멱등성을 고려합니다.
- 실험 결과에는 코드 버전, 데이터 버전 또는 기간, 설정값과 실행 환경을 기록합니다.

## 결정 대기 사항

- GCP Gold 후보의 실제 staging 경로와 HDFS 백업 형식
- PostgreSQL Gold 배열의 실측 용량과 archived 판 행 보존 운영값
- Raw·Silver 등 계층별 데이터 보존 기간
- 개인정보 및 민감정보 처리 정책
- 운영 환경의 Publisher DB 접속 경로와 커밋 후 알림 인증 방식

