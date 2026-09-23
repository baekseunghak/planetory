# 239 — 프론트 Nginx 배포·OAuth 장애 구분

- Jira: [S15P21C206-239](https://ssafy.atlassian.net/browse/S15P21C206-239)
- 기준: 2026-09-23 재조회한 `origin/develop`의 `67a9e741`.
- 브랜치: `fix/S15P21C206-239-web-proxy-errors`.
- 상태: 구현·로컬 검증 완료. 2026-09-23 사용자 요청에 따라 일반 MR로 제출한다. 비작성자 리뷰·병합과 실제 배포 인수는 별도이며 Jira 완료로 표시하지 않는다.
- 운영 규칙 정본: [Docker 개발·배포 기준](../../../docs/operations/docker.md).

## 범위와 출처

239의 네 가지 결함을 확인한다. 9월 21일 로컬 수정은 develop `0e2a8e9`를 기준으로 84 브랜치의 요청 시점 DNS, 전달 헤더 보존, 상대 리다이렉트를 먼저 적용한 상태였다. 9월 23일에는 기존 수정을 백업하고 최신 develop까지 fast-forward한 뒤 다시 적용했다. README의 양쪽 기록을 보존하고 Nginx의 중복 지시문을 제거했다.

| 항목 | 최신 develop에 이미 있는 부분 | 이번 239의 변경 |
| --- | --- | --- |
| 백엔드 없는 프론트 기동 | 84의 요청 시점 Docker DNS | 유지·회귀 검증 |
| HTTPS·Host 전달 | 84의 전달 헤더 보존 | 유지·회귀 검증 |
| 내부 포트 없는 리다이렉트 | 84의 `absolute_redirect off` | 유지·회귀 검증 |
| 장애·인증 실패 구분 | 콜백 503을 아직 인증 실패로 안내 | 콜백 401/403과 502/503/504 분리, 로그인 시작 장애 안내, 화면 문구·검사 추가 |

84의 `/api/v1/me` 502·504 → 401 임시 우회는 최신 develop에서 이미 제거됐다. 239는 API 상태·본문 보존을 유지하며 이를 검증한다. 위 세 항목을 이번 239에서 새로 구현한 것으로 계산하지 않는다.

## 구현 체크리스트

- [x] 백엔드가 없어도 프론트 Nginx가 실행되도록 요청 시점 DNS 해석을 사용한다.
- [x] 신뢰하는 프록시의 원래 HTTPS 스킴과 Host를 백엔드에 전달한다.
- [x] Nginx 자체 리다이렉트에 내부 포트·스킴이 붙지 않게 한다.
- [x] 콜백의 401/403 인증 실패와 502/503/504 일시 장애를 분리한다. 로그인 시작 경로의 장애에도 같은 안내를 적용한다.
- [x] `callbackProblem()`과 로그인 화면에 `service_unavailable` 분기를 추가한다. 기존 취소/실패·안전한 복귀 주소·URL 정리·수동 재시도 흐름은 유지한다.
- [x] 회원 조회를 포함한 API의 상태·본문을 보존한다. 가짜 401이나 정상 SPA HTML로 바꾸지 않는다.
- [x] 실제 Nginx를 통과하는 재현 스크립트와 Chrome 인증 회귀를 추가한다.

## 검증

2026-09-23에 최신 develop과 통합한 작업 코드로 다음을 실행했다. 브라우저 검사는 사용자 지침에 따라 Chrome만 실행했다.

| 검증 | 결과 |
| --- | --- |
| `npm run build` | 타입 검사·운영 빌드·개발 전용 코드 제외 검사 통과 |
| `npm test` | 단위 446개 통과 |
| `npx playwright test --config=playwright.auth.config.ts --project=chrome` | 기존 로그인·닉네임·세션·로그아웃 및 장애/복구 검사 14개 통과 |
| `npm run test:nginx` | 실제 Docker 기본 runtime 빌드·Nginx 문법·HTTP·Chrome 검사 9개 통과 |
| `git diff --check`, 변경 문서 상대 링크 | 통과 |

Nginx 검사는 백엔드 DNS가 없는 상태의 정적 화면 기동, API 502 유지, 로그인 시작/콜백 장애 안내, 백엔드의 뒤늦은 등록과 자동 해석, HTTPS 헤더·Host·인코딩된 URI·PATCH 본문·CSRF 전달, 상대 리다이렉트, 콜백 성공/취소/인증 실패/장애 분기, API 401/403/404/500/502/503/504 상태·JSON 보존과 실제 Chrome 화면을 포함한다. 이번에는 로그인 시작 경로에서도 401/403 보존과 502/503/504 분리를 추가로 고정했다. 실패한 재실행이 이전 성공 결과를 남기지 않도록 결과 파일에 시작·종료 시각과 진행/실패/성공 상태를 기록한다.

9월 21일의 단위 360개·Chrome 13개·Nginx 8개는 이전 소스의 이력이며 위 최신 검증 건수에 합산하지 않는다. 운영 빌드에는 기존 Vite 설정 import 확장자와 500kB 초과 번들 경고가 남지만 타입·빌드·개발 코드 제외 검사는 통과했다.

로컬 Node 24.18.0과 Docker Engine 29.7.2를 사용했다. 컨테이너 빌드는 저장소 Dockerfile의 Node 22 Alpine 및 Nginx unprivileged 1.27 Alpine을 사용했다. Docker가 꺼져 있어 확인한 임시 소켓 폴더만 백업 후 기존 복구 실행기로 기동했으며, 없는 임시 폴더는 건너뛰었다. 기존 데이터·볼륨은 초기화하지 않았다. 테스트가 생성한 컨테이너와 네트워크는 종료·삭제된 것을 확인했다.

`npm run test:nginx`는 개인 Google·SSAFY 계정, OAuth 비밀키, 기존 DB를 사용하지 않는다. 결과 JSON과 화면은 무시된 `test-results/nginx/`에 저장한다. 실제 배포 HTTPS, Cloudflare, Spring 전달 헤더 해석, 외부 제공자 로그인은 이 합성 검증의 통과 범위가 아니다.

## 후속 반영

일반 MR은 `fix/S15P21C206-239-web-proxy-errors`에서 `develop`을 대상으로 하며 비작성자 리뷰 후 병합한다. 현재 Jira는 `해야 할 일`로 확인했으며 이번 제출에서 상태를 바꾸지 않는다. 실제 배포 담당자는 변경 이미지의 SHA를 확인하고 배포된 Nginx/백엔드를 통한 원래 HTTPS 콜백을 확인한다. 이 티켓의 로컬 수정 완료를 서비스 전체 인수(216)나 배포 완료로 표시하지 않는다.

기술 근거: [Nginx proxy_pass의 변수·resolver 동작](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass), [Nginx 상대 리다이렉트](https://nginx.org/en/docs/http/ngx_http_core_module.html#absolute_redirect).
