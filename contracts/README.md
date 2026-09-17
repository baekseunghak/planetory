# 시스템 간 데이터 계약

독립 배포되는 생산자와 소비자가 함께 검사할 데이터 형식을 둔다.

- [Gold 게시 계약](gold/README.md): GCP Publisher가 PostgreSQL에 적재하고 Backend·Frontend가 읽는 필드·단위와 게시 재시도 규칙
- [온라인 파생 계산 내부 계약](derived-compute/README.md): Backend가 Python Worker에 보내는 잔차·주기도 HTTP/JSON 요청·응답과 초기 제한

각 언어의 내부 객체 전체는 복사하지 않고 독립 배포 경계의 직렬화 형식만 둔다.
