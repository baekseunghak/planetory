#!/bin/sh
# 마이그레이션 검사 [S15P21C206-84]
#
# 두 가지를 본다.
#   1. 버전 번호 선점 — 타깃 브랜치의 최대 번호보다 낮은 새 마이그레이션.
#      머지 뒤 그 번호가 이미 적용된 최대값보다 낮아져 Flyway가 거부한다.
#   2. 되돌릴 수 없는 변경 — 이미지를 되돌려도 복구되지 않는 스키마 변경.
#
# 검사 대상은 **타깃 브랜치 대비 이번에 추가·수정된 파일뿐**이다. 작업 트리
# 전체를 훑으면 이미 병합된 마이그레이션을 계속 다시 잡는다. 실제로 그 방식
# 때문에 기본 브랜치의 V19(REVOKE 3줄)가 병합 직후 파이프라인을 멈추게 했다.
#
# 타깃을 알 수 없으면(브랜치 파이프라인, 로컬) 건너뛴다. 이 검사는 머지 전
# 관문이고, 이미 병합된 변경을 다시 막는 것은 의미가 없다.
#
# 로컬 실행:
#   sh apps/backend/scripts/check-migrations.sh --self-test
#   CI_MERGE_REQUEST_TARGET_BRANCH_NAME=develop sh apps/backend/scripts/check-migrations.sh

set -eu

DIR="${MIGRATION_DIR:-apps/backend/src/main/resources/db/migration}"

# 이미 적용된 마이그레이션은 검사에서 뺀다. 파일을 고치면 Flyway 체크섬이
# 바뀌어 기존 DB가 기동을 거부하므로 허용 표시를 넣을 방법이 없다.
GRANDFATHERED="${SCHEMA_GRANDFATHERED:-V5__exploration_domain_constraints.sql}"

# 넓은 검사. 주석과 문자열 리터럴을 걷어낸 본문에 건다. 설명을 썼다는 이유로
# 막으면 아무도 설명을 쓰지 않게 된다.
BROAD="${SCHEMA_IRREVERSIBLE:-DROP +(TABLE|COLUMN|VIEW|MATERIALIZED|TYPE|SEQUENCE|FUNCTION|TRIGGER)|ALTER +TABLE +[^ ]+ +DROP|RENAME|SET +NOT +NULL|REVOKE|ALTER +COLUMN +[^ ]+ +TYPE}"

# 좁은 검사. 문자열을 남긴 본문에 건다. 이 저장소의 권한 변경은 전부
# DO $$ ... EXECUTE format('REVOKE ...') ... $$ 안에 있어 넓은 검사가 문자열을
# 걷어낸 뒤에는 한 건도 걸리지 않았다(V2·V11·V13·V16·V18의 REVOKE 9건 → 0건).
# SQL 문자열에 잘 나오지 않는 동사만 넣어 오탐을 줄인다.
STRICT="${SCHEMA_IRREVERSIBLE_STRICT:-REVOKE|DROP +TABLE|DROP +COLUMN|RENAME|SET +NOT +NULL}"

# 주석을 줄 단위로 걷어낸 뒤 줄바꿈·탭을 공백 하나로 접는다. 줄 단위 grep은
# `ALTER TABLE users` 다음 줄의 `DROP nickname`을 놓치고, 탭으로 띄운 키워드도
# 놓친다. 주석 제거는 줄을 합치기 전에 해야 뒤 내용이 삼켜지지 않는다.
#
# 남은 구멍 하나. 주석 제거가 문자열 리터럴을 구분하지 않으므로, 문자열 안에
# `--`가 있으면 같은 줄의 나머지가 통째로 지워진다. 아래 한 줄은 통과한다.
#
#   EXECUTE format('a--b'); REVOKE UPDATE ON t FROM planetory_app;
#
# 걸리려면 "문자열 안의 --"와 "한 줄에 두 문장"이 동시에 성립해야 하는데 지금
# 저장소에는 각각 0건이다. 막으려면 SQL 문자열을 인식하는 파서가 필요해 비용이
# 크다. **이 검사는 완전한 차단이 아니라 실수 방지다.**
flatten() {
    sed -e 's/--.*$//' "$1" | tr '\n\t' '  ' | tr -s ' '
}

