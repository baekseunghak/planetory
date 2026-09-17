package com.planetory.backend.domain.exploration.service;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * 선택한 별·내 행성 상세 응답 (탐사 API 4.2) [S15P21C206-138].
 *
 * <p>별도의 행성 상세 API를 두지 않는다. 행성 선택은 프론트가 이미 받은 {@code planets.items}에서
 * 처리한다.
 */
public final class StarViews {

    private StarViews() {
    }

    /** `GET /me/stars/{ticId}` — 발견한 별만 허용한다. 미발견은 {@code STAR_LOCKED}. */
    public record StarDetail(
            String ticId,
            OffsetDateTime asOf,
            StarInfo star,
            Unlock unlock,
            Progress progress,
            Planets planets,
            Achievement achievement,
            SkyViews.Marker marker,
            Actions actions,
            /** 이 상세를 읽은 시점의 회원별 지도 버전. 메타·타일과 같은 불투명 값이다. */
            String version,
            String presentationVersion) {
    }

    /**
     * `GET /stars/{ticId}` — 공개 별 요약 (탐사 API 4.5).
     *
     * <p>발견하지 않은 회원도 부를 수 있다. 별 게시판 헤더·[이 별 분석하기] 버튼·출처 카드가 쓴다.
     *
     * @param unlockedForMe      요청 회원의 발견 여부
     * @param analysisAvailable  {@code unlockedForMe}와 같은 값이다. 뜻이 달라 필드를 나눠 둔다.
     *                           false면 프론트가 [이 별 분석하기]를 비활성으로 보인다
     * @param currentBundleId    현재 판. published 별은 판이 있어야 하지만, 없더라도 헤더는 떠야
     *                           하므로 null을 준다. 분석 진입(5.1)이 503으로 막는다
     */
    public record PublicStarSummary(
            String ticId,
            PublicStarInfo star,
            boolean boardOpen,
            boolean unlockedForMe,
            boolean analysisAvailable,
            String currentBundleId,
            int discoveredMemberCount) {
    }

    /**
     * `GET /me/stars`, `GET /members/{memberId}/stars` — 내 별 목록 (탐사 API 4.4).
     *
     * <p>{@code hasNext}는 {@code nextCursor != null}과 같은 뜻이다. 프론트가 둘 중 편한 쪽을
     * 쓰도록 둘 다 준다.
     */
    public record StarList(List<StarListItem> items, String nextCursor, boolean hasNext) {
    }

    /**
     * 목록 한 줄.
     *
     * @param lastActivityAt          최근 제출·재개·발견 중 가장 늦은 시각. 정렬 키다
     * @param unpublishedSignalCount  매칭했지만 공개하지 않은 신호 수. <b>본인 조회에만 있고
     *                                타인 조회는 응답에서 필드 자체를 뺀다</b>(NFR-14). 0과
     *                                "볼 수 없음"은 다르다
     * @param reopened                재개된 뒤 아직 새 제출이 없는 상태. 지도 타일과 같은 뜻이다
     */
    public record StarListItem(
            String ticId,
            String progressStage,
            int planetCount,
            boolean completedWithoutPlanets,
            int achievementCount,
            String grade,
            Integer currentCurveStep,
            boolean reopenPending,
            boolean reopened,
            // null일 때만 필드를 뺀다. 본인은 항상 값이 있고(0 포함) 타인은 null이다.
            // 전역으로 null을 빼면 명세 예제의 "marker": null까지 사라지므로 이 필드에만 건다.
            @com.fasterxml.jackson.annotation.JsonInclude(
                    com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
            Integer unpublishedSignalCount,
            java.time.OffsetDateTime lastActivityAt,
            String unlockReason,
            SkyViews.Marker marker) {
    }


    /**
     * 공개 요약의 별 정보.
     *
     * <p>온도·반지름을 넣지 않는다. 감추는 것이 아니라 이 응답을 쓰는 화면에 놓을 자리가 없어서다.
     * 셋 다 TESS 카탈로그 공개 값이고 본인 상세({@link StarInfo})는 모두 준다(D-18).
     */
    public record PublicStarInfo(int sectorCount, List<Integer> sectors, Double tmag) {
    }

    /**
     * 별 자체의 관측·물리 정보.
     *
     * <p>본인 상세는 세 물리값을 모두 준다(D-18). 카탈로그에 없으면 필드를 빼지 않고 null을
     * 보낸다. 프론트가 "데이터 없음"으로 그릴 수 있어야 한다(AT-93 선례).
     *
     * <p>확정 행성 보유 여부·후보 수는 절대 넣지 않는다(HOME-04, AT-03).
     */
    public record StarInfo(
            int sectorCount,
            List<Integer> sectors,
            /** TESS 등급. 무차원 */
            Double tmag,
            /** 유효 온도. K */
            Double teffK,
            /** 반지름. 태양 = 1 */
            Double radiusRsun) {
    }

    public record Unlock(
            String reason,
            String triggerTicId,
            String triggerAchievementId,
            OffsetDateTime unlockedAt,
            Position position) {
    }

    /**
     * 저장된 좌표를 그대로 준다. 지도 타일·위치 찾기·별 상세가 같은 값을 반환해야 한다.
     *
     * @param depthZ        -1.0~1.0 정규화 깊이. 렌더 월드 z는 프론트가 ×256으로 만든다
     * @param layoutOrdinal 회원별 안정 정수. 배열 인덱스가 아니다
     */
    public record Position(
            double x,
            double y,
            double depthZ,
            String layoutVersion,
            int layoutOrdinal) {
    }

    public record Progress(
            String stage,
            Integer currentCurveStep,
            String completionReason,
            boolean reopenPending,
            OffsetDateTime reopenedAt,
            OffsetDateTime completedAt) {
    }

    /**
     * 회원이 이 별에서 찾은 행성.
     *
     * <p>목록을 4개 상한이나 페이지로 자르지 않는다. {@code count}는 항상 {@code items.length}이며
     * 같은 version의 지도 {@code planetCount}와 일치해야 한다.
     */
    public record Planets(
            int count,
            /** 진행 완료인데 표시할 행성이 0개. 외계행성이 없다는 증거가 아니다 */
            boolean completedWithoutPlanets,
            List<PlanetItem> items) {
    }

    /**
     * @param kind      confirmed / unconfirmed. FP는 이 배열에 오지 않는다
     * @param periodDays 매칭한 신호의 반복 주기(일). 사용자 입력값이 아니다
     * @param depthPpm  어두워진 정도(ppm). 퍼센트는 프론트가 /10000으로 만든다
     */
    public record PlanetItem(
            String candidateId,
            String kind,
            Double periodDays,
            Integer depthPpm) {
    }

    /** {@code grade}는 열이 아니라 {@code count}에서 만드는 계산값이다(GRD-01). */
    public record Achievement(
            int count,
            String grade,
            AchievementByType byType) {
    }

    public record AchievementByType(int confirmed, int unconfirmed, int fp) {
    }

    /**
     * @param analysis        start(제출 없음) / continue(진행 중) / review(완료). 재개 별은 continue
     * @param resultAvailable 제출 이력이 있으면 결과 페이지가 열린다(RES-10)
     * @param boardOpen       한 명 이상 발견한 별이면 true(COM-01). 스레드 목록은 서비스 API가 준다
     */
    public record Actions(
            String analysis,
            boolean resultAvailable,
            boolean boardOpen,
            int threadCount) {
    }
}
