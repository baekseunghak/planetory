# Ingestion

TESS와 외부 카탈로그 원천을 탐색하고 다운로드한 뒤 검증한다. 입력 버전, 파일 크기와 checksum을 확인한 데이터만 후속 HDFS Raw 적재 대상으로 넘긴다. 실제 원천 데이터, 실행 manifest와 자격 증명은 Git에 넣지 않는다.

감사 완료 파일의 SequenceFile bundle·manifest·원본 복원과 HDFS 원자 확정 절차는 [TESS HDFS Raw 적재](hdfs/README.md)를 따른다.

## TESS SPOC 2분 Light Curve 수집

`S15P21C206-75`의 현재 범위는 Sector 1~13, 총 247,824개다. 2026-09-18에 검증을 완료한 Sector 3·4·5 55,986개는 기존 RunId `20260918T080417Z`에 불변으로 보존하고, 새 RunId는 Sector 1·2·6~13 191,838개만 추가 수집한다. 공식 MAST bulk script에서 실행 시점의 목록을 다시 만들며 목록 전체와 실제 원본은 Git에 커밋하지 않는다. 설정은 [service-v1.json](config/service-v1.json)에 둔다.

```powershell
Set-Location distributed-system/ingestion
python -m ingestion source-list `
  --output C:\planetory-staging\manifests\tess-service-v1.json
```

생성 목록에는 bulk script URL·조회 시각·script SHA-256·Sector별 항목 수와 정렬한 전체 목록의 `source_list_sha256`을 기록한다. 파일명·URL에서 Sector와 TIC를 다시 검증하고, MAST URI의 SHA-256을 5로 나눈 안정적인 값으로 Worker 1~5에 배정한다. Python의 실행별 `hash()`는 사용하지 않는다.

Run의 source list가 이미 있으면 다시 내려받아 덮어쓰지 않고 기존 본문 hash를 재검증해 `SOURCE_LIST_CACHED`로 재사용한다. 신규 목록도 `--expected-source-list-sha256`과 일치한 뒤에만 원자적으로 기록한다. 원천 목록이 바뀌면 기존 Run을 변형하지 않고 새 RunId와 승인된 기대 hash를 사용한다.

다운로드는 Worker별 한 프로세스가 설정의 `download_concurrency`만큼 파일을 동시에 처리한다. 현재 운영값은 4이며 허용 범위는 1~4다. 파일마다 독립된 `.part`를 사용하고 이벤트는 메인 스레드가 source list 순서대로 append하므로 파일·manifest 병렬 쓰기는 발생하지 않는다. 최초 실행은 다음 형태다.

```powershell
python -m ingestion download `
  --source-list C:\planetory-staging\manifests\tess-service-v1.json `
  --output C:\planetory-staging\raw\tess `
  --events C:\planetory-staging\manifests\download-events-worker-1.jsonl `
  --run-manifest C:\planetory-staging\manifests\download-run-worker-1.json `
  --worker-slot 1
```

컨테이너에서는 위 경로를 `/staging/...`으로 바꾼다. Worker 2~6의 `worker-slot`은 각각 1~5다. 한 Worker에서 여러 수집 프로세스를 띄우지 않고 단일 supervisor 안의 제한된 파일 동시성만 사용한다.

### 다운로드·재실행 계약

- 최종 파일이 TIC·Sector·PROCVER·FITS block·checksum 검사를 통과하면 네트워크 요청 없이 `cached=true`로 기록한다.
- 다운로드 중에는 같은 디렉터리의 `.part`만 쓴다. 재시작하면 기존 크기부터 HTTP Range를 요청하고, 서버가 Range를 무시해 200을 반환하면 그 파일만 처음부터 다시 쓴다.
- 응답 크기, FITS 헤더와 선택 checksum을 통과한 뒤에만 `os.replace`로 최종 경로에 올린다.
- 429·일시적 5xx는 `Retry-After` 또는 지수 backoff로 최대 5회 재시도한다. 실패 항목은 `FAILED` 이벤트로 남기고 다음 항목을 진행한다.
- 개별 `.part`는 64MiB를 넘지 못한다. staging 파일시스템의 예상 사용률이 75%에 도달하면 `STOPPED_CAPACITY`를 기록하고 신규 다운로드를 중단한다.
- `input_snapshot_id`는 `lc:spoc:s<4자리 Sector>:sha256:<64 hex>:procver:<PROCVER>`다. 실행 시각과 run ID는 내용 식별자에 넣지 않는다.

`download-events-*.jsonl`은 각 항목의 `VALIDATED`, `FAILED`, `STOPPED_CAPACITY` 상태와 checksum·PROCVER·snapshot ID·전송 바이트를 append한다. `download-run-*.json`은 선택·다운로드·cache·실패 수와 실패 목록을 요약한다. 프로세스 강제 종료 시 완료 이벤트와 `.part`가 남으므로 같은 명령을 다시 실행한다.

