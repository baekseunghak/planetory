# Gold 배치 게시 경로의 코드 구조 (S15P21C206-276)

- 상태: 구현·합성 검증 완료. 운영 서비스 DB 적재는 합성 별 하나로 시험했다(2026-09-27, 시험 행 삭제). Node 1 게시 제어기와 Airflow 게시 단계는 운영 배포 전이다. Gold 생성·게시 준비 gate는 `S15P21C206-80`이 따로 올린다.
- 대상 독자: 이 경로를 처음 보는 개발자·운영자. 코드가 어떻게 나뉘고 어떤 순서로 이어지는지 설명한다.
- 정본: 필드·결과 코드·검사 규칙은 [Publisher README](../../distributed-system/publisher/README.md) 「payload 모양」「적재 절차」「배치 run」, Gold 필드와 표기는 [Gold 계약](../../contracts/gold/README.md), 시스템 경계는 [시스템 아키텍처](system-architecture.md)다. 이 문서와 정본이 다르면 정본을 따른다.

## 1. 한눈에 보기

배치가 만든 검증된 Gold를 운영 서비스 DB에 싣는 경로다. GCP 클러스터에서 만든 결과를 EC2가 가져가지 않는다. GCP Node 1이 EC2-A의 PostgreSQL에 직접 쓰고 Backend에 알린다([시스템 아키텍처](system-architecture.md)의 불변 규칙).

```text
GCP Hadoop 클러스터 (80)                                           AWS EC2-A
─────────────────────────────                                      ─────────────
Silver attempt
  │ tess_gold (Spark)        별마다 79 evaluate → 125 번들
  ▼
Gold attempt (HDFS, JSON Lines: manifest / candidates / bundles)
  │ tess_gate (Spark)        schema·checksum·후보 표를 다시 검사
  ▼
publish-ready marker (HDFS)
  │ Airflow approve_publication  ← 사람이 승인
  ▼
Node 1  tess_publish_ctl (systemd unit, 276)
  │ hdfs dfs -cat 으로 로컬 폴더에 받기 (파일마다 checksum 대조)
  │ docker run <고정 Publisher 이미지> python -m publisher publish-run
  ▼
Publisher (컨테이너 안, 276)
  │ run_source.read_ready  폴더 검사 → 별마다 payload
  │ load.publish_star      별마다 한 트랜잭션 ───── tailnet 5432 ──→  service-db (PostgreSQL)
  │ notify_backend         판 전환 알림 ──────────── tailnet 8080 ──→  Backend 후처리
  ▼
run 기록 JSON (Node 1 상태 파일, Airflow XCom 요약)
```

같은 Publisher를 튜토리얼 5종(`tutorial_source`)과 목업(`mock_source`)도 쓴다. 입력 어댑터만 다르고 적재(`load.publish_star`)는 하나다.

## 2. 저장소에서 어디에 무엇이 있나

