# 데이터 관리 및 재현성

> 데이터 저장 위치와 계층 경계의 정본은 [시스템 아키텍처](./system-architecture.md)입니다. 이 문서는 디렉터리, 파티션, 보존 및 재현성 규칙을 상세화합니다.

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

- 원본 정제곡선의 모든 점과 품질 마스크
- `fold_reference_time_btjd`
- 원본 주기도
- 후보별 통과 모델
- 계산 버전

전체 파일 스키마는 미니 파이프라인 PoC 후 별도 Task에서 확정합니다.

EC2에 공개한 PublicationBundle은 HDFS의 `publication-bundle-backup`에 RF2로 보관합니다.

- 용도: manifest와 checksum을 검증한 EC2 릴리스 복구
- 보존: 30일 PoC 기간
- 용량 관리: HDFS 사용률 75% 신규 수집 중단선에 포함
- 온라인 조회: 사용하지 않음

> 이 백업은 같은 HDFS 클러스터 안의 복사본입니다. EC2 릴리스 삭제·손상은 복구할 수 있지만, HDFS 클러스터 전체 손실과 NameNode 메타데이터 손실은 보호하지 않습니다.

약 171만 개로 예상되는 작은 FITS는 개별 파일로 저장하지 않습니다. 원본 바이트를 512MB~1GB SequenceFile 묶음으로 보존하고 `manifest.parquet`에 파일명, TIC, Sector, 크기, checksum과 묶음 위치를 기록합니다. 원본을 삭제하거나 컬럼을 제거하지 않습니다.

## EC2 Gold 릴리스

```text
/gold
├─ releases/<bundle_id>/
│  └─ <PublicationBundle 파일 구조는 PoC 후 확정>
├─ current -> releases/<현재 bundle_id>
└─ previous -> releases/<직전 bundle_id>
```

- 전송 중인 디렉터리는 공개하지 않습니다.
- 경로, 파이프라인 버전, 파일 목록과 checksum을 전송 전후에 검증합니다.
- 모든 검증이 통과하면 `previous`를 기존 `current`로 갱신한 뒤 `current`만 새 릴리스로 원자적으로 전환합니다.
- 검증에 실패하면 기존 `current`, `previous`와 릴리스를 유지합니다.
- 신규 분석 세션은 `current`를 한 번 조회하고 선택한 `publication_bundle_id`를 끝까지 사용합니다.
- 진행 중 세션·재시도·온라인 계산은 `current`가 아니라 `releases/<publication_bundle_id>`를 조회합니다.
- `current`와 `previous`보다 오래된 릴리스와 해당 캐시는 진행 중 세션·재시도·보존기간 내 히스토리가 참조하지 않으면 삭제합니다. 참조 중인 릴리스는 보존기간이 끝날 때까지 삭제하지 않습니다.

## 재현성

- 입력 및 출력 경로를 코드에 하드코딩하지 않고 설정이나 실행 인자로 전달합니다.
- 실행 명령, 환경 변수 이름, 의존성 버전과 필요한 리소스를 문서화합니다.
- 비밀 값은 GitLab CI/CD Variables 또는 EC2의 안전한 비밀 관리 수단으로 주입합니다.
- 랜덤 연산이 있다면 seed를 명시합니다.
- 동일 작업을 재실행해도 데이터 중복이나 손상이 발생하지 않도록 멱등성을 고려합니다.
- 실험 결과에는 코드 버전, 데이터 버전 또는 기간, 설정값과 실행 환경을 기록합니다.

## 결정 대기 사항

- GCP Gold 후보의 실제 staging 경로
- 진행 중 세션·재시도·히스토리가 참조하는 이전 Bundle·캐시의 보존기간
- Raw·Silver 등 계층별 데이터 보존 기간
- 개인정보 및 민감정보 처리 정책
- 데이터 접근 권한

