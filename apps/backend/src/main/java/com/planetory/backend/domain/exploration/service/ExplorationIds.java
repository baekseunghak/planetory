package com.planetory.backend.domain.exploration.service;

import java.util.OptionalLong;

/**
 * API 문자열 식별자와 DB 숫자 ID의 대응 (Gold 게시 계약 4절) [S15P21C206-140].
 *
 * <p>접두 문자열은 외부 표현이며 DB 열 타입은 바꾸지 않는다.
 */
public final class ExplorationIds {

    public static final String BUNDLE = "b-";
    public static final String CANDIDATE = "c-";
    public static final String SEGMENT = "seg-";

    /** {@code Long.MAX_VALUE}는 19자리다. 18자리까지만 받으면 넘침을 따로 검사하지 않아도 된다. */
    private static final int MAX_DIGITS = 18;

    private ExplorationIds() {
    }

    public static String bundle(long id) {
        return BUNDLE + id;
    }

    public static String candidate(long id) {
        return CANDIDATE + id;
    }

    public static String segment(long id) {
        return SEGMENT + id;
    }

    /**
     * 접두 뒤에 양의 정수만 받는다. {@code b-01}·{@code b-+1}처럼 같은 대상을 다르게 쓴 값은
     * 거절한다. 하나의 대상이 여러 문자열을 가지면 캐시 키와 요청 비교가 어긋난다.
     */
    public static OptionalLong parse(String value, String prefix) {
        if (value == null || !value.startsWith(prefix)) {
            return OptionalLong.empty();
        }
        String digits = value.substring(prefix.length());
        if (digits.isEmpty() || digits.length() > MAX_DIGITS || digits.charAt(0) == '0') {
            return OptionalLong.empty();
        }
        for (int i = 0; i < digits.length(); i++) {
            char c = digits.charAt(i);
            if (c < '0' || c > '9') {
                return OptionalLong.empty();
            }
        }
        return OptionalLong.of(Long.parseLong(digits));
    }
}
