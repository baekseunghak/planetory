# TESS HDFS Raw 적재

`S15P21C206-76`의 실행 정본이다. 다운로드가 끝난 파일을 Worker 5대에서 동시에 512MiB~1GiB SequenceFile로 묶고, 전체 Sector가 검증된 경우에만 HDFS Raw 경로로 원자 확정한다.

## 저장 계약

- Worker 2~6은 각각 writer 하나만 실행한다. 서로 다른 `bundle-w<slot>-<number>.seq`를 쓰므로 전체 동시 writer는 5개다.
- 값은 FITS 원본 바이트이며 key는 원파일명이다. Java writer가 쓰기 직전에 크기와 SHA-256을 다시 검사한다.
- manifest는 원파일명, TIC, Sector, 크기, SHA-256, 최종 bundle 위치, SequenceFile key, 시작·끝 offset, `input_snapshot_id`, source list SHA-256과 Worker slot을 기록한다.
- 각 bundle의 첫 레코드를 offset으로 다시 추출해 SHA-256을 비교한 뒤에만 완료 marker를 만든다.
- 각 파일의 HDFS replication을 2로 맞추고 `hdfs dfs -checksum`, 전체 staging `fsck HEALTHY`를 확인한다.
- Worker별 JSONL을 고정 Spark 3.5.5 image로 `manifest.parquet`로 변환한다. 최종 경로는 `/lake/raw/tess/release=<release>/sector=<sector>/`다.
- 진행 중 결과는 `/lake/raw/tess/.staging/run=<run>/...`에만 있다. 다섯 Worker의 bundle·manifest·marker 감사가 모두 성공한 뒤 Sector 디렉터리 하나를 HDFS rename으로 확정한다.

PoC HDFS는 Kerberos가 없는 simple mode다. staging bundle은 OS/HDFS 사용자 `planetory-admin`이 쓰고, `hdfs` 슈퍼유저는 정확한 staging 경로 준비·전체 감사·최종 rename만 수행한다. 이 권한 경계는 인터넷 또는 다중 테넌트 보안 경계로 간주하지 않는다.

## 실행 순서

먼저 같은 RunId의 해당 Sector에 대해 Worker 5개 `download-audit`가 `expected=validated`, `errors=[]`이고 `.part`가 0인지 확인한다. 그 다음 저장소 루트 PowerShell에서 실행한다.

```powershell
$Load = '.\infra\distributed-system\scripts\run-tess-hdfs-load.ps1'
$Run = '20260918T080417Z'
$SourceSha = '5781b664ea901bbbeecb4829e34c314e52961d111460b3e5a6ebe58918efc789'
$CodeRelease = '20260918T134800Z'

& $Load -Step RunAll -RunId $Run -ExpectedSourceListSha256 $SourceSha `
  -ReleaseId $Run -CodeReleaseId $CodeRelease