### 45개 표본 게이트

저장소의 고정 checksum 45개만 실행할 때는 목록과 checksum의 교집합을 사용한다.

```powershell
python -m ingestion download `
  --source-list C:\planetory-staging\manifests\tess-service-v1.json `
  --output C:\planetory-staging\raw\tess `
  --events C:\planetory-staging\manifests\sample-events.jsonl `
  --run-manifest C:\planetory-staging\manifests\sample-run.json `
  --checksums ..\..\experiments\tess-fixture\service_sample_checksums.json `
  --checksums-only
```

아래 표본 게이트는 최초 Sector 3·4·5 실행 때 적용한 검증 기록이다. 45개 표본의 checksum 대조, 중단 뒤 Range 재개와 재실행 cache hit를 통과한 뒤 Sector 3 전체로 확대했고, Sector 4·5는 Sector 3의 처리량·429·실패율·디스크 증가량을 확인한 뒤 실행했다.

2026-09-18 실제 MAST 게이트 결과는 다음과 같다.

| 검사 | 결과 |
| --- | --- |
| 공식 원천 목록 | 55,986개(Sector 3: 15,993 / 4: 19,997 / 5: 19,996), `source_list_sha256=5781b664ea901bbbeecb4829e34c314e52961d111460b3e5a6ebe58918efc789` |
| 고정 표본 45개 | 89,945,280바이트, 45/45 다운로드·FITS·고정 checksum 감사 성공, 실패 0 |
| 강제 종료·재개 | 1,048,576바이트 `.part`에서 종료한 뒤 Range로 남은 950,144바이트만 전송, 최종 1,998,720바이트 검증 성공 |
| 같은 명령 재실행 | 45/45 cache hit, 다운로드 0, 전송 0, 실패 0 |

첫 강제 종료 시도는 12초 동안 응답 본문을 받기 전 종료되어 0바이트 `.part`만 남았다. 두 번째 시도는 1MiB가 기록된 정확한 프로세스를 종료해 재개 요청을 검증했다.

### 개선 트러블슈팅: 순차 다운로드 병목

비교 기준은 실제 배포된 이전 ReleaseId `20260918T090029Z`와 개선 ReleaseId `20260918T110402Z`다. 데이터 RunId `20260918T080417Z`는 바꾸지 않았으므로 이미 검증된 FITS와 내려받던 `.part`를 그대로 사용했다.

결론적으로 같은 15분 측정 창에서 전체 처리량은 **3.12MiB/s에서 10.54MiB/s로 3.38배 증가**했다. 증가분은 7.42MiB/s, 증가율은 237.8%다. Worker별 처리량도 약 620~655KiB/s에서 2.02~2.16MiB/s로 증가했다.

#### 증상과 원인

순차 처리 중인 2026-09-18 14,936/55,986개 시점의 5개 Worker 합산 속도는 3.12MiB/s, ETA는 6시간 58분이었다. 각 Worker의 속도는 약 620~655KiB/s로 비슷했고 HTTP 429나 디스크 부족은 없었다. 이전 `run_download`는 파일 하나의 다운로드·검증·event 기록이 끝나야 다음 파일을 시작했으므로, CPU를 더 쓰는 계산보다 파일별 네트워크 응답 대기가 처리량을 제한했다. 동시성만 바꾼 A/B 실행에서 처리량이 증가해 이 판단을 확인했다.

이전 코드는 Worker마다 항상 한 파일만 처리했다.

```python
for index, product in enumerate(products, 1):
    event = downloader(product, destination, ...)
    append_event(events_path, event)
```

현재 코드는 표준 라이브러리 `ThreadPoolExecutor`로 파일별 다운로드·검증만 병렬화한다. `map` 결과를 메인 스레드에서 입력 순서대로 소비하므로 event JSONL과 카운터는 동시에 쓰지 않는다.

```python
with ThreadPoolExecutor(max_workers=concurrency) as pool:
    for start in range(0, len(products), concurrency):
        indexed = list(enumerate(products[start:start + concurrency], start + 1))
        for event in pool.map(execute, indexed):
            append_event(events_path, event)
```

#### 주요 코드 개선점

