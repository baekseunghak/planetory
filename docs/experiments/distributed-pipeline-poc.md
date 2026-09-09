# 분산 파이프라인 Docker PoC

## 목적

작은 합성 Sector 데이터가 다음 경로를 실제로 통과하는지 검증한다.

```text
합성 데이터 → HDFS Raw → Spark on YARN → HDFS Bronze/Silver
           → Gold 검증·전송 → 모의 EC2 Gold/서비스 DB → 조회
```

YARN은 Spark 작업에 CPU와 메모리를 배정하는 Hadoop의 자원 관리자다. Publisher는 완료된 Silver 결과를 검사하고 EC2용 Gold 묶음으로 만들어 보내는 프로그램이다.

## 제외 범위

- 실제 MAST 대량 다운로드
- FITS 전체 파싱, BLS와 AI 정확도 평가
- Airflow 설치
- 실제 GCP·EC2 생성과 운영 배포
- 독립 VM 장애 내성과 운영 처리량 증명

## 위치

```text
experiments/distributed-pipeline/
├─ README.md
├─ compose.yaml                   # 기본 2 Worker
├─ compose.four-workers.yaml      # 4 Worker 검사 추가 설정
├─ docker/
├─ conf/                          # HDFS·YARN 설정
├─ fixtures/generate.py           # 고정된 합성 데이터
├─ jobs/sector_summary.py
├─ publisher/publish.py
├─ mock-service/                  # Gold 수신기·PostgreSQL·조회 검사
├─ scripts/                       # 실행·검사·중지, PowerShell 포함
├─ tests/
└─ results/                       # 작은 측정 결과만 보관
```

첫 입력은 `tic_id`, `sector`, `time`, `flux`, `quality` 열을 가진 CSV로 충분하다. 여러 TIC, 두 개 이상의 Sector, 결측값과 품질 제외 행을 포함한다. 원본 데이터와 대형 결과 파일은 Git에 넣지 않는다.

## 실행 흐름

1. 고정 seed로 합성 데이터를 만든다.
2. 입력 크기와 SHA-256 값을 확인하고 HDFS Raw에 쓴다.
3. `spark-submit --master yarn --deploy-mode cluster`로 작업을 제출한다.
4. Spark가 유효값 정규화, Sector별 요약과 TIC별 Sector 결합 결과를 만든다.
5. Bronze와 Silver를 Parquet으로 HDFS에 쓴다.
6. Publisher가 완료된 Silver만 읽고 Gold 파일과 manifest를 만든다.
7. 검증한 Bundle과 manifest·checksum을 HDFS에 RF2로 백업한다.
8. 파일과 manifest를 모의 EC2 수신기로 실제 전송한다.
9. 수신기가 checksum을 확인하고 릴리스 정보와 검색용 요약을 PostgreSQL에 기록한다.
10. 조회 프로그램이 HDFS 연결 없이 Gold 파일과 DB를 읽는다.

Spark Standalone 또는 `local[*]` 실행 성공은 YARN 검증으로 인정하지 않는다. Spark 실행 프로세스와 Worker 모두 같은 Python 의존성을 사용해야 한다.

## 최소 컨테이너

| 구성 | 기본 검사 | 확장 검사 |
| --- | --- | --- |
| NameNode·ResourceManager | 각 1개 | 각 1개 |
| DataNode·NodeManager | 각 2개 | 각 4개 |
| Standby NameNode·JournalNode | 생략 | 실제 GCP 수동 HA 검증에서 추가 |
| Spark 제출·Publisher | 실행 후 종료 | 동일 |
| PostgreSQL·모의 수신기·조회 | 각 1개 | 동일 |
| Raw/Bronze/Silver/Bundle backup 복제 수 | 2/2/2/2 | 2/2/2/2 |

기본 검사는 연결을 빠르게 확인한다. Worker 장애 검사는 4 Worker 구성에서만 판정한다. 한 PC의 컨테이너는 같은 물리 디스크를 사용하므로 실제 서버 장애 검증을 대신하지 않는다.

## 네트워크 경계

- Hadoop 네트워크와 모의 EC2 네트워크를 분리한다.
- Publisher와 Gold 수신기만 두 네트워크 사이를 통신한다.
- 조회 프로그램에는 HDFS 주소·볼륨·자격 증명을 제공하지 않는다.
- Gold 수신기는 쓰기 권한, 조회 프로그램은 읽기 권한만 가진다.
- 로컬 관리 화면은 필요할 때만 `127.0.0.1`에 공개한다.

## 합격 조건

1. YARN 작업 ID와 성공 상태가 남고 둘 이상의 NodeManager에서 Task가 실행된다.
2. Raw·Bronze·Silver가 HDFS에 존재하며 행 수, 스키마와 복제 수가 기대값과 같다.
3. Raw 내용의 SHA-256 값이 입력과 같다.
4. 전체 데이터를 Spark Driver로 가져오는 `collect()` 없이 분산 집계한다.
5. Spark 작업은 서비스 DB 쓰기 권한이 없고 Publisher만 전송을 시작한다.
6. 같은 입력과 버전으로 재실행해도 활성 릴리스와 DB 행이 중복되지 않는다.
7. 손상 파일·전송 중단·DB 반영 실패 시 이전 Gold가 계속 조회된다.
8. 동시에 두 릴리스를 활성화하면 조건을 먼저 만족한 한 요청만 성공한다.
9. HDFS를 차단해도 이미 공개된 Gold 조회가 성공한다.
10. HDFS의 PublicationBundle 백업과 EC2 수신본의 checksum이 같다.
11. 4 Worker 검사에서 Worker 중단, Spark 재시도와 Raw RF2 읽기를 확인한다.

## 결과 기록

다음 정보를 함께 기록한다.

- 커밋과 이미지 내용 식별값
- seed와 입력 행 수
- 입력·출력 checksum
- YARN 작업 ID
- Worker 수와 Worker당 CPU·RAM 할당
- 처리 시간과 실패 주입 결과

1·2·4 Worker 비교는 같은 입력으로 반복 실행한다. 로컬 측정값을 GCP 운영 성능으로 단정하지 않는다.