```

`RunAll`은 Sector 3·4·5의 다운로드 감사 gate를 모두 먼저 통과한 뒤 loader를 한 번 설치한다. Sector별로 최종 경로가 있으면 `Commit` 재감사 후 건너뛰고, 없으면 `Build → Upload → uploader 완료 대기 → Audit → Commit`을 순서대로 실행한다. 첫 실패에서 중단하고 해당 staging을 보존하므로 같은 명령으로 재개할 수 있다.

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

업로드 unit은 현재 부팅에서 실패 시 재시작하지만 enable하지 않는다. Worker가 재부팅되면 HDFS·DataNode 정상 상태를 확인한 뒤 같은 `Upload`를 다시 실행한다. 완료 marker가 있는 bundle은 건너뛰고 중단된 현재 bundle만 다시 만든다.

`Commit`은 Worker 2~6 전체가 지정된 경우에만 허용한다. 같은 plan 재실행은 HDFS의 완료 marker가 bundle·manifest와 일치하면 건너뛰고, 완료 marker가 없는 현재 run의 정확한 부분 bundle만 다시 만든다. 확정 경로가 이미 있으면 `_READY.json`의 run·release·source·Sector가 모두 같을 때만 `COMMIT_CACHED`로 끝낸다.

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

2026-09-18 기준 Python 계획·감사 검사 4개, Python AST 문법 검사, PowerShell parser와 필수 계약 검사를 통과했다. 검사는 완전한 download audit만 허용하는지, 같은 입력의 plan ID·shard 경계가 결정적인지, plan 변조를 거부하는지, bundle manifest·HDFS checksum·RF2가 plan과 일치해야 Sector 감사가 통과하는지 확인한다. 초기 오프라인 검토에서 Install 대상 tuple 열거, oneshot 직렬 시작, final rename 뒤 checksum 출력 경로 변경, Commit 중단 뒤 `_READY.json.part`가 재감사를 막는 결함을 확인했다. 각각 tuple 보존, `systemctl --no-block start`, 경로 제외 checksum 알고리즘·digest 저장, Commit 시작 시 현재 staging의 정확한 임시 marker만 정리하는 방식으로 수정하고 회귀 계약에 반영했다. 실제 Install·Upload 전 발견되어 서버 영향은 없다.

권한을 승인한 같은 날의 실환경 `Preflight`는 HA `active:standby`, Live DataNode 5개, 기본 RF2, HDFS 사용률 0%와 RunId `20260918T080417Z` Sector 3의 Worker 5대 감사 gate를 통과했다. 대상은 15,993개, 원본 31,965,808,320바이트다.

첫 `Install`은 archive를 Windows 프로세스 인자에 넣어 전달하려다 명령 길이와 출력 처리 제약으로 원격 변경 전에 실패했다. 전송을 기존 OpenSSH `scp`의 비대화식·엄격한 host key 검증과 원격 SHA-256 확인으로 교체했다. 다음 실행은 Node 1 임시 작업 경로에서 Hadoop classpath 조회의 `JAVA_HOME` 누락과 `javac`의 US-ASCII 기본 인코딩 때문에 컴파일 전에 중단됐다. release 최종 경로로 이동하기 전이라 EXIT cleanup이 archive와 임시 작업 경로를 제거했다. 설치 명령에 고정 Java 17·Hadoop 설정 경로와 `javac -encoding UTF-8`을 명시하고 오프라인 회귀 계약에 추가했다.

수정 release는 6개 노드 설치에 123.7초가 걸렸지만 첫 `Build`가 Worker 1에서 release 최상위의 `0700` 상속 때문에 일반 계정의 Python 파일 읽기를 거부했다. 이때 생성된 것은 정확한 빈 HDFS staging 경로뿐이며 FITS 본문은 업로드되지 않았다. 설치 시 root 소유는 유지하되 디렉터리 `0755`·일반 파일 `0644`에 해당하는 `a=rX,u+w`를 명시하고, 설치·cache hit 모두 실행 계정의 release 탐색·loader 읽기 검사를 통과하도록 수정했다. 불변 release는 덮어쓰지 않고 새 CodeReleaseId `20260918T134800Z`로 설치했다.

Sector 3 실측은 Build 100.1초, 5개 Worker upload 11분 8초, 독립 Audit 524.3초였다. upload는 61 bundle·15,993개·31,965,808,320바이트를 처리했고 유효 원본 처리량은 약 47.9MB/s(45.6MiB/s), unit 재시작 0, `.part` 0이었다. Audit은 checksum·RF2·offset·manifest·fsck를 모두 통과했다. 첫 Commit은 587.2초 동안 재감사와 Spark `manifest.parquet`, `_READY.json`, 최종 경로 원자 rename까지 완료하고 최종 FSCK `HEALTHY`, 370/370 blocks, 평균 복제 2.0, under/missing/corrupt 0을 확인했으나, 마지막 parser가 실제 Hadoop 표기 `Under-replicated blocks`의 하이픈을 예상하지 않아 exit 1을 냈다. 실제 확정 데이터는 정상이며 검사식을 실제 표기에 맞추고 FSCK 임시 로그를 성공·실패 모두 정리하도록 수정했다. 같은 RunId Commit 재실행은 529.9초에 전체 감사를 다시 통과하고 `COMMIT_CACHED`로 끝나 새 bundle·manifest·rename을 만들지 않았다.

Sector 3의 `Build → Upload → Audit → Commit` 실측 합계는 약 31분 20초다. 읽기 전용 gate로 확인한 Sector 4는 19,997개·37,952,974,080바이트, Sector 5는 19,996개·38,469,484,800바이트다. 현재 처리량과 bundle당 감사 시간을 적용하면 같은 전체 절차는 각각 약 37분이며, 이는 아직 실행 전 추정치다. `Commit`이 안전을 위해 Audit을 다시 수행하므로 독립 Audit을 생략하면 약 10분 줄지만, 운영 확인 절차는 독립 Audit 성공을 보고 Commit하는 현재 순서를 유지한다.

## 2026-09-19 완료 조건 재검증

Sector 3 최종 경로를 현재 시점에서 다시 검증했다. 같은 RunId Commit은 481.7초에 전체 checksum·manifest·RF2·FSCK 감사를 통과하고 `COMMIT_CACHED`로 끝났다. 실행 전후 `hdfs dfs -ls -R` 인벤토리 SHA-256은 `13c239d2f865350f7b8b98405a618bb49762ef218fa90bccb31c62c9afd80534`로 같았고 bundle·완료 marker·JSONL manifest는 각각 61개, 논리·물리 사용량은 31,989,555,750·63,979,111,500바이트로 변하지 않았다.

Worker별 결정적 무작위 표본 1개씩 총 5개를 manifest offset으로 복원해 실제 Worker 로컬 FITS와 크기·SHA-256을 비교했고 5/5가 일치했다. 고정 Spark image로 `manifest.parquet`의 12개 필드, 15,993행, null·파일명 중복 0, Sector·source lineage, offset과 Worker별 개수·바이트 합계를 확인했다. 별도 validation staging에 의도적인 `.part`를 만든 실패 주입은 최종 Raw 검색 0건과 최종 인벤토리 불변을 확인한 뒤 정확한 validation 경로만 삭제했다.

추가 FSCK는 370/370 블록의 `Live_repl=2`, 5개 DataNode 배치, missing·corrupt·under-replicated 0을 확인했다. HA는 `active:standby`, safe mode는 OFF, HDFS 사용률은 1%다. `yarn` 계정은 `hadoop` 그룹으로 `_READY.json`과 Parquet `_SUCCESS`를 읽었고 5개 uploader unit은 모두 `success`, 재시작 0, `inactive/dead`다. 보조 검사 초안은 Dead DataNode 0일 때 `dfsadmin -report`가 해당 줄을 생략하고 `hdfs dfs -stat %A`가 디렉터리 접두사 없이 `rwxr-x---`을 반환하는 형식을 잘못 가정해 중단됐다. 실제 출력에 맞춰 빈 Dead 값을 0으로 처리하고 권한 비교를 정정한 재검사는 통과했으며 HDFS 데이터에는 영향이 없었다.

Jira 완료 조건은 Sector 3 실데이터에서 모두 입증됐지만 현재 전체 승인 범위 진행률은 29.49%다. Sector 4·5에는 final·staging·활성 uploader가 없으므로 초기 범위 전체 적재가 끝나기 전까지 `S15P21C206-76`을 전체 완료로 판단하지 않는다.

## 2026-09-19 Sector 3~5 자동 연속 적재

단일 Sector 단계 실행만 제공하던 runner에 `RunAll`을 추가했다. 전체 Sector의 download audit을 먼저 확인하고, 기존 단계를 재사용해 Sector별 uploader 완료를 기다린 뒤 감사·확정한다. 완료된 Sector 3은 `COMMIT_CACHED` 전수 재감사 후 건너뛰고 Sector 4·5를 자동으로 이어서 처리했다. 오류나 3시간 timeout이면 다음 Sector로 넘어가지 않으며 같은 명령으로 완료 Sector를 재감사하고 미완료 Sector부터 재개한다.

실환경 전체 실행은 86.7분에 끝났다. Sector 4는 19,997개·75 bundle·37,952,974,080바이트이며 upload는 937.7초, Sector 5는 19,996개·75 bundle·38,469,484,800바이트이며 upload는 868.9초였다. 두 Sector 모두 독립 Audit과 Commit 재감사, `manifest.parquet` 행 수, 원자 rename과 최종 FSCK `HEALTHY`를 통과했다.

별도 읽기 전용 최종 검사는 Sector 3·4·5의 `_READY.json`과 Parquet `_SUCCESS`, 정확한 run·release·source checksum·RF2를 확인했다. 세 staging 경로는 모두 없고 최종 release는 논리 108,471,409,680바이트, RF2 물리 216,942,819,360바이트, 657개 HDFS 파일·1,259 blocks다. under-replicated·missing·corrupt는 모두 0, HA는 `active:standby`, Live DataNode 5개, HDFS 사용률 2%다. Sector 4·5 uploader 10개는 전부 `success`, exit 0, 재시작 0, `inactive/dead`다. 전체 승인 범위 55,986개 적재 진행률은 100%다.