| 구분 | 이전 코드 | 현재 코드 | 효과와 제한 |
| --- | --- | --- | --- |
| 파일 처리 | Worker당 in-flight 1개 | Worker당 `download_concurrency`개 | 현재 5개 Worker × 4개로 최대 20개 파일을 처리한다. |
| 동시성 경계 | 설정 없음 | 설정 로드와 `run_download` 진입에서 1~4만 허용 | 오설정으로 MAST와 서버를 과도하게 압박하지 않는다. `1`로 되돌리면 기존 순차 동작이 된다. |
| 병렬화 범위 | 다운로드와 기록이 한 반복문에 결합 | `execute`만 작업 스레드에서 실행 | 파일별 `.part`·검증은 병렬로 수행하지만 공유 event와 집계 상태는 메인 스레드만 갱신한다. |
| 기록 순서 | 실행 순서와 event 순서가 자연히 동일 | `pool.map`으로 source list 순서를 유지 | 완료 순서가 달라도 `sequence`와 JSONL 순서가 결정적이며 병렬 append 손상을 피한다. |
| 중단 경계 | 실패·용량 감지 직후 다음 파일을 시작하지 않음 | 현재의 최대 4개 batch 결과까지만 회수한 뒤 중단 | 이미 시작한 파일을 버리지 않으면서 다음 batch 확산을 막는다. |
| 실행 요약 | 선택·성공·실패 수만 기록 | `processed`, `concurrency`도 기록 | 중단 시 실제 처리 범위와 적용 동시성을 사후 감사할 수 있다. |
| 호출 경로 | supervisor는 순차 기본값 사용, 직접 CLI는 연속 실패 설정을 전달하지 않음 | supervisor와 직접 CLI 모두 같은 config 값을 전달 | 수동 실행과 24시간 supervisor 실행의 동작 차이를 없앤다. |

Python 프로세스를 여러 개 띄우거나 다른 언어로 downloader를 다시 작성하지 않았다. 이 병목은 네트워크 대기였고 표준 라이브러리 스레드만으로 실측 처리량이 개선됐다. 단일 프로세스를 유지하면 Worker별 lock, `.part` 재개, event 복구와 supervisor의 기존 책임도 그대로 재사용할 수 있다.

#### 운영 적용 중 해결한 문제

기존 supervisor가 `ADOPTING`한 downloader는 unit의 자식 프로세스가 아니므로 `systemctl stop`만으로는 종료되지 않을 수 있었다. `Pause`는 다음 순서로 이 문제를 해결한다.

1. 해당 RunId와 Worker의 systemd unit을 먼저 멈춰 재시작 경쟁을 차단한다.
2. command line의 source list·output·worker slot·Sector가 모두 일치하는 downloader를 하나만 찾는다.
3. 일치한 프로세스에 TERM을 보내고 최대 30초 기다린다. 남아 있을 때만 KILL을 사용한다.
4. 일치하는 downloader가 0개인지 확인한 뒤 FITS·`.part` 개수와 바이트를 출력한다.

실제 전환에서는 KILL 없이 5개 Worker를 멈췄고 FITS 15,594개와 0바이트 `.part` 3개를 보존했다. 새 ReleaseId를 설치한 뒤 같은 데이터 RunId를 재개했으므로 완료 파일은 cache hit, 미완료 파일은 기존 Range 규칙을 사용한다.

동시성은 바로 최댓값으로 올리지 않고 다음 게이트를 거쳤다.

| 단계 | 관찰 결과 | 판정 |
| --- | --- | --- |
| 순차 기준선 | 최근 15분 합산 3.12MiB/s, ETA 6시간 58분 | 병목 재현 |
| 전체 동시성 2 | 최근 2분 합산 5.58MiB/s, 기준 대비 1.79배 | 확대 가능 |
| worker-2 동시성 4 canary | 최근 1분 2.29MiB/s, 348개 event에서 429·재시도·실패 0 | 전체 적용 가능 |
| 전체 동시성 4 | 최근 1분 합산 10.88MiB/s, 기준 대비 3.49배 | 현재 운영값 채택 |
| 전체 동시성 4 지속 측정 | 최근 15분 합산 10.54MiB/s, 같은 창의 순차 기준 대비 3.38배·237.8% 증가 | 개선 지속 확인 |

전체 적용 측정 시점은 18,014/55,986개(32.18%), 검증 완료 33.34GiB, ETA 약 1시간 50분이었다. 적용 뒤 확인한 2,781개 `VALIDATED` event에서 HTTP·기타 재시도와 깨진 JSONL은 0이었고, 5개 unit은 모두 `active/running`, `NRestarts=0`, `/mnt/data` 사용률 1%였다. 이는 실행 중 단기 관측치이며 최대 처리량이나 최종 성공을 뜻하지 않는다. 세 Sector 전수 감사 전까지 동시성 4를 상한으로 유지한다.

같은 15분 창으로 다시 측정한 시점에는 24,657/55,986개(44.04%), 검증 완료 45.08GiB, `.part` 0바이트, ETA 약 1시간 32분이었다. ETA에는 성능 개선뿐 아니라 이미 완료된 파일 증가도 반영되므로 속도 개선율은 동일한 15분 창의 처리량인 3.12MiB/s와 10.54MiB/s를 기준으로 계산한다.

