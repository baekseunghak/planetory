# exec — 포팅 매뉴얼

SSAFY 제출 양식에 맞춘 산출물이다. 기준 커밋은 `develop` `e2c7c19b`(2026-09-28)다.

| # | 제출 항목 | 파일 |
| --- | --- | --- |
| 1 | GitLab 소스 클론 이후 빌드·배포 문서 (JVM·웹서버·WAS·IDE 버전, 빌드 환경 변수, 배포 특이사항, DB 접속 정보·계정·프로퍼티 파일 목록) | [1-porting-manual.md](1-porting-manual.md) |
| 2 | 외부 서비스 정보 (소셜 로그인, AI, 공개 데이터 API, 클라우드·네트워크) | [2-external-services.md](2-external-services.md) |
| 3 | DB 덤프 최신본 (스키마 + 튜토리얼·챌린지 별 데이터) | [3-db-dump/](3-db-dump/README.md) |
| 4 | 시연 시나리오 (화면별 스크린샷·클릭 단위) | [4-demo-scenario.md](4-demo-scenario.md), 사진은 `images/` |

- 비밀 값(비밀번호·키·토큰)은 어느 파일에도 적지 않았다. 넣는 위치와 변수 이름만 적었다.
- 각 문서는 제출용 요약본이다. 절차가 바뀌면 문서 안에 링크한 담당 정본(`docs/`, `infra/`, `apps/`)이 우선한다.
