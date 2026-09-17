# 201번 작업 범위와 인수 상태

대상: [S15P21C206-201](https://ssafy.atlassian.net/browse/S15P21C206-201), 공용 프론트 실행환경·라우터·API 클라이언트 구성. 갱신일: 2026-09-17.

## 현재 판단

공통 코드와 실제 로컬 인증 연결은 검증했고 MR !34는 9/15에 develop으로 병합되었다. 9/17에는 지웅님의 182 실제 분석 컴포넌트와 공통 기반을 함께 실행해 단위 41·Chromium 20·운영 빌드 2, 공통 Chrome/Edge/Firefox 각 9개를 통과했다. **A 화면 공유·공통 연결과 develop 병합은 더 이상 대기 항목이 아니다.** [9/17 통합 검증과 한계](foundation-integration-201-validation.md)를 따른다.

실제 기능 입력 API 오류 대조는 재실행해 완료했다. 최신 백엔드 0b7436f·격리 DB·가상 제공자에서 201/182 공통 클라이언트 총30개 확인점이 통과했다. [실제 결과](live-feature-errors-201-results.json). 배포 HTTPS와 실제 Safari도 미검증이다. Jira는 진행 중을 유지하며 이번에는 상태나 완료 기준을 바꾸지 않았다.

실제 A 컴포넌트 연결 검사는 fixture 응답을 사용한 프론트 통합 증거이며 실제 분석 백엔드 인수를 대신하지 않는다. 티켓의 완료 조건을 삭제하거나 배포 미검증을 통과로 바꾸지 않는다. 분석 전체 기능과 W04 전체 OAuth UI 완성을 201의 선행 조건으로 추가하지 않는다.

- 작업 브랜치: feature/S15P21C206-201-web-shared-foundation.
- 기존 [MR !34](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/merge_requests/34)는 병합 커밋 `112aa83`으로 develop에 포함되었다. 원격 201 브랜치는 삭제되어 있으며 새 브랜치나 MR은 만들지 않았다.
- 현재 develop 확인 기준은 `0b7436f`, A/W 통합 실행 기준은 182의 `507bd30`이다. 기존 실제 제공자 인증의 버전과 환경은 각 기록에 남긴다. 이번 프론트 브랜치를 재기준화한 것은 아니다.

## 포함 범위

- React·TypeScript·Vite 실행환경, 공통 메뉴·1024px 안내·공용 라우터.
- 평면 /api/v1/me 회원 조회, 쿠키 포함 요청, 401 세션 정리, 403/404 및 fieldErrors.reason 보존.
- 매 쓰기 전 CSRF 발급, 취소·시간 초과 중 늦은 쓰기 차단, 일반 POST/PATCH 자동 재전송 금지.
- 공통 헤더 로그아웃, 성공 확인 전 회원 정보 유지, 응답 유실 시 명시적인 로그인 상태 확인.
- 같은 앱에서 TIC·History·원 글·복귀 주소를 전달하는 PageSlots, 개발 fixture와 운영 번들 분리.
- Vite/Nginx의 API·OAuth 진입/콜백 프록시 및 연결 문서.

은하 렌더러·별 상세·행성·분석 기능과 완성형 로그인 화면은 각각의 기능 티켓 범위다. 개인 시제품은 유지한다. 202~204는 별도 후속 실행에서 공통 연결을 반영했다.

## 완료 조건 대조

| 조건                         | 확인한 증거                                                                                     | 남은 범위                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 실행환경·빌드·공통 오류 처리 | 기존 201 검증 및 develop 병합, 9/17 실제 A 컴포넌트를 포함한 통합 검사 통과                     | 해당 로컬 공통 기반 검증 완료. 배포 검증은 아래 별도 항목                                                         |
| 실제 인증된 GET·쿠키·CSRF    | 실제 SSAFY 및 Google 로그인, /me 200, 새로고침, CSRF 조회, 로그아웃 204, 이후 /me 401           | 배포 HTTPS에서 같은 동작 확인                                                                                     |
| 401/403/404·fieldErrors      | 실제 로컬 HTTP 오류, 실제 백엔드 공통 오류 처리기가 생성한 본문을 기존 클라이언트로 대조        | 실제 profile/onboarding 오류 확인 완료. 빈 fieldErrors 생략을 수용했다. 비어 있지 않은 배열은 기존 계약 검사 증거 |
| A/W 공통 라우터·세션         | 182 실제 AnalysisPage와 한 라우터/SessionProvider/API 클라이언트, 회원·TIC·복귀·새로고침 재검증 | 201-08 검증 완료. History 소비자는 fixture이며 개별 기능 전체 인수는 각 티켓에서 진행                             |
| POST/PATCH 자동 재전송 금지  | 취소·시간 초과·403·응답 유실에서 쓰기 반복 없음                                                 | 각 기능의 폼 복구·멱등 정책은 해당 기능에서 검증                                                                  |
| 직접 URL·작은 화면·운영 분리 | 로컬 개발/dist 및 앞선 Nginx 인증 경로·쿠키 검사                                                | 배포 주소의 직접 진입/새로고침과 실제 Safari                                                                      |
| 티켓 종료                    | 구현·시험·계약·한계를 문서로 제공, 기존 MR develop 병합 확인                                    | 배포 HTTPS·Safari, Jira 최종 증거 등록·완료 정리                                                                  |

현재 서버 ErrorResponse에는 추적 ID가 없다. 선택적 응답 헤더 보존과 브라우저 내부 localRequestId를 구분하며 새 서버 추적 기능을 완료 조건으로 추가하지 않는다.

## 다음 담당자가 할 일

1. **완료:** 실제 프로필/첫 방문 안내 오류를 공통 클라이언트2종으로 대조했다. 현재 빈 fieldErrors 생략은 정상 계약이며 새 백엔드 기능을 요구하지 않는다.
2. **서진:** 이번 182 실제 컴포넌트 연결 검증을 201 완료 자료에 사용한다. 지웅님에게 새 검사용 분석 화면을 요구하거나 182의 전체 완료를 기다리지 않는다.
3. **배포 담당/서진:** 배포 주소와 API upstream이 준비되면 직접 URL/새로고침, 실제 로그인·/me·로그아웃, HTTPS 쿠키·OAuth 콜백을 확인한다. 실제 Safari 실행 환경이 준비되면 지원 브라우저 검증도 추가한다.
4. **서진/팀:** 이미 병합된 코드와 남은 인수 증거를 구분해 Jira에 정리한다. 배포 조건을 후속 작업으로 분리하려면 별도 팀 결정을 기록하며, 이번에는 완료 기준이나 Jira 상태를 변경하지 않는다.

## 근거

- [9/17 실제 분석 컴포넌트 통합 검증](foundation-integration-201-validation.md)
- [검증 기록](verification.md)
- [실제 SSAFY](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/blob/599ef655def3959b44751fccfc16e44d43990de9/apps/frontend/docs/auth-ssafy-201-validation.md) / [실제 Google](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/blob/599ef655def3959b44751fccfc16e44d43990de9/apps/frontend/docs/auth-google-201-validation.md)
- [실제 백엔드·시험 제공자·Nginx](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/blob/599ef655def3959b44751fccfc16e44d43990de9/apps/frontend/docs/auth-backend-201-validation.md)
- [공통 오류 생성/전달 검증과 한계](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/blob/599ef655def3959b44751fccfc16e44d43990de9/apps/frontend/docs/auth-error-201-validation.md)
