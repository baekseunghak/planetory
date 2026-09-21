package com.planetory.backend.domain.post.service;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.DateTimeException;
import java.util.Base64;
import java.util.Set;
import org.springframework.util.MultiValueMap;

/** 기본 피드와 공개 분석 페이지. 커서 위치는 권한이 아니며 매 요청에서 공개 조건을 다시 적용한다. */
public record CommunityQuery(String scope, Long target, String judgment, int size,
                             OffsetDateTime afterAt, Long afterId) {
    public static CommunityQuery feed(MultiValueMap<String, String> params) {
        only(params, Set.of("ticId", "board", "size", "cursor"));
        Long tic = params.containsKey("ticId") ? positive(params.getFirst("ticId")) : null;
        // 특정 별 경로의 프론트가 붙이는 중복 범위만 허용한다. 커서는 ticId 단독과 같다.
        if (params.containsKey("board") && (tic == null || !"STAR".equals(params.getFirst("board")))) throw invalid();
        return page("feed-v1", tic, "", params);
    }

    public static CommunityQuery analyses(long thread, MultiValueMap<String, String> params) {
        only(params, Set.of("judgment", "size", "cursor"));
        String judgment = params.containsKey("judgment") ? params.getFirst("judgment") : "";
        if (!Set.of("", "LIKELY_PLANET", "UNLIKELY_PLANET", "UNSURE").contains(judgment)
                || params.containsKey("judgment") && judgment.isEmpty()) throw invalid();
        return page("analyses-v1", thread, judgment, params);
    }

    public static void only(MultiValueMap<String, String> params, Set<String> allowed) {
        if (params.entrySet().stream().anyMatch(e -> !allowed.contains(e.getKey()) || e.getValue().size() != 1))
            throw invalid();
    }

    private static CommunityQuery page(String scope, Long target, String judgment, MultiValueMap<String, String> params) {
        long size = params.containsKey("size") ? positive(params.getFirst("size")) : 20;
        if (size > 100) throw invalid();
        var expected = new CommunityQuery(scope, target, judgment, (int) size, null, null);
        String cursor = params.getFirst("cursor");
        if (!params.containsKey("cursor")) return expected;
        var position = cursor(cursor, expected.binding());
        return new CommunityQuery(scope, target, judgment, (int) size, position.at(), position.id());
    }

    record Cursor(OffsetDateTime at, long id) {}

    static Cursor cursor(String cursor, String binding) {
        try {
            if (cursor == null || cursor.isEmpty() || cursor.length() > 1024) throw invalid();
            String[] parts = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8).split("\\|", -1);
            if (parts.length != 6 || !String.join("|", java.util.Arrays.copyOf(parts, 4)).equals(binding)) throw invalid();
            OffsetDateTime at = OffsetDateTime.parse(parts[4]);
            if (at.getYear() < 1 || at.getYear() > 9999 || at.getNano() % 1000 != 0) throw invalid();
            long id = positive(parts[5]);
            if (!next(binding, at, id).equals(cursor)) throw invalid();
            return new Cursor(at, id);
        } catch (IllegalArgumentException | DateTimeException e) { throw invalid(); }
    }

    public String next(OffsetDateTime at, long id) {
        return next(binding(), at, id);
    }
    static String next(String binding, OffsetDateTime at, long id) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString((binding + "|" + at + "|" + id).getBytes(StandardCharsets.UTF_8));
    }
    private String binding() { return scope + "|" + target + "|" + judgment + "|" + size; }

    public static long id(String value, String prefix) {
        try {
            if (value == null || !value.startsWith(prefix)) throw invalid();
            return positive(value.substring(prefix.length()));
        } catch (BusinessException e) { throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND); }
    }
    static long positive(String value) {
        if (value == null || !value.matches("[1-9][0-9]{0,18}")) throw invalid();
        try { return Long.parseLong(value); }
        catch (NumberFormatException e) { throw invalid(); }
    }
    private static BusinessException invalid() { return new BusinessException(ErrorCode.VALIDATION_FAILED); }
}
