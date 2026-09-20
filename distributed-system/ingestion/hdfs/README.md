# TESS HDFS Raw 적재

`S15P21C206-76`의 실행 정본이다. `S15P21C206-75`의 최종 coverage가 보증한 Sector 1~13 원본을 Worker 5대에서 동시에 512MiB~1GiB SequenceFile로 묶고, Sector별 감사와 전체 coverage가 모두 검증된 경우에만 HDFS Raw 경로로 원자 확정한다.

## 저장 계약

- Worker 2~6은 각각 writer 하나만 실행한다. 서로 다른 `bundle-w<slot>-<number>.seq`를 쓰므로 전체 동시 writer는 5개다.
- 값은 FITS 원본 바이트이며 key는 원파일명이다. Java writer가 쓰기 직전에 크기와 SHA-256을 다시 검사한다.
- manifest는 원파일명, TIC, Sector, 크기, SHA-256, 최종 bundle 위치, SequenceFile key, 시작·끝 offset, `input_snapshot_id`, source list SHA-256과 Worker slot을 기록한다.
- 신규 plan은 각 bundle의 첫·중간·마지막 레코드를 offset으로 다시 추출해 SHA-256을 비교한 뒤에만 완료 marker를 만든다. 이미 확정된 Sector 3~5의 v1 marker는 기존 첫 레코드 증거를 보존하되 재감사한다.
- 각 파일의 HDFS replication을 2로 맞추고 `hdfs dfs -checksum`, 전체 staging `fsck HEALTHY`를 확인한다.
- Worker별 JSONL을 고정 Spark 3.5.5 image로 `manifest.parquet`로 변환한다. 최종 경로는 `/lake/raw/tess/release=<release>/sector=<sector>/`다.
- 진행 중 결과는 `/lake/raw/tess/.staging/run=<run>/...`에만 있다. 다섯 Worker의 bundle·manifest·marker 감사가 모두 성공한 뒤 Java `FileContext.rename(..., Rename.NONE)`으로 Sector 디렉터리 하나를 원자 확정한다. 최종 경로가 이미 있으면 덮어쓰거나 하위에 중첩하지 않고 실패한다.
- Sector plan v2는 원천 `run_id`, `release_id`, Sector 전체 `product_count`, source list SHA-256과 RF2를 고정한다. cache hit도 이 필드를 모두 정확히 비교한다.
- Sector 1~13이 모두 확정되면 75의 coverage SHA-256을 키로 `/lake/raw/tess/coverage=<coverage-sha256>/_READY.json`을 원자 확정한다. 이 marker는 각 Sector `_READY.json`의 SHA-256과 경로, 원천 run·release·개수·바이트를 묶으며 누락·중복 Sector를 허용하지 않는다.
- SequenceFile compression은 `NONE`을 유지한다. FITS 원본 바이트의 단순 복원·감사 계약을 우선한 결정이며, 압축 변경은 동일 데이터셋의 저장량·CPU·복원 시간 benchmark가 생긴 뒤 별도 검토한다.

PoC HDFS는 Kerberos가 없는 simple mode다. staging bundle은 OS/HDFS 사용자 `planetory-admin`이 쓰고, `hdfs` 슈퍼유저는 정확한 staging 경로 준비·전체 감사·최종 rename만 수행한다. 이 권한 경계는 인터넷 또는 다중 테넌트 보안 경계로 간주하지 않는다.

HDFS 사전 점검은 safe mode OFF, Live DataNode 5개, 기본 RF2, 현재 사용률 75% 미만을 확인한다. Sector마다 적재 직전에 다시 검사하고, 입력 바이트의 RF2 예상 사용량을 반영한 예상 사용률이 70% 이하여야 한다. `dfs.datanode.du.reserved`는 DataNode당 100GiB(`107374182400`)여야 하며 Worker 원본 디스크도 기본 100GiB 이상 가용해야 한다. 저장소 설정을 기존 클러스터에 반영하고 DataNode를 재시작하는 작업은 별도 통제된 운영 절차이며, 적용 전에는 Preflight가 적재를 막는다.

기존 클러스터의 예약값이 0이면 적재 전에 다음 단계를 한 번 실행한다. 현재 `/etc/hadoop/hdfs-site.xml`에서 예약값 외 속성이 저장소 정본과 다르면 변경 전에 중단한다. 정합하면 Node 1~6에 같은 설정을 배치하고 Worker 2~6 DataNode를 한 대씩 재시작하며 매번 Live DataNode 5대 복귀를 확인한다. 재실행해도 같은 설정을 검증한 뒤 같은 롤링 순서를 반복한다.

