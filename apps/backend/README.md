# Backend

Java 21 · Spring Boot 4.1.1 · Gradle Wrapper 9.7.1 기반 백엔드다.

PostgreSQL 18.6 연결, ERD v1.1 기반 Flyway 최초 마이그레이션, JPA·JdbcClient 병행 데이터 접근, 공통 오류 응답, 로컬 Swagger UI·예제 API를 제공한다. 회원·탐사·커뮤니티 기능과 인증은 아직 구현하지 않았다. Gold 배열·메타데이터도 ERD에 따라 PostgreSQL 테이블로 정의한다.

실행 명령·환경변수·마이그레이션 규칙·검증 결과는 [개발 환경 안내](docs/development-setup.md)를 참고한다. 저장소 루트의 기존 Compose에서 `service-db`를 실행한 뒤 이 폴더에서 Wrapper로 빌드한다.
