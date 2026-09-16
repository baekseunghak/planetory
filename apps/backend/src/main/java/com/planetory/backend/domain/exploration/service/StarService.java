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
