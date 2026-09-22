package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;
import java.util.List;

/** 공개 은하 전용 allowlist. 개인 탐사 응답을 직렬화하지 않는다 [S15P21C206-251]. */
public final class PublicSkyViews {
    private PublicSkyViews() {}

    public record Owner(String memberId, String nickname) {}
    public record Meta(Owner owner, String scope, String visibility, String representation,
                       String version, String layoutVersion, String presentationVersion,
                       int starCount, SkyViews.Bounds bounds, int tileSize,
                       List<SkyViews.ZoomLevel> zoomLevels, OffsetDateTime asOf) {}
    public record Tile(String representation, String version, int level, boolean versionChanged,
                       SkyViews.TileBounds bounds, long rangeStarCount, List<Star> stars,
                       String nextCursor, OffsetDateTime asOf) {}
    public record Star(String ticId, double x, double y, double depthZ, int layoutOrdinal,
                       int planetCount, String progressStage, boolean completedWithoutPlanets) {}
    public record Detail(String memberId, String ticId, String version, String presentationVersion,
                         StarViews.Position position, Planets planets) {}
    public record Planets(int count, List<Planet> items) {}
    public record Planet(String candidateId, String kind, Double periodDays, Double depthPpm) {}
}
