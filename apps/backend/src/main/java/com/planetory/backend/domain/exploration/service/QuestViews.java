package com.planetory.backend.domain.exploration.service;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.List;

/**
 * 퀘스트 패널 응답 (탐사 API 4.3) [S15P21C206-139].
 *
 * <p>조회만 한다. 이 응답을 만들면서 별을 열거나 진행 상태를 바꾸지 않는다.
 */
public final class QuestViews {

    private QuestViews() {
    }

    /** `GET /me/quests` — 튜토리얼·챌린지·다시 열린 별을 한 스냅샷에서 읽는다. */
    public record Quests(OffsetDateTime asOf, Tutorial tutorial, Challenge challenge, List<Reopened> reopened) {
    }

    /** @param completedCount {@code GET /me}의 {@code tutorialCompleted}와 같은 기준으로 센다 */
    public record Tutorial(int completedCount, List<TutorialItem> items) {
    }

    /**
     * 튜토리얼 한 칸.
     *
     * @param status           {@code locked}(미발견) / {@code unlocked}(발견, 분석 시작 전) /
     *                         {@code in_progress} / {@code completed}. 한 번 완료한 칸은 별이 재개돼도
     *                         {@code completed}로 남는다
     * @param ticId            열린 순번에만 준다. 잠긴 칸의 별을 미리 드러내지 않는다(AT-57)
     * @param completionReason {@code completed}일 때만 준다
     */
    public record TutorialItem(int seq, String intent, String status, String ticId, String completionReason) {
    }

    /**
     * 진행 중 챌린지. 진행 회차가 없으면 {@code round}가 null이고 나머지는 빈 값이다.
     *
     * @param eligible         진행 회차가 있고 튜토리얼을 모두 끝냈는지
     * @param ticId            회원에게 열린 경우에만 준다. 지도 빨간 느낌표의 원천이다. 지도·상세의
     *                         {@code marker}에는 챌린지를 싣지 않는다
     * @param progressStage    열린 경우 그 별의 진행 단계, 아니면 null
     * @param participantCount 대상 별 공식 신호 스레드의 유효 공개 분석 참여자 수(D-13). 회차가 없으면 null
     */
    public record Challenge(Round round, boolean eligible, String ticId, boolean unlocked,
                            String progressStage, Integer participantCount) {

        static final Challenge NONE = new Challenge(null, false, null, false, null, null);
    }

    public record Round(String roundId, int roundNo, LocalDate startsOn, LocalDate endsOn, String description) {
    }

    /**
     * 다시 열린 별 카드(DEC-27). 재개 뒤 새 제출이 생기면 빠진다.
     *
     * @param newDiscoverableCount 재개 이벤트 저장(S15P21C206-150) 전까지 null이다. 0으로 채우지 않는다
     */
    public record Reopened(String ticId, OffsetDateTime reopenedAt, Integer newDiscoverableCount) {
    }
}
