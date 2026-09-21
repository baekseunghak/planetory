package com.planetory.backend.domain.post.service;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.nio.charset.StandardCharsets;
import java.time.DateTimeException;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.Set;
import org.springframework.util.MultiValueMap;

/** 현재 순위의 위치만 전달한다. 다음 요청에서는 공개 상태와 참여 수를 다시 평가한다. */
public record HotTopicsQuery(int size, Long afterCount, OffsetDateTime afterAt, Long afterId) {
    static final int HOT_TOPIC_MIN_PARTICIPANTS = 10;

    public static HotTopicsQuery parse(MultiValueMap<String, String> params) {
        CommunityQuery.only(params, Set.of("size", "cursor"));
        long size = params.containsKey("size") ? positive(params.getFirst("size")) : 20;
        if (size > 100) throw invalid();
        var first = new HotTopicsQuery((int) size, null, null, null);
        if (!params.containsKey("cursor")) return first;
        String cursor = params.getFirst("cursor");
        try {
            if (cursor == null || cursor.isEmpty() || cursor.length() > 1024) throw invalid();
            String[] parts = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8).split("\\|", -1);
            if (parts.length != 5 || !parts[0].equals("hot-v1") || !parts[1].equals(Long.toString(size))) throw invalid();
            long count = positive(parts[2]), id = positive(parts[4]);
            OffsetDateTime at = OffsetDateTime.parse(parts[3]);
            if (count < HOT_TOPIC_MIN_PARTICIPANTS || at.getYear() < 1 || at.getYear() > 9999 || at.getNano() % 1000 != 0) throw invalid();
            if (!first.next(count, at, id).equals(cursor)) throw invalid();
            return new HotTopicsQuery((int) size, count, at, id);
        } catch (IllegalArgumentException | DateTimeException e) { throw invalid(); }
    }

    public String next(long count, OffsetDateTime at, long id) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                ("hot-v1|" + size + "|" + count + "|" + at + "|" + id).getBytes(StandardCharsets.UTF_8));
    }

    private static long positive(String value) {
        if (value == null || !value.matches("[1-9][0-9]{0,18}")) throw invalid();
        try { return Long.parseLong(value); }
        catch (NumberFormatException e) { throw invalid(); }
    }
    private static BusinessException invalid() { return new BusinessException(ErrorCode.VALIDATION_FAILED); }
}
