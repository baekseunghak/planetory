package com.planetory.backend.domain.exploration.service;

import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import com.planetory.backend.domain.exploration.service.StarViews.Achievement;
import com.planetory.backend.domain.exploration.service.StarViews.Actions;
import com.planetory.backend.domain.exploration.service.StarViews.Planets;
import com.planetory.backend.domain.exploration.service.StarViews.Progress;
import com.planetory.backend.domain.exploration.service.StarViews.PublicStarSummary;
import com.planetory.backend.domain.exploration.service.StarViews.StarDetail;
import com.planetory.backend.domain.exploration.service.StarViews.StarInfo;
import com.planetory.backend.domain.exploration.service.StarViews.Unlock;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

/**
 * 선택한 별·내 행성 상세 (탐사 API 4.2) [S15P21C206-138].
 */
@Service
@RequiredArgsConstructor
public class StarService {

    private final StarRepository stars;
    private final SkyService sky;
    private final Clock clock;

    /**
     * 발견한 별의 상세.
     *
     * <p>상세·진행·개인 행성을 <b>한 스냅샷</b>에서 읽는다(4.2절). 따로 읽으면 행성 목록과
     * {@code planets.count}, 지도의 {@code planetCount}가 서로 어긋난 채로 나갈 수 있다.
     *
     * @throws BusinessException 발견하지 않은 별이면 {@code STAR_LOCKED}
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public StarDetail detail(long memberId, long ticId) {
        if (!stars.hasUnlocked(memberId, ticId)) {
            // 별의 존재 자체는 숨기지 않는다. 열리지 않았다는 사실만 알린다(NFR-06, AT-64).
            throw new BusinessException(ErrorCode.STAR_LOCKED);
        }
        StarInfo star = stars.findStar(ticId)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        Unlock unlock = stars.findUnlock(memberId, ticId)
                .orElseThrow(() -> new BusinessException(ErrorCode.STAR_LOCKED));

        // 분석을 시작하지 않았으면 진행 행이 없다. 응답은 그래도 성립해야 한다.
        Progress progress = stars.findProgress(memberId, ticId)
                .orElseGet(() -> new Progress("unexplored", null, null, false, null, null));

        List<StarViews.PlanetItem> items = stars.findMyPlanets(memberId, ticId);
        boolean completed = "completed".equals(progress.stage());
        Planets planets = new Planets(items.size(), completed && items.isEmpty(), items);

        Achievement counted = stars.countAchievements(memberId, ticId);
        Achievement achievement = new Achievement(counted.count(), grade(counted.count()),
                counted.byType());

        boolean hasSubmission = stars.hasSubmission(memberId, ticId);
        Actions actions = new Actions(analysisAction(progress, hasSubmission), hasSubmission,
                stars.isBoardOpen(ticId), stars.countThreads(ticId));

        return new StarDetail(String.valueOf(ticId), OffsetDateTime.now(clock), star, unlock,
                progress, planets, achievement, stars.findMarker(memberId, ticId).orElse(null),
                actions, sky.version(memberId), SkyService.PRESENTATION_VERSION);
    }

    /**
     * 공개 별 요약 (탐사 API 4.5).
     *
     * <p>발견하지 않은 회원도 부를 수 있다. 별 게시판 헤더·[이 별 분석하기] 버튼·출처 카드가 쓴다.
     *
     * <p>미공개 별과 아무도 발견하지 않은 별은 <b>같은 404</b>로 덮는다. 둘을 구분해 응답하면
     * 없는 TIC과 있는 TIC을 가려낼 수 있게 된다(4.5절).
     *
     * <p>후보 수·확정 보유 여부·타인의 진행 상태는 넣지 않는다.
     *
     * @throws BusinessException 미공개이거나 아무도 발견하지 않았으면 {@code STAR_NOT_PUBLISHED}
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public PublicStarSummary publicSummary(long memberId, long ticId) {
        StarViews.PublicStarInfo star = stars.findPublishedStar(ticId)
                .orElseThrow(() -> new BusinessException(ErrorCode.STAR_NOT_PUBLISHED));
        if (!stars.isBoardOpen(ticId)) {
            throw new BusinessException(ErrorCode.STAR_NOT_PUBLISHED);
        }

        // 뜻이 다른 두 값이지만 지금 판정 기준은 같다. 나중에 갈릴 수 있어 필드를 나눠 둔다.
        boolean unlockedForMe = stars.hasUnlocked(memberId, ticId);

        return new PublicStarSummary(String.valueOf(ticId), star, true, unlockedForMe,
                unlockedForMe, stars.findCurrentBundleId(ticId).orElse(null),
                stars.countDiscoveredMembers(ticId));
    }

    /** 목록 기본 크기와 상한. 상한은 한 요청이 목록을 통째로 끌어오지 못하게 막는다. */
    public static final int DEFAULT_LIST_SIZE = 20;
    public static final int MAX_LIST_SIZE = 100;

    private static final String SCOPE_SUBMITTED = "submitted";
    private static final String SCOPE_DISCOVERED = "discovered";
    private static final String SORT_RECENT = "recent";