최종 RunId `20260918T080417Z`는 2026-09-18 13:21 UTC에 Worker 5대의 Sector 3·4·5 전수 감사를 모두 통과했다. 고정 source list 55,986개와 실제 FITS 55,986개가 일치하고 검증 원본은 100.94GiB, manifest를 포함한 run 디렉터리는 101.13GiB다. `.part`, 최신 실패, HTTP·기타 재시도와 손상된 완결 JSONL은 모두 0이며 각 `/mnt/data` 사용률은 2%다. 최종 release `20260918T124821Z`의 내용 SHA-256은 `14b52924c9a60625dd78f5e10cbf9743399343fd035954de9e2a7c1077f900ee`다.

### Sector 1~13 확장 계약

2026-09-19 공식 MAST bulk script 13개를 다시 생성해 총 247,824개와 `source_list_sha256=8c6c2370682e24351fce1223d6f463da2bd57ae2e1780033d940dd695cfe2c38`을 확인했다. 파일명은 Sector 사이에서도 중복되지 않으며 설정의 Sector별 기대 개수 합과 일치한다.

| 범위 | Run | 파일 수 | Raw 크기 |
| --- | --- | ---: | ---: |
| 기존 Sector 3·4·5 | `20260918T080417Z` | 55,986 | 실측 100.94GiB |
| 추가 Sector 1·2·6~13 | `20260919T005932Z` | 191,838 | 기존 실측 평균 기준 약 346GiB |
| 최종 Sector 1~13 | 두 Run의 coverage | 247,824 | 약 447GiB |

기존 Run의 source list에 Sector를 추가하거나 파일을 새 Run으로 복사하지 않는다. 신규 source list는 Sector 1~13 전체를 고정하지만 supervisor 실행 대상은 `1 → 2 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13`으로 제한한다. 각 신규 Sector는 Worker별 전수 감사와 complete marker가 성공해야 다음 Sector로 진행한다.

모든 신규 supervisor가 `COMPLETE`가 된 뒤 `FinalCoverage`를 실행한다. 이 단계는 기존 Run의 Sector 3~5와 신규 Run의 나머지 Sector에 대해 다음을 다시 대조한다.

- source list 본문 SHA-256과 Sector별 Worker 배정
- Sector별 audit·complete manifest의 스키마, source SHA, 기대·검증 개수와 바이트
- 실제 FITS 파일명 집합, 파일 크기 합, 예상 밖 FITS와 잔여 `.part` 0건
- Worker 5개 합산 Sector별 기대 개수와 최종 247,824개

Sector complete marker는 바로 앞의 전수 FITS identity·SHA-256 감사를 통과해야만 생성된다. `FinalCoverage`는 447GiB를 다시 해시하지 않고 이 감사 증거와 현재 파일 집합·크기를 연결한다. 최종 manifest와 SHA-256 sidecar는 신규 Run의 `manifests/coverage-sectors-1-13.json[.sha256]`에 5대 모두 같은 내용으로 기록한다. HDFS 경로·적재 결과는 이 manifest에 넣지 않고 `S15P21C206-76`에서 별도로 관리한다.

2026-09-19 expansion 실행은 데이터 RunId `20260919T005932Z`를 유지한다. 최초 ReleaseId `20260919T005933Z`의 canary·실패 주입과 Worker 5대 기동 뒤, 코드 리뷰에서 확인한 손상 FITS 예외·RunId별 잠금·완료 unit 재부팅 경합을 보완한 ReleaseId `20260919T015748Z`, release 내용 SHA-256 `3d22c384455e6d2dd2c2049ea92ffe88b7725d63444bc571eb3770e13f54d298`을 적용했다. worker-2 canary에서 기존 2,964개를 그대로 인식했고 main PID를 `SIGKILL`한 뒤 `134505→134706`, `NRestarts=0→1`로 같은 Run을 재개해 2,984개까지 증가했다. 이후 Worker 3~6을 한 대씩 재시작했다. 5대 모두 새 release의 `enabled/active/running`, Worker 전역 잠금 PID 일치, 이전 완료 unit disabled를 확인했다. 롤링 직후 15분 창은 합계 17,273/191,838개(9.00%), 검증 원본 32.76GiB, 9.63MiB/s이며 현재 실패·429·전체 HTTP 재시도·기타 재시도는 모두 0이다. `.part` 2.91MiB는 전송 중인 파일이며 현재 속도 기준 추가 범위 ETA는 약 9시간 46분이다.

