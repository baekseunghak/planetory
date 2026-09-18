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

첫 `Install`은 archive를 Windows 프로세스 인자에 넣어 전달하려다 명령 길이와 출력 처리 제약으로 원격 변경 전에 실패했다. 전송을 기존 OpenSSH `scp`의 비대화식·엄격한 host key 검증과 원격 SHA-256 확인으로 교체했다. 다음 실행은 Node 1 임시 작업 경로에서 Hadoop classpath 조회의 `JAVA_HOME` 누락과 `javac`의 US-ASCII 기본 인코딩 때문에 컴파일 전에 중단됐다. release 최종 경로로 이동하기 전이라 EXIT cleanup이 archive와 임시 작업 경로를 제거했다. 설치 명령에 고정 Java 17·Hadoop 설정 경로와 `javac -encoding UTF-8`을 명시하고 오프라인 회귀 계약에 추가했다. Java/Hadoop 실제 재컴파일부터 HDFS upload·RF2·byte comparison·commit까지의 결과는 재실행 뒤 이어서 기록한다.
