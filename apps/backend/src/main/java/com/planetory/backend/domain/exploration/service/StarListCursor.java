package com.planetory.backend.domain.exploration.service;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Objects;
import java.util.Optional;

/**
 * 내 별 목록 페이지 커서 [S15P21C206-138].
 *
 * <p>{@link SkyCursor}와 같은 방식이다. 불투명 값이며 요청 회원·대상 회원·scope·sort·size에
 * 묶는다. 하나라도 다르면 이어서 읽을 수 없어 400으로 거절한다.
 *
 * <p>위치는 정렬 키 두 개를 그대로 담는다. {@code lastActivityAt} 내림차순이고 동률은
 * {@code ticId}로 가르므로, 이어읽기 조건도 두 값을 함께 봐야 경계에서 중복·누락이 없다.
 * epoch milli 하나만 담으면 같은 시각의 별들이 통째로 밀리거나 빠진다.
 */
record StarListCursor(long viewerId, long targetId, String scope, String sort, int size,
                      long afterActivityEpochMilli, long afterTicId) {

    private static final String FIELD_SEPARATOR = "|";
    private static final int FIELD_COUNT = 7;

    String encode() {
        String raw = String.join(FIELD_SEPARATOR,
                Long.toString(viewerId), Long.toString(targetId), scope, sort,
                Integer.toString(size), Long.toString(afterActivityEpochMilli),
                Long.toString(afterTicId));
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * 커서를 풀고 이번 요청과 같은 조건인지 확인한다.
     *
     * @return 이어읽을 위치. 형식이 깨졌거나 묶인 조건이 다르면 비어 있다.
     */
    static Optional<StarListCursor> decode(String encoded, StarListCursor expected) {
        String raw;
        try {
            raw = new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException malformed) {
            return Optional.empty();
        }
        String[] parts = raw.split("\\" + FIELD_SEPARATOR, -1);
        if (parts.length != FIELD_COUNT) {
            return Optional.empty();
        }
        try {
            StarListCursor decoded = new StarListCursor(
                    Long.parseLong(parts[0]), Long.parseLong(parts[1]), parts[2], parts[3],
                    Integer.parseInt(parts[4]), Long.parseLong(parts[5]), Long.parseLong(parts[6]));
            return decoded.boundTo(expected) ? Optional.of(decoded) : Optional.empty();
        } catch (NumberFormatException malformed) {
            return Optional.empty();
        }
    }

    /**
     * 요청 회원·대상 회원·scope·sort·size가 모두 같아야 이어읽을 수 있다.
     *
     * <p>요청 회원까지 묶는 이유는 같은 대상이라도 보는 사람에 따라 응답이 다르기 때문이다.
     * 본인 조회에만 {@code unpublishedSignalCount}가 붙는다(NFR-14).
     */
    private boolean boundTo(StarListCursor expected) {
        return viewerId == expected.viewerId
                && targetId == expected.targetId
                && Objects.equals(scope, expected.scope)
                && Objects.equals(sort, expected.sort)
                && size == expected.size;
    }
}