```powershell
& $Load -Step ConfigureCapacity -RunId $Run -ExpectedSourceListSha256 $SourceSha `
  -ReleaseId $Run -CodeReleaseId $CodeRelease
```

## 실행 순서

먼저 같은 RunId의 해당 Sector에 대해 Worker 5개 `download-audit`가 `expected=validated`, `errors=[]`이고 `.part`가 0인지 확인한다. 그 다음 저장소 루트 PowerShell에서 실행한다.

```powershell
$Load = '.\infra\distributed-system\scripts\run-tess-hdfs-load.ps1'
$Run = '20260919T005932Z'
$SourceSha = '8c6c2370682e24351fce1223d6f463da2bd57ae2e1780033d940dd695cfe2c38'
$CoverageSha = 'df6bfa638a0d70913b0d0bade11f0c5335bf9c505a9fbe256fa8552f0623bd94'
$CodeRelease = '<이번 코드 release id>'

& $Load -Step ServerRunAll -RunId $Run -ExpectedSourceListSha256 $SourceSha `
  -ReleaseId $Run -CodeReleaseId $CodeRelease -ExpectedCoverageSha256 $CoverageSha
```

`ServerRunAll`은 검증된 FinalCoverage와 loader를 배치한 뒤 Node 1의 enabled systemd unit으로 전체 실행을 넘긴다. 이 시점부터 운영자 PC와 Tailscale 세션이 종료돼도 Node 1이 실패 시 30초 뒤 재시작하며 같은 staging에서 재개한다. Node 1의 Worker 기동·상태 확인은 고정 내부 IP `10.20.2.10`~`10.20.6.10`의 SSH만 사용하고 소스 주소도 `10.20.1.10`으로 고정한다. 전용 키는 Node 1의 `/etc/planetory/tess-hdfs-runall/`에만 두며 Worker는 해당 내부 IP에서 온 키만 허용한다. bundle 데이터와 감사 명령은 기존 `hdfs://planetory` 사설망 경로를 사용한다. Tailscale은 최초 배치와 운영자 상태 조회에만 사용한다.

서버 조정기는 기존 Run의 Sector 3~5와 확장 Run의 Sector 1·2·6~13을 합친 정확한 1~13 입력 지도를 만들고 Sector마다 HDFS Preflight를 다시 수행한다. final이 있으면 전수 재감사하고, 미완료 Sector는 `plan → Worker 5대 병렬 upload → uploader 완료 대기 → Commit`으로 처리한다. Worker unit은 실패 시 재시작하고 Node 1 조정기가 재기동되면 active unit은 그대로 감시하며 inactive 미완료 unit만 멱등 재실행한다. `Commit`은 checksum·manifest·RF2·FSCK 전수 감사 뒤에만 manifest와 `_READY.json`을 만들고 원자 rename한다. 첫 실패에서는 다음 Sector를 시작하지 않고 staging을 보존하며, 13개가 모두 확정된 뒤에만 전체 HDFS coverage marker를 만든다. 기존 로컬 `RunAll`은 단계별 장애 진단용 수동 fallback으로 유지한다.

운영자는 다음 읽기 전용 명령으로 Node 1 조정기 상태를 본다. 이 조회가 끊겨도 서버 unit에는 영향이 없다.

```powershell
tailscale ssh SSAFY@node-1 "sudo systemctl status planetory-tess-hdfs-runall-$Run --no-pager"
tailscale ssh SSAFY@node-1 "sudo journalctl -u planetory-tess-hdfs-runall-$Run -n 80 --no-pager"
```

FinalCoverage가 없는 과거 Sector 3~5 재검증은 `ExpectedCoverageSha256`을 생략한 기존 명령을 사용할 수 있다. 이 호환 경로는 새 Sector를 추가하거나 전체 1~13 완료를 주장하는 용도가 아니다.

단계별 진단이나 실패 지점 재실행은 다음 명령을 사용한다.

