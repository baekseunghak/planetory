package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 별 지도 응답 (탐사 API 4.1, v1.3 개별 별 표현) [S15P21C206-136].
 *
 * <p>전체 지도는 행성·궤도를 그리지 않는다. 내 행성 배열은 선택 상세에서만 받는다(C06).
 * 색·크기는 저장 좌표와 순번으로 프론트가 만드는 연출이라 여기서 보내지 않는다.
 */
public final class SkyViews {

    /** v1.3 응답 구분값. 누락이나 구 `clusters`를 빈 지도 정상 응답으로 처리하지 않는다. */
    public static final String REPRESENTATION = "individual-stars";

    private SkyViews() {
    }

    /** `GET /me/sky` — 홈 진입과 버전 무효화 시 한 번 읽는다. */
    public record SkyMeta(
            String representation,
            String version,
            String layoutVersion,
            String presentationVersion,
            /** 회원의 전체 발견 수. 적재 수·가시 수·범위 수와 다르다. */
            int starCount,
            /** 전체 발견 별의 월드 경계. 카메라 전체 보기 범위이며 별 데이터는 없다. */
            Bounds bounds,
            int tileSize,
            List<ZoomLevel> zoomLevels,
            List<String> centerTicIds,
            boolean firstVisit,
            OffsetDateTime asOf) {
    }

    public record Bounds(double minX, double maxX, double minY, double maxY) {
    }

    public record ZoomLevel(int level, double scale) {
    }

    /**
     * `GET /me/sky/tiles` — 모든 배율에서 실제 개별 별을 준다.
     *
     * <p>{@code stars}가 비어도 빈 지도나 범위 적재 완료를 뜻하지 않는다.
     * {@code versionChanged}면 프론트는 이전 cursor를 버리고 메타부터 다시 받는다.
     */
    public record SkyTile(
            String representation,
            String version,
            int level,
            boolean versionChanged,
            /** 요청 bbox를 타일 격자에 맞춰 넓힌 실제 응답 범위. 왼쪽·아래 포함, 오른쪽·위 제외. */
            TileBounds bounds,
            /** 이 범위의 전체 별 수. 페이지를 다 모으면 이 수와 같아야 한다. */
            long rangeStarCount,
            List<SkyStar> stars,
            String nextCursor,
            OffsetDateTime asOf) {
    }

    public record TileBounds(double x, double y, double w, double h) {
    }

    public record SkyStar(
            String ticId,
            double x,
            double y,
            /** 단위 없는 정규화 깊이. 프론트가 ×256으로 월드 깊이를 만든다. */
            double depthZ,
            /** 저장한 회원별 안정 순번. 전송 배열 순서나 현재 별 수가 아니다. */
            int layoutOrdinal,
            /** 맞춘 확정 행성 + "행성 같음"으로 판단한 미확정. 지도에 궤도는 그리지 않는다. */
            int planetCount,
            String progressStage,
            /** completed이고 planetCount가 0. FP 성과 여부와 무관하다. */
            boolean completedWithoutPlanets,
            Marker marker,
            boolean reopened) {
    }

    /** 튜토리얼이면 번호를 함께 준다. 챌린지는 번호가 없고 그 밖에는 null이다. */
    public record Marker(String type, Integer seq) {
    }
}
