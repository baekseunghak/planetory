# Analysis UI 검증 기록

- 검증일: 2026-09-10 (KST)
- Jira: `S15P21C206-50`
- 대상: `experiment/S15P21C206-50-web-analysis-prototype`의 `experiments/analysis-ui`
- 환경: Windows, Node.js 24.19.0, pnpm 11.19.0, Python 3.12.14, Playwright 1.63.0 / Chrome
- 의존성: 기존 `pnpm-lock.yaml`을 유지하고 frozen lockfile로 설치했다.

## 실행 결과

| 검증                      | 실행 명령                                                                      | 결과                                                          |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| 단위 테스트               | `pnpm test`                                                                    | 4개 파일, 30개 테스트 통과                                    |
| 타입 검사 및 배포 빌드    | `pnpm build`                                                                   | TypeScript 검사 및 Vite 빌드 통과                             |
| Mock 예제                 | `pnpm validate:fixtures`                                                       | 합성 시나리오 10개, HTTP 예제 54개, 잘못된 변형 6개 거부 확인 |
| 브라우저 테스트           | PowerShell에서 `$env:CI = 'true'` 후 `pnpm exec playwright test`               | 22개 테스트 통과 (24.5초)                                     |
| 원본 데이터 내보내기 함수 | Python 3.12 환경에서 `python -m pytest scripts/test_export_observations.py -q` | 5개 테스트 통과                                               |
| 포맷 검사                 | `pnpm format:check`                                                            | 모든 대상 파일 통과                                           |

브라우저 검증은 `CI=true`로 기존 서버 재사용을 금지하고, 해당 작업 폴더에서 새로 실행한 `127.0.0.1:5174` 서버를 사용했다. 개발 중이던 별도 분석실 서버를 테스트하지 않았다.

## 확인한 동작

- Mock 제출·판정 불일치·재시도·중복 성과 방지·선택 게시·부분 실패·공개 통계·상세 보기·만료/숨김 상태.
- TOI-270 44,551점, L 98-59 47,579점, CM Draconis 11,558점의 실제 관측 데이터를 모두 불러오고 접은 곡선에 반영.
- 주기 미세조정 시 마지막 그래프 유지, 같은 Worker 재사용, 오래된 응답 무시, Worker 실패·시간 초과 후 복구.
- 구간 선택, 키보드 조작, 선택 취소 복원, epoch·duration 및 시간 영역 표시 동기화, 새로고침 복원.
- 1,440px·1,024px 너비의 그래프 배치와 좁은 화면 안내, 관측 파일이 없을 때의 복구 가능한 오류.
- 데이터 필터의 배타성, 기준 시각 고정, 중복 시각 거부, 공개 데이터의 정답 필드 제외, 수치 정밀도 및 NaN 거부.

## 검증 중 보완

초기 포맷 검사에서는 Windows의 `core.autocrlf=true`로 체크아웃된 파일 29개가 Prettier의 LF 규칙과 충돌했다. 이 앱에 `.gitattributes`를 추가하고 파일 줄바꿈을 LF로 정리했다. 앱 로직 변경은 없으며, Python 테스트가 생성한 `.pytest_cache/`도 Git 및 포맷 검사에서 제외했다.

## 범위와 한계

이 기록은 기존 `analysis-ui` 프로토타입의 동작 재검증이다. Mock 테스트 통과가 최신 요구사항과 API 계약의 일치를 뜻하지는 않으며, 정책 차이는 [프로토타입 안내](README.md)와 [API 문서](../../docs/api/analysis/README.md)를 함께 확인해야 한다.

관측 JSON은 기존 로컬 생성물을 준비해서 사용했다. Python 테스트는 내보내기 함수의 계약을 확인했고, 이번 검증에서 전체 FITS 입력을 다시 내보내거나 BLS를 재계산하지 않았다. 실제 Backend·DB·인증·성과 지급·게시 서비스 연동, 대규모 성능 및 새 `analysis-lab` 화면의 검증은 이 기록에 포함하지 않는다.
