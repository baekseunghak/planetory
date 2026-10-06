# 서비스 CI/CD

Frontend, Backend와 온라인 계산기의 검사·ARM64 이미지 생성·서비스 배포 설정을 둘 위치다.

각 앱은 `arm64-docker`에서 `linux/arm64` 이미지를 만들고 `claude@donh-vnic`에 해당 앱만 배포한다. CI·레지스트리의 `donh-orc2`는 서비스 배포 대상이 아니다. 변수와 최종 볼륨 보존 절차는 [CI/CD 문서](../../../docs/operations/cicd.md)를 따른다.
