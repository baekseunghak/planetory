# Publisher

완료된 Silver를 검사하고 EC2용 Gold 묶음으로 포장해 서비스 PostgreSQL에 게시한다.

경로, 버전과 checksum을 검증한 뒤 전달한다. 전송이나 검증에 실패하면 기존 Gold를 바꾸지 않는다.

## 현재 상태 (S15P21C206-262)

**적재 단계만 구현했고 입력은 목업이다.** 실제 Gold 입력(HDFS reader), 게시 전 QA, 후보 대조, GCP→EC2-A 접속 경로는 없다.

| 파일 | 역할 | 교체 시 |
| --- | --- | --- |
| `publisher/load.py` | Gold payload 한 건을 적재하고 current로 전환한다 | 그대로 쓴다 |
| `publisher/mock_source.py` | 계약 예시 payload를 더미 별 TIC에 옮겨 싣는다 | **HDFS Gold reader로 바꾼다** |
| `publisher/__main__.py` | 명령(`mock-load`·`mock-purge-sql`·`notify`)과 Backend 알림 | 명령만 추가한다 |
| `publisher/mock_purge.sql` | `mock-` 표식 행을 지운다 | 목업을 걷을 때 함께 지운다 |
| `publisher/fixtures/gold-toi270-s3.json` | 목업 입력 원천 | 목업을 걷을 때 함께 지운다 |

두 단계 사이의 약속은 **Gold payload의 모양**이다. `experiments/gold-roundtrip`(`S15P21C206-117`)이 만드는 형식이다. 입력 어댑터가 같은 모양을 내면 `load.publish`는 원천을 구분하지 않는다.

- `bundle`: `tic_id`, `bundle_version`, `manifest`, `fold_reference_time_btjd`, `base_days`
- `segments[]`: `sector`, `binning_revision`, `start_btjd`, `bin_minutes`, `n_points`, `flux`, `flux_scatter`, `gaps`
- `periodogram`: `period_min_days`, `period_max_days`, `n_periods`, `power`
- `candidates[]`: 후보 수치, `transit_model`, `discoverable`, `is_confirmed`
- `checksums`: `segment:<sector>:<revision>:flux`, `periodogram:power`

목업 원천 `fixtures/gold-toi270-s3.json`은 gold-roundtrip이 실제 TESS 곡선(TOI-270, Sector 3)으로 만든 계약 예시의 사본이다. 과학 기준값이 아니다. gold-roundtrip에서 게시 전 QA와 DB 왕복 검사를 통과했으므로 목업 경로에서는 QA를 다시 하지 않는다.

## 적재 절차

정본은 [시스템 아키텍처](../../docs/architecture/system-architecture.md) 「공개」와 [ERD](../../docs/architecture/database-erd.md) 결정 12다. `load.publish`가 그대로 밟는다.

1. `planetory_gold_writer` 멤버 계정으로 붙는다. 소유자로 붙으면 권한 분리가 무력화된다.
2. `pg_advisory_xact_lock(tic_id)`으로 같은 TIC 게시를 줄 세운다.
3. `(tic_id, bundle_version)`이 이미 있으면 재시도다. 아무것도 바꾸지 않는다. archived 판의 늦은 재시도도 현재 판을 되돌리지 않는다.
4. 세그먼트(자연 키로 공유) → 판 `staging` → 주기도 → 후보를 넣는다. manifest의 `segment_ids`·`array_checksums`는 DB id로 채운다.
5. 기존 `current`를 `archived`로 바꾸고, archived 판의 주기도를 지우고, 새 판을 `current`로 올린다.
6. 커밋 뒤 `POST /internal/bundles/b-<id>/activated`로 Backend에 알린다. 헤더는 `X-Planetory-Service-Token: <INTERNAL_SERVICE_TOKEN>`이다. 실패해도 DB 전환은 되돌리지 않는다. 토큰이 없으면 보내지 않는다. 적재를 다시 돌리면 판이 이미 있어 알림을 건너뛰므로, 보내지 못한 판은 `notify --bundle b-<id>`로만 다시 알린다.

1~5는 한 트랜잭션이다. 격리 수준은 바꾸지 않고 서버 기본 `READ COMMITTED`로 연다. 공식 스레드 요약을 동기화하는 V19가 있어 후보 네 수치 변경 트랜잭션은 `READ COMMITTED`여야 한다. 적용 전 확인·오류 처리·공개 요청 잠금 대기 조건은 [공식 검색 본문 계약](../../docs/api/community/README.md#공식-제목본문의-구현-차이)을 따른다.

V23 이후 후보 변경·current 전환은 [알림 DB 생산 계약](../../docs/development/service-backend/community.md#notification-producer-contract)을 따른다. 지연 트리거가 최종 current 상태에서만 원천 사건·당시 수신 의도를 기록한다. Gold 계정의 회원 직접 권한은 추가하지 않는다. 사건을 별도 INSERT하거나 제약 트리거를 중간에 강제 실행하지 않는다.

## 목업이 다루지 않는 것

- **별 등록.** `stars`에 이미 있는 TIC에만 싣는다.
- **후보 대조.** 후보가 이미 있는 별은 거부한다. 운영 Publisher는 [후보 정정 계약](../../docs/architecture/candidate-correction-contract.md)으로 갱신·은퇴를 대조해야 한다.
- **세그먼트 재사용 검증.** 같은 자연 키가 있으면 점 수만 대조한다. 운영은 flux checksum으로 대조해야 한다.

## 실행

서비스 노드에서 돌리는 방법과 계정 준비·삭제 절차는 [EC2 서비스 배포](../../infra/service/README.md) 「Gold 목업」에 있다.

```sh
python -m publisher mock-load --tic 900000008,900000027   # libpq 환경변수(PGHOST 등)로 접속
python -m publisher mock-purge-sql                        # 삭제 SQL 출력. 소유자 psql로 넘긴다
python -m publisher notify --bundle b-12                  # 이미 current인 판에 알림만 다시 보낸다
python -m unittest test_mock_source test_notify           # DB 없이 도는 검사(입력 어댑터, 알림 헤더·경로)
```

2026-09-23 EC2-A 격리 환경(운영 백엔드 이미지로 V24까지 적용한 빈 DB)에서 검증했다. 두 별 적재와 Backend 알림 `applied: true`, 재실행 시 변경 없음, 삭제 모의 실행 뒤 그대로, 실제 삭제 뒤 판·세그먼트·주기도·후보·알림 흔적 0, 삭제 뒤 재적재까지 확인했다. 회원 참조가 있을 때 삭제가 멈추는지와 분석 API의 실제 응답은 확인하지 않았다.
