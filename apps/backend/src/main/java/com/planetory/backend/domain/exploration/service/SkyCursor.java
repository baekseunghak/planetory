package com.planetory.backend.domain.exploration.service;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Objects;

/**
 * 타일 페이지 커서 [S15P21C206-136].
 *
 * <p>탐사 API 4.1: 불투명 값이며 인증 회원·version·level·원 요청 bbox·limit에 묶는다.
 * 하나라도 다르면 이어서 읽을 수 없으므로 400으로 거절한다. 프론트가 값을 해석하지 않도록
 * Base64로 감싸지만 비밀은 아니다. 다른 회원의 커서를 써도 회원 값이 달라 거절된다.
 */
record SkyCursor(long memberId, String version, int level,
                 double x, double y, double w, double h, int limit, long afterTicId) {

    private static final String FIELD_SEPARATOR = "|";

    String encode() {
        String raw = String.join(FIELD_SEPARATOR,
                Long.toString(memberId), version, Integer.toString(level),
                Double.toString(x), Double.toString(y), Double.toString(w), Double.toString(h),
                Integer.toString(limit), Long.toString(afterTicId));
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * 커서를 풀고 이번 요청과 같은 조건인지 확인한다.
     *
     * @return 이어읽을 위치. 형식이 깨졌거나 묶인 조건이 다르면 비어 있다.
     */
    static java.util.Optional<SkyCursor> decode(String encoded, SkyCursor expected) {
        String raw;
        try {
            raw = new String(Base64.getUrlDecoder().decode(encoded), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException malformed) {
            return java.util.Optional.empty();
        }
        String[] parts = raw.split("\\" + FIELD_SEPARATOR, -1);
        if (parts.length != 9) {
            return java.util.Optional.empty();
        }
        try {
            SkyCursor decoded = new SkyCursor(
                    Long.parseLong(parts[0]), parts[1], Integer.parseInt(parts[2]),
                    Double.parseDouble(parts[3]), Double.parseDouble(parts[4]),
                    Double.parseDouble(parts[5]), Double.parseDouble(parts[6]),
                    Integer.parseInt(parts[7]), Long.parseLong(parts[8]));
            return decoded.boundTo(expected) ? java.util.Optional.of(decoded) : java.util.Optional.empty();
        } catch (NumberFormatException malformed) {
            return java.util.Optional.empty();
        }
    }

    /** 회원·version·level·bbox·limit가 모두 같아야 이어읽을 수 있다. */
    private boolean boundTo(SkyCursor expected) {
        return memberId == expected.memberId
                && Objects.equals(version, expected.version)
                && level == expected.level
                && Double.compare(x, expected.x) == 0
                && Double.compare(y, expected.y) == 0
                && Double.compare(w, expected.w) == 0
                && Double.compare(h, expected.h) == 0
                && limit == expected.limit;
    }
}
