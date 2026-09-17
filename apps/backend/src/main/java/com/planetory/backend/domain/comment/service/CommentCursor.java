package com.planetory.backend.domain.comment.service;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.Objects;
import java.util.Optional;

/**
 * 댓글 목록 페이지 커서 [S15P21C206-159].
 *
 * <p>{@code StarListCursor}와 같은 방식이다. 불투명 값이며 부모 종류·부모 ID·size에 묶는다.
 * 하나라도 다르면 이어서 읽을 수 없어 400으로 거절한다.
 *
 * <p>위치는 정렬 키 두 개를 그대로 담는다. {@code createdAt} 내림차순이고 동률은 {@code id}로
 * 가르므로, 이어읽기 조건도 두 값을 함께 봐야 경계에서 중복·누락이 없다. 같은 트랜잭션에서 만든
 * 댓글들은 DB 기본값이 같은 시각을 주므로 동률이 실제로 발생한다.
 *
 * <p>보는 사람에 따라 응답이 달라지지 않으므로 회원 ID는 묶지 않는다. 다른 회원의 커서를 받아도
 * 같은 페이지를 볼 뿐이며, 목록 자체가 인증 회원 모두에게 같다.
 */
record CommentCursor(String parentType, long parentId, int size,
                     long afterCreatedEpochMicro, long afterId) {

    private static final String FIELD_SEPARATOR = "|";
    private static final int FIELD_COUNT = 5;
    private static final long MICROS_PER_SECOND = 1_000_000L;
    private static final long NANOS_PER_MICRO = 1_000L;

    /** 마지막으로 준 항목에서 다음 페이지 커서를 만든다. */
    static CommentCursor after(String parentType, long parentId, int size, Instant createdAt, long id) {
        long micros = Math.addExact(Math.multiplyExact(createdAt.getEpochSecond(), MICROS_PER_SECOND),
                createdAt.getNano() / NANOS_PER_MICRO);
        return new CommentCursor(parentType, parentId, size, micros, id);
    }

    /** 이어읽기 기준 시각. */
    Instant afterCreatedAt() {
        return Instant.ofEpochSecond(
                Math.floorDiv(afterCreatedEpochMicro, MICROS_PER_SECOND),
                Math.floorMod(afterCreatedEpochMicro, MICROS_PER_SECOND) * NANOS_PER_MICRO);
    }

    String encode() {
        String raw = String.join(FIELD_SEPARATOR, parentType, Long.toString(parentId),
                Integer.toString(size), Long.toString(afterCreatedEpochMicro), Long.toString(afterId));
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * 커서를 풀고 이번 요청과 같은 조건인지 확인한다.
     *
     * @return 이어읽을 위치. 형식이 깨졌거나 묶인 조건이 다르면 비어 있다.
     */
    static Optional<CommentCursor> decode(String encoded, CommentCursor expected) {
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
            CommentCursor decoded = new CommentCursor(parts[0], Long.parseLong(parts[1]),
                    Integer.parseInt(parts[2]), Long.parseLong(parts[3]), Long.parseLong(parts[4]));
            return decoded.boundTo(expected) ? Optional.of(decoded) : Optional.empty();
        } catch (NumberFormatException malformed) {
            return Optional.empty();
        }
    }

    /** 부모와 페이지 크기가 모두 같아야 이어읽을 수 있다. */
    private boolean boundTo(CommentCursor expected) {
        return Objects.equals(parentType, expected.parentType)
                && parentId == expected.parentId
                && size == expected.size;
    }
}
