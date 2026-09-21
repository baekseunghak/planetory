/**
 * 도메인 패키지. 하위에 {@code <도메인>/controller|dto|entity|repository|service|exception}로 나눈다.
 * 서비스·저장소 의존성이 없는 도메인 간 공유 조건은 순환 참조 방지를 위해 domain 바로 아래에 둘 수 있다.
 * 규칙은 docs/development-setup.md 7장을 따른다. 회원·커뮤니티·탐사 기능은 후속 Task에서 추가한다.
 */
package com.planetory.backend.domain;
