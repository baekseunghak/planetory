package com.planetory.backend.domain.exploration.service;

import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.List;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import com.planetory.backend.domain.exploration.service.SkyViews.Bounds;
import com.planetory.backend.domain.exploration.service.SkyViews.SkyMeta;
import com.planetory.backend.domain.exploration.service.SkyViews.SkyStar;
import com.planetory.backend.domain.exploration.service.SkyViews.SkyTile;
import com.planetory.backend.domain.exploration.service.SkyViews.TileBounds;
import com.planetory.backend.domain.exploration.service.SkyViews.ZoomLevel;

/**
 * 별 지도 메타·타일 조회 [S15P21C206-136].
 *
 * <p>모든 배율에서 개별 별을 준다. 서버가 군집을 만들지 않는다(ERD v1.3 미결 8, D-16 이후 계약).
 */
@Service
@RequiredArgsConstructor
public class SkyService {

    public static final int DEFAULT_LIMIT = 1000;
    public static final int MAX_LIMIT = 2000;

    /**
     * 배율 단계. 모든 단계가 같은 개별 별을 주며 축소해도 생략하지 않는다.
     * 프론트는 단계 수와 scale을 하드코딩하지 않고 메타에서 읽는다.
     */
    private static final List<ZoomLevel> ZOOM_LEVELS = List.of(
            new ZoomLevel(0, 0.25), new ZoomLevel(1, 0.5), new ZoomLevel(2, 1),
            new ZoomLevel(3, 2), new ZoomLevel(4, 4));

    /**
     * 배율 1.0인 기준 단계. 위치 찾기는 카메라를 옮기는 조회라 가장 넓은 쪽도 좁은 쪽도 아닌 기본
     * 배율을 준다. 단계 목록이 바뀌어도 따라오도록 상수로 박지 않고 찾는다.
     */
    private static final int NEUTRAL_LEVEL = ZOOM_LEVELS.stream()
            .filter(zoom -> zoom.scale() == 1).findFirst().orElseThrow().level();

    private final SkyRepository stars;
    private final StarRepository unlocks;
    private final JdbcClient jdbc;
    private final Clock clock;
    private final SkyProperties properties;

    /** 정사각 타일 한 변. 응답 범위를 이 격자에 맞춘다. 메타로 프론트에 알린다. */
    public int tileSize() {
        return properties.tileSize();
    }

    /** 경계 상자 상한. 한 요청이 지도를 통째로 끌어오지 못하게 막는다. */
    public int maxBox() {
        return properties.maxBox();
    }

    /**
     * 메타는 경계·별 수·버전·중심 별을 한 스냅샷에서 읽는다 [S15P21C206-137].
     *
     * <p>네 값을 따로 읽으면 그 사이에 들어온 발견이 일부에만 반영돼, 프론트가 받은 경계 밖에
     * 별이 있거나 별 수와 실제가 어긋난 상태로 화면을 그린다.
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public SkyMeta meta(long memberId, boolean firstVisit) {
        Bounds bounds = stars.findBounds(memberId)
                // 가입 처리가 튜토리얼 1번을 열므로 별 0개는 없다(9.4절). 그래도 응답은 성립해야 한다.
                .orElseGet(() -> new Bounds(0, 0, 0, 0));
        return new SkyMeta(SkyViews.REPRESENTATION, version(memberId),
                PersonalSpiralGalaxyLayout.LAYOUT_VERSION, PRESENTATION_VERSION,
                stars.countStars(memberId), bounds, tileSize(), ZOOM_LEVELS,
                stars.findCenterTicIds(memberId), firstVisit, now());
    }

    /**
     * 별 위치 찾기(4.1절). 검색·필터로 고른 별이 아직 받지 않은 범위에 있을 때 쓴다.
     *
     * <p>발견한 별만 허용한다. 좌표는 별 상세와 <b>같은 조회</b>에서 가져와 세 화면이 어긋나지 않게 한다.
     * 경계 상자는 그 별이 들어 있는 타일 한 칸이며, 타일 조회와 같은 격자에 맞춘다.
     *
     * @throws BusinessException 발견하지 않은 별이면 {@code STAR_LOCKED}
     */
    @Transactional(readOnly = true)
    public SkyViews.Locate locate(long memberId, long ticId) {
        StarViews.Position position = unlocks.findUnlock(memberId, ticId)
                .orElseThrow(() -> new BusinessException(ErrorCode.STAR_LOCKED))
                .position();
        int tile = tileSize();
        return new SkyViews.Locate(String.valueOf(ticId), position.x(), position.y(), position.depthZ(),
                NEUTRAL_LEVEL,
                new SkyViews.TileBounds(Math.floor(position.x() / tile) * tile,
                        Math.floor(position.y() / tile) * tile, tile, tile),
                position.layoutOrdinal(), position.layoutVersion(), version(memberId));
    }

    /** 프론트 연출 계약 버전. 좌표 배치 버전과 다른 값이다. */
    public static final String PRESENTATION_VERSION = "personal-galaxy-v1";