```powershell
$Load = '.\infra\distributed-system\scripts\run-tess-hdfs-load.ps1'
$Run = '20260918T080417Z'
$SourceSha = '5781b664ea901bbbeecb4829e34c314e52961d111460b3e5a6ebe58918efc789'

& $Load -Step Preflight -RunId $Run -ExpectedSourceListSha256 $SourceSha -Sector 3
& $Load -Step Install   -RunId $Run -ExpectedSourceListSha256 $SourceSha -Sector 3
& $Load -Step Build     -RunId $Run -ExpectedSourceListSha256 $SourceSha -Sector 3
& $Load -Step Upload    -RunId $Run -ExpectedSourceListSha256 $SourceSha -Sector 3
& $Load -Step Status    -RunId $Run -ExpectedSourceListSha256 $SourceSha -Sector 3
& $Load -Step Audit     -RunId $Run -ExpectedSourceListSha256 $SourceSha -Sector 3
& $Load -Step Commit    -RunId $Run -ExpectedSourceListSha256 $SourceSha -Sector 3
```

`Upload`은 다섯 systemd oneshot unit을 차례로 시작할 뿐이며 실제 bundle 생성·HDFS 쓰기는 Worker 5대에서 동시에 진행된다. `Status`는 systemd와 HDFS staging을 읽기만 한다. Sector 3을 Upload하는 동안 기존 수집 supervisor가 Sector 4를 다운로드할 수 있다.

업로드 unit은 현재 부팅에서 실패 시 재시작하지만 enable하지 않는다. Worker가 재부팅되면 HDFS·DataNode 정상 상태를 확인한 뒤 같은 `Upload`를 다시 실행한다. 완료 marker가 있는 bundle은 건너뛰고 중단된 현재 bundle만 다시 만든다. systemd `NRestarts`는 최종 증거에 기록하지만 0을 성공 조건으로 요구하지 않는다. 재시작 뒤에도 같은 plan의 최종 감사가 통과하는지가 완료 조건이다.

`Commit`과 `CoverageCommit`은 Worker 2~6 전체가 지정된 경우에만 허용한다. 같은 plan 재실행은 HDFS의 완료 marker가 bundle·manifest와 일치하면 건너뛰고, 완료 marker가 없는 현재 run의 정확한 부분 bundle만 다시 만든다. 확정 경로가 이미 있으면 `_READY.json`의 schema·run·release·source·Sector·개수·RF2가 모두 같고 전수 재감사가 통과할 때만 `COMMIT_CACHED`로 끝낸다.

## 원본 추출

`manifest.parquet` 또는 보존된 `.control/worker=<slot>/*.manifest.jsonl`에서 `bundle_location`, `offset_start`, `sequence_key`, `sha256`을 가져온다. loader가 설치된 Worker에서 다음 도구로 임의 표본을 복원한다.

```bash
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 HADOOP_CONF_DIR=/etc/hadoop
RELEASE=/opt/planetory-hdfs-load/releases/<code-release>
java -cp "$RELEASE/classes:$(/opt/hadoop/bin/hadoop classpath)" TessSequenceFileTool extract \
  '<bundle_location>' '<offset_start>' '<sequence_key>' '<sha256>' /tmp/restored.fits
sha256sum /tmp/restored.fits
```

복원 파일은 검증 뒤 정확한 경로만 지운다. 원본 FITS, 최종 Raw와 다른 run의 staging을 정리 대상으로 넓히지 않는다.

## 검증과 실패 기록

오프라인 검사는 다음 한 명령이다.

```powershell
& .\infra\distributed-system\scripts\test-tess-hdfs-load.ps1
```

현재 Python 계획·감사 검사 11개, Python AST 문법 검사, PowerShell parser와 필수 계약 검사를 통과한다. 검사는 FinalCoverage의 두 Run lineage와 Sector 1~13 전역 개수, plan v2 cache 필드, 첫·중간·마지막 복원, 알 수 없는 artifact 거부, legacy v1 재감사, HDFS coverage marker와 덮어쓰기 없는 원자 rename, Node 1의 정확한 Worker 내부 IP와 HA safe-mode 출력 계약, Spark manifest 스크립트의 immutable release 직접 mount를 포함한다. PowerShell 계약은 `RunAll`이 첫 Preflight를 재사용하고 `Commit`의 전수 감사 외에 같은 `Audit`을 중복 실행하지 않는지도 검사한다. 초기 오프라인 검토에서 Install 대상 tuple 열거, oneshot 직렬 시작, final rename 뒤 checksum 출력 경로 변경, Commit 중단 뒤 `_READY.json.part`가 재감사를 막는 결함을 확인했다. 각각 tuple 보존, `systemctl --no-block start`, 경로 제외 checksum 알고리즘·digest 저장, Commit 시작 시 현재 staging의 정확한 임시 marker만 정리하는 방식으로 수정하고 회귀 계약에 반영했다. 실제 Install·Upload 전 발견되어 서버 영향은 없다.

