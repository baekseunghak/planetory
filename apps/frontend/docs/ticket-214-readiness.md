# 214 프로필·닉네임·사용법 다시 보기

S15P21C206-214 / W16 · 하서진 · 2026-09-18. [서비스 API 3절](../../backend/docs/service-api-spec.md), [공용 프론트 연결](shared-frontend-contract.md). develop b0d733b에 선행213(577a2f3)을 통합했다. 리뷰·병합과 아래 미확정 계약 전에는 티켓 완료가 아니다.

## 구현한 기능

- /me와 /members/:memberId에서 기존 GET /api/v1/me 및 /api/v1/members/:memberId를 사용한다. own profile의 발견/완료/신호/등급 수는 achievementSummary 값을 그대로 표시하며 클라이언트가 합산하지 않는다. 로딩/오류/수동 재조회와 회원 변경·탭 복귀 취소/재조회는 기존 공통 코드를 사용한다.
- 타인 DTO는 회원 ID·현재 닉네임·별 공개 상태·허용 성과 요약만 투영한다. 가입일·사적 설정·순위·백분위·맞춘 수를 추가하지 않는다. PRIVATE 별 슬롯은 mount하지 않으며 비공개 안내를 표시한다. 403 권한 오류는 공통 ErrorState가 404와 구별한다. 자기 회원 URL은 /me로 이동한다.
- PATCH /me/profile은 NFC·2~20자·허용 문자·기본 금칙어를 먼저 검사하고 서버 추가 금칙어/400 fieldErrors/409를 표시한다. 저장 동안 입력과 중복 저장을 막고 성공하면 /me와 세션을 갱신한다. 응답 유실 시 초안과 입력을 보존한 채 GET /me로 현재 이름을 확인하며 자동 PATCH 재전송은 없다. 최신 글/댓글/반응 이름은 조회 응답의 author/member nickname을 사용한다.
- App.profileSections로 stars/history/statistics 슬롯을 주입한다. props는 memberId/isOwn/starListVisibility이고 history/statistics는 본인만 렌더한다. A13/A15/A16 기본값은 연결 준비 상태이며 타인 PRIVATE 별 목록은 슬롯을 주입해도 렌더하지 않는다. 상대 화면을 대신 만들지 않았다.
- 사용법 다시 보기는 별도 dialog 안의 GIF+텍스트 5단계다. 매번1단계, 이전/다음/닫기/마지막 닫기, 좌우 화살표·Escape, 닫은 뒤 버튼 포커스 복원. GIF 실패에도 텍스트·조작 유지, 모션 줄이기는 PNG, 수동 정지/재생 제공. 실제 분석·첫 방문 안내·튜토리얼을 실행하지 않고 어떠한 상태 쓰기도 하지 않는다.

## 원본214에 남는 미확정 사항

1. **가입일:** 현행 서비스3.1/3.2와 실제 MemberController.MeResponse에는 가입일 필드가 없다. 발견/완료 등 요약은 계약이 있지만 MY-01 가입일은 표시할 수 없다. 현재는 미제공 안내만 표시한다. W01/S04 담당과 필드명·UTC 또는 날짜 형식·표시 기준을 합의하고 서버 제공 후 소비/검증해야 한다. 존재하지 않는 joinedAt/createdAt을 계약인 것처럼 추가하지 않았다.
2. **팔로우 수:** MY-01 P0 수치와 COM-16 P1 기능의 충돌은 티켓에 미결로 명시되어 있고 현재 S04 응답에는 값이 없다. 임의0이나 팔로우 UI를 추가하지 않았다. P0 제외 승인 또는 수치 제공 계약 확정이 필요하다.

이 둘은 단순 배포 인수가 아니므로216으로 넘기고214를 완료 처리할 수 없다. A13/A15/A16의 내부 완성은 이 티켓의 역선행 조건으로 추가하지 않는다.

## 에셋과 A14

[guide 에셋 설명](../public/guides/README.md). Planetory 설명용 도식이며 실제 분석 화면 녹화가 아니다. scripts/generate-guides.py로 GIF5개·PNG5개를 재생성할 수 있다. 제출이 무조건 완료/새 성과를 주는 것으로 오해하지 않도록 문구를 수정했다. A14 담당이 실제 봉우리·구간·판단·제출 조작과 문구를 비교하고 필요시 에셋을 교체하는 작업은216-214에 남긴다.

## 재현과 검사

apps/frontend에서 npm ci, npm run dev:profiles → http://127.0.0.1:58356/me. u-209 본인, u-210 타인 PRIVATE, u-211 타인 PUBLIC은 합성 회원이며 개발 전용 HTTP fixture다. 일반 실행/운영 빌드는 개발 모드로 자동 전환하지 않는다.

- npm run build / npm test
- npx playwright test --config=playwright.profiles.config.ts
- npm run test:comments / npm run test:production

검사는 서버 집계 소비/공개 필드 제한, 닉네임 경계·중복·금칙어·NFC·유실 복구·중복 저장 차단, 안내5단계/실제 이미지 로딩·키보드·포커스·실패·정지 이미지, 안내 전후 GET /me 동일 및 쓰기 요청0을 포함한다. Firefox BiDi의 page.emulateMedia가 모션 설정에 반영되지 않아 이 검사 프로젝트에는 실제 ui.prefersReducedMotion=1을 지정했다. matchMedia를 가짜로 바꾸지 않았다.

검증 결과(2026-09-18): 타입/빌드·운영 fixture 제외 검사 통과. 단위83개, 프로필24개(Chromium/Chrome/Edge/Firefox), 댓글7개, 운영 빌드8개 통과. 초기 검사에서 발견한 오류 문구 중복을 수정했고, Firefox 모션 환경 설정을 바로잡은 뒤24개 전체를 재검사했다. 상대 링크 검사0건·git diff --check 통과. 실제 S04·A14 종단 인수는 포함하지 않는다.

## 216-214 실제 인수 인계

S04 준비된 실제 환경에서 동일 절차를 실행한다. 기대 결과: 내/타인 허용 필드·서버 요약 일치, 닉네임 저장/중복/유실과 기존 글·댓글·반응의 현재 이름, 공개→비공개 전환 후 이전 상세 자료 비노출. 가입일/팔로우 정책은 위 원본 조건 해결이 먼저다. A13/A15/A16 실제 슬롯은 담당 컴포넌트 준비 후 연결하고, A14와 안내 조작/문구 교차 검토 및 AT-119 실제 상태 불변을 확인한다. 프론트 하서진·S04 담당·A 화면 백지웅 협업. 실제 인수는 미실행이며 합성 응답 검사를 통과 근거로 대체하지 않는다.

롤백은 main.tsx의 profile/member 등록과 profileSections 공급을 되돌리고 기존201~213을 유지한다. 이 MR은 선행 !75→!76→!78→!79→!80 이후 병합한다. Draft를 설정하지 않는다.

## 2026-09-18 선행 MR 리뷰 통합

205~213 수정과 develop 2f25c11을 통합했다. [전체 리뷰 수정·검증](mr-review-fixes-20260918.md)을 참고한다. 프로필 가입일/팔로우 미결과216 실제 통합 인수는 이번 수정으로 완료하지 않았다.