다운로드·Sector별 전수 감사·complete marker 생성은 각 서버의 systemd supervisor가 수행하므로 Codex 세션, 운영자 PC 또는 Tailscale 연결이 끊겨도 계속된다. 5개 supervisor가 `COMPLETE`가 된 뒤의 두 Run 통합 `FinalCoverage`만 전체 Worker에 다시 연결하는 제어 단계다. 연결이 끊기면 수집을 중단하거나 다시 받지 않고, 연결 복구 뒤 같은 읽기 전용 증거 결합 단계를 재실행한다. `FinalCoverage`가 통과하기 전에는 Sector 1~13 최종 완료로 기록하지 않는다.

#### 기존 Progress 명령 재사용 확인

기존 명령은 현재 스크립트에서도 인자를 바꾸지 않고 재사용한다.

```powershell
$Run = '.\infra\distributed-system\scripts\run-tess-ingestion.ps1'
& $Run `
  -Step Progress `
  -RunId 20260918T080417Z `
  -ExpectedSourceListSha256 5781b664ea901bbbeecb4829e34c314e52961d111460b3e5a6ebe58918efc789 `
  -RateWindowMinutes 15
```

기본 `Sectors`는 신규 expansion 대상 `1,2,6~13`이지만, `-Sectors`를 생략하고 기존 RunId `20260918T080417Z`를 조회하면 스크립트가 `3,4,5`를 선택한다. 따라서 과거 명령에 `Sectors`, `NodeNumbers`, `ReleaseId`를 추가할 필요가 없다. 그 외 Run의 범위를 바꿀 때만 `-Sectors`를 명시한다. 각 Worker에서 source list checksum을 확인하고 파일별 최신 `VALIDATED` event를 집계한다. 속도는 지정한 창 안에서 cache hit를 제외한 실제 `bytes_transferred`만 사용하며, FITS·event·프로세스를 변경하지 않는 읽기 전용 단계다.

2026-09-18 완료 뒤 같은 명령을 재사용한 출력은 다음과 같다.

```text
TOTAL run=20260918T080417Z sectors=3,4,5 files=55986/55986 percent=100.00% verified=100.94 GiB partial=0.00 KiB rate=1.92 MiB/s window=15m eta=0h 00m
PASS: Progress
```

#### 재발 시 확인 순서

1. `Progress`에서 Worker별 속도, 전체 ETA, `.part` 바이트를 확인한다.
2. event에서 429·5xx·재시도·`FAILED` 증가 여부를 확인한다. 증가하면 속도보다 원천 보호를 우선해 동시성을 낮춘다.
3. `SupervisorStatus`에서 `RUNNING`, `BACKOFF`, `PAUSED_CAPACITY`를 구분하고 `/mnt/data` 사용률을 함께 확인한다.
4. 코드 교체가 필요하면 `Pause`로 현재 실행만 안전하게 멈춘다. 데이터 RunId를 유지하고 새 ReleaseId로 설치·재개한다.
5. 회귀가 발생하면 `download_concurrency`를 `1`로 둔 release를 설치한다. FITS·`.part`·event는 삭제하지 않는다.

로컬 회귀 검사는 동시 다운로드의 실제 overlap, event 순서, 허용 범위 밖 동시성 거부와 회로 차단 시 현재 batch까지만 처리하는 경계를 포함한다.

### 5개 Worker 실행

저장소 루트에서 [run-tess-ingestion.ps1](../../infra/distributed-system/scripts/run-tess-ingestion.ps1)을 사용한다. 데이터 `RunId`와 코드 `ReleaseId`를 분리하므로 실행 중 새 감독 코드를 배치해도 이미 받은 파일과 `.part`를 그대로 이어 쓸 수 있다. release의 `READY`는 tar/gzip 시각과 무관한 파일 경로+내용 SHA-256이며, 같은 ID에 다른 내용이 있으면 덮어쓰지 않고 중단한다.

```powershell
$Common = @{
  RunId = 'data-yyyyMMddTHHmmssZ에서 data- 접두사를 뺀 UTC 값'
  ReleaseId = 'code-yyyyMMddTHHmmssZ에서 code- 접두사를 뺀 UTC 값'
  ExpectedSourceListSha256 = '8c6c2370682e24351fce1223d6f463da2bd57ae2e1780033d940dd695cfe2c38'
}
$Run = '.\infra\distributed-system\scripts\run-tess-ingestion.ps1'

& $Run -Step Preflight @Common
& $Run -Step Install @Common
& $Run -Step SourceList @Common       # 새 데이터 RunId에서 한 번
& $Run -Step Start @Common -Sector 1 -Limit 1 -NodeNumbers 2   # 최초 canary
& $Run -Step Audit @Common -Sector 1 -Limit 1 -NodeNumbers 2
& $Run -Step InstallSupervisor @Common
& $Run -Step SupervisorStatus @Common
& $Run -Step Progress @Common -RateWindowMinutes 15

# 5개 supervisor가 모두 COMPLETE인 뒤 실행한다.
& $Run -Step FinalCoverage @Common

# 운영자 점검을 위한 안전 중지. Sector는 supervisor 상태에서 자동 판별한다.
& $Run -Step Pause @Common

# 실제 hang 복구 검사는 canary Worker 하나에만 실행한다.
& $Run -Step TestSupervisorWatchdog @Common -NodeNumbers 2
```