    /**
     * 내 별 목록 (탐사 API 4.4).
     *
     * <p>{@code submitted}는 제출 이력이 있는 별(MY-02), {@code discovered}는 발견한 별 전부다.
     * {@code discovered}는 <b>본인 조회에서만</b> 허용한다. 타인의 미제출 발견까지 보이면 그
     * 사람의 진행 상태가 드러난다.
     *
     * <p>타인 조회에서 {@code unpublishedSignalCount}를 지운다(NFR-14). 0으로 바꾸지 않고 null로
     * 둔다. "공개 안 한 신호가 없다"와 "볼 수 없다"는 다른 뜻이다.
     *
     * @throws BusinessException 타인이 목록을 비공개했으면 {@code STAR_LIST_PRIVATE},
     *                           scope·sort·size가 계약 밖이면 {@code VALIDATION_FAILED}
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public StarViews.StarList list(long viewerId, long targetId, String requestedScope,
                                   String requestedSort, Integer requestedSize, String cursor) {
        boolean self = viewerId == targetId;
        String scope = validateScope(requestedScope, self);
        String sort = validateSort(requestedSort);
        int size = validateSize(requestedSize);

        if (!self && !stars.isStarListPublic(targetId)) {
            throw new BusinessException(ErrorCode.STAR_LIST_PRIVATE);
        }

        StarListCursor request = new StarListCursor(viewerId, targetId, scope, sort, size, 0, 0);
        StarListCursor position = cursor == null ? null
                : StarListCursor.decode(cursor, request)
                        .orElseThrow(() -> new BusinessException(ErrorCode.VALIDATION_FAILED));

        // 한 건 더 읽어 다음 페이지 유무를 판단한다.
        List<StarViews.StarListItem> page = stars.findStarList(targetId, scope,
                position == null ? null
                        : java.time.Instant.ofEpochMilli(position.afterActivityEpochMilli())
                                .atOffset(java.time.ZoneOffset.UTC),
                position == null ? null : position.afterTicId(),
                size + 1);

        boolean hasNext = page.size() > size;
        List<StarViews.StarListItem> visible = hasNext ? page.subList(0, size) : page;
        List<StarViews.StarListItem> items = self ? visible : visible.stream()
                .map(StarService::withoutOwnerOnlyFields)
                .toList();

        String nextCursor = null;
        if (hasNext) {
            StarViews.StarListItem last = visible.get(visible.size() - 1);
            nextCursor = new StarListCursor(viewerId, targetId, scope, sort, size,
                    last.lastActivityAt().toInstant().toEpochMilli(),
                    Long.parseLong(last.ticId())).encode();
        }
        return new StarViews.StarList(items, nextCursor, hasNext);
    }

    /** 타인에게는 미게시 수를 주지 않는다. 0이 아니라 없음이다(NFR-14). */
    private static StarViews.StarListItem withoutOwnerOnlyFields(StarViews.StarListItem item) {
        return new StarViews.StarListItem(item.ticId(), item.progressStage(), item.planetCount(),
                item.completedWithoutPlanets(), item.achievementCount(), item.grade(),
                item.currentCurveStep(), item.reopenPending(), item.reopened(), null,
                item.lastActivityAt(), item.unlockReason(), item.marker());
    }

    private static String validateScope(String requested, boolean self) {
        String scope = requested == null ? SCOPE_SUBMITTED : requested;
        if (!SCOPE_SUBMITTED.equals(scope) && !SCOPE_DISCOVERED.equals(scope)) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        if (SCOPE_DISCOVERED.equals(scope) && !self) {
            // 타인의 미제출 발견까지 보이면 그 사람의 진행 상태가 드러난다.
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        return scope;
    }

    private static String validateSort(String requested) {
        String sort = requested == null ? SORT_RECENT : requested;
        if (!SORT_RECENT.equals(sort)) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        return sort;
    }

    private static int validateSize(Integer requested) {
        if (requested == null) {
            return DEFAULT_LIST_SIZE;
        }
        if (requested < 1 || requested > MAX_LIST_SIZE) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        return requested;
    }

    /**
     * 성과 수에서 만드는 표시 등급. 열이 아니다(GRD-01).
     *
     * <p>0개는 등급이 없다. null과 "없음" 문자열을 섞지 않는다.
     */
    static String grade(int achievementCount) {
        if (achievementCount <= 0) {
            return null;
        }
        return switch (achievementCount) {
            case 1 -> "A";
            case 2 -> "S";
            case 3 -> "SS";
            default -> "SSS";
        };
    }

    /**
     * 분석 버튼이 무엇을 해야 하는지.
     *
     * <p>재개한 별은 진행 상태가 completed에서 in_progress로 돌아오므로 {@code continue}가 된다.
     * 따로 재개 분기를 두지 않는다.
     */
    private static String analysisAction(Progress progress, boolean hasSubmission) {
        if ("completed".equals(progress.stage())) {
            return "review";
        }
        return hasSubmission ? "continue" : "start";
    }
}
