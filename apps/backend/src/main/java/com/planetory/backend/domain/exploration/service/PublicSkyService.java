package com.planetory.backend.domain.exploration.service;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.function.Supplier;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/** 소유자 전체 보유 별의 공개 투영. 각 응답 반환 직전에 최신 공개 권한을 재검사한다. */
@Service
@RequiredArgsConstructor
public class PublicSkyService {
    private final SkyService sky;
    private final SkyRepository positions;
    private final StarRepository stars;
    private final PublicSkyRepository publicStars;
    private final PlatformTransactionManager transactions;
    private final Clock clock;

    public PublicSkyViews.Meta meta(long owner) {
        return readPublic(owner, () -> {
            var profile = requirePublic(owner);
            var meta = sky.meta(owner, false);
            return new PublicSkyViews.Meta(profile, "all-owned", "PUBLIC", meta.representation(),
                    version(owner), meta.layoutVersion(), meta.presentationVersion(), meta.starCount(),
                    meta.bounds(), meta.tileSize(), meta.zoomLevels(), meta.asOf());
        });
    }

    public PublicSkyViews.Tile tiles(long viewer, long owner, int level,
            double x, double y, double w, double h, String requestedVersion, Integer requestedLimit,
            String cursor) {
        return readPublic(owner, () -> {
            requirePublic(owner);
            sky.validateLevel(level);
            sky.validateBox(x, y, w, h);
            int limit = sky.validateLimit(requestedLimit);
            var bounds = sky.snapToTiles(x, y, w, h);
            String current = version(owner);
            if (!current.equals(requestedVersion)) {
                return new PublicSkyViews.Tile(SkyViews.REPRESENTATION, current, level, true,
                        bounds, 0, List.of(), null, now());
            }
            // 별도 공개 namespace와 방문자 binding으로 개인/타인 요청 커서의 혼용을 막는다.
            String prefix = "public-sky-v1." + viewer + ".";
            var request = new SkyCursor(owner, current, level, x, y, w, h, limit, 0);
            Long after = null;
            if (cursor != null) {
                if (!cursor.startsWith(prefix)) throw invalidCursor();
                var decoded = SkyCursor.decode(cursor.substring(prefix.length()), request)
                        .orElseThrow(PublicSkyService::invalidCursor);
                if (decoded.afterTicId() <= 0 || !cursor.equals(prefix + decoded.encode())) throw invalidCursor();
                after = decoded.afterTicId();
            }
            var page = publicStars.findStarsInRange(owner, bounds, after, limit + 1);
            boolean hasMore = page.size() > limit;
            var visible = hasMore ? page.subList(0, limit) : page;
            String next = hasMore ? prefix + new SkyCursor(owner, current, level, x, y, w, h, limit,
                    Long.parseLong(visible.getLast().ticId())).encode() : null;
            return new PublicSkyViews.Tile(SkyViews.REPRESENTATION, current, level, false, bounds,
                    positions.countInRange(owner, bounds), visible, next, now());
        });
    }

    public PublicSkyViews.Detail detail(long owner, long tic) {
        return readPublic(owner, () -> {
            requirePublic(owner);
            var position = stars.findUnlock(owner, tic).orElseThrow(PublicSkyService::unavailable).position();
            var planets = publicStars.findPlanets(owner, tic);
            return new PublicSkyViews.Detail("u-" + owner, Long.toString(tic), version(owner),
                    SkyService.PRESENTATION_VERSION, position, new PublicSkyViews.Planets(planets.size(), planets));
        });
    }

    private String version(long owner) {
        // 기존 revision은 발견 외 성과·Gold 수치·라벨 갱신을 모두 추적하지 않는다.
        return sky.version(owner) + ":public-v1:" + publicStars.fingerprint(owner);
    }

    private PublicSkyViews.Owner requirePublic(long owner) {
        return publicStars.findOwner(owner).orElseThrow(PublicSkyService::unavailable);
    }

    private <T> T readPublic(long owner, Supplier<T> action) {
        T result = read(action, TransactionDefinition.ISOLATION_REPEATABLE_READ);
        // 같은 RR 안의 반복 검사는 철회 커밋을 못 본다. HistoryService와 같은 별도 최신 읽기다.
        read(() -> requirePublic(owner), TransactionDefinition.ISOLATION_READ_COMMITTED);
        return result;
    }

    private <T> T read(Supplier<T> action, int isolation) {
        var tx = new TransactionTemplate(transactions);
        tx.setReadOnly(true);
        tx.setIsolationLevel(isolation);
        tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        return tx.execute(status -> action.get());
    }

    private OffsetDateTime now() { return OffsetDateTime.now(clock); }
    private static BusinessException unavailable() { return new BusinessException(ErrorCode.PUBLIC_SKY_NOT_AVAILABLE); }
    private static BusinessException invalidCursor() { return new BusinessException(ErrorCode.VALIDATION_FAILED); }
}
