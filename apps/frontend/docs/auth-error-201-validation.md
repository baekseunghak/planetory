# 201 오류 응답 검증 · 2026-09-15

## 판정

공통 오류 처리에서 프론트 수정이 필요한 결함을 발견하지 못했다. 실제 인증·CSRF 연결과 공통 오류 생성/전달 계약을 검증했다. 인증된 실제 입력 기능 API를 통한 fieldErrors 종단 시험은 하지 않았다. 이를 위해 새 닉네임 API나 서버 추적 ID 구현을 201의 필수 선행으로 추가하지 않는다. 현재 상태는 [인수 문서](ticket-201-readiness.md)를 따른다.

## 검증 결과

| 검사                              | 결과  | 범위                                                               |
| --------------------------------- | ----- | ------------------------------------------------------------------ |
| 프론트 API·CSRF 단위 검사         | 13/13 | fieldErrors.reason, 선택적 헤더, 204, 취소, 재전송 금지, 세션 정리 |
| 백엔드 기존 공통 오류 검사        | 4/4   | 검증 오류, 업무 오류, 404/405/415, 내부 정보 비노출                |
| 백엔드 오류 본문 추출 검사        | 1/1   | 기존 테스트 컨트롤러와 실제 공통 처리기로 5종 응답 생성            |
| 실제 HTTP → 기존 공통 클라이언트  | 5/5   | 백엔드 직접·Nginx 경유 401, 개발용 허용 경로의 404                 |
| 생성된 MVC 응답 → 기존 클라이언트 | 5/5   | 빈 nickname, 깨진 JSON, 본문 누락, 404, 500 본문 재생              |

`fieldErrors[{field, reason}]`, status·code·message를 그대로 전달한다. fieldErrors 생략은 빈 배열로 다룬다. 401만 세션 정리 이벤트를 발생시키고 쓰기 요청을 자동 재전송하지 않으며, 500 쓰기 응답은 결과 불명확으로 구분한다. 클라이언트 소스 해시와 확인점별 결과는 [결과 JSON](auth-error-201-results.json)에 있다.

## 실제 API 검증과 계약 검증의 구분

입력 오류 5종은 보안 필터를 끈 Spring MVC 검사에서 직렬화한 본문이다. 그 본문을 기존 프론트 클라이언트에 넣어 확인한 것으로, 실제 인증된 기능 API나 기능 폼의 검증을 대신하지 않는다. 실제 인증된 403/404의 이전 결과는 [기존 인증 검증](auth-backend-201-validation.md)을 사용하며 이번에 재실행했다고 하지 않는다.

현재 운영 Controller에는 로그인 페이지, CSRF, 회원 조회, 개발용 hello의 GET이 있다. 닉네임 수정·게시글 입력 등의 검증 DTO를 받는 실제 기능 API는 없다. 입력 기능 API가 제공되면 해당 기능 연결 시 잘못된 입력의 fieldErrors를 공통 클라이언트와 폼에서 대조한다. 201에서 기능 화면이나 서버 입력 API를 대신 만들지 않는다.

## 요청 추적 ID 안내 정정

- [서비스 API 2.4절](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/blob/d079789740870678177713d333878fa27e2eac3f/apps/backend/docs/service-api-spec.md)은 오류를 code·message·fieldErrors로 정의한다.
- [탐사 API](https://lab.ssafy.com/s15-bigdata-dist-sub1/S15P21C206/-/blob/d079789740870678177713d333878fa27e2eac3f/apps/backend/docs/exploration-api-spec.md)는 9/11 변경 이력에 오류 본문의 requestId 제거를 명시한다. 분석 제출의 requestId는 별도 멱등 키다.
- API 안내 README 3절의 오류 requestId는 위 상세 명세와 다른 잔존 표기다. 이것만으로 서버 추적 기능 추가를 필수화하지 않는다. Jira201의 '합의한 요청 식별 정보'와 별도 계약을 구분하며 새 헤더 이름을 임의로 정하지 않는다.
- 현재 서버 requestId는 null, localRequestId는 브라우저 내 식별 값으로 분리한다. 임의 요청 헤더를 보내거나 분석 멱등 키와 혼동하지 않는다. 별도 서버 추적 계약이 합의되면 그때 어댑터를 맞춘다.

이전 진행 기록에서 서버 추적 ID 구현을 필수 대기로 적은 부분은 위 판단으로 정정한다. Jira·정본 문서의 내용을 이번 검사에서 바꾸거나 팀 합의를 대신한 것은 아니다.

## 버전·재현·한계

- 최신 develop `d079789740870678177713d333878fa27e2eac3f`, 로그인 MR !42 병합 확인.
- Java 검증은 격리 사본 d50c75e3으로 실행했다. 운영 소스와 build.gradle은 현행 develop과 같다.
- 실제 HTTP는 기존 1cf1cca 검증 서버의 로컬 58308/58310 포트를 사용했다. 오류·보안·인증 소스는 현행과 같다.
- 기존 201 client.ts를 TypeScript 변환해 검사했으며 기능 코드를 수정하지 않았다. 브라우저 UI와 실제 제공자 로그인을 재검사한 결과가 아니다.
- 초기 단위 검사 실행 제한은 정상 Windows 권한으로 해결했다. 세션 없는 로그아웃의 204 계약을 잘못 기대한 검증 시나리오도 바로잡고 운영 코드는 유지했다.
- 이 PC의 도구·상세 보고서 위치: `C:/Users/SSAFY/Documents/ChatGPT/BrandNewDay/output/ticket-workflow/201-real-backend/`. `verify-error-contract.mjs`, `error-contract-validation.md`와 격리 Java 검증 소스가 있다. 팀 공통 실행 경로가 아니다.

실계정 쿠키·OAuth 키·DB 데이터는 이번에 변경하지 않았다. 201-08의 실제 상대 컴포넌트, 201-09 배포/Safari, 201-10 제출·리뷰·병합은 남는다. 이번 검사로 commit/push·MR·Jira를 변경하지 않았다.
