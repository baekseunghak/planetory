#!/bin/sh
# 서비스 런타임 접속 계정 생성 [S15P21C206-83]
#
# postgres 이미지의 엔트리포인트가 "빈 데이터 디렉터리를 처음 초기화할 때만" 실행한다.
# 이미 데이터가 있는 볼륨에서는 실행되지 않으므로, 기존 배포에 계정을 추가할 때는
# infra/service/README.md의 수동 절차를 따른다.
#
# 역할(planetory_app)은 V2 마이그레이션도 만들지만 여기서 먼저 만든다. 아래 GRANT가
# 역할의 존재를 요구하는데 마이그레이션은 이 스크립트보다 나중에 돌기 때문이다.
# V2의 DO 블록은 이미 있는 역할을 그대로 쓰므로 둘이 부딪히지 않는다.
#
# 비밀번호는 파일에 적지 않고 .env의 APP_DB_PASSWORD로 주입한다.

set -e

if [ -z "$APP_DB_PASSWORD" ]; then
    echo "APP_DB_PASSWORD가 없습니다. 서비스 런타임 계정을 만들 수 없습니다." >&2
    exit 1
fi

APP_DB_USER="${APP_DB_USER:-planetory_service}"

# 비밀번호를 명령줄 인자나 로그에 남기지 않도록 psql 변수로 전달한다.
psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
     -v app_user="$APP_DB_USER" -v app_password="$APP_DB_PASSWORD" <<'EOSQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'planetory_app') THEN
        CREATE ROLE planetory_app NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'planetory_gold_writer') THEN
        CREATE ROLE planetory_gold_writer NOLOGIN;
    END IF;
END $$;

CREATE USER :"app_user" PASSWORD :'app_password';
GRANT planetory_app TO :"app_user";

-- 이 계정은 앱 런타임 전용이다. 스키마에 객체를 만들 수 없어야 한다.
-- PostgreSQL 15부터 public 스키마의 CREATE는 기본으로 없지만 명시적으로 회수한다.
REVOKE CREATE ON SCHEMA public FROM :"app_user";
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EOSQL

echo "서비스 런타임 계정 ${APP_DB_USER}을 만들고 planetory_app을 부여했습니다."
