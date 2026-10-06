#!/bin/sh
# 실제 Docker로 Compose 파일·프로젝트 선택, 볼륨 보존, health 실패 롤백을 검증한다.
set -eu
umask 077
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
export COMPOSE_PROJECT_NAME="planetory-deploy-test-$$"
export COMPOSE_FILE="$tmp/compose.json"
volume="$COMPOSE_PROJECT_NAME-data"
export DEPLOY_TEST_VOLUME="$volume"
cleanup() {
    docker compose down >/dev/null 2>&1 || true
    docker volume rm "$volume" >/dev/null 2>&1 || true
    rm -rf "$tmp"
}
trap cleanup EXIT
docker pull alpine:3.20 >/dev/null
docker pull alpine:3.21 >/dev/null
docker pull alpine:3.22 >/dev/null
docker volume create "$volume" >/dev/null
cat >"$COMPOSE_FILE" <<'EOF'
{"services":{"app":{"image":"${APP_IMAGE}","command":["sh","-c","sleep 300"],"volumes":["data:/data"],"healthcheck":{"test":["CMD","grep","-qv","^3[.]21[.]","/etc/alpine-release"],"interval":"1s","timeout":"1s","retries":1}}},"volumes":{"data":{"name":"${DEPLOY_TEST_VOLUME}","external":true}}}
EOF
printf 'APP_IMAGE=alpine:3.20\n' >"$tmp/.env"
export APP_IMAGE=alpine:3.20
docker compose up -d --wait >/dev/null
docker compose exec -T app sh -c 'echo preserved >/data/sentinel'
before=$(docker volume inspect -f '{{.Mountpoint}}' "$volume")
cd "$tmp"
SERVICE=app IMAGE_VAR=APP_IMAGE IMAGE=alpine:3.22 HEALTH_TIMEOUT=8 \
    sh "$here/deploy.sh" >success.log 2>&1
grep -qx 'APP_IMAGE=alpine:3.22' .env
if SERVICE=app IMAGE_VAR=APP_IMAGE IMAGE=alpine:3.21 HEALTH_TIMEOUT=8 \
    sh "$here/deploy.sh" >rollback.log 2>&1; then
    echo 'FAIL: unhealthy deployment was accepted' >&2
    exit 1
fi
test "$(docker inspect -f '{{.Config.Image}}' "$(docker compose ps -aq app)")" = alpine:3.22
grep -qx 'APP_IMAGE=alpine:3.22' .env
test "$(docker compose exec -T app cat /data/sentinel)" = preserved
test "$(docker volume inspect -f '{{.Mountpoint}}' "$volume")" = "$before"
echo 'PASS: custom Compose/project, image declaration, unhealthy rollback, persistent volume'
