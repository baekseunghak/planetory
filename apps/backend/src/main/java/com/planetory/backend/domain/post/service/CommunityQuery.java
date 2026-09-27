package com.planetory.backend.domain.post.service;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.DateTimeException;
import java.util.Base64;
import java.util.Set;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import org.springframework.util.MultiValueMap;

/** 기본 피드와 공개 분석 페이지. 커서 위치는 권한이 아니며 매 요청에서 공개 조건을 다시 적용한다. */
public record CommunityQuery(String scope, Long target, String judgment, int size,
                             OffsetDateTime afterAt, Long afterId, Search search) {
    public record Search(String q, String searchIn, String author, String board, String tag, String type) {
        String binding() {
            // 길이 접두사로 임의의 구분자 입력을 구분하고 커서 길이를 일정하게 유지한다.
            String value = String.join("", List.of(q, searchIn, author, board, tag).stream()
                    .map(s -> s.length() + ":" + s).toList());
            if (!type.isEmpty()) value += type.length() + ":" + type;
            try {
                return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
            } catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
        }
        String pattern() { return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"; }
    }

    public static CommunityQuery feed(MultiValueMap<String, String> params) {
        only(params, Set.of("q", "searchIn", "author", "ticId", "board", "tag", "type", "size", "cursor"));
        Long tic = params.containsKey("ticId") ? positive(params.getFirst("ticId")) : null;
        String q = text(params, "q"), author = text(params, "author");
        String field = params.containsKey("searchIn") ? params.getFirst("searchIn") : "TITLE_BODY";
        if (q.codePointCount(0, q.length()) > 100 || params.containsKey("searchIn") && q.isEmpty()
                || !Set.of("TITLE_BODY", "TITLE", "BODY").contains(field)) throw invalid();
        String board = params.containsKey("board") ? params.getFirst("board") : "";
        String tag = params.containsKey("tag") ? params.getFirst("tag") : "";
        if (params.containsKey("board") && !Set.of("STAR", "FREE").contains(board)
                || tic != null && board.equals("FREE")
                || params.containsKey("tag") && !PostService.TAGS.contains(tag)) throw invalid();
        String type = params.containsKey("type") ? params.getFirst("type") : "";
        if (params.containsKey("type") && !Set.of("POST", "SIGNAL_THREAD").contains(type)
                || type.equals("SIGNAL_THREAD") && (!author.isEmpty() || !tag.isEmpty() || board.equals("FREE")))
            throw invalid();
        // TIC는 STAR를 이미 뜻하므로 기존 기본 피드 커서와 같은 정규화 범위를 쓴다.
        if (tic != null) board = "";
        Search search = new Search(q, field, author, board, tag, type);
        boolean basic = q.isEmpty() && author.isEmpty() && board.isEmpty() && tag.isEmpty() && type.isEmpty();
        return page(basic ? "feed-v1" : "feed-v2", tic, "", params, basic ? null : search);
    }

    private static String text(MultiValueMap<String, String> params, String key) {
        if (!params.containsKey(key)) return "";
        // ECMAScript trim: Java strip와 달리 NBSP/BOM을 포함하고 U+0085 등은 제외한다.
        String value = params.getFirst(key).replaceAll("^[\\s\\p{Zs}\\u2028\\u2029\\uFEFF]+|[\\s\\p{Zs}\\u2028\\u2029\\uFEFF]+$", "");
        if (value.isEmpty() || value.indexOf('\0') >= 0) throw invalid();
        return value;
    }

    public static CommunityQuery analyses(long thread, MultiValueMap<String, String> params) {
        only(params, Set.of("judgment", "size", "cursor"));
        String judgment = params.containsKey("judgment") ? params.getFirst("judgment") : "";
        if (!Set.of("", "LIKELY_PLANET", "UNLIKELY_PLANET", "UNSURE").contains(judgment)
                || params.containsKey("judgment") && judgment.isEmpty()) throw invalid();
        return page("analyses-v1", thread, judgment, params, null);
    }

    public static void only(MultiValueMap<String, String> params, Set<String> allowed) {
        if (params.entrySet().stream().anyMatch(e -> !allowed.contains(e.getKey()) || e.getValue().size() != 1))
            throw invalid();
    }

    private static CommunityQuery page(String scope, Long target, String judgment, MultiValueMap<String, String> params, Search search) {
        long size = params.containsKey("size") ? positive(params.getFirst("size")) : 20;
        if (size > 100) throw invalid();
        var expected = new CommunityQuery(scope, target, judgment, (int) size, null, null, search);
        String cursor = params.getFirst("cursor");
        if (!params.containsKey("cursor")) return expected;
        var position = cursor(cursor, expected.binding());
        return new CommunityQuery(scope, target, judgment, (int) size, position.at(), position.id(), search);
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
    private String binding() { return scope + "|" + target + "|" + (search == null ? judgment : search.binding()) + "|" + size; }

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