flatten_no_strings() {
    sed -e 's/--.*$//' -e "s/'[^']*'//g" "$1" | tr '\n\t' '  ' | tr -s ' '
}

# 되돌릴 수 없는 구문을 찾아 표준출력으로 낸다. 없으면 아무것도 내지 않는다.
find_irreversible() {
    file="$1"
    flatten_no_strings "$file" | grep -oiE "$BROAD" || true
    flatten "$file" | grep -oiE "$STRICT" || true
}

allowed() {
    grep -qiE '^[[:space:]]*--[[:space:]]*IRREVERSIBLE' "$1"
}

# --- 회귀 검사 --------------------------------------------------------------
# 리뷰에서 실제로 우회가 확인된 입력을 고정한다. 검사를 고칠 때 같이 돈다.
self_test() {
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    fail=0

    expect() {
        name="$1"; want="$2"; body="$3"
        printf '%s' "$body" > "$tmp/$name"
        if [ -n "$(find_irreversible "$tmp/$name")" ]; then got=block; else got=pass; fi
        if [ "$got" = "$want" ]; then
            echo "  ok    $name ($want)"
        else
            echo "  FAIL  $name: $want 를 기대했으나 $got" >&2
            fail=1
        fi
    }

    echo "회귀 검사"
    expect oneline block 'ALTER TABLE users DROP nickname;
'
    expect multiline block 'ALTER TABLE users
  DROP nickname;
'
    expect tabs block 'ALTER TABLE	users	DROP	nickname;
'
    expect revoke_in_string block 'DO $$
BEGIN
    EXECUTE format('"'"'REVOKE DELETE ON %I.%I FROM planetory_app'"'"', '"'"'public'"'"', '"'"'users'"'"');
END $$;
'
    expect plain_add pass 'ALTER TABLE users ADD COLUMN nickname TEXT;
'
    expect comment_only pass '-- 이 마이그레이션은 컬럼을 DROP 하지 않는다. REVOKE 도 없다.
ALTER TABLE users ADD COLUMN memo TEXT;
'
    expect set_not_null block 'ALTER TABLE users ALTER COLUMN nickname SET NOT NULL;
'

    # 번호 역전은 차단이어야 한다. 인라인 구현을 스크립트로 옮기면서 한 번
    # 경고로 약해진 적이 있다. exit 1 이 남아 있는지 여기서 고정한다.
    if grep -A6 'if \[ "\$taken" = "1" \]; then' "$0" | grep -q "exit 1"; then
        echo "  ok    version_preemption_blocks (exit 1 유지)"
    else
        echo "  FAIL  version_preemption_blocks: 번호 역전이 차단이 아니라 경고입니다" >&2
        fail=1
    fi

    if [ "$fail" = "1" ]; then
        echo "회귀 검사 실패" >&2
        exit 1
    fi
    echo "회귀 검사 통과"
}

if [ "${1:-}" = "--self-test" ]; then
    self_test
    exit 0
fi

# --- 실제 검사 --------------------------------------------------------------
TARGET="${CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-}"

if [ -z "$TARGET" ]; then
    echo "타깃 브랜치를 알 수 없어 검사를 건너뜁니다(브랜치 파이프라인 또는 로컬)."
    echo "이 검사는 머지 전 관문입니다. 이미 병합된 변경은 다시 보지 않습니다."
    exit 0
fi

if ! git fetch --quiet --depth=50 origin "$TARGET" 2>/dev/null; then
    echo "경고: 타깃 브랜치($TARGET)를 가져오지 못해 검사를 건너뜁니다." >&2
    exit 0
fi

