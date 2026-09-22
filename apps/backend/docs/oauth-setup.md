# OAuth 로그인·세션 설정

Google OIDC와 표준 OAuth2 방식 SSAFY 로그인을 Spring Security에 연결한다.
회원은 `users(provider, provider_user_id)`로 식별하며 제공자가 다르면 같은 이메일이어도 합치지 않는다.
SSAFY는 제공받은 2026-09-15 통합 가이드의 URL·client_secret_post·userId 형식을 반영했다.
실제 제공자의 로그인·동의 및 콜백은 등록 주소를 맞춘 뒤 사용자 브라우저에서 확인한다.

## 1. 실행과 제공자 등록

키가 없으면 기본 `local` 프로필로 서버·테스트를 실행할 수 있다. 인증 API는 보호되며 개발용 로그인 우회 API는 없다.
제공자 프로필을 켜면 필요한 환경변수가 없을 때 기동이 실패한다. 예시 값을 실제 키로 취급하지 않는다.

현재 PC는 `apps/backend/.env.oauth.properties`에 Google·SSAFY 키와 로컬 콜백을 저장했다.
이 파일은 Git·Docker 이미지에서 제외되고, `apps/backend`를 작업 디렉터리로 실행할 때 자동으로 읽는다.
파일 내용은 공유하지 않는다. Gradle 테스트는 이 파일을 읽지 않고 테스트 제공자만 사용한다.
개인 파일의 `spring.profiles.include=local,oauth-ssafy`로 로컬 DB 설정도 함께 활성화한다.
IDE도 작업 디렉터리를 `apps/backend`로 지정한다. 다른 PC에는 개인 설정이 자동으로 전달되지 않는다.

### Google

Google 콘솔에서 **웹 애플리케이션** OAuth 클라이언트를 만들고 승인된 리디렉션 URI에 다음을 등록한다.

```text
http://localhost:8080/login/oauth2/code/google
https://<운영 도메인>/login/oauth2/code/google
```

PowerShell 예시(환경변수 값은 IDE 실행 설정이나 로컬 비밀 설정에 보관):

```powershell
$env:SPRING_PROFILES_INCLUDE = 'oauth-google'
$env:SPRING_PROFILES_ACTIVE = 'local'
$env:GOOGLE_CLIENT_ID = '<웹 클라이언트 ID>'
$env:GOOGLE_CLIENT_SECRET = '<클라이언트 비밀 값>'
$env:GOOGLE_REDIRECT_URI = 'http://localhost:8080/login/oauth2/code/google'
.\gradlew.bat bootRun
```

다운로드한 Google JSON은 `web.client_id`, `web.client_secret` 값을 위 환경변수에 연결한다.
`installed` 형태의 데스크톱 클라이언트 JSON은 이 서버 콜백용 웹 클라이언트로 대체한다.
JSON 원본을 저장소에 복사하지 않는다. Spring Boot가 Google JSON이나 일반 `.env` 파일을 자동으로 읽지는 않는다.
2026-09-15 `web` 유형 클라이언트(프로젝트 `planetory-oauth`)를 받아 현재 PC 개인 파일에 연결했다.
개인 파일은 `spring.profiles.include=local,oauth-google,oauth-ssafy`와 `GOOGLE_*` 세 값을 가진다.

`http://localhost:8080/login`에서 Google 버튼을 누른다. 성공 후 기본 목적지는 `/api/v1/me`다.
프론트가 구현되면 `AUTH_SUCCESS_URL=/auth/complete`처럼 **같은 출처의 고정 경로**로 바꾼다.
`returnUrl` 같은 요청 값으로 로그인 완료 목적지를 정하지 않는다.

### SSAFY

`SPRING_PROFILES_INCLUDE=oauth-google,oauth-ssafy`로 두 제공자를 함께 켠다.
SSAFY 앱 등록 화면의 다음 세 값만 개인 파일 또는 환경변수에 넣는다.