`Preflight`는 읽기 전용이고 변경 단계는 `-WhatIf`를 지원한다. 각 Worker의 `/mnt/data` 사용률 75% 미만, 가용 공간 100GiB 이상, 활성 수집 unit·수동 downloader 0개를 확인해 다른 Run과 중복 실행하지 않는다. `MinimumFreeGiB`는 80~1,000 범위에서 명시할 수 있으나 이번 expansion은 기본 100GiB를 사용한다. `InstallSupervisor`는 Worker별 systemd unit을 enable/start한다. unit은 `/mnt/data`와 network-online 뒤 기동하고, 비정상 종료 시 30초 뒤 재시작하며 서버가 다시 부팅되어도 같은 데이터 RunId를 재개한다. 잠금은 Run 디렉터리가 아니라 Worker 공통 `/mnt/data/staging/S15P21C206-75/locks/supervisor-worker-<slot>.lock`에 둔다. 따라서 서로 다른 RunId도 같은 Worker에서 동시에 실행할 수 없고, 잠금 충돌은 종료 코드 75로 systemd 재시작 대상이 된다. 설치기는 이전 unit의 상태 manifest가 `COMPLETE`이고 unit이 inactive일 때만 해당 unit을 disable하며, 그 외에는 새 unit 설치 전에 실패한다. 기존 PID 인계와 이 Worker 전역 잠금으로 중복 프로세스를 막고, Sector 1→2→6→7→8→9→10→11→12→13을 각 Worker에서 순서대로 전수 감사한 뒤 진행한다.

`Pause`는 supervisor 상태에서 현재 Sector를 자동 판별한다. 운영자가 `-Sector`를 명시했는데 활성 Sector와 다르면 프로세스를 멈추기 전에 거부한다. 이미 `COMPLETE`면 `PAUSE_NOT_REQUIRED`로 종료해 완료 상태를 덮어쓰지 않는다. 정확한 unit을 먼저 정지한 뒤 현재 RunId·worker slot·Sector가 모두 일치하는 기존 downloader만 TERM으로 종료하고 최대 30초를 기다린다. 완료 FITS, `.part`, event와 HDFS 원본은 삭제하지 않으며 FITS·part·event 수, 강제 종료 여부를 `pause-worker-<slot>.json`에 원자적으로 기록하고 상태를 `PAUSED_OPERATOR`로 남긴다.

### 장시간 복구 계약

- 셸·Codex·Tailscale 세션이 끊겨도 systemd 서비스와 다운로드는 서버에서 계속된다.
- 프로세스나 서버가 중단되면 최종 검증 파일은 cache hit, 미완료 파일은 `.part` 크기부터 Range 재개한다.
- unit은 `Type=notify`, `WatchdogSec=5min`으로 실행한다. 다운로드 시도·수신 chunk·재시도 대기·Sector 감사·supervisor backoff에서 진행 heartbeat를 보내며 5분 동안 신호가 없으면 systemd가 프로세스 전체를 종료하고 30초 뒤 같은 RunId로 재기동한다.
- 429·일시적 5xx는 파일 안에서 최대 5회 재시도한다. 연속 10개 파일이 실패하면 회로를 열고 30초부터 최대 15분까지 backoff한 뒤 같은 Sector를 재실행한다.
- `Retry-After`가 잘못된 값이면 응답을 닫고 지수 backoff로 폴백한다. source list의 항목 수·내용 SHA-256과 정식 MAST endpoint·product URI가 다르면 다운로드와 진행률 집계를 거부한다.
- 예상 디스크 사용률 75%에서 현재 파일 상태를 보존하고 멈춘다. 사용률이 70% 아래로 내려올 때까지 60초 간격으로 대기한 뒤 재개한다.
- 이벤트는 append+fsync한다. 강제 종료로 마지막 JSON 줄만 찢어졌으면 다음 시작 때 그 줄만 잘라내며, 중간 줄 손상은 숨기지 않고 감사 실패로 남긴다.
- 최종 파일 손상은 cache 검증에서 거부하고 다시 받는다. 비 ASCII primary header와 잘못된 숫자도 동일한 무결성 오류로 처리해 손상 final을 교체하고 손상 `.part`는 해당 파일만 제거한다. FITS 문자열 안의 `/`는 주석 구분자로 오인하지 않는다. 64MiB를 넘은 비정상 `.part`도 그 파일만 제거하고 처음부터 다시 받는다.
- 각 Sector는 전체 FITS·event checksum·내용 기반 snapshot ID·`.part` 부재 감사에 통과해야 완료 marker가 생긴다.
- 신규 Run이 모두 끝나도 기존 3~5와 합친 `FinalCoverage`가 247,824개, Sector별 기대 개수, 실제 파일명·바이트와 `.part` 0건을 확인하기 전에는 Sector 1~13 수집 완료로 판정하지 않는다.

