# 전체·비교 통계 실행

상태: 구현·격리 검증 완료. 사용자 승인일: 2026-09-22. Jira: [S15P21C206-178](https://ssafy.atlassian.net/browse/S15P21C206-178). 정책은 [통계 지표 사전](../requirements/planetory-statistics-policy.md), DB는 [ERD](../architecture/database-erd.md), 응답은 [서비스 API 12.2](../../apps/backend/docs/service-api-spec.md#statistics-policy)를 따른다. 공유/운영 DB와 스케줄은 이 작업에서 활성화하지 않았다.

## 실행 경계

기존 단발 운영 명령에 `statistics`를 추가한다. 웹 서버·HTTP 쓰기 API·새 배치 플랫폼은 없다. 외부 스케줄러의 목표 주기는 MV 10분, 일별 기준선 KST 매일 00:10이다. 실제 스케줄러 등록과 계정 공급은 인프라 담당의 별도 운영 적용이다. 등록 전 해당 환경에서 처리 시간·실패 알림을 확인한다. 실행 직후에는 명령이 종료되며 주기 실행을 내장하지 않는다.

V20→V21을 소유자 역할로 먼저 적용한다. V21이 만드는 `planetory_stats_job`은 NOLOGIN 그룹이다. 운영 담당은 전용 로그인 계정에 이 그룹만 부여하고 앱·Gold writer·소유자 그룹과 분리한다. 접속 변수 `DATABASE_URL`, `DATABASE_USER`, `DATABASE_PASSWORD`는 환경의 비밀 공급 경로로 주입한다. 값을 명령줄·로그에 쓰지 않는다. 서비스 앱은 `planetory_app`으로만 접속한다.

```powershell
# 기존 빌드 결과 JAR의 정확한 경로를 지정한다. prod와 OAuth 로컬 설정 제외를 명시한다.
java -jar <backend.jar> --spring.profiles.active=prod --spring.config.import=optional:classpath:/oauth-test-no-local.properties --planetory.command=statistics --planetory.statistics.mode=refresh
java -jar <backend.jar> --spring.profiles.active=prod --spring.config.import=optional:classpath:/oauth-test-no-local.properties --planetory.command=statistics --planetory.statistics.mode=snapshot
```

명령은 Flyway를 항상 비활성화한다. `refresh`는 최초에는 일반 REFRESH, 이후에는 CONCURRENTLY를 실행한다. `snapshot`은 DB 관측 시각의 KST 오늘 D를 사용하고 `snapshotDate=D-1`로 저장한다. 진단용 `--planetory.statistics.cutoff=YYYY-MM-DD`는 snapshot에만 허용하며 D 경계를 뜻한다. 과거 성공본이 있으면 변경 없이 성공 종료하지만, 없으면 새로 생성하지 않는다. 미래 날짜도 거절한다.

## 시간·실패·권한

- 두 명령은 같은 transaction advisory lock으로 중첩을 거절한다. 연결이 종료되거나 프로세스가 중단되면 DB가 잠금을 해제한다. 원천 SELECT·계산·Snapshot INSERT는 REPEATABLE_READ 한 트랜잭션이다. Snapshot 유일 키는 별도 접속의 중복 INSERT도 거절한다.
- 성공 종료 0, 다른 잡 실행 중 2, 과거/미래 원천 재현 불가 3, 실행 오류 1이다. 작업 SQL에는 8분 제한을 적용한다. 실패한 트랜잭션은 MV·Snapshot을 공개하지 않는다. 실패를 성공이나 정상 0건으로 처리하지 않는다.
- MV 조회는 원천 기준 `asOf`로부터 10분이 지나면 STALE, 최초 성공 전에는 UNAVAILABLE이다. 일별 조회는 최신 성공 날짜가 어제보다 오래되면 STALE이다. stale 값·기준 시각·개별 지표 상태는 원본 그대로다. 장애 여부를 추측하는 별도 성공 덮어쓰기나 실패 Snapshot을 만들지 않는다.
- 일별 `asOf`는 기록의 배타적 종료 경계다. `sourceObservedAt`은 실행 트랜잭션의 일관된 읽기 시각, `generatedAt`은 계산 완료 시각이다. 전날까지 기록을 실행 시점 상태로 계산한다는 사용자 추가 승인을 반영한다. 늦은 커밋과 라벨·회원 상태 변경이 반영될 수 있으며 자정 당시 상태라고 표시하지 않는다.
- 앱은 MV·Snapshot 읽기만 허용한다. 잡은 MV MAINTAIN, Snapshot SELECT/INSERT 및 identity USAGE, users/submissions/성과/판정 SELECT만 가진다. 성공본 UPDATE/DELETE·원천 쓰기·소유권은 주지 않는다. MV REFRESH는 PostgreSQL의 소유자 권한 평가를 사용한다.
- 실패 이후 같은 날짜 재실행은 최초 성공본만 만든다. 외부 라벨 변경으로 이전 성공본을 다시 계산하지 않는다. 과거 날짜 신규 backfill·정책 변경 재집계는 별도 승인과 이력 설계가 필요하다.

## 격리 검증

테스트는 별도 PostgreSQL 18.6 컨테이너와 임시 통합 사본에서 수행한다. 173의 V20 및 177 개인 구현·테스트를 사본에 넣어 신규 DB 전체 migration, V19→V20→V21 순차 업그레이드, validate, 재실행 0건을 확인했다. V20과 개인 구현을 178 소유 변경으로 중복 배포하지 않는다. 통계 테스트의 개인 HTTP 소비 검사에는 177 구현이 필요하다. 테스트 명령은 `-PskipLocalDb`로 공용 개발 DB 자동 기동을 막는다.

```powershell
.\gradlew.bat -PskipLocalDb test --tests '*StatisticsAggregationTest' --tests '*StatisticsMigrationTest' --tests '*StatisticsCommandTest' --tests '*MemberCommunityPermissionTest' --tests '*PlanetoryApplicationCommandModeTest'
```

2026-09-22 통합 검증은 서로 다른 테스트 158건 모두 통과했다. 최초 실행에서는 임시 사본에 기존 검색 fixture가 빠져 CommunityReadTest 1건이 실패했다. fixture 복사 후 해당 클래스 17건을 재실행해 모두 통과했다. 전체 통계·개인 소비·실제 앱/잡 권한·신규/업그레이드·실패/멱등/원천 시각·제출·공개·퀘스트·별 결과·검색·핫 토픽 회귀이며 bootJar도 통과했다. 성공본에 회원별 원자료가 없는 것도 검사했다.

| 합성 제출 | MV 갱신 | MV 조회 | 일별 기준선 |
| --- | --- | --- | --- |
| 101건 | 20.8ms | 3.1ms | 13.8ms |
| 10,001건 | 57.5ms | 3.2ms | 33.4ms |
| 100,001건 | 440.0ms | 3.1ms | 241.0ms |

단일 회원의 동일 후보 반복 제출 표본·로컬 일회용 DB·규모별 1회 측정이다. 실제 회원/후보 다양성·600만 제출·운영 메모리/I/O를 반영한 운영 성능 인수가 아니다. 후보별 최신 AI 원천 미확보로 모든 AI 참여를 UNKNOWN으로 처리했으며, 원천 확보 후 정상0·최신실패·버전별 구간 인수는 후속이다. 프론트 연결·브라우저 인수와 실제 운영 잡 활성화도 별도다.