| 환경변수 | 의미 |
|---|---|
| `SSAFY_CLIENT_ID`, `SSAFY_CLIENT_SECRET` | 발급받은 앱 자격 증명 |
| `SSAFY_REDIRECT_URI` | 등록한 백엔드 `/login/oauth2/code/ssafy` 전체 주소 |

가이드에 따라 다음 설정은 코드에 고정했다.

| 항목 | 값 |
|---|---|
| 인가 URL | `https://project.ssafy.com/oauth/sso-check` |
| 토큰 URL | `https://project.ssafy.com/ssafy/oauth2/token` |
| 사용자 정보 URL | `https://project.ssafy.com/ssafy/resources/userInfo` |
| 클라이언트 인증 | `client_secret_post` — form body에 ID·Secret 전달 |
| 회원 식별 | 최상위 `userId` |
| 사용자 정보 요청 | Bearer 헤더 + form-urlencoded Content-Type |

scope는 인가 요청에 보내지 않는다. 개인정보 동의는 개발자센터에서 설정하며 로그인에는 고정 제공되는 userId만 필요하다.
단, 개발자센터에서 제공 정보 항목을 하나도 선택하지 않으면 `sso-check`가 "예상치 못한 에러(ERROR ID)" 화면을 띄운다(2026-09-15 확인).
이메일·이름 등은 저장하지 않으므로 최소 항목만 선택한다.
가이드의 `Code` 표기도 SSAFY 콜백에서만 소문자 `code`로 변환한다. 둘이 함께 오면 모호한 요청으로 거절한다.

**실연동 확인 사항:** 가이드에 `state` 요청·반환 설명이 없다. 서버는 로그인 시작 시 임의의 state를 생성하고
콜백에서 동일한 값을 검증한다. 누락·불일치면 401이다. 실서버가 state를 반환하지 않으면 공급자 지원 여부를 확인해야 하며,
세션의 state를 콜백에 임의로 채우거나 검증을 끄지 않는다.

### 개발자센터에서 수정할 주소

- SSAFY Redirect URI: **`http://localhost:8080/login/oauth2/code/ssafy`**
- Google 승인된 리디렉션 URI: **`http://localhost:8080/login/oauth2/code/google`**
- 별도 서비스 주소 항목이 있다면 현재 백엔드 로그인 진입점은 **`http://localhost:8080/login`**이다.
- 스크린샷의 `/api/auth/ssafy/callback`, `http://localhost:5173/oauth/callback`은 현재 구현의 콜백이 아니다.
- 추후 프론트의 서비스 주소와 OAuth 백엔드 콜백 주소를 구분한다. 운영 도메인은 아직 미정이며,
  운영 등록 시 `https://<도메인>/login/oauth2/code/ssafy`와 Google 대응 경로를 각각 추가한다.

## 2. 최초 가입에 필요한 데이터

최초 가입은 회원·기본 설정·튜토리얼 1번 별 발견·진행 상태를 한 트랜잭션으로 생성한다.
`tutorial_stars`의 활성화된 `seq=1`과 그에 연결된 `stars` 행이 필요하다.
운영자가 정한 실제 튜토리얼 TIC을 넣어야 하므로 임의의 운영 seed는 만들지 않는다.
초기 데이터가 없으면 콜백은 `503 DEPENDENCY_UNAVAILABLE`이고 회원 생성도 롤백된다.
테스트는 격리된 스키마에 가상의 튜토리얼 별을 넣고 종료 후 그 스키마만 삭제한다.