75의 실제 FinalCoverage는 2026-09-20에 247,824개·441.62GiB·`.part` 0, Worker 5대 동일 SHA-256 `df6bfa638a0d70913b0d0bade11f0c5335bf9c505a9fbe256fa8552f0623bd94`로 완료됐다. 저장소의 100GiB 예약 설정은 Node 1~6에 반영했고 Worker 2~6 DataNode의 순차 재시작과 Live DataNode 5대 복귀를 확인했다. 실제 FinalCoverage를 입력으로 한 Sector 1~13 적재와 최종 HDFS coverage 감사는 아직 끝나지 않았으므로 76 완료로 간주하지 않는다.

첫 Sector 1~13 `RunAll` 시도는 Worker coverage 5개를 읽은 뒤 로컬 `coverage-map` 실행에서 `ModuleNotFoundError: No module named 'ingestion'`으로 중단됐다. HDFS staging 준비·loader 설치·uploader 시작 전이어서 데이터 영향은 없다. runner가 로컬 검증 호출 동안 `distributed-system`을 `PYTHONPATH` 앞에 추가하고 기존 값을 `finally`에서 복원하도록 수정했으며, 이 경로 설정·복원을 오프라인 계약에 추가했다. 안전한 재실행 시작점은 동일한 `RunAll` 처음이다.

수정 후 CodeReleaseId `20260920T040219Z`로 재실행해 FinalCoverage, Sector 1 Preflight와 6개 노드의 동일 loader content SHA-256을 확인했다. Sector 1은 15,889개·32,398,643,520바이트를 Worker 5대의 63개 bundle로 계획했고, uploader 5개가 모두 시작됐다. 이 기록은 적재 시작 증거이며 Sector 1 확정이나 Sector 1~13 완료 증거가 아니다. `RunAll` 완료, 각 Sector `COMMIT_OK`와 최종 `COVERAGE_COMMIT_OK`는 계속 확인해야 한다.

로컬 제어기 단절 뒤에도 계속 적재하도록 CodeReleaseId `20260920T120026Z`, 내용 SHA-256 `c357018ae7be69966fef07731703f797218780b0f363a9216ac5614e0d93ee84`를 6개 노드에 설치했다. Node 1에서 source `10.20.1.10`을 bind한 내부 SSH로 Worker `10.20.2.10`~`10.20.6.10`의 host key와 실제 hostname을 모두 확인했다. 최종 조정기 unit은 enabled·active/running, 현재 기동 `NRestarts=0`이며 Sector 1 final의 cached 전수 감사를 시작했다. 첫 bootstrap은 root 전용 키를 일반 세션으로 읽으려다 서비스 시작 전에 중단됐고, 다음 bootstrap은 내부 `ssh`가 파이프의 남은 표준입력을 소비해 unit이 disabled/inactive로 남았다. `sudo ssh -n`으로 둘을 닫았다. 첫 service 실행은 HA safe-mode의 실제 두 줄이 각각 endpoint를 덧붙이는 형식을 엄격 비교해 차단됐고, 다음 실행은 `ProtectSystem=strict` 아래 `/tmp` 쓰기 금지로 cached 감사 전에 차단됐다. HA 접두사 검증과 systemd `RuntimeDirectory`를 반영했으며 이 네 실패는 모두 신규 Worker upload 전에 발생해 HDFS staging·final을 변경하지 않았다. Sector 1~13 완료와 최종 coverage marker는 아직 진행 중이다.

