package com.planetory.backend.domain.exploration.service;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.Optional;

/**
 * 성과 목록 페이지 커서 (탐사 API 9.1절) [S15P21C206-144].
 *
 * <p>{@link StarListCursor}와 같은 방식이다. 불투명 값이며 요청 회원·{@code ticId} 필터·size에 묶는다.
 * 하나라도 다르면 이어서 읽을 수 없어 400으로 거절한다.
 *
 * <p>위치는 정렬 키 두 개를 그대로 담는다. {@code recognizedAt} 내림차순이고 동률은 성과 id로 가른다.
 * 같은 트랜잭션에서 인정된 성과는 시각이 같으므로 시각만 담으면 경계에서 통째로 밀리거나 빠진다.
 *
 * @param ticId 필터 TIC. 필터가 없으면 0
 */
record AchievementCursor(long memberId, long ticId, int size, long afterRecognizedEpochMicro,
                         long afterAchievementId) {

    private static final String FIELD_SEPARATOR = "|";
    private static final int FIELD_COUNT = 5;
    private static final long MICROS_PER_SECOND = 1_000_000L;
    private static final long NANOS_PER_MICRO = 1_000L;

    /** 마지막으로 준 항목에서 다음 페이지 커서를 만든다. */
    static AchievementCursor after(long memberId, long ticId, int size, OffsetDateTime recognizedAt,
                                   long achievementId) {
        Instant at = recognizedAt.toInstant();
        long micros = Math.addExact(Math.multiplyExact(at.getEpochSecond(), MICROS_PER_SECOND),
                at.getNano() / NANOS_PER_MICRO);
        return new AchievementCursor(memberId, ticId, size, micros, achievementId);
    }

    /** 이어읽기 기준 시각. */
    OffsetDateTime afterRecognizedAt() {
        return Instant.ofEpochSecond(
                        Math.floorDiv(afterRecognizedEpochMicro, MICROS_PER_SECOND),
                        Math.floorMod(afterRecognizedEpochMicro, MICROS_PER_SECOND) * NANOS_PER_MICRO)
                .atOffset(ZoneOffset.UTC);
    }

    String encode() {
        String raw = String.join(FIELD_SEPARATOR, Long.toString(memberId), Long.toString(ticId),
                Integer.toString(size), Long.toString(afterRecognizedEpochMicro),
                Long.toString(afterAchievementId));
        return Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * 커서를 풀고 이번 요청과 같은 조건인지 확인한다.
     *
     * @return 이어읽을 위치. 형식이 깨졌거나 묶인 조건이 다르면 비어 있다.
     */
    static Optional<AchievementCursor> decode(String encoded, AchievementCursor expected) {
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
            AchievementCursor decoded = new AchievementCursor(Long.parseLong(parts[0]), Long.parseLong(parts[1]),
                    Integer.parseInt(parts[2]), Long.parseLong(parts[3]), Long.parseLong(parts[4]));
            return decoded.boundTo(expected) ? Optional.of(decoded) : Optional.empty();
        } catch (NumberFormatException malformed) {
            return Optional.empty();
        }
    }

    private boolean boundTo(AchievementCursor expected) {
        return memberId == expected.memberId && ticId == expected.ticId && size == expected.size;
    }
}