첫 별의 자리는 이후 발견 별과 같은 `GalaxyLayout.place(userId, ticId)` 결과를 `world_x`·`world_y`·`depth_z`·`layout_version`으로 저장한다(탐사 API 4.1·9.4절).
**임시:** 은하 배치 함수는 `S15P21C206-139`에서 구현한다. 그 전까지 `BootstrapGalaxyLayout`이 원점과 `layout_version=bootstrap-0`을 저장한다.
139의 구현이 병합되면 이 클래스를 삭제한다. `bootstrap-0` 좌표가 남은 개발 DB는 별 지급 기록만 지우지 말고 [개발 환경 안내의 V4 DB 준비](development-setup.md#v4-erd-v12-반영)에 따라 새 DB를 쓰거나 회원 관련 데이터까지 함께 정리한다. 기존 회원은 로그인해도 첫 별이 다시 생성되지 않는다. 배치에 실패하면 회원 생성도 롤백된다.

닉네임은 `별_`와 16자리 임의 16진수로 자동 생성한다. 기존 V1의 `lower(nickname)` 유일 인덱스를 사용한다.
닉네임 중복 제약이 이미 있으므로 V1 수정이나 중복 마이그레이션은 추가하지 않았다.
동시 최초 로그인은 제공자 ID 유일 제약으로 한 회원만 생성한다.
`withdrawn` 회원은 자동 복구하지 않고 로그인·기존 세션 사용을 거절한다.

## 3. API·브라우저 계약

| 메서드·주소 | 결과 |
|---|---|
| `GET /login` | 설정된 제공자만 표시하는 로그인 안내 페이지 |
| `GET /oauth2/authorization/google` 또는 `/ssafy` | 제공자 로그인 시작 |
| `GET /login/oauth2/code/{provider}` | 백엔드 콜백, 성공 시 고정 프론트 경로로 이동 |
| `GET /api/v1/me` | 내부 회원 ID(`u-숫자`)·닉네임·권한·설정·탐사 요약 |
| `GET /api/v1/auth/csrf` | `{ "headerName": "X-CSRF-TOKEN", "token": "..." }` |
| `POST /api/v1/auth/logout` | 현재 세션 무효화·SESSION 쿠키 삭제, 204 |

설정된 제공자가 없는 경우 `/login`은 503 안내 페이지를 반환한다.
API 미인증·만료는 `401 AUTH_REQUIRED`, 권한 부족·CSRF 검증 실패는 `403 FORBIDDEN`이다.
OAuth 콜백 검증 실패도 토큰이나 제공자 오류 원문 없이 401 JSON으로 응답한다.
로그아웃은 로그인 여부와 관계없이 현재 세션의 유효한 CSRF 토큰이 필요하다(234, 사용자 승인 2026-09-22). 토큰 없음·오류·이전 세션 토큰은 403이다. 반복 요청은 새 CSRF 토큰 조회 후 보내면 204다. 만료 경계와 재시도는 [서비스 API 3.3절](service-api-spec.md#33-로그아웃)을 따른다.

브라우저는 로그인 성공 후 CSRF를 다시 조회하고 변경 요청에 전달한다.
Spring의 기본 XOR/BREACH 보호 토큰을 응답 그대로 사용하며, 직접 디코딩하지 않는다.

```javascript
// 같은 출처의 프론트에서 실행한다. csrfToken은 메모리에만 보관한다.
const csrf = await fetch('/api/v1/auth/csrf', { credentials: 'include' }).then(r => r.json());
const response = await fetch('/api/v1/auth/logout', {
  method: 'POST', credentials: 'include', headers: { [csrf.headerName]: csrf.token }
});
if (response.ok) {
  // 프론트의 개인 데이터 캐시·로그인 상태를 비우고 로그인 화면으로 이동한다.
  location.assign('/login');
}
```

401 응답에서도 개인 데이터 캐시를 비우고 재로그인 안내로 이동한다.
`/api/v1/me`의 닉네임·역할은 DB의 현재 값을 읽으므로 세션 재발급이 필요 없다.
타인 자원의 소유권 검사는 각 도메인 서비스가 내부 회원 ID로 수행해야 한다.
`/api/v1/operator/**`는 운영자 권한을 요구하며, 해당 업무 API는 별도 구현 대상이다.

## 4. 세션·배포

- 서비스 인스턴스는 1개로 확정됐고 세션은 EC2-A `redis-session`에 둔다(2026-09-17 리뷰 반영, 구현 `S15P21C206-237`). 계산 캐시는 별도 `redis-cache`다. 배포·재시작은 전면 중단이지만 `redis-session`을 함께 재시작하지 않으면 로그인은 유지된다. 237에서 Spring Session Redis를 구현했으며 격리 환경에서 검증한다. 공유·운영 Redis 연결 및 배포 완료를 의미하지 않는다. 기존 메모리 세션은 첫 전환 시 승계하지 않으므로 재로그인이 필요하다.
- 마지막 유효 인증 API 요청 접수 시각부터 정확히 30분이다. 만료 시각과 같아도 401이다.
- 폴링·입력 오류·권한 부족도 유효 인증 요청이면 연장한다. 정적 경로·개발 hello·CSRF 토큰 조회는 연장하지 않는다.
- 별도 토큰 갱신·주기적 heartbeat API는 없다. 동시에 여러 기기를 로그인할 수 있다.
- 로그인 중 Spring이 세션 ID와 CSRF 토큰을 교체한다. 로그인 완료 후 제공자 access/refresh token과 원본 principal은 보관하지 않고 내부 회원 ID로 교체한다.
- 세션 쿠키 이름은 `SESSION`, `HttpOnly`, `SameSite=Lax`다. 운영은 `Secure=true`, local만 false다.
- 운영 브라우저는 HTTPS로 접속한다. 프록시는 `/login`, `/oauth2/`, `/api/`를 백엔드로 전달한다.
- 프론트/API는 같은 출처로 제공한다. 개발 Vite 프록시도 위 경로를 백엔드로 전달하고 등록 콜백 주소를 그 출처에 맞춘다. `localhost`와 `127.0.0.1`을 섞지 않는다.
- 외부 Origin에 대한 CORS 허용은 추가하지 않았다. 별도 출처가 필요하면 허용 Origin·쿠키 정책을 명시적으로 설계한다.
- `infra/service/compose.yaml`에 제공자 환경변수 전달을 추가했다. 서버 `.env` 또는 보호 변수에 값을 설정한다.
- Compose의 프로필 선택 변수는 `OAUTH_PROFILES=oauth-google,oauth-ssafy`다. 컨테이너 안에서는 `SPRING_PROFILES_INCLUDE`로 전달된다.
- Spring Session Redis가 CSRF·OAuth 인가 요청·SecurityContext·활동 시각을 저장한다. 제공자 authorized client는 기존 성공 처리에서 제거하므로 제공자 토큰을 장기 보관하지 않는다. 실제 로컬 OAuth 서버의 code 교환·콜백·로그아웃으로 직렬화 경계를 검증한다(`S15P21C206-237`).
- 다중 인스턴스는 별개 문제다. `SecurityConfig`의 세션 부재에 따른 로그아웃 CSRF 면제는 234에서 제거했다. 남은 선행 항목은 [EC2 서비스 진입·장애 전환 경계](../../../docs/architecture/ec2-service-entry-failover.md) 6절을 따른다.


### Redis 연결과 저장 경계(237)

사용자 승인일은 2026-09-22다. 단일 앱의 재시작 후 로그인 유지가 목적이며 다중 앱 지원은 포함하지 않는다. `SESSION_REDIS_HOST`·`SESSION_REDIS_PORT`와 `CACHE_REDIS_HOST`·`CACHE_REDIS_PORT`를 각각 별도 인스턴스로 주입한다. 필요한 경우 `SESSION_REDIS_PASSWORD`·`CACHE_REDIS_PASSWORD`를 안전한 환경 설정에서 주입한다. 동일 host/port 설정은 기동 시 거절한다. 주소·운영 포트의 기본값은 두지 않는다.

- Spring Session은 세션 전용 연결과 `planetory:session` 키를 사용한다. 기본 RedisTemplate은 계산 캐시 전용 연결을 사용하며 세션 TTL을 계산 캐시 TTL로 재사용하지 않는다.
- `RedisSessions`는 단일 앱에서 저장·삭제·활동 갱신만 같은 공정 잠금으로 직렬화한다. 잠금 대기·Redis 연결·명령 타임아웃은 각각 2초이며 잠금 획득 실패도 503이다. HTTP 업무 처리 전체를 잠그지 않고 세션 내용이나 무효화 목록을 프로세스 메모리에 보관하지 않는다. 다중 앱에서는 이 잠금이 유효하지 않으므로 Redis 원자 연산으로 교체해야 한다.
- 유효 인증 요청의 활동 시각을 Redis에 즉시 반영하고, 지연된 응답의 저장은 최신 시각과 합쳐 단조 증가를 유지한다. 인증 세션의 만료 시각은 마지막 활동+30분이며 CSRF 조회·정적 요청은 TTL을 연장하지 않는다. 활동 시각이 없으면 인증을 거절한다.
- `ON_SAVE`·변경된 속성만 저장하는 정책을 고정한다. 기존 세션 저장과 삭제를 같은 경계에서 실행해 로그아웃/ID 교체 이후 늦은 저장이 이전 세션을 다시 만들지 못하게 한다.
- Spring Session의 기본 응답 커밋 훅이 본문 전송·flush 전에 세션을 저장한다. 외부 오류 필터는 커밋 전 Redis 읽기/저장 실패를 503 `DEPENDENCY_UNAVAILABLE`로 변환한다. 응답 본문을 별도 복사·캐시하지 않는다. 오류 필터는 한 번만 등록하고 OncePerRequestFilter의 ASYNC/ERROR 재디스패치 제외 기본값을 유지한다. 현재 동기 API 경로를 검증하며 향후 비동기·스트리밍은 요청 종료 후 세션 변경을 허용하지 않도록 별도 검토한다. 이미 커밋된 응답의 오류를 거짓 새 응답으로 덮지 않는다.
- 테스트는 일회용 PostgreSQL·Redis 두 개를 사용한다. 앱 컨텍스트 전체 종료/재기동과 로컬 OAuth 공급자 HTTP 교환을 검증하며, 실제 Google/SSAFY 제공자 인수·운영 프로세스 배포·Redis 자체 재시작 persistence는 검증 범위 밖이다.
- 84 원격 브랜치 `8be195fb`의 Compose에서는 두 Redis 연결 구성을 확인하지 못했다. 운영 연결값·메모리·eviction·persistence 인수는 84 담당으로 남긴다. 운영 인프라는 변경하지 않는다.

검증 명령은 `./gradlew -PskipLocalDb test --tests '*RedisSessionIntegrationTest'`다. 이 테스트는 자체 컨테이너만 중지/일시정지하며 기존 개발 DB를 사용하지 않는다. 기존 MockHttpSession 회귀는 테스트 작업에서만 `planetory.session.redis.enabled=false`를 사용한다. 이 속성은 배포 설정에 넣지 않는다.

## 5. 코드 위치와 검증

```text
domain/auth/controller · dto    CSRF 조회
domain/auth/oauth               검증된 제공자 사용자 → 회원 → 세션
domain/auth/service             세션 로그인·활동 시각·무효화
domain/member                  회원·설정 저장과 내 정보 API
domain/exploration/service     가입 시 첫 별 초기화, 프로필 탐사 요약
global/security                SecurityConfig, 세션 필터, principal, 오류 응답
```

```powershell
.\gradlew.bat test
```

`AuthIntegrationTest`는 로컬 테스트 OAuth 서버와 실제 PostgreSQL 격리 스키마로 검증한다.
Google과 같은 OIDC code 교환·RSA 서명 검증, SSAFY용 표준 OAuth2 UserInfo 경로,
state·nonce·audience·issuer·만료·서명 오류, 동시 가입, 초기화·배치 실패 롤백, 첫 별 좌표·배치 버전 저장과 좌표 CHECK 제약,
30분 만료·활동 연장, 현재 역할·상태 반영, CSRF·세션 ID 교체·기기별 로그아웃을 포함한다.
실제 Google·SSAFY 앱 등록/동의 화면과 프록시·HTTPS 쿠키 검증은 자격 증명 설정 후 별도로 수행한다.

참고: [Spring OAuth2 Login](https://docs.spring.io/spring-security/reference/servlet/oauth2/login/advanced.html),
[Spring CSRF](https://docs.spring.io/spring-security/reference/servlet/exploits/csrf.html),
[Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect).