Sector 1~6 확정 뒤 Sector 7은 19,995개·70개 bundle·35,818,706,880바이트의 upload와 전수 audit까지 통과했지만, `UMask=0027`인 조정기 임시 디렉터리에 복사한 `manifest_to_parquet.py`를 Spark 컨테이너 사용자가 읽지 못해 Parquet 생성 전에 중단됐다. Sector 7 staging은 그대로 보존했다. 임시 복사를 제거하고 권한이 설치 시 검증된 immutable release 파일을 read-only bind mount하도록 수정했다. CodeReleaseId `20260920T152934Z`, 내용 SHA-256 `5916e7913c65f4e49ecfbed93d821c80146233db4b613b3dbc00bde180bcbc88`를 6개 노드에 설치했고, 같은 Spark image에서 `MANIFEST_SCRIPT_READ_OK 2018` canary를 통과했다. Node 1 조정기는 해당 release로 enabled·active/running, `NRestarts=0`이며 cached Sector 재감사 뒤 보존된 Sector 7 staging을 재개한다. Sector 7 확정과 Sector 8~13, 최종 coverage marker는 아직 완료되지 않았다.

권한을 승인한 같은 날의 실환경 `Preflight`는 HA `active:standby`, Live DataNode 5개, 기본 RF2, HDFS 사용률 0%와 RunId `20260918T080417Z` Sector 3의 Worker 5대 감사 gate를 통과했다. 대상은 15,993개, 원본 31,965,808,320바이트다.

첫 `Install`은 archive를 Windows 프로세스 인자에 넣어 전달하려다 명령 길이와 출력 처리 제약으로 원격 변경 전에 실패했다. 전송을 기존 OpenSSH `scp`의 비대화식·엄격한 host key 검증과 원격 SHA-256 확인으로 교체했다. 다음 실행은 Node 1 임시 작업 경로에서 Hadoop classpath 조회의 `JAVA_HOME` 누락과 `javac`의 US-ASCII 기본 인코딩 때문에 컴파일 전에 중단됐다. release 최종 경로로 이동하기 전이라 EXIT cleanup이 archive와 임시 작업 경로를 제거했다. 설치 명령에 고정 Java 17·Hadoop 설정 경로와 `javac -encoding UTF-8`을 명시하고 오프라인 회귀 계약에 추가했다.

수정 release는 6개 노드 설치에 123.7초가 걸렸지만 첫 `Build`가 Worker 1에서 release 최상위의 `0700` 상속 때문에 일반 계정의 Python 파일 읽기를 거부했다. 이때 생성된 것은 정확한 빈 HDFS staging 경로뿐이며 FITS 본문은 업로드되지 않았다. 설치 시 root 소유는 유지하되 디렉터리 `0755`·일반 파일 `0644`에 해당하는 `a=rX,u+w`를 명시하고, 설치·cache hit 모두 실행 계정의 release 탐색·loader 읽기 검사를 통과하도록 수정했다. 불변 release는 덮어쓰지 않고 새 CodeReleaseId `20260918T134800Z`로 설치했다.

Sector 3 실측은 Build 100.1초, 5개 Worker upload 11분 8초, 독립 Audit 524.3초였다. upload는 61 bundle·15,993개·31,965,808,320바이트를 처리했고 유효 원본 처리량은 약 47.9MB/s(45.6MiB/s), unit 재시작 0, `.part` 0이었다. Audit은 checksum·RF2·offset·manifest·fsck를 모두 통과했다. 첫 Commit은 587.2초 동안 재감사와 Spark `manifest.parquet`, `_READY.json`, 최종 경로 원자 rename까지 완료하고 최종 FSCK `HEALTHY`, 370/370 blocks, 평균 복제 2.0, under/missing/corrupt 0을 확인했으나, 마지막 parser가 실제 Hadoop 표기 `Under-replicated blocks`의 하이픈을 예상하지 않아 exit 1을 냈다. 실제 확정 데이터는 정상이며 검사식을 실제 표기에 맞추고 FSCK 임시 로그를 성공·실패 모두 정리하도록 수정했다. 같은 RunId Commit 재실행은 529.9초에 전체 감사를 다시 통과하고 `COMMIT_CACHED`로 끝나 새 bundle·manifest·rename을 만들지 않았다.

Sector 3의 기존 `Build → Upload → Audit → Commit` 실측 합계는 약 31분 20초다. 읽기 전용 gate로 확인한 Sector 4는 19,997개·37,952,974,080바이트, Sector 5는 19,996개·38,469,484,800바이트다. 기존 흐름에서 독립 `Audit` 524.3초 뒤 `Commit`이 같은 전수 감사를 다시 수행했다. Sector 1~13 확장 실행부터 `RunAll`은 `Commit`의 통합 감사만 사용해 검증 범위와 실패 시 원자성은 유지하면서 신규 Sector당 약 8~10분의 중복 검사를 제거한다. 실제 개선 시간은 전체 실행 결과로 다시 기록한다.

