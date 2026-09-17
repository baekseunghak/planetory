# EC2 서비스 배포

Frontend, Backend와 온라인 계산기의 공통 Docker Compose 설정을 둘 위치다.

`compose.yaml`은 Registry의 Frontend·Backend 이미지를 실행한다. 로컬 빌드는 하지 않으며 실제 DB 주소, Gold 경로와 비밀 값은 각 서버의 `.env`에서 주입한다.

GitLab의 EC2-A/B 수동 배포 job은 같은 Compose를 사용해 선택한 서비스만 갱신한다. 노드별 차이가 생길 때만 `ec2-a/`, `ec2-b/`에 추가 설정을 둔다.

## service-db

PostgreSQL 18.6을 같은 Compose 안에서 `service-db`로 띄운다. Backend는 `service` 네트워크로 `service-db:5432`에 붙으며 호스트 포트를 열지 않는다. 외부 인바운드는 0개다.

`.env`에 `POSTGRES_PASSWORD`가 없으면 기동이 실패한다. `POSTGRES_DB`, `POSTGRES_USER`와 Backend의 `DATABASE_*`는 기본값을 쓰면 서로 맞는다.

데이터는 named volume `planetory-service-db-data`에 있다. 이 볼륨이 회원·제출·히스토리의 유일한 사본이다(복제·백업 없음, ADR D6·D7). `docker compose down -v`와 볼륨 이름 변경은 곧 데이터 상실이다. 재배포·이미지 교체는 볼륨을 지우지 않는다.

마운트 경로 `/var/lib/postgresql`은 postgres:18에서 바뀐 규약이다. 17 이하의 `/var/lib/postgresql/data`로 되돌리면 깨진다.

현재는 소유자 겸 서비스 계정 하나(`planetory`)로 접속한다. `planetory_app`·`planetory_gold_writer` 역할 분리는 `S15P21C206-238`의 `users` GRANT가 들어온 뒤에 적용한다.
