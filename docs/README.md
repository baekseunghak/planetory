# Planetory 문서 지도

이 문서는 문서 유형을 선택하는 첫 번째 진입점이다. 개별 파일을 여기서 바로 찾지 말고, 현재 요청과 일치하는 디렉터리의 `README.md`를 읽어 정본·상세·초안 문서를 판단한다.

## 입력 → 디렉터리 매칭

| 사용자 요청 | 다음에 읽을 README |
| --- | --- |
| Jira, Epic, 브랜치, 개발, 문서, 커밋, MR, Release | [워크플로](workflows/README.md) |
| 기능 정책, 사용자 동작, 상태, 화면 문구 | [요구사항](requirements/README.md) |
| 시스템 경계, AWS·GCP, DB, 온라인 계산, 저장소 구조 | [아키텍처](architecture/README.md) |
| 프론트엔드·백엔드 구현 명세 | [개발](development/README.md) |
| 데이터 저장, Hadoop·Spark, TESS 처리, AI 조사 | [데이터](data/README.md) |
| API 담당 경계, 서비스·탐사 계약, Mock과 예제 | [API](api/README.md) |
| Docker, CI/CD, 배포 | [운영](operations/README.md) |
| 팀원 Tailscale 등록, EC2·GCP 서버 접속 | [운영](operations/README.md) |
| GCP 서버 접속·상태·네트워크·방화벽·비용 점검 | [운영](operations/README.md) |
| 담당 범위, 문서 충돌과 동기화 상태 | [프로젝트](project/README.md) |
| 문서·아키텍처 변경 이력, 판단 근거, 재발 방지 | [변경 이력](changes/README.md) |
| PoC와 검증 결과 | [실험](experiments/README.md) |
| 팀원별 KPT | [일일 보고서](daily-report/README.md) |
| 문서 첨부 이미지 | [이미지](images/README.md) |

## 관리 역할

| 역할 | 정본·진입점 |
| --- | --- |
| AI 공통 가드레일 | [AGENTS.md](../AGENTS.md) |
| 문서 위치와 탐색 순서 | 이 문서와 각 디렉터리 `README.md` |
| 현재 담당·충돌·반영 대기 | [프로젝트 운영](project/README.md) |
| 중요한 변경과 판단 근거 | [변경 이력](changes/README.md) |

## 탐색 규칙

1. 현재 요청에 맞는 디렉터리 README 하나를 선택한다.
2. 해당 README의 입력 매칭과 문서 상태를 확인한다.
3. 매칭된 개별 문서와 변경 대상에 가장 가까운 코드 `README.md`만 읽는다.
4. 정본·아키텍처를 수정하거나 과거 오류가 관련되면 `docs/changes/`를 Jira 키·문서 경로·키워드로 검색하고 일치한 기록만 읽는다.
5. 여러 영역에 걸친 작업일 때만 두 번째 디렉터리 README를 추가로 읽는다.
6. 문서와 코드가 다르면 실제 구현, Jira 요구사항과 정본을 비교하고 충돌을 보고한다.

## 문서 관리 규칙

- 새로운 문서 유형 자체가 생길 때만 이 파일에 디렉터리를 추가한다.
- 구조·소유권은 지도, 현재 충돌·차단 사항은 프로젝트 상태, 중요한 판단 이력은 변경 이력, 팀 회고는 KPT, 일반 작업 내역은 Git·Jira에서 관리한다.
- 문서 생성·수정·이동·삭제 규칙은 [문서 생명주기](workflows/documentation.md), 변경 이력 규칙은 [변경 이력](changes/README.md), 상태 어휘와 공통 가드레일은 [AGENTS.md](../AGENTS.md)를 따른다. 같은 규칙을 이 파일에 복제하지 않는다.