version_of() { n=${1#V}; echo "${n%%__*}"; }

CHANGED=$(git diff --name-only --diff-filter=AM "origin/$TARGET...HEAD" -- "$DIR" || true)

if [ -z "$CHANGED" ]; then
    echo "이번 변경에 마이그레이션이 없습니다. 검사할 것이 없습니다."
    exit 0
fi

echo "이번 변경에서 추가·수정된 마이그레이션:"
echo "$CHANGED" | sed 's/^/  /'
echo ""

# 0. 이름 규칙과 한 브랜치 안의 번호 중복. 디렉터리 전체를 본다. 중복이 있으면
#    Flyway가 애초에 기동하지 못하므로 타깃에는 있을 수 없고, 따라서 전체를
#    검사해도 이미 병합된 것 때문에 실패하지 않는다.
names=$(ls "$DIR"/V*.sql 2>/dev/null | sed 's#.*/##' || true)
if [ -n "$names" ]; then
    numbers=$(echo "$names" | sed -nE 's/^V([0-9]+)__.*/\1/p')
    if [ "$(echo "$numbers" | grep -c .)" != "$(echo "$names" | grep -c .)" ]; then
        echo "이름 규칙에 맞지 않는 마이그레이션이 있습니다. V<정수>__<설명>.sql 이어야 합니다." >&2
        echo "$names" >&2
        exit 1
    fi
    duplicates=$(echo "$numbers" | sort -n | uniq -d)
    if [ -n "$duplicates" ]; then
        echo "마이그레이션 버전 번호가 겹칩니다: $duplicates" >&2
        exit 1
    fi
fi

# 1. 버전 번호 선점
base_max=$(git ls-tree --name-only "origin/$TARGET" -- "$DIR/" | while read -r path; do
    case "${path##*/}" in V*__*.sql) version_of "${path##*/}" ;; esac
done | sort -n | tail -1)

if [ -z "$base_max" ]; then
    echo "타깃에 마이그레이션이 없습니다. 선점 검사를 건너뜁니다."
else
    echo "타깃($TARGET)의 최대 버전: V$base_max"
    taken=0
    for path in $CHANGED; do
        name="${path##*/}"
        case "$name" in V*__*.sql) ;; *) continue ;; esac
        # 타깃에 이미 있는 파일은 새 번호가 아니다.
        if git ls-tree --name-only "origin/$TARGET" -- "$path" | grep -q .; then
            continue
        fi
        v=$(version_of "$name")
        if [ "$v" -le "$base_max" ]; then
            echo "경고: $name 이 타깃의 최대 버전 V$base_max 보다 낮거나 같습니다." >&2
            taken=1
        fi
    done
    if [ "$taken" = "1" ]; then
        echo "" >&2
        echo "타깃의 최대 번호(V$base_max)보다 큰 번호로 바꾸십시오." >&2
        echo "이 저장소는 out-of-order를 쓰지 않습니다. V$base_max 까지 적용된 DB에" >&2
        echo "그보다 낮은 번호가 들어가면 Flyway가 기동을 거부합니다." >&2
        exit 1
    fi
    echo "버전 선점 검사 통과"
    echo "한계: 타깃과만 비교한다. 열려 있는 MR 둘이 각각 같은 번호를 추가하면"
    echo "      둘 다 통과하고 나중에 머지되는 쪽이 깨진다. 타깃에서 이미 확인되는"
    echo "      번호 역전은 위에서 막는다. 둘은 별개다."
fi

