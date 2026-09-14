# W03 명세 대조·검증 기록

대상: `S15P21C206-201`, 기준 develop `321f10b`, SRS v1.2·서비스 API 2~3절·서버 ErrorResponse. 작성일 2026-09-14.

## 요구사항 대응

| 기준                         | 코드/검증 대상                      | 완료 판단 범위                                                            |
| ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| React·TS·Vite 공용 앱        | package, main, App                  | 타입·빌드·lockfile 재설치 확인                                            |
| ACC-03 / NFR-06 인증 게이트  | SessionProvider, ProtectedRoutes    | 인증 조회 fixture·401 직접 경로와 만료 처리; 실제 S03 검증은 대기         |
| ACC-04 세션 확인             | /api/v1/me decoder, clear, 취소     | 평면 memberId·상태 구분, clear는 서버 로그아웃을 대체하지 않음            |
| 공통 401/403/404·fieldErrors | api/client, RequestState            | 서버의 field/reason 보존·권한과 인증 구분·수동 읽기 재조회                |
| 요청 식별                    | ApiError.localRequestId / requestId | 로컬 식별 및 설정된 응답 헤더 보존 테스트; 서버 헤더 합의는 대기          |
| A/W 같은 라우터              | PageSlots, pagePath, usePageContext | 같은 앱의 시험 소비자로 검증; 실제 분석 컴포넌트 통합은 대기              |
| ID·BTJD/UTC                  | string 경로/decoder, shared/types   | ID 손실 방지·시각 타입 구분; 분석 과학 단위 변환은 A 범위                 |
| 자동 재전송 금지             | api/client                          | POST/PATCH 유실·취소·시간 초과는 자동 재시도 없음; 폼 복구는 각 기능 티켓 |
| NFR-08 공통 접근성           | 메뉴 dialog, RequestState           | 키보드/포커스 복귀·로딩/오류; 별/그래프 접근성은 별도 티켓                |
| NFR-17                       | DesktopGate                         | 1023px 안내 / 1024px 서비스 표시; 실제 Safari·모바일 성능 보증 아님       |
| NFR-19 / 개발 기능 분리      | dev fixture, production 검사        | 운영 번들에 계정/리셋/성과 시연·가상 회원 데이터 없음                     |
| 직접 URL·새로고침            | BrowserRouter, nginx.conf           | Vite 브라우저 검증; Docker/Nginx 배포 실행 검증은 별도                    |

## 실제 실행 결과

실행 환경: Windows, Node v24.18.0, npm 11.16.0. Docker 기준 Node 22에서의 실행은 미검증이다. 아래는 이번 작업에서 새로 실행한 결과이며 기존 시제품의 과거 기록이 아니다.

| 검사                                          | 실제 결과                                                                                                                                                        |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci --no-audit --no-fund`                 | lockfile로 37개 패키지 재설치 성공                                                                                                                               |
| `npm run build`                               | TypeScript 통과, Vite 배포 빌드 통과, 개발 기능 미포함 검사 통과                                                                                                 |
| `npm test`                                    | 12개 통과: 평면 회원 DTO, 문자열 ID, 복귀 문맥, 쿠키/Headers, reason 오류, 401/403/404, 204, 본문 수신 중 취소, 자동 재전송 금지, 타임아웃, 쓰기 취소의 불확실성 |
| Chromium                                      | 화면 검증 6개 통과                                                                                                                                               |
| 설치된 Chrome                                 | 같은 화면 검증 6개 통과                                                                                                                                          |
| 설치된 Edge                                   | 같은 화면 검증 6개 통과                                                                                                                                          |
| `npm run test:production`                     | 2개 통과: 서버 미설정 503·자동 가짜 로그인 없음, 실제 dist 직접 주소/새로고침/복귀/개발 라우트 미포함                                                            |
| `vite build --mode fixture` + production 검사 | 개발 모드 이름으로 빌드해도 고정 회원/확인 화면이 배포되지 않음                                                                                                  |
| Firefox                                       | 6개 모두 브라우저 시작 단계의 `browserType.launch: spawn UNKNOWN`. 페이지 동작을 검증한 결과가 아니며 통과로 세지 않음                                           |
| Safari / Docker Nginx / 실제 S03              | 실행 환경 또는 실제 인증 구현 부재로 미검증                                                                                                                      |

브라우저 6개 시나리오: 인증 쿠키/같은 회원/TIC·History·복귀값/새로고침, 401 직접 경로 및 만료 뒤 보호 화면 제거, 403/404/필드 reason 및 재조회 복구, 이전 경로의 늦은 응답 무시, 메뉴 Tab 순환/Escape/포커스 복귀 및 1023/1024 경계, 잘못된 회원 응답과 /accounts 라우트 차단.

정상 배포 JS는 약 245KB(압축 약 79KB), CSS 약 2.8KB다. 이 수치는 공통 연결 자리의 빌드 크기이며 은하 지도 성능 인수 결과가 아니다.

## 미완료·경계

- Git에 실제 /api/v1/me·OAuth·세션 구현이 없어 실제 인증된 요청·CSRF 동작을 확인할 수 없다.
- 새 공통 앱에는 201번 외 기능 화면을 등록하지 않았다. 이전 은하 지도 등은 기존 작업 폴더에 보존되어 있다.
- 백지웅 담당 실제 화면과 공통 구조를 사용하는 통합 검토가 남았다. PageSlots fixture는 구조 확인용이다.
- 이 PC에서 Docker 명령이 확인되지 않아 Nginx 컨테이너 실행 인수는 아직 하지 않았다.
- Firefox 시작 오류를 해결한 환경에서 다시 실행하고, Safari 및 Node 22 기준을 추가 검증해야 한다. 기본 `npm run check`의 Chromium 통과가 이 검증들을 대체하지 않는다.
- Jira는 진행 중을 유지한다. 타입/fixture/브라우저 검사 통과만으로 완료 또는 전체 서비스 완성을 선언하지 않는다.

## 201번 범위 분리 후 재검증

2026-09-14, 은하 렌더러·별 상세·퀘스트 등 후속 기능을 분리한 공통 기반에서 다시 실행했다.

- `npm ci --no-audit --no-fund`: lockfile 기준 37개 패키지 설치 성공.
- `npm run check`: 타입·빌드·운영 코드 분리 검사, 단위 12개, Chromium 6개, dist 2개 모두 통과.
- `npm run format:check`: 통과.
- 코드와 별도로 기본 fixture 실행 포트를 58267로 구분했다. 테스트 전용 포트는 기존과 같다.
- 최신 `origin/develop`은 `321f10b`이며 실제 인증 구현이 아직 없다. 인증 담당 Jira는 `S15P21C206-156`, 확인 시점 해야 할 일이다.
- 이번에는 실제 백엔드·A 컴포넌트·Safari·Firefox·Docker·배포 인수를 통과했다고 기록하지 않는다. [완료 조건 대조](ticket-201-readiness.md)에 재개 조건을 적었다.
