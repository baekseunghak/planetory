package com.planetory.backend.domain.exploration.service;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Objects;
import java.util.Optional;

/**
 * 내 별 목록 페이지 커서 [S15P21C206-138].
 *
 * <p>{@link SkyCursor}와 같은 방식이다. 불투명 값이며 요청 회원·대상 회원·scope·sort·size와
 * <b>필터</b>에 묶는다. 하나라도 다르면 이어서 읽을 수 없어 400으로 거절한다.
 *
 * <p>필터를 묶는 이유는 커서가 결과 집합 안의 위치이기 때문이다. 필터가 달라지면 같은 위치가
 * 다른 집합의 한가운데를 가리켜, 화면이 이어 읽는 줄 알고 엉뚱한 구간을 받는다(S15P21C206-152).
 *
 * <p>위치는 정렬 키 두 개를 그대로 담는다. {@code lastActivityAt} 내림차순이고 동률은
 * {@code ticId}로 가르므로, 이어읽기 조건도 두 값을 함께 봐야 경계에서 중복·누락이 없다.
 * epoch milli 하나만 담으면 같은 시각의 별들이 통째로 밀리거나 빠진다.
 */
record StarListCursor(long viewerId, long targetId, String scope, String sort, int size, String filter,
                      long afterActivityEpochMicro, long afterTicId) {

    private static final String FIELD_SEPARATOR = "|";
    private static final int FIELD_COUNT = 8;
    private static final long MICROS_PER_SECOND = 1_000_000L;
    private static final long NANOS_PER_MICRO = 1_000L;

    /** 마지막으로 준 항목에서 다음 페이지 커서를 만든다. */
    static StarListCursor after(long viewerId, long targetId, String scope, String sort, int size,
                                String filter, java.time.OffsetDateTime lastActivity, long ticId) {
        java.time.Instant at = lastActivity.toInstant();
        long micros = Math.addExact(Math.multiplyExact(at.getEpochSecond(), MICROS_PER_SECOND),
                at.getNano() / NANOS_PER_MICRO);
        return new StarListCursor(viewerId, targetId, scope, sort, size, filter, micros, ticId);
    }

    /** 이어읽기 기준 시각. */
    java.time.OffsetDateTime afterActivity() {
        return java.time.Instant.ofEpochSecond(
                        Math.floorDiv(afterActivityEpochMicro, MICROS_PER_SECOND),
                        Math.floorMod(afterActivityEpochMicro, MICROS_PER_SECOND) * NANOS_PER_MICRO)
                .atOffset(java.time.ZoneOffset.UTC);
    }

    String encode() {
        String raw = String.join(FIELD_SEPARATOR,
                Long.toString(viewerId), Long.toString(targetId), scope, sort,
                Integer.toString(size), filter, Long.toString(afterActivityEpochMicro),
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
                    Integer.parseInt(parts[4]), parts[5], Long.parseLong(parts[6]),
                    Long.parseLong(parts[7]));
            return decoded.boundTo(expected) ? Optional.of(decoded) : Optional.empty();
        } catch (NumberFormatException malformed) {
            return Optional.empty();
        }
    }

    /**
     * 요청 회원·대상 회원·scope·sort·size·필터가 모두 같아야 이어읽을 수 있다.
     *
     * <p>요청 회원까지 묶는 이유는 같은 대상이라도 보는 사람에 따라 응답이 다르기 때문이다.
     * 본인 조회에만 {@code unpublishedSignalCount}가 붙는다(NFR-14).
     */
    private boolean boundTo(StarListCursor expected) {
        return viewerId == expected.viewerId
                && targetId == expected.targetId
                && Objects.equals(scope, expected.scope)
                && Objects.equals(sort, expected.sort)
                && size == expected.size
                && Objects.equals(filter, expected.filter);
    }
}
