# 인증 런타임 실측(235)

- Jira: [S15P21C206-235](https://ssafy.atlassian.net/browse/S15P21C206-235)
- 측정일: 2026-09-23
- 상태: 235의 DB 장애 인증 예외 경계 수정·격리 재검증 완료(15건 통과). 239 통합 이후의 표시 분리·재검증 상태는 [239 검증 기록](../../apps/frontend/docs/ticket-239-readiness.md)을 따른다. 실제 외부 제공자·운영 인수는 별도다.
- 목적: prod 설정의 실제 쿠키 속성과 DB 중단 시 인증 응답을 기록하고 발견한 인증 예외 처리 누락을 수정한다. 정책·운영 설정·마이그레이션은 변경하지 않는다.
- 기준: [OAuth·세션 계약](../../apps/backend/docs/oauth-setup.md), [서비스 배포](../../infra/service/README.md), [운영 문서](README.md).

## 요구사항과 선행 조건

235의 최초 범위는 관찰·검증이었다. 이후 사용자가 2026-09-23 같은 브랜치에서 백엔드 결함 수정을 명시적으로 요청하여 인증 예외 경계 수정을 포함한다. Jira 브라우저 도구는 시작 단계의 sandbox ACL 오류로 실패했다. 아래 범위는 조정 작업이 전달한 기존 Jira 원문 확인 요약과 현재 저장소를 대조한 것으로, Jira 최신 상태 직접 재조회 결과가 아니다.

| 관련 작업 | 현재 저장소에서 확인한 사실 | 남은 경계 |
| --- | --- | --- |
| 240 | 공통 `server.forward-headers-strategy=framework`, 제한된 진단 로그, 기존 503·롤백 유지 | 외부 전달 헤더 정제·Host 검증·backend 직결 제한은 별도 인수 |
| 237 | 실제 세션 Redis와 캐시 Redis의 별도 연결, `SESSION`·30분 idle | 운영 연결·지속성 검증과 구분 |
| 234 | 로그아웃에 현재 세션의 CSRF 필요 | 아래 반복·오래된 토큰 검증 |
| 84 | 기준 develop에 병합됨. 현재 `infra/service/compose.yaml`에는 두 Redis 서비스와 `SESSION_REDIS_*`·`CACHE_REDIS_*` 전달이 없음 | 병합을 운영 준비 완료로 보지 않음 |
| 239 | nginx의 요청 시점 DNS, Proto/Host 전달, `absolute_redirect off`, `/me` 장애를 401로 바꾸지 않는 라우팅은 존재 | 최초 측정 때는 콜백 503이 `authentication_failed`였으며, 239 통합 후 `service_unavailable`과 별도 화면 안내로 구분한다. 현재 결과는 [239 검증 기록](../../apps/frontend/docs/ticket-239-readiness.md)을 따른다 |

현재 nginx의 외부 `Forwarded`·일부 `X-Forwarded-*` 미제거와 임의 Proto 통과는 [기존 신뢰 경계](../../apps/backend/docs/oauth-setup.md#oauth-proxy-240)에 남아 있다. 이번 시험은 정상 입력만 사용하며 그 취약 경로의 운영 인수를 대신하지 않는다.

## 수정 전 실행 식별과 공통 격리 경계

- 실행 소스: `67a9e7412ca983914e050ade291b3f1e7443b650`의 `apps/backend/src/main` 그대로. 운영 코드 수정 없음.
- backend main Git tree: `f181aa06637d28ab998980f56d21e0ceb5bce3dd`.
- nginx 원본 Git blob: `233cc9e18bc737ed90869b2f8267361ab164c7b3`, 파일 SHA-256: `510334080e0dd846686cca8b85742495854b0fb33abb6fe3e7d50858752f5592`.
- 하네스: [AuthRuntimeVerificationTest](../../apps/backend/src/test/java/com/planetory/backend/domain/auth/AuthRuntimeVerificationTest.java). 기존 합성 제공자만 재사용하며 회원·첫 별 배치·시계는 실제 구현이다.
- 최종 하네스 SHA-256: `866d6647a913e1850de5b4d9084a31ebd7e3281ddba5051fc9930d2bdea95e28`. 공유 제공자 등록 도우미를 인자로 재사용하도록 보완한 `RedisSessionIntegrationTest.java` SHA-256: `16c17a20a5790666028939475f916660fff37d23a7e75e24f90105a93c56fa1c`.
- 프로필 `prod`, Spring Session Redis 활성화. 개인 OAuth 설정 import는 존재하지 않는 optional classpath 리소스로 대체한다. `local` 및 `secure=false`를 사용하지 않는다.
- 전용 PostgreSQL `postgres:18.6-alpine`, 서로 다른 Redis `redis:8.2-alpine` 두 컨테이너, 실제 프론트 Dockerfile과 같은 nginx `nginxinc/nginx-unprivileged:1.27-alpine`을 사용한다.
- TLS: 시험마다 만든 localhost SAN 인증서로 nginx에서 종료하며 Java HTTP 클라이언트는 이 인증서를 신뢰 저장소로 검증한다. 인증서 검증·호스트명 검증을 끄지 않는다. 키·쿠키·토큰 값은 출력하지 않는다.
- nginx의 라우팅·오류 처리·전달 헤더는 원본을 유지한다. `listen`에 TLS를 추가하고 backend 주소만 Testcontainers 호스트 터널로 치환한다. 키 접근을 위해 시험용 nginx만 root로 실행하므로 운영 컨테이너 권한 검증이 아니다.
- DB는 테스트 생성 객체의 container ID로만 중지·재시작한다. 상태가 실제 stopped인지 검사한다. loopback의 빈 포트를 이번 시험의 명시적 포트로 할당하고 재시작 후 동일 포트인지 검사한다. 기존 마이그레이션은 새 일회용 DB에만 적용하고 가상 튜토리얼 별을 넣는다. 공유·운영 DB와 다른 작업 컨테이너·볼륨은 조작하지 않는다.
- 풀 연결 대기는 시험 시간 제한을 위해 1500ms로 설정한다. 운영 기본 대기 시간·장애 응답 지연 수치의 인수는 아니다.
- `GET /api/v1/me`와 일반 로그인은 TLS nginx를 경유한다. 콜백 원응답 비교는 내부 HTTP로 같은 앱을 직접 호출하며 HTTPS 전달 헤더와 메모리의 시험용 쿠키를 사용한다. 이 직접 비교를 브라우저 HTTPS 검증으로 분류하지 않는다.

## 수정 전 관찰 결과

Java 실행 버전은 21.0.11이며 로컬 Docker 서버는 29.6.2다. 실행 컨테이너 이미지 ID는 다음과 같다(태그 이름만 확인한 결과가 아니다).

| 구성 | 이미지 ID |
| --- | --- |
| PostgreSQL | `sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2` |
| 세션 Redis·캐시 Redis | `sha256:5517128c78ca95f28f7dc6a90e2f808f35f01a4a01c2c20e514571b4d9706275` |
| nginx | `sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0` |

### 실제 Set-Cookie

쿠키 값은 생략한다. Google형·SSAFY형의 인가/성공 콜백 및 CSRF 발급 모두 동일한 생성 속성을 확인한다.

| 시점 | 이름 | Path | Secure | HttpOnly | SameSite | 만료 속성 |
| --- | --- | --- | --- | --- | --- | --- |
| 인가·성공 콜백·CSRF | SESSION | / | 있음 | 있음 | Lax | 없음(브라우저 세션 쿠키) |
| 로그아웃 첫 번째 헤더 | SESSION | / | 있음 | 없음 | Lax | `Expires=Thu, 01 Jan 1970 00:00:10 GMT` |
| 로그아웃 두 번째 헤더 | SESSION | / | 있음 | 있음 | Lax | `Max-Age=0; Expires=Thu, 1 Jan 1970 00:00:00 GMT` |
| DB 중단 콜백 원응답의 삭제 헤더 | SESSION | / | 있음 | 없음 | Lax | `Expires=Thu, 01 Jan 1970 00:00:10 GMT` |

삭제 헤더를 생성 쿠키와 같은 속성이라고 가정하지 않는다. 같은 이름·Path의 과거 만료를 확인하며, 첫 삭제 헤더에 HttpOnly가 없다는 관찰만으로 로그인 쿠키의 HttpOnly 결함으로 분류하지 않는다.

### HTTP 응답

두 제공자는 모두 합성 공급자다. 인가 응답의 `redirect_uri`와 성공 Location은 실제 시험의 HTTPS 출처·포트를 유지하며 내부 backend 포트로 돌아가지 않았다.

| 조건·요청 | 백엔드 원응답 / nginx 경유 실측 |
| --- | --- |
| 정상 로그인 인가 및 성공 콜백 | 각각 302, 로그인 후 `/api/v1/me` 200 |
| 미인증 `/api/v1/me` | nginx 경유 401 `AUTH_REQUIRED` |
| CSRF 누락·로그인 전 토큰으로 로그아웃 | nginx 경유 403 `FORBIDDEN` |
| 현재 CSRF로 로그아웃 | 204, SESSION 삭제 헤더 2개 |
| 삭제 전 토큰 재사용 / 새 CSRF 조회 후 반복 | 403 / 204 |
| 유효 세션 없는 `error=access_denied` 콜백 | 내부 401 `AUTH_REQUIRED` / nginx 302 `/oauth/callback?error=access_denied` |
| **DB 중단 직후, 기존 인증 세션 `/api/v1/me`** | **503 `DEPENDENCY_UNAVAILABLE`와 500을 서로 다른 실행에서 관찰. 503 보장 불충족** |
| **DB 계속 중단, 콜백 시험 후 동일 인증 세션 `/api/v1/me` 재요청** | **500, 기본 오류 본문(`timestamp`, `status`, `error`, `path`), 공통 `code` 없음** |
| DB 중단, 미인증 `/api/v1/me` | nginx 경유 401 `AUTH_REQUIRED` |
| DB 중단, Google형·SSAFY형 인가 | nginx 경유 302; 세션 Redis에 인가 상태 저장 가능 |
| **DB 중단, 유효 code·state 콜백** | **내부 503 `DEPENDENCY_UNAVAILABLE` / nginx 302 `/oauth/callback?error=authentication_failed`** |
| 같은 DB 주소로 재시작 후 기존 인증 세션 `/api/v1/me` | 준비 중 500을 거쳐 200 복구. 세션 재로그인 없음 |

공통 오류 작성기를 거친 401·403·503의 실제 JSON 필드는 `code`, `message` 두 개다. `fieldErrors`·`requestId`는 이 응답에 없으며 `Cache-Control: no-store`다. 위 500은 이 공통 형식에서 벗어난 별도 실패다. 미인증과 정상 분류된 의존성 장애 본문은 다음과 같다.

```json
{"code":"AUTH_REQUIRED","message":"로그인이 필요합니다."}
```

```json
{"code":"DEPENDENCY_UNAVAILABLE","message":"일시적으로 처리할 수 없습니다. 잠시 후 다시 시도해 주세요."}
```

### 분리 보고한 문제와 측정 한계

1. **239 표시 문제 재현:** DB 장애 503이 nginx에서 일반 인증 실패 Location으로 바뀐다. 현재 `callbackProblem`은 이를 `failed`로 분류하며 의존성 장애 표시를 구분하지 않는다. 실측 통과는 이 현재 동작을 재현했다는 뜻이며 239 인수 통과가 아니다.
2. **235 인증 API 장애 계약 위반:** DB가 실제 stopped 상태인 동안 `/me`가 500·기본 오류 형식으로 응답하는 경로를 재현했다. 중단 직후 한 번의 503만으로 인수하면 놓친다. 인가·콜백 실패를 여러 번 거친 뒤 같은 세션으로 `/me`를 호출하는 검사를 남기고 503 기대를 유지하므로 수정 전 검사는 실패했다. `SessionAuthenticationFilter`는 `DataAccessException`만 503으로 변환하므로 트랜잭션 시작 실패 등 다른 예외의 필터 경계를 후속 결함 분석에서 확인해야 한다. 이는 최초 관찰 당시의 조사 방향이다. 이후 실제 예외 확인과 수정은 아래 재검증 절에 기록한다.
3. **초기 복구 시험 무효와 재측정:** 자동 할당 호스트 포트가 Docker stop/start 뒤 바뀐 것을 확인했다(`database-restart-host-port-changed=true`). 앱은 재시작 전 주소를 유지했고, 기존 주소의 연결 예외 클래스는 `CannotGetJdbcConnectionException → SQLTransientConnectionException → PSQLException → ConnectException`이었다. 이 조건에서 지속된 500은 정상 주소 복원 후 복구 실패의 근거가 아니다. 시험 전용 DB에 빈 loopback 포트를 명시한 재측정에서는 동일 컨테이너·동일 주소(`changed=false`)로 준비 중 500 후 기존 세션 200 복구를 확인했다. DB 중단 중 500 문제는 포트가 바뀌기 전에도 재현되어 이 환경 문제와 별개다.
4. **환경 차이:** 테스트에서 DB 소유자와 런타임 계정을 분리하지 않았다. 운영 최소 권한·계정 분리 인수로 사용할 수 없다. 기존 테스트용 가상 별만 넣었으며 운영 튜토리얼 데이터 준비를 입증하지 않는다.

시험 준비 중 컴파일/컨테이너 호스트 연결 실패와 삭제 쿠키의 만료 형식에 대한 잘못된 예상은 검증 하네스에서 수정했다. 로그 억제 설정은 후속 테스트에 남기지 않고 원복하며, 합성 공급자의 인스턴스와 종료 수명주기를 기존 Redis 시험에서 분리했다. 수정 전에는 아래 명령이 실패했다. 기대 상태를 500으로 낮추지 않고 예외 처리 수정 후 재검증했다.

### 수정 전 마지막 검증 결과

2026-09-23 09:34:27~09:35:48 KST, 6개 클래스 **15건 중 14건 통과·1건 실패·건너뜀 0건**이다. 235 시험은 최초·지속 DB 중단 `/me`가 모두 500이어서 503 계약 검사에서 실패했다. 이후 같은 주소의 DB를 다시 시작하자 첫 복구 관찰 요청은 200이었다. 앞선 실행에서 보인 준비 중 500과 구분한다.

| 클래스 | 통과 / 실패 |
| --- | --- |
| AuthRuntimeVerificationTest | 0 / 1 |
| RedisSessionIntegrationTest | 8 / 0 |
| ForwardedHeadersConfigurationTest | 2 / 0 |
| AuthSessionTimeoutTest | 1 / 0 |
| SessionDependencyFilterTest | 2 / 0 |
| OAuthLoginSuccessHandlerTest | 1 / 0 |

마지막 DB container ID는 `2905d0ed93267d6c8f13f591abfb134a4f246b7f3e7551085aaa479e48f3fec6`다. 재시작 전후 같은 ID와 호스트 포트 `58226`을 사용했으며 앱 접속 대상은 `jdbc:postgresql://localhost:58226/test?loggerLevel=OFF`로 유지했다. 테스트 종료 후 해당 ID가 `docker ps -a`에 없는 것을 확인했다. 이 포트는 이번 시험에서 선택한 임시 포트이며 운영 포트가 아니다.

변경 문서 상대 링크 오류 0건, `git diff --check` 통과, 새 테스트·보고서의 행 끝 공백 0건을 확인했다. 운영 코드·nginx·Compose의 diff는 없다. 신규 마이그레이션, 공유 DB 변경, 운영 배포, commit·push·MR·Jira 쓰기는 수행하지 않았다.

## 백엔드 수정과 재검증(사용자 요청)

2026-09-23 같은 브랜치의 수정을 승인받아 인증 필터와 OAuth 성공 처리의 기존 DB 오류 분기에 `CannotCreateTransactionException`을 추가했다. 별도 공통 모듈·의존성·전역 예외 변환은 추가하지 않았다.

실제 중단 DB의 `MemberService.requireActive` 호출에서 `CannotCreateTransactionException`을 확인했다. `JpaRepository.findById`의 읽기 트랜잭션을 시작할 연결을 얻지 못하는 경우이며 기존 `DataAccessException` 분기로 포획되지 않았다. 이 예외를 공통 인증 필터에서 503으로 처리하므로 `/me`뿐 아니라 같은 회원 검증을 거치는 인증 API·CSRF 조회에 적용된다. OAuth 회원 생성의 트랜잭션 시작 실패도 같은 503·안전한 DB 분류 로그·세션 정리 경계로 처리한다. 다른 `TransactionSystemException`은 예상 밖 오류 500으로 유지함을 기존 단위검사에 추가했다.

2026-09-23 09:44:22~09:45:50 KST 재검증: 위 6개 클래스 **15건 모두 통과, 실패·건너뜀 0건**이다. 수정 전의 실패 기록을 대체하는 현재 결과다.

| 재측정 항목 | 결과 |
| --- | --- |
| DB 중단 직후·지속 중단 인증 `/me` | 모두 503 `DEPENDENCY_UNAVAILABLE`, 공통 JSON·no-store |
| DB 중단 인증 CSRF 조회 | 503 `DEPENDENCY_UNAVAILABLE` |
| DB 복구 대기·동일 세션 복구 | 503 → 503 → 200, 재로그인 없음 |
| 미인증 `/me`·합성 OAuth 인가·콜백 | 기존 401·302·내부 503 유지 |
| 로그아웃 CSRF·Redis·전달 헤더·안전 진단 회귀 | 통과 |

재측정 DB는 `04d6028eee18d8ceef020b838ab68a11d82224be1085673e7c4645dca1676f4b`, 전후 동일 localhost 포트 `59188`을 사용했다. 이 포트는 이번 시험 전용이다. 실행 소스는 앞선 기준 커밋에 아래 두 앱 파일 수정만 더한 것으로 식별한다. 이미지·prod·TLS·Redis 분리 조건은 위와 같다.

| 파일 | 수정 후 SHA-256 |
| --- | --- |
| SessionAuthenticationFilter.java | `be6c96b7f88040673b57a970056e359370e00e17671b11fecb712014ba4c3571` |
| OAuthLoginSuccessHandler.java | `db31426d5938cd9842005f9471263705ab2d447eed3777468376a8648221be1c` |
| AuthRuntimeVerificationTest.java | `2b1b09ff753c2820219e13b834c19240dc3ae0fe9eb6e78056b62fb0b74f8a3c` |

235 단독 수정 시점에는 239의 nginx 콜백 표시 문제가 남아 있었다. DB 장애를 일반 업무 전체에서 모두 503으로 바꾸는 변경이 아니라 인증 경계의 누락된 예외만 보완한 것이다. 이 시점에는 운영 설정·마이그레이션·배포·공유 DB 변경과 commit·push를 수행하지 않았다. 이후 239 통합에서는 아래 검사의 DB 장애 콜백 기대값을 `service_unavailable`로 변경한다. 위의 실행 식별자·해시·응답 표는 당시 측정 이력으로 보존한다.

## 재현

Docker Desktop과 JDK/Gradle Wrapper 실행 환경을 준비한다. 외부 제공자 키와 운영 `.env`는 필요하지 않다. 운영 Compose를 실행하지 않는다.

로컬 Docker 전용이다. DB 포트를 `127.0.0.1`에 고정하고 프록시를 `localhost` 인증서로 부르므로 CI(`CI=true`, dind)에서는 건너뛴다(S15P21C206-88 `backend:test`).

```powershell
Set-Location apps/backend
.\gradlew.bat -PskipLocalDb test --tests '*AuthRuntimeVerificationTest'
```

쿠키 값을 제거한 허용 목록 관찰 파일은 `apps/backend/build/runtime-235/observations.txt`에 남고, JUnit 결과는 `build/test-results/test/`에 남는다. 생성 결과·인증서·키는 Git에 추가하지 않는다. 시험용 인증서는 임시 디렉터리에서 정리하고 컨테이너는 해당 테스트 수명주기에서 정리한다.

기존 회귀와 함께 실행하는 명령은 다음과 같다. `AuthIntegrationTest`의 외부 DB 기본 연결을 사용하지 않는다.

```powershell
.\gradlew.bat -PskipLocalDb test --tests '*AuthRuntimeVerificationTest' --tests '*RedisSessionIntegrationTest' --tests '*ForwardedHeadersConfigurationTest' --tests '*AuthSessionTimeoutTest' --tests '*SessionDependencyFilterTest' --tests '*OAuthLoginSuccessHandlerTest'
```

## 미검증·후속 인수

- Google/SSAFY 실제 제공자의 등록·동의·콜백과 실제 사용자 브라우저 쿠키 동작은 미검증이다. 합성 공급자의 실제 HTTP code 교환·OIDC 서명 검증과 구분한다.
- 실제 Cloudflare TLS → Tunnel 평문 → 운영 nginx 경로, 배포 이미지 SHA, 실제 배포 연결 변수·Redis 지속성·메모리/eviction/용량, backend 직결 차단은 확인하지 않는다.
- 이 Java 런타임 검사는 `/oauth/callback` SPA를 렌더링하지 않고 nginx Location을 검증한다. 화면의 Chrome 검사는 [239 검증 기록](../../apps/frontend/docs/ticket-239-readiness.md)으로 구분한다.
- 239의 의존성 장애 표시 분리·검사 정합화는 239에서 반영한다. 실제 프록시의 전달 헤더 정제·직결 차단과 운영 인수는 별도로 남는다.