## 2026-09-19 완료 조건 재검증

Sector 3 최종 경로를 현재 시점에서 다시 검증했다. 같은 RunId Commit은 481.7초에 전체 checksum·manifest·RF2·FSCK 감사를 통과하고 `COMMIT_CACHED`로 끝났다. 실행 전후 `hdfs dfs -ls -R` 인벤토리 SHA-256은 `13c239d2f865350f7b8b98405a618bb49762ef218fa90bccb31c62c9afd80534`로 같았고 bundle·완료 marker·JSONL manifest는 각각 61개, 논리·물리 사용량은 31,989,555,750·63,979,111,500바이트로 변하지 않았다.

Worker별 결정적 무작위 표본 1개씩 총 5개를 manifest offset으로 복원해 실제 Worker 로컬 FITS와 크기·SHA-256을 비교했고 5/5가 일치했다. 고정 Spark image로 `manifest.parquet`의 12개 필드, 15,993행, null·파일명 중복 0, Sector·source lineage, offset과 Worker별 개수·바이트 합계를 확인했다. 별도 validation staging에 의도적인 `.part`를 만든 실패 주입은 최종 Raw 검색 0건과 최종 인벤토리 불변을 확인한 뒤 정확한 validation 경로만 삭제했다.

추가 FSCK는 370/370 블록의 `Live_repl=2`, 5개 DataNode 배치, missing·corrupt·under-replicated 0을 확인했다. HA는 `active:standby`, safe mode는 OFF, HDFS 사용률은 1%다. `yarn` 계정은 `hadoop` 그룹으로 `_READY.json`과 Parquet `_SUCCESS`를 읽었고 5개 uploader unit은 모두 `success`, 재시작 0, `inactive/dead`다. 보조 검사 초안은 Dead DataNode 0일 때 `dfsadmin -report`가 해당 줄을 생략하고 `hdfs dfs -stat %A`가 디렉터리 접두사 없이 `rwxr-x---`을 반환하는 형식을 잘못 가정해 중단됐다. 실제 출력에 맞춰 빈 Dead 값을 0으로 처리하고 권한 비교를 정정한 재검사는 통과했으며 HDFS 데이터에는 영향이 없었다.

Jira 완료 조건은 Sector 3 실데이터에서 모두 입증됐지만 현재 전체 승인 범위 진행률은 29.49%다. Sector 4·5에는 final·staging·활성 uploader가 없으므로 초기 범위 전체 적재가 끝나기 전까지 `S15P21C206-76`을 전체 완료로 판단하지 않는다.

## 2026-09-19 Sector 3~5 자동 연속 적재

단일 Sector 단계 실행만 제공하던 runner에 `RunAll`을 추가했다. 전체 Sector의 download audit을 먼저 확인하고, 기존 단계를 재사용해 Sector별 uploader 완료를 기다린 뒤 감사·확정한다. 완료된 Sector 3은 `COMMIT_CACHED` 전수 재감사 후 건너뛰고 Sector 4·5를 자동으로 이어서 처리했다. 오류나 3시간 timeout이면 다음 Sector로 넘어가지 않으며 같은 명령으로 완료 Sector를 재감사하고 미완료 Sector부터 재개한다.

실환경 전체 실행은 86.7분에 끝났다. Sector 4는 19,997개·75 bundle·37,952,974,080바이트이며 upload는 937.7초, Sector 5는 19,996개·75 bundle·38,469,484,800바이트이며 upload는 868.9초였다. 두 Sector 모두 독립 Audit과 Commit 재감사, `manifest.parquet` 행 수, 원자 rename과 최종 FSCK `HEALTHY`를 통과했다.

별도 읽기 전용 최종 검사는 Sector 3·4·5의 `_READY.json`과 Parquet `_SUCCESS`, 정확한 run·release·source checksum·RF2를 확인했다. 세 staging 경로는 모두 없고 최종 release는 논리 108,471,409,680바이트, RF2 물리 216,942,819,360바이트, 657개 HDFS 파일·1,259 blocks다. under-replicated·missing·corrupt는 모두 0, HA는 `active:standby`, Live DataNode 5개, HDFS 사용률 2%다. Sector 4·5 uploader 10개는 전부 `success`, exit 0, 재시작 0, `inactive/dead`다. 전체 승인 범위 55,986개 적재 진행률은 100%다.