| 위치 | 하는 일 | 부르는 곳 | 검사 |
| --- | --- | --- | --- |
| `libs/astro-kernel/astro_kernel/gold_serialization.py` | 125 `assemble`. 122·123·124 결과를 검증해 번들(곡선·주기도·후보·외부 참조·checksum·manifest)로 묶는다. DB로 가는 외부 참조의 `source`를 `DB_SOURCES`로 바꾼다(`nea_pscomppars` → `archive`) | 79 집계, 튜토리얼 어댑터 | `libs/astro-kernel/tests/test_candidate_aggregation.py` |
| `libs/astro-kernel/astro_kernel/candidate_aggregation.py` | 79 집계. 별 단위 `evaluate`와 run 단위 `combine`(80이 나눔), 한 프로세스용 `aggregate` | 80 `tess_gold`, 테스트 | 같은 파일 |
| `distributed-system/spark/tess_gold.py`·`tess_gold_ctl.py`·`tess_gate.py` | Gold 생성, attempt 확정, 게시 준비 gate(80) | Airflow(80) | `distributed-system/spark/test_tess_gold*.py`, `test_tess_gate.py` |
| `distributed-system/spark/tess_publish_ctl.py` | Node 1 게시 제어기. publish-ready를 받아 Publisher 컨테이너를 돌리고 run 기록을 남긴다 | systemd unit, Airflow `start_publish`·`wait_publish` | `distributed-system/spark/test_tess_publish_ctl.py` |
| `distributed-system/airflow/dags/tess_publication_dag.py`·`tess_publication_contract.py` | run 하나를 외부 수집 → Gold → gate → 승인 → 게시로 잇는 DAG와, Node 1에 보낼 명령 문자열 | Airflow | `distributed-system/airflow/tests/test_tess_publication_dag.py` |
| `distributed-system/publisher/publisher/__main__.py` | Publisher CLI. `publish-run`(배치), `load-payload`(튜토리얼 JSON), `mock-load`, `notify`, `supply-report` 등 | 컨테이너 진입점 | `test_run_source.py`(종료 코드), `test_load.py` |
| `distributed-system/publisher/publisher/run_source.py` | 배치 입력 어댑터. 게시 준비 폴더 검사(`read_ready`), 별 검사(`check_bundle`), 125 번들 → payload 변환(`gold_body`·`to_payload`) | `publish-run`, 튜토리얼 어댑터(`gold_body`) | `distributed-system/publisher/test_run_source.py` |
| `distributed-system/publisher/publisher/load.py` | 적재. preflight, 별 하나 게시(`publish_star`), 같은 트랜잭션 안 되읽기 검사(`_verify_staging`), run 기록 한 행(`publish_outcome`) | 모든 Publisher 명령 | `distributed-system/publisher/test_load.py`(일회용 PostgreSQL) |
| `distributed-system/publisher/publisher/tutorial_source.py`·`mock_source.py` | 튜토리얼 5종·목업 입력. 같은 payload 모양을 낸다 | `tutorial-build`, `mock-load` | `test_tutorial_source.py`, `test_mock_source.py` |
| `infra/distributed-system/scripts/configure-tess-publish-airflow-node1.sh` | Airflow 계정이 게시 명령 두 개만 sudo로 부르게 하는 release별 sudoers | 운영자(Node 1 root) | `bash -n`, Node 1 `visudo` |
| `infra/distributed-system/scripts/run-tess-silver.ps1`·`stage-tess-airflow-node1.ps1` | pipeline release(`spark/` 파일 목록)와 Airflow release 묶음 | 운영자(작업 PC) | — |

## 3. 데이터가 모양을 바꾸는 순서

| 단계 | 모양 | 만드는 곳 |
| --- | --- | --- |
| 125 번들 | `{bundle, segments, candidates, candidate_dispositions, external_statuses, periodogram, history_proposals, …}`. ID는 run 안에서만 유일한 임시값(번들 = TIC, 후보·세그먼트 = TIC × 100 + n) | `gold_serialization.assemble` |
| publish-ready 번들 한 줄 | `{"tic_id", "payload": 125 번들, "metadata": {"star": {teff_k, radius_rsun, tmag}, "observations": {"<Sector>": {cadence, source_version}}}}` | 80 `tess_gold` |
| Publisher payload | `tic_id`, `label`, `star`, `segments[]`(+`observation`), `bundle`(판 버전·manifest·기준 시각·`base_days`), `periodogram`, `candidates[]`(`record`·`disposition`·`external` 목록·`ai`), `external_only` | `run_source.gold_body`·`to_payload` |
| DB 행 | `stars`, `observation_datasets`, `light_curve_segments`, `publication_bundles`, `periodograms`, `candidates`, `candidate_dispositions`, `external_signal_references` | `load.publish_star` |

몇 가지 약속이 있다.

