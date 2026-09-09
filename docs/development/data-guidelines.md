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

Gold 후보는 `PublicationBundle`이라는 논리 계층입니다. GCP의 실제 staging 경로는 아직 정하지 않았으므로 `/lake/gold` 같은 경로를 임의로 만들지 않습니다. v0.12의 최소 입력은 원본 정제곡선 전 점·품질 마스크·`fold_reference_time_btjd`·원본 주기도·후보별 통과 모델·계산 버전이며, 전체 파일 스키마는 미니 파이프라인 PoC 후 별도 Task에서 확정합니다.

약 171만 개로 예상되는 작은 FITS는 개별 파일로 저장하지 않습니다. 원본 바이트를 512MB~1GB SequenceFile 묶음으로 보존하고 `manifest.parquet`에 파일명, TIC, Sector, 크기, checksum과 묶음 위치를 기록합니다. 원본을 삭제하거나 컬럼을 제거하지 않습니다.

## EC2 Gold 릴리스

```text
/gold
├─ releases/<bundle_id>/
│  └─ <PublicationBundle 파일 구조는 PoC 후 확정>
└─ current -> releases/<bundle_id>
```

- 전송 중인 디렉터리는 공개하지 않습니다.
- 경로, 파이프라인 버전, 파일 목록과 checksum을 전송 전후에 검증합니다.
- 모든 검증이 통과한 경우에만 `current`를 새 릴리스로 원자적으로 전환합니다.
- 검증에 실패하면 기존 `current`와 릴리스를 유지합니다.
- 분석 세션은 시작할 때 선택한 `bundle_id`를 끝까지 사용합니다.
- 구버전 Bundle과 해당 캐시는 정해진 보존기간 종료 시 함께 만료합니다. 기간은 아직 미정입니다.

## 재현성

- 입력 및 출력 경로를 코드에 하드코딩하지 않고 설정이나 실행 인자로 전달합니다.
- 실행 명령, 환경 변수 이름, 의존성 버전과 필요한 리소스를 문서화합니다.
- 비밀 값은 GitLab CI/CD Variables 또는 EC2의 안전한 비밀 관리 수단으로 주입합니다.
- 랜덤 연산이 있다면 seed를 명시합니다.
- 동일 작업을 재실행해도 데이터 중복이나 손상이 발생하지 않도록 멱등성을 고려합니다.
- 실험 결과에는 코드 버전, 데이터 버전 또는 기간, 설정값과 실행 환경을 기록합니다.

## 결정 대기 사항

- GCP Gold 후보의 실제 staging 경로
- EC2 Gold 저장 경로와 릴리스 보존 수
- Raw·Silver 등 계층별 데이터 보존 기간
- 개인정보 및 민감정보 처리 정책
- 데이터 접근 권한

