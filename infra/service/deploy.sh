#!/bin/sh
# 서비스 한 개를 교체하고, 살아나지 않으면 직전 이미지로 되돌린다 [S15P21C206-84].
#
# 배포 노드에서 실행한다. CI가 이 파일을 $DEPLOY_PATH로 올린 뒤
# ssh로 호출한다. 로직을 CI YAML의 한 줄짜리 ssh 명령에 넣지 않는 이유는, 거기서는
# 읽을 수도 고칠 수도 없고 어느 단계에서 실패했는지 구분할 수도 없기 때문이다.
#
# 입력은 환경변수다.
#   SERVICE         compose 서비스 이름. 공백으로 나뉜 목록이면 교체만 하고
#                   헬스 확인과 롤백을 하지 않는다(GCP 노드의 airflow 등).
#   IMAGE_VAR       compose가 읽는 이미지 변수 이름 (FRONTEND_IMAGE, ...)
#   IMAGE           새로 띄울 이미지 전체 참조
#   ACTION          up이면 교체까지, 그 외에는 pull만 한다
#   HEALTH_PATH     추가 HTTP 경로. 비우면 Compose HEALTHCHECK만 확인한다
#   HEALTH_PORT     컨테이너가 듣는 포트. 기본 8080
#   HEALTH_TIMEOUT  헬스 대기 한계(초, 벽시계). 기본 90
#   DB_BACKUP       true면 교체 전에 service-db를 덤프한다
#   COMPOSE_FILE    기본 compose.yaml. 이관 서버는 기존 compose.json을 사용한다
#   COMPOSE_PROJECT_NAME  이관 서버는 planetory-service를 유지한다
#
# 알아 둘 것 셋.
#
# 1. 롤백은 **이미지만** 되돌린다. 스키마는 되돌리지 않는다. Flyway는 앞으로만 가고
#    clean이 막혀 있다. 이 저장소의 마이그레이션은 추가형뿐이라 구 앱이 새 스키마에서
#    Hibernate validate를 통과하지만, 되돌릴 수 없는 변경은 CI(backend:schema)가 막는다.
# 2. compose.yaml은 되돌리지 않는다. 포트·환경변수·볼륨 정의를 이미지 배포와 같은
#    파이프라인에 싣지 말 것.
# 3. 덤프는 DB와 같은 호스트·같은 디스크에 있다. 인스턴스를 잃으면 함께 사라진다.

set -eu
umask 077

export COMPOSE_FILE="${COMPOSE_FILE:-compose.yaml}"
COMPOSE="docker compose"
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

# 선언된 상태와 도는 상태를 맞춘다. 이게 없으면 노드에서 누가 인자 없이
# docker compose up -d 를 실행할 때 .env의 옛 이미지로 조용히 되돌아간다.
#
# 임시 파일에 쓰고 옮긴다. sed -i 와 append 를 나눠 쓰면 중간에 죽었을 때
# 잘린 .env가 남고, 그 파일은 DB 비밀번호까지 들고 있다.
#
# 단일 서비스와 복수 서비스 양쪽에서 부른다. 복수 서비스 분기가 이 기록 없이
# 끝나던 탓에 Airflow는 새 이미지로 돌면서 선언만 옛 이미지로 남았다.
record_image() {
    touch .env
    tmp=".env.deploy.$$"
    { grep -v "^${IMAGE_VAR}=" .env || true; echo "${IMAGE_VAR}=${IMAGE}"; } > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" .env
    echo "선언 갱신: ${IMAGE_VAR}=${IMAGE}"
}

set_image "$IMAGE"
$COMPOSE config -q

# 서비스 목록을 받은 job은 헬스 판정 대상이 하나로 정해지지 않는다. 종전처럼
# 교체만 하고 끝낸다. 따옴표 없이 펼쳐야 여러 서비스가 각각 인자로 전달된다.
case "$SERVICE" in
    *" "*)
        # shellcheck disable=SC2086
        $COMPOSE pull $SERVICE
        if [ "$ACTION" = "up" ]; then
            # shellcheck disable=SC2086
            $COMPOSE up -d --no-deps $SERVICE
            # 교체에 성공한 뒤에만 선언을 갱신한다. pull만 한 경우는 아직
            # 도는 이미지가 옛것이므로 기록하지 않는다.
            record_image
            # shellcheck disable=SC2086
            $COMPOSE ps $SERVICE
        fi
        echo "교체 완료(헬스 확인 없음): $SERVICE <- $IMAGE"
        exit 0
        ;;
esac

$COMPOSE pull "$SERVICE"

if [ "$ACTION" != "up" ]; then
    echo "pull만 수행했습니다: $SERVICE <- $IMAGE"
    exit 0
fi

# 헬스 확인에 쓸 도구가 없으면 멀쩡한 배포를 실패로 판정해 되돌린다. 교체 전에 막는다.
if [ -n "$HEALTH_PATH" ] && ! command -v curl >/dev/null 2>&1; then
    echo "헬스 확인에 curl이 필요한데 배포 노드에 없습니다. 교체하지 않고 중단합니다." >&2
    exit 2
fi

# 정지·crash loop 상태의 컨테이너도 잡아야 한다. -a 없이는 보이지 않아 직전 이미지를
# 못 찾고 "첫 배포"로 오판하며, 그러면 재시도 배포에서 롤백이 조용히 사라진다.
current_image() {
    container=$($COMPOSE ps -aq "$SERVICE" 2>/dev/null | head -n 1)
    [ -n "$container" ] || return 0
    docker inspect -f '{{.Config.Image}}' "$container" 2>/dev/null || true
}