- **ID는 DB가 붙인다.** 125의 임시 ID는 DB에 들어가지 않는다. 레코드 checksum은 ID를 빼고 계산하므로 DB에서 다시 읽어도 같은 값이 나온다.
- **외부 참조는 목록이다.** 124는 원천마다 직접 대응을 하나씩 내고, 우리 후보와 대응하지 않는 행도 낸다. 그래서 `candidates[].external`은 목록이고 대응 없는 행은 `external_only`(`candidate_id=NULL`)로 따로 싣는다. 두 목록을 빠짐없이 실어야 `external_statuses` checksum이 맞는다.
- **`archive` 표기는 125가 한다.** 266 NASA 설명은 `source='archive'`와 정확한 `pl_name`으로만 원천을 찾는다. `source`가 checksum 재료라 어댑터에서 바꿀 수 없어, DB로 가는 순간(125)에 바꾸고 snapshot·`bundle_version`에는 원래 이름을 둔다.
- **메타데이터는 80이 싣는다.** 125 번들에 없는 관측 원천 버전(Bronze PROCVER)과 cadence를 80이 번들 줄에 붙인다. 별 속성은 원천이 없어 NULL이다.

## 4. 게시 run 하나가 흘러가는 순서

1. **승인.** `tess_publication_run`의 `wait_gate`가 publish-ready 요약을 넘기고, 사람이 `approve_publication`에서 승인한다.
2. **unit 시작.** `start_publish`가 SSH로 `sudo -n python3.12 <release>/spark/tess_publish_ctl.py start-unit publish …`를 부른다(`tess_publication_contract.publish_start_command`). 제어기는 unit 파일 `planetory-tess-publish-<run>.service`를 설치하고 시작만 한 뒤 바로 끝난다.
3. **받기.** unit 안의 `tess_publish_ctl publish`가 marker를 확인한다(`ready_marker`). 이어서 디스크 여유를 보고, part를 `/var/lib/planetory-publish/run=<run>/ready`에 받으며 sha256·bytes·lines를 대조한다(`fetch`·`fetch_part`).
4. **게시.** 고정 이미지(`/etc/planetory/publisher/image`)로 `docker run … publish-run --run-id <run> --ready /ready --approval airflow/tess-publication-run/<run>/approved`를 부른다.
5. **Publisher 안.** `__main__.run_record`가 순서대로 처리한다.
   1. `run_source.read_ready`가 폴더 전체를 먼저 검사한다(5장).
   2. 번들을 줄 단위로 하나씩 payload로 바꾼다.
   3. 별마다 `load.publish_outcome` → `publish_star(first_publish_only=True)`가 한 트랜잭션으로 적재·되읽기 검사·current 전환을 한다.
   4. 끝나면 `notify_record`가 Backend에 판 전환을 알린다.
6. **기록.** Publisher는 run 기록 JSON을 표준 출력으로 낸다. 제어기는 그것을 상태 파일(`publish=<UTC>.json`)에 남기고, 성공하면 로컬 사본을 지운다.
7. **대기와 결과.** `wait_publish`가 Triggerer로 5분마다 `status publish`를 읽는다(`GOLD_STATUS_JSON=` 한 줄, Gold와 같은 형식). 완료되면 요약(결과 코드별 수, 알림 상태, 게시되지 않은 별 최대 50개)을 XCom으로 넘긴다.

## 5. 검사는 누가 어디서 하나

같은 검사를 두 번 하지 않도록 나눴다(80과 합의).