운영 상태는 `SupervisorStatus`로 확인한다. `ADOPTING`, `RUNNING`, `BACKOFF`, `PAUSED_CAPACITY`, `PAUSED_OPERATOR`, `COMPLETE`를 구분하며 상태 JSON과 Sector별 run/audit/complete manifest는 데이터 RunId 아래에 남는다.

전체 진행률은 읽기 전용 `Progress`로 확인한다. 고정 source list의 전체 항목 대비 최신 `VALIDATED` 이벤트 수를 완료량·퍼센트로 집계하고, 검증 완료 바이트와 미완료 `.part` 바이트를 구분한다. 최신 파일별 event에서 현재 실패 수·실패율, HTTP 429·전체 HTTP 재시도와 기타 재시도도 함께 합산한다. 속도는 `RateWindowMinutes` 동안 cache hit를 제외한 실제 `bytes_transferred`의 평균이며, ETA는 완료 파일 평균 크기와 이 속도로 계산한 추정값이다. 최근 전송이 없거나 완료 표본이 없으면 `eta=unknown`으로 표시한다. 동시 append 중인 마지막 미완성 줄만 제외하고, 그보다 앞선 완결 줄의 JSON 손상은 `INVALID_EVENT_JSON`으로 실패시켜 잘못된 진행률을 숨기지 않는다. 이 단계는 source list·supervisor 상태·event JSONL과 `.part` 크기만 읽으며 FITS 본문·checksum을 다시 읽거나 프로세스에 신호를 보내지 않는다.

2026-09-18 최초 실환경 `Progress` 조회는 source list의 Worker 배정 필드를 `worker_slot`으로 잘못 읽어 `KeyError: 'worker_slot'`로 중단됐다. 실제 계약 필드 `assigned_worker`로 수정했고, 이후 오프라인 검사는 실제 source list 형식의 집계 Python을 직접 실행해 Worker 선택·완료 바이트·`.part` 크기를 확인한다. 이 실패는 조회 스크립트에서만 발생했으며 실행 중인 수집 프로세스와 데이터는 변경하지 않았다.

### 실패 검증 범위

| 실패 | 검증 방식 | 결과 |
| --- | --- | --- |
| 실제 MAST 전송 중 프로세스 종료 | 1MiB `.part`에서 강제 종료 후 재실행 | Range로 나머지만 전송 |
| 감독 프로세스 SIGKILL | worker-2 systemd main PID만 종료 | 30초 뒤 새 PID, `NRestarts=1`, 기존 다운로드 계속 |
| 살아 있으나 진행 없는 프로세스 | worker-2 main PID에 `SIGSTOP` | 5분 watchdog timeout, `SIGABRT`, 30초 뒤 `74730→75912`, `NRestarts=0→1`, 같은 RunId 재개 |
| 기존 nohup 실행과 감독기 동시 배치 | 5개 Worker 실제 PID 인계 | 모두 `ADOPTING`, 중복 다운로드 없음 |
| 운영자 안전 중지 | `Pause`로 supervisor 우선 정지 후 정확한 downloader만 TERM | 강제 종료 없이 정지, 완료 FITS와 `.part` 보존, 같은 RunId 재개 |
| 제한 병렬 처리 | 동시성 2 전체 비교 후 worker-2 동시성 4 canary, 이후 전체 적용 | event 순서 유지, 429·재시도·실패 0, 최근 1분 10.88MiB/s |
| 429·503·연결 중단·Range 무시 | 로컬 HTTP 실패 주입 | `Retry-After`/backoff·재개·현재 파일 재시작 통과 |
| HTTP 오류 응답·잘못된 `Retry-After` | 로컬 응답 객체·헤더 실패 주입 | 응답 close, 지수 backoff 폴백 통과 |
| 연속 네트워크 실패 | 10개 연속 실패 주입 | 회로차단 exit 3과 supervisor backoff 기록 |
| 용량 상·하한 | disk usage 주입 | 75% 중단, 70% 미만 재개 통과 |
| 손상 final·대형 part·찢어진 event tail | 파일 실패 주입 | 해당 파일 교체·part 초기화·마지막 줄 복구 통과 |
| 비 ASCII FITS final·part, 문자열 내 `/` | 로컬 FITS header 실패 주입 | 무결성 오류 정규화, 손상 part 제거·final 재다운로드, `PROCVER` 보존 통과 |
| event 중간 완결 줄 손상 | `Progress` fixture에 잘못된 JSON 줄 주입 | `INVALID_EVENT_JSON`으로 조회 실패, 손상 은폐 없음 |
| source list 본문 변조·비정식 endpoint | hash·URL 실패 주입 | 진행률 집계와 제품 로딩 전 거부 |
| 다른 RunId의 중복 감독 실행 | Worker 공통 lock과 CLI 충돌 실패 주입 | 두 번째 실행 종료 코드 75, systemd 재시작 대상 유지 |
| 완료 unit 재부팅 경합 | 이전 state `COMPLETE`·inactive 검사 뒤 롤링 설치 | Worker 2~6 이전 unit disabled, 새 unit lock PID 일치 |
| 두 Run coverage 누락·잔여 part | 기존·신규 Run의 audit/complete와 실제 파일 fixture 결합 | 중복 Sector 거부, 잔여 `.part`가 있으면 최종 coverage 실패 |
| 서버 재부팅 | unit `enabled`, network/mount dependency 검사 | 부팅 재개 계약 확인; 공유 HDFS/YARN 영향 때문에 실제 VM 재부팅은 미실행 |