    /**
     * 요청 범위의 별 한 페이지.
     *
     * <p>요청 version이 현재와 다르면 별을 주지 않고 재시작을 요구한다. 이때의 빈 배열은
     * 빈 지도나 적재 완료가 아니다.
     *
     * <p>버전·페이지·범위 수를 <b>한 스냅샷</b>에서 읽는다 [S15P21C206-137]. 기본 격리 수준은
     * 문장마다 스냅샷을 새로 떠서, 읽는 도중 발견이 들어오면 {@code rangeStarCount}가 실제로
     * 받게 될 페이지 합과 달라진다. 프론트는 그 수로 적재 완료를 판단하므로 영원히 기다리거나
     * 덜 받은 채로 끝난다. REPEATABLE READ는 첫 문장의 스냅샷을 트랜잭션 끝까지 유지한다.
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public SkyTile tiles(long memberId, int level, double x, double y, double w, double h,
                         String requestedVersion, Integer requestedLimit, String cursor) {
        validateLevel(level);
        validateBox(x, y, w, h);
        int limit = validateLimit(requestedLimit);

        String current = version(memberId);
        if (!current.equals(requestedVersion)) {
            // 이전 cursor를 새 데이터에 적용하지 않는다. 프론트는 메타부터 다시 받는다.
            return new SkyTile(SkyViews.REPRESENTATION, current, level, true,
                    snapToTiles(x, y, w, h), 0, List.of(), null, now());
        }

        TileBounds bounds = snapToTiles(x, y, w, h);
        SkyCursor request = new SkyCursor(memberId, current, level, x, y, w, h, limit, 0);
        Long afterTicId = cursor == null ? null
                : SkyCursor.decode(cursor, request)
                        .map(SkyCursor::afterTicId)
                        .orElseThrow(() -> new BusinessException(ErrorCode.VALIDATION_FAILED));

        // 한 건 더 읽어 다음 페이지 유무를 판단한다. 남은 것이 없으면 nextCursor는 null이다.
        List<SkyStar> page = stars.findStarsInRange(memberId, bounds, afterTicId, limit + 1);
        boolean hasMore = page.size() > limit;
        List<SkyStar> visible = hasMore ? page.subList(0, limit) : page;
        String nextCursor = hasMore
                ? new SkyCursor(memberId, current, level, x, y, w, h, limit,
                        Long.parseLong(visible.get(visible.size() - 1).ticId())).encode()
                : null;

        return new SkyTile(SkyViews.REPRESENTATION, current, level, false, bounds,
                stars.countInRange(memberId, bounds), visible, nextCursor, now());
    }

    /**
     * 회원 지도 버전을 올린다. 발견·상태 변경 트랜잭션 안에서 호출한다(D-7).
     *
     * @return 올린 뒤의 값. 제출·공개·재개 응답의 {@code skyVersion}에 그대로 넣는다.
     */
    @Transactional
    public String bumpVersion(long memberId) {
        long revision = jdbc.sql("""
                        INSERT INTO member_sky_revisions(user_id, revision, updated_at)
                             VALUES (:memberId, 1, CURRENT_TIMESTAMP)
                        ON CONFLICT (user_id) DO UPDATE
                                SET revision = member_sky_revisions.revision + 1,
                                    updated_at = CURRENT_TIMESTAMP
                          RETURNING revision
                        """)
                .param("memberId", memberId)
                .query(Long.class).single();
        return format(memberId, revision);
    }

    /**
     * 현재 버전. 행이 없으면 아직 아무 변경도 없었다는 뜻이라 0으로 읽는다.
     *
     * <p>여기서 1을 주면 첫 {@link #bumpVersion(long)}이 같은 값을 만들어, 실제로 변경이
     * 있었는데 프론트가 알아채지 못한다.
     */
    public String version(long memberId) {
        long revision = jdbc.sql("SELECT revision FROM member_sky_revisions WHERE user_id = :memberId")
                .param("memberId", memberId)
                .query(Long.class).optional().orElse(0L);
        return format(memberId, revision);
    }

    private static String format(long memberId, long revision) {
        return "u-" + memberId + ":" + revision;
    }

    /**
     * 요청 상자를 타일 격자에 맞춰 넓힌다. 왼쪽·아래 경계는 포함하고 오른쪽·위는 제외하므로
     * 같은 격자의 이웃 요청이 같은 별을 두 번 주지 않는다.
     */
    TileBounds snapToTiles(double x, double y, double w, double h) {
        int tile = tileSize();
        double minX = Math.floor(x / tile) * tile;
        double minY = Math.floor(y / tile) * tile;
        double maxX = Math.ceil((x + w) / tile) * tile;
        double maxY = Math.ceil((y + h) / tile) * tile;
        return new TileBounds(minX, minY, maxX - minX, maxY - minY);
    }

    private void validateLevel(int level) {
        if (ZOOM_LEVELS.stream().noneMatch(zoom -> zoom.level() == level)) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
    }

    private void validateBox(double x, double y, double w, double h) {
        boolean finite = Double.isFinite(x) && Double.isFinite(y)
                && Double.isFinite(w) && Double.isFinite(h);
        if (!finite || w <= 0 || h <= 0 || w > maxBox() || h > maxBox()) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
    }

    private int validateLimit(Integer requested) {
        if (requested == null) {
            return DEFAULT_LIMIT;
        }
        if (requested < 1 || requested > MAX_LIMIT) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        return requested;
    }

    private OffsetDateTime now() {
        return OffsetDateTime.now(clock);
    }
}
