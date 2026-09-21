package com.planetory.backend.domain.post.service;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;

/** 반응 종류·글·페이지 크기에 묶인 updated_at/ID 내림차순 위치. */
record ReactionCursor(long postId, String reaction, int size, Instant time, long id) {
    String encode() {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                (postId + "|" + reaction + "|" + size + "|" + time + "|" + id).getBytes(StandardCharsets.UTF_8));
    }

    static ReactionCursor decode(String cursor, long postId, String reaction, int size) {
        try {
            String[] fields = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8).split("\\|", -1);
            if (fields.length != 5) throw new IllegalArgumentException();
            var decoded = new ReactionCursor(Long.parseLong(fields[0]), fields[1], Integer.parseInt(fields[2]),
                    Instant.parse(fields[3]), Long.parseLong(fields[4]));
            if (decoded.postId != postId || !decoded.reaction.equals(reaction) || decoded.size != size || decoded.id <= 0
                    || decoded.time.isBefore(Instant.parse("0001-01-01T00:00:00Z"))
                    || decoded.time.isAfter(Instant.parse("9999-12-31T23:59:59.999999Z"))) throw new IllegalArgumentException();
            return decoded;
        } catch (IllegalArgumentException | java.time.DateTimeException e) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
    }
}