| 검사 | 하는 곳 | 걸리면 |
| --- | --- | --- |
| 79 schema, 후보 표 재해시(`candidates_sha256`), payload 배열·레코드 checksum과 `bundle_version` 재계산, 메타데이터 모양 | 80 `tess_gate` | publish-ready를 만들지 않는다 |
| marker 모양, 디스크 여유, part 파일 전송 무결성 | `tess_publish_ctl` | 65로 멈춘다 |
| marker 형식·`run_id`, `files` 대조(폴더 밖 경로 거절), manifest 한 줄·형식 버전, `counts`, 번들 줄 수 = ready 수 | `run_source.read_ready` | run 전체 거절, 아무 별도 싣지 않는다(65) |
| 번들 줄과 run manifest 항목의 1:1 대응, 배열·레코드 checksum, [Gold 계약 4장](../../contracts/gold/README.md#4-필드와-단위) 값 범위, 첫 게시 판인지 | `run_source._star`·`check_bundle` | 그 별만 `PUBLISH_REJECTED` |
| 같은 판 재요청(`payload_digest`), 이미 current가 있는 별, DB 제약, 적재 뒤 되읽기 checksum | `load.publish_star`·`_verify_staging` | `ALREADY_PUBLISHED`, `IDEMPOTENCY_CONFLICT`, `PUBLISH_REJECTED`(`current_kept`), 트랜잭션 rollback |

## 6. 실패와 재실행

모든 층이 "다시 돌리면 끝난 별은 그대로"를 전제로 짜여 있다.

- **재실행이 안전한 이유.** 판은 `(tic_id, bundle_version)`으로 식별하고, `bundle_version`은 입력과 계산 버전의 해시다. 같은 판을 다시 실으면 적재가 `payload_digest`를 대조해 `ALREADY_PUBLISHED`로 끝내고 아무것도 바꾸지 않는다. 별마다 트랜잭션이 따로라 중간에 끊겨도 끝난 별은 남고 끊긴 별은 rollback된다.
- **종료 코드가 이어지는 방식.**

| 층 | 0 | 1 | 65와 그 밖 |
| --- | --- | --- | --- |
| `publish-run` | 모든 별이 끝남(`current_kept` 별 포함) | 일시 장애(`PUBLISH_ROLLED_BACK`)나 알림 일부 실패 | 65는 데이터 거절만 남음 |
| `tess_publish_ctl publish` | 상태 `complete` | 상태 `failed`, 예외로 종료해 systemd가 5분 뒤 재시작 | 상태 `rejected`, 65(이미지에 `publish-run`이 없을 때의 2, docker 125도 여기) |
| systemd unit | 끝 | `Restart=on-failure` | `RestartPreventExitStatus=65`, 멈춤 |
| Airflow `wait_publish` | 요약 반환 | 대기 계속 | 실패(`terminal`) |

- **튜토리얼 별.** 80이 대상에서 빼지만, 들어와도 이미 current가 있어 `first_publish_only`로 거절된다. 이 거절은 `current_kept=true`로 표시하고 종료 코드에서 실패로 세지 않는다.

## 7. 왜 이렇게 짰나

| 결정 | 이유 | 기록 |
| --- | --- | --- |
| 입력은 JSON Lines 폴더, 줄 단위로 읽는다 | Publisher 이미지는 Parquet를 못 읽고, run이 커서 한 파일로 메모리에 올릴 수 없다. 메모리가 별 하나 크기로 묶인다 | [변경 이력 2026-09-27](../changes/2026-09-W4/2026-09-27.md) 「publish-run 입력을 80 게시 준비 폴더로 바꿈」 |
| 첫 게시만 한다 | 적재는 새 판에서 이전 후보를 모두 은퇴시킨다. 후보 동일성 대조([후보 정정 계약](candidate-correction-contract.md)) 전에 갱신하면 회원 기록이 은퇴 후보에 남는다 | 같은 날 「배치 run 입력 어댑터와 외부 참조 적재」 |
| 새 별은 `hidden` | 배치로 올린 별을 곧바로 회원에게 공개하지 않는다. 공개 절차는 따로 정한다 | 같은 항목 |
| 입력 어댑터는 `payload_digest`를 주지 않는다 | 재시도 판정 규칙은 적재 하나가 가진다(`!223` 리뷰) | [Publisher README](../../distributed-system/publisher/README.md) 「payload 모양」 |
| 게시는 systemd unit으로 돈다 | 별이 많으면 오래 걸리고, Airflow 재시작·재배포와 무관해야 한다. Gold·gate와 같은 틀이라 대기 코드를 같이 쓴다 | 같은 날 「Airflow 게시 단계」 |
| Publisher 이미지는 root 전용 파일로 고정한다 | sudo 아래에서 임의 이미지를 host 네트워크와 DB env 파일로 띄우면 root와 같다 | 같은 항목 |
| sudo 설정은 276 전용 스크립트로 둔다 | sudoers는 release별 파일이고, 이미 적용한 release는 cmp 검사로 바뀌지 않는다. 게시 단계는 새 release로 배포한다 | 같은 항목 |

## 8. 직접 돌려 보기

로컬 검사는 DB·클러스터 없이 돈다. 적재 검사만 일회용 PostgreSQL이 필요하다. 모든 명령은 저장소 루트에서 실행한다.

```powershell
$env:UV_PROJECT = "$PWD/libs/astro-kernel"; $env:PYTHONPATH = "$PWD/libs/astro-kernel"
# 커널(125·79)
Push-Location libs/astro-kernel; uv run --locked pytest -q -p no:cacheprovider; Pop-Location
# Publisher DB 없는 검사. 합성 run을 80 배치 폴더로 써서 읽는다(test_run_source.write_ready)
Push-Location distributed-system/publisher; uv run --locked python -m unittest test_mock_source test_tutorial_source test_run_source; Pop-Location
# Node 1 게시 제어기와 DAG 계약
Push-Location distributed-system/spark; uv run --locked python -m unittest test_tess_publish_ctl; Pop-Location
Push-Location distributed-system/airflow; python -m unittest discover -s tests; Pop-Location
# 적재 검사. 개발·운영 DB가 아닌 일회용 PostgreSQL을 가리킨다(psycopg·numpy가 있는 환경)
docker run --rm -d --name pg-it -e POSTGRES_PASSWORD=<임시> -p 127.0.0.1:55432:5432 postgres:18.6-alpine
$env:PUBLISHER_TEST_DATABASE_URL = "postgresql://postgres:<임시>@127.0.0.1:55432/postgres"
Push-Location distributed-system/publisher; python -m unittest test_load; Pop-Location
```

- 합성 게시 준비 폴더는 `test_run_source.synthetic_run`과 `write_ready`가 만든다. 80과 같은 배치(번들 part 여러 개, 빈 part, `_SUCCESS`)다.
- Windows 경로가 길면 psycopg DLL이 올라오지 않을 수 있다. 그때는 CI처럼 `python:3.12-slim` 컨테이너에서 `test_load`를 돌린다.
- Node 1에서 수동으로 한 번 게시하는 명령과 준비물은 [EC2 서비스 배포](../../infra/service/README.md#node-1-실행) 「Node 1 실행」에 있다.

## 9. 아직 안 된 것

- **Node 1 배포.** 게시 단계가 든 새 release, `/etc/planetory/publisher/image`, 게시 sudoers를 배포해야 한다(운영 승인). 첫 run의 Publisher 이미지는 276 코드가 든 것이어야 한다. develop 병합 뒤 CI가 만든다.
- **실제 run.** 첫 `tess_publication_run` 게시와 266 NASA 정보 `ready` 확인, 제한 Sector 별의 분석 화면 확인이 남았다.
- **갱신 게시.** 후보 동일성 대조, 튜토리얼 제외, 값이 바뀐 이력(`history_proposals`) 적재가 생긴 뒤 연다.
- **정책.** 계약 밖의 QA 기준값(데이터 담당 합의), `hidden` 별을 `published`로 바꾸는 절차를 정해야 한다.
- **규모.** run 전체를 로컬에 받는다. 1~13은 ready가 많아야 5,156개라 충분하다. 더 큰 run은 part 단위 스트리밍으로 바꾼다.
