#!/bin/sh
# 서비스 한 개를 교체하고, 살아나지 않으면 직전 이미지로 되돌린다 [S15P21C206-84].
#
# 배포 노드에서 실행한다. CI가 compose.yaml과 함께 이 파일을 $DEPLOY_PATH로 올린 뒤
# ssh로 호출한다. 로직을 CI YAML의 한 줄짜리 ssh 명령에 넣지 않는 이유는, 거기서는
# 읽을 수도 고칠 수도 없고 어느 단계에서 실패했는지 구분할 수도 없기 때문이다.
#
# 입력은 환경변수다.
#   SERVICE         compose 서비스 이름 (frontend, backend, ...)
#   IMAGE_VAR       compose가 읽는 이미지 변수 이름 (FRONTEND_IMAGE, ...)
#   IMAGE           새로 띄울 이미지 전체 참조
#   ACTION          up이면 교체까지, 그 외에는 pull만 한다
#   HEALTH_PATH     확인할 경로(/ 또는 /actuator/health). 비우면 확인과 롤백을 건너뛴다
#   HEALTH_PORT     컨테이너가 듣는 포트. 기본 8080
#   HEALTH_TIMEOUT  헬스 대기 한계(초). 기본 90
#   DB_BACKUP       true면 교체 전에 service-db를 덤프한다
#
# 알아 둘 것: 롤백은 **이미지만** 되돌린다. 스키마는 되돌리지 않는다. Flyway는
# 앞으로만 가고 clean이 막혀 있다(application.properties). 마이그레이션이 이미
# 적용된 뒤 이미지를 되돌리면 구 앱이 새 스키마 위에서 돈다. 이 저장소의
# 마이그레이션은 지금까지 열·테이블 추가뿐이라 Hibernate validate를 통과하지만,
# 열을 지우거나 이름을 바꾸는 마이그레이션이 들어오면 그 가정이 깨진다.
# 그때를 위해 DB_BACKUP=true로 교체 직전 덤프를 남긴다.

set -eu

COMPOSE="docker compose -f compose.yaml"
ACTION="${ACTION:-up}"
HEALTH_PATH="${HEALTH_PATH:-}"
HEALTH_PORT="${HEALTH_PORT:-8080}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
DB_BACKUP="${DB_BACKUP:-false}"
BACKUP_DIR="backups"

for required in SERVICE IMAGE_VAR IMAGE; do
    eval "value=\${$required:-}"
    if [ -z "$value" ]; then
        echo "필수 환경변수가 없습니다: $required" >&2
        exit 2
    fi
done

# compose가 읽는 변수 이름이 서비스마다 다르므로 동적으로 내보낸다.
set_image() {
    export "$IMAGE_VAR=$1"
}

current_image() {
    container=$($COMPOSE ps -q "$SERVICE" 2>/dev/null || true)
    [ -n "$container" ] || return 0
    docker inspect -f '{{.Config.Image}}' "$container" 2>/dev/null || true
}

# 호스트에 게시된 주소를 compose에서 읽는다. .env의 FRONTEND_PORT·BACKEND_PORT를
# 바꿔도 따라간다. CI에 포트를 적어두면 둘이 조용히 어긋난다.
health_url() {
    published=$($COMPOSE port "$SERVICE" "$HEALTH_PORT" 2>/dev/null || true)
    [ -n "$published" ] || return 1
    echo "http://${published}${HEALTH_PATH}"
}

# compose의 healthcheck는 서비스마다 없을 수 있고, 있어도 up -d가 끝난 시점에는
# 아직 starting이다. 공개 경로를 직접 두드려 "사용자가 받을 응답"으로 판정한다.
wait_healthy() {
    [ -n "$HEALTH_PATH" ] || return 0
    waited=0
    while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
        url=$(health_url || true)
        if [ -n "$url" ] && curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
            echo "헬스 통과: $url (${waited}초)"
            return 0
        fi
        sleep 3
        waited=$((waited + 3))
    done
    echo "헬스 실패: ${HEALTH_TIMEOUT}초 안에 ${SERVICE}:${HEALTH_PORT}${HEALTH_PATH} 가 응답하지 않았습니다" >&2
    return 1
}

replace() {
    set_image "$1"
    $COMPOSE up -d --no-deps "$SERVICE"
}

set_image "$IMAGE"
$COMPOSE config -q
$COMPOSE pull "$SERVICE"

if [ "$ACTION" != "up" ]; then
    echo "pull만 수행했습니다: $SERVICE <- $IMAGE"
    exit 0
fi

PREVIOUS=$(current_image)
if [ -n "$PREVIOUS" ]; then
    echo "직전 이미지: $PREVIOUS"
else
    echo "직전 이미지가 없습니다(첫 배포). 실패해도 되돌릴 대상이 없습니다."
fi

if [ "$DB_BACKUP" = "true" ]; then
    mkdir -p "$BACKUP_DIR"
    dump="$BACKUP_DIR/service-db-$(date +%Y%m%d-%H%M%S).sql"
    # 접속 정보는 컨테이너 안의 환경변수를 그대로 쓴다. 호스트 셸로 꺼내지 않는다.
    $COMPOSE exec -T service-db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$dump"
    echo "DB 덤프: $dump ($(wc -c < "$dump") bytes)"
    # 볼륨이 유일한 사본이라 덤프를 함부로 지우면 안 되지만, 무한히 쌓여 디스크를
    # 채우는 것도 서비스 중단이다. 최근 10개만 남긴다.
    ls -1t "$BACKUP_DIR"/service-db-*.sql 2>/dev/null | tail -n +11 | xargs -r rm -f
fi

replace "$IMAGE"

if wait_healthy; then
    $COMPOSE ps "$SERVICE"
    echo "배포 완료: $SERVICE <- $IMAGE"
    exit 0
fi

echo "=== 배포 실패. 되돌립니다 ===" >&2
$COMPOSE logs --tail 50 "$SERVICE" >&2 || true

if [ -z "$PREVIOUS" ]; then
    echo "되돌릴 이미지가 없습니다. $SERVICE 는 실패한 상태로 남습니다." >&2
    exit 1
fi

replace "$PREVIOUS"

if wait_healthy; then
    echo "되돌렸습니다: $SERVICE <- $PREVIOUS" >&2
    if [ "$DB_BACKUP" = "true" ]; then
        echo "주의: 이미지만 되돌렸습니다. 스키마는 그대로입니다. 덤프는 $BACKUP_DIR 에 있습니다." >&2
    fi
    exit 1
fi

echo "되돌린 뒤에도 헬스가 통과하지 않습니다. 사람이 확인해야 합니다." >&2
exit 1
