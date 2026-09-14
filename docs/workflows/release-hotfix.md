# Release·Hotfix 가이드

## 이 문서를 읽는 경우

`릴리스 브랜치 만들어줘`, `배포 버전 준비해줘`, `hotfix 만들어줘`, `운영 긴급 수정해줘`

## Release

- 릴리스 후보 범위가 정해진 뒤 최신 `develop`에서 `release/vX.Y.Z`를 만든다.
- 새 기능은 추가하지 않는다. 통합 테스트, 차단 결함 수정, 버전과 릴리스 문서만 변경한다.
- EC2 스테이징에서 실제와 유사한 데이터 규모로 검증하고 결과와 포함 Jira를 MR에 기록한다.
- `release → main` 병합, tag 생성, 같은 release를 `develop`에 병합하고, 두 MR과 배포 검증이 끝난 뒤 브랜치를 삭제한다.
- 두 MR은 Squash하지 않으며 `main` 대상은 최소 2명, `develop` 대상은 최소 1명의 승인을 받는다. `main` 대상 MR은 [Release 템플릿](../../.gitlab/merge_request_templates/Release.md)의 완료 조건을 모두 확인한다.

## Hotfix

- `main` 배포판의 긴급 문제만 Jira Bug로 만들고 최신 `main`에서 `hotfix/*`를 만든다.
- 같은 브랜치로 `main`과 `develop` MR을 각각 만들고, 진행 중인 release가 있으면 그 브랜치에도 반영한다.
- 각 MR은 최소 1명의 승인을 받고 Squash하지 않는다. `main` 병합에는 patch tag를 남긴다.
- 발생 환경, 재현 방법, 영향 범위, 롤백 방법과 대상 브랜치별 검증 결과를 기록한다.
- 별도 Hotfix 템플릿은 두지 않고 [Default 템플릿](../../.gitlab/merge_request_templates/Default.md)을 사용한다.

운영 배포, 태그, 병합과 브랜치 삭제는 정확한 대상과 승인 조건을 확인한 뒤 실행한다. MR 형식은 [MR 가이드](merge-request.md)를 따른다.