# 2. R__table_comments.sql이 테이블을 덮는지. 머리말이 "새 테이블이 생기면
#    여기에 추가한다"고 적었지만 강제할 수단이 없어 member_sky_revisions가
#    34개 중 하나만 빠진 채로 남아 있었다. DB 없이 대조할 수 있다.
#
#    **설명 누락은 이번 변경이 만든 테이블만 본다.** 전체를 훑으면 누가 설명을
#    빠뜨린 뒤로 마이그레이션을 건드리는 모든 MR이 남의 결손 때문에 막힌다.
#    위 1번에서 고친 것과 같은 구조다.
#
#    유령 설명(없는 테이블에 COMMENT ON)은 전체를 본다. 그 상태로는 Flyway가
#    기동 중 실패하므로 타깃에 미리 존재할 수 없고, 따라서 남의 결손이 될 일이
#    없다. 이번 변경이 만든 것만 잡힌다.
comments_file="$DIR/R__table_comments.sql"
if [ -f "$comments_file" ]; then
    strip='s/--.*$//'
    created=$(sed -e "$strip" "$DIR"/V*.sql 2>/dev/null \
        | grep -oiE 'CREATE +TABLE +(IF +NOT +EXISTS +)?[a-z_][a-z0-9_]*' \
        | awk '{print tolower($NF)}' | sort -u)
    dropped=$(sed -e "$strip" "$DIR"/V*.sql 2>/dev/null \
        | grep -oiE 'DROP +TABLE +(IF +EXISTS +)?[a-z_][a-z0-9_]*' \
        | awk '{print tolower($NF)}' | sort -u)
    tables=$(echo "$created" | grep -vxF "$dropped" 2>/dev/null || echo "$created")
    commented=$(sed -e "$strip" "$comments_file" \
        | grep -oiE 'COMMENT +ON +TABLE +[a-z_][a-z0-9_]*' \
        | awk '{print tolower($NF)}' | sort -u)

    # 누락은 이번 변경이 만든 테이블만 본다.
    changed_v=$(echo "$CHANGED" | grep -E '/V[0-9]+__.*\.sql$' || true)
    if [ -n "$changed_v" ]; then
        new_tables=$(sed -e "$strip" $changed_v 2>/dev/null \
            | grep -oiE 'CREATE +TABLE +(IF +NOT +EXISTS +)?[a-z_][a-z0-9_]*' \
            | awk '{print tolower($NF)}' | sort -u)
        new_tables=$(echo "$new_tables" | grep -vxF "$dropped" 2>/dev/null || echo "$new_tables")
    else
        new_tables=""
    fi
    missing=$(echo "$new_tables" | grep -vxF "$commented" | grep -v '^$' || true)
    stale=$(echo "$commented" | grep -vxF "$tables" || true)
    if [ -n "$missing" ]; then
        echo "R__table_comments.sql에 설명이 없는 테이블이 있습니다:" >&2
        echo "$missing" | sed 's/^/    /' >&2
        echo "ERD는 pg_description을 읽으므로 설명이 없으면 화면에서도 비어 보입니다." >&2
        exit 1
    fi
    if [ -n "$stale" ]; then
        echo "R__table_comments.sql이 없는 테이블에 설명을 걸고 있습니다:" >&2
        echo "$stale" | sed 's/^/    /' >&2
        echo "없는 테이블에 COMMENT ON을 걸면 Flyway가 기동 중 실패합니다." >&2
        exit 1
    fi
    if [ -n "$new_tables" ]; then
        echo "테이블 설명 대조 통과(이번 변경이 만든 $(echo "$new_tables" | grep -c .)개, 전체 $(echo "$tables" | grep -c .)개)"
    else
        echo "테이블 설명 대조 통과(이번 변경은 새 테이블을 만들지 않음, 전체 $(echo "$tables" | grep -c .)개)"
    fi
fi

# 3. 되돌릴 수 없는 변경
failed=0
for path in $CHANGED; do
    name="${path##*/}"
    case "$name" in V*__*.sql|R*__*.sql) ;; *) continue ;; esac
    case " $GRANDFATHERED " in *" $name "*) continue ;; esac
    [ -f "$path" ] || continue

    hits=$(find_irreversible "$path")
    [ -n "$hits" ] || continue

    if allowed "$path"; then
        echo "되돌릴 수 없는 변경을 명시적으로 허용했습니다: $name"
        continue
    fi
    failed=1
    echo "되돌릴 수 없는 변경이 있습니다: $name" >&2
    echo "$hits" | sort -u | sed 's/^/    /' >&2
done

if [ "$failed" = "1" ]; then
    echo "" >&2
    echo "세 배포로 나누면 어느 단계에서 실패해도 이미지 롤백으로 복구됩니다." >&2
    echo "  1차: 새 열을 추가만 한다 (구 앱·신 앱 모두 동작)" >&2
    echo "  2차: 코드가 새 열을 쓰게 바꾼다 (스키마 변경 없음)" >&2
    echo "  3차: 아무도 쓰지 않게 된 구 열을 지운다" >&2
    echo "" >&2
    echo "나눌 수 없다면 파일에 '-- IRREVERSIBLE: <근거>' 줄을 추가하십시오." >&2
    exit 1
fi

echo "마이그레이션 검사 통과"