# 호스트에 게시된 주소를 compose에서 읽는다. .env의 포트를 바꿔도 따라간다.
health_url() {
    published=$($COMPOSE port "$SERVICE" "$HEALTH_PORT" 2>/dev/null | head -n 1)
    [ -n "$published" ] || return 1
    echo "http://${published}${HEALTH_PATH}"
}

# Compose --wait를 통과한 뒤 호스트 게시 경로의 실제 HTTP 응답도 확인한다.
# 대기는 벽시계로 센다. curl 타임아웃과 왕복 시간을 빼먹으면 설정값의 몇 배를 기다린다.
wait_healthy() {
    [ -n "$HEALTH_PATH" ] || return 0
    deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        url=$(health_url || true)
        if [ -n "$url" ] && curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
            echo "헬스 통과: $url"
            return 0
        fi
        sleep 3
    done
    echo "헬스 실패: ${HEALTH_TIMEOUT}초 안에 ${SERVICE}:${HEALTH_PORT}${HEALTH_PATH} 가 응답하지 않았습니다" >&2
    return 1
}

# up -d는 기존 컨테이너를 먼저 지우고 새로 만든다. 실패를 그대로 두면 set -e가
# 스크립트를 죽여 롤백에 도달하지 못하고, 구 컨테이너는 이미 사라진 뒤다.
replace() {
    set_image "$1"
    $COMPOSE up -d --no-deps --wait --wait-timeout "$HEALTH_TIMEOUT" "$SERVICE" || return 1
}

PREVIOUS=$(current_image)
if [ -n "$PREVIOUS" ]; then
    echo "직전 이미지: $PREVIOUS"
else
    echo "직전 이미지가 없습니다(첫 배포). 실패해도 되돌릴 대상이 없습니다."
fi

if [ "$DB_BACKUP" = "true" ]; then
    mkdir -p "$BACKUP_DIR"
    dump="$BACKUP_DIR/service-db-$(date +%Y%m%d-%H%M%S).sql"
    # 리다이렉트는 명령 실행 전에 파일을 만든다. 중간에 죽으면 잘린 덤프가 남고,
    # 보존 정책이 그걸 백업으로 세어 진짜 백업을 밀어낸다. .partial로 받아 검사 후 옮긴다.
    # 접속 정보는 컨테이너 안의 환경변수를 그대로 쓴다. 호스트 셸로 꺼내지 않는다.
    if ! $COMPOSE exec -T service-db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$dump.partial"; then
        rm -f "$dump.partial"
        echo "DB 덤프에 실패했습니다. 되돌릴 수단 없이 마이그레이션을 돌리지 않습니다." >&2
        echo "service-db가 살아 있는지 확인하십시오. 교체하지 않았습니다." >&2
        exit 3
    fi
    if ! tail -n 5 "$dump.partial" | grep -q 'PostgreSQL database dump complete'; then
        rm -f "$dump.partial"
        echo "덤프가 완결되지 않았습니다. 교체하지 않았습니다." >&2
        exit 3
    fi
    mv "$dump.partial" "$dump"
    echo "DB 덤프: $dump ($(wc -c < "$dump") bytes)"
    # 볼륨이 유일한 사본이라 덤프를 함부로 지우면 안 되지만, 무한히 쌓여 디스크를
    # 채우는 것도 서비스 중단이다. 최근 10개만 남긴다.
    ls -1t "$BACKUP_DIR"/service-db-*.sql 2>/dev/null | tail -n +11 | while read -r old; do
        rm -f "$old"
    done
fi

rollback() {
    echo "=== 배포 실패. 되돌립니다 ===" >&2
    mkdir -p "$BACKUP_DIR"
    failure_log="$BACKUP_DIR/deploy-$(date +%Y%m%d-%H%M%S).log"
    $COMPOSE logs --tail 50 "$SERVICE" > "$failure_log" 2>&1 || true
    echo "실패 로그(보호된 로컬 파일): $failure_log" >&2

    if [ -z "$PREVIOUS" ]; then
        echo "되돌릴 이미지가 없습니다. $SERVICE 는 실패한 상태로 남습니다." >&2
        echo "재시작 루프를 멈추려면 docker compose stop $SERVICE 를 실행하고 조사하십시오." >&2
        exit 1
    fi

    if ! replace "$PREVIOUS"; then
        echo "되돌리기 자체가 실패했습니다. 사람이 확인해야 합니다." >&2
        exit 1
    fi

    if wait_healthy; then
        echo "되돌렸습니다: $SERVICE <- $PREVIOUS" >&2
        if [ "$DB_BACKUP" = "true" ]; then
            echo "주의: 이미지만 되돌렸습니다. 스키마는 그대로입니다. 덤프는 $BACKUP_DIR 에 있습니다." >&2
        fi
        exit 1
    fi

    echo "되돌린 뒤에도 헬스가 통과하지 않습니다. 사람이 확인해야 합니다." >&2
    exit 1
}

replace "$IMAGE" || rollback
wait_healthy || rollback

# 교체가 실제로 일어났는지 확인한다. IMAGE_VAR가 compose.yaml이 읽는 이름과 다르면
# 아무도 안 읽는 변수를 내보내고, up -d는 할 일이 없어 구 컨테이너가 계속 응답하며,
# 헬스는 통과한다. 그대로 두면 배포하지 않고 성공을 보고한다.
RUNNING=$(current_image)
if [ "$RUNNING" != "$IMAGE" ]; then
    echo "교체가 반영되지 않았습니다. 도는 이미지: $RUNNING" >&2
    echo "IMAGE_VAR=$IMAGE_VAR 가 compose.yaml의 변수 이름과 맞는지 확인하십시오." >&2
    exit 4
fi

record_image

$COMPOSE ps "$SERVICE"
echo "배포 완료: $SERVICE <- $IMAGE"