## 검증

원격 변경 없이 다음 검사를 실행한다.

```powershell
Set-Location distributed-system/ingestion
python -m unittest discover -s tests -v
python -m compileall -q ingestion tests
```

현재 39개 Python 검사가 원자적 저장, 제한된 병렬 처리와 복구 루프, Sector 1~13 설정 합계와 두 Run coverage 결합을 검사한다. 70~75% 구간에서는 계속 실행하고 75% 중단을 실제로 경험한 뒤에만 70% 미만까지 기다리는 hysteresis, 짧은 저수준 event write의 완전 기록, 병렬 실행 중 event 순서, HTTP 오류 응답 정리와 잘못된 backoff 헤더, source endpoint, 감사 전 event tail 복구, watchdog heartbeat와 회로차단 시 현재 batch까지만 처리하는 경계도 회귀 검사한다. 비 ASCII·잘못된 숫자 FITS header, 손상 final·part, 따옴표 안 `/`, 서로 다른 RunId의 Worker 잠금 공유와 잠금 충돌 비정상 종료도 회귀 검사한다. 클러스터 스크립트의 오프라인 계약은 Sector 1·13 경계와 expansion 전체 인자를 포함해 `pwsh -File infra/distributed-system/scripts/test-tess-ingestion.ps1`로 검사한다. 실제 VM 전체 재부팅과 디스크를 75%까지 채우는 검사는 공유 HDFS/YARN과 비용에 영향을 주므로 수행하지 않는다.

### 원천 checksum 조사

공식 MAST bulk download는 Sector별 curl script를 제공하지만 파일별 digest manifest는 제공하지 않는다. TESS Science Data Products 문서는 FITS HDU에 `CHECKSUM`과 `DATASUM`이 포함됨을 명시하고, FITS checksum 규약은 전체 HDU의 32비트 1의 보수 합으로 전송·저장 중 손상을 검사한다. 현재 stdlib downloader는 파일 SHA-256, FITS block, TIC·Sector·PROCVER와 event 일치까지 검사하지만 HDU별 `CHECKSUM`·`DATASUM` 알고리즘은 아직 실행하지 않는다.

2026-09-18 MAST 응답 표본 5개에서 HTTP `ETag` 32자리 값과 내려받은 파일의 MD5가 5/5 일치했다. 그러나 MAST 공식 문서에서 TESS 응답 `ETag`를 MD5 계약으로 보장한 근거는 확인하지 못했으므로 전체 파일의 독립 checksum으로 채택하지 않는다. 모든 파일에 독립 원천 checksum을 확정하려면 표준 FITS checksum 검증기를 도입하거나 MAST의 공식 digest 계약을 추가 확인해야 한다. [TESS bulk download](https://archive.stsci.edu/tess/bulk_downloads.html), [TESS Science Data Products](https://archive.stsci.edu/files/live/sites/mast/files/home/missions-and-data/active-missions/tess/_documents/EXP-TESS-ARC-ICD-TM-0014-Rev-F.pdf), [FITS checksum 규약](https://fits.gsfc.nasa.gov/registry/checksum/checksum.pdf)

## 외부 원천

TIC·TCE·TOI·Archive·ExoFOP는 FITS 목록과 섞지 않고 원천별 raw snapshot으로 저장한다. 각 snapshot도 `retrieved_at`, `source_uri`, query/version, content SHA-256과 원자적 최종화를 사용한다. 원천별 URL·인증·사용 조건을 확인하기 전에는 빈 응답을 새 성공 snapshot으로 확정하지 않는다.
