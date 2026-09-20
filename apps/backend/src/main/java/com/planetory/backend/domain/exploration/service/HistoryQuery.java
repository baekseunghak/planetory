package com.planetory.backend.domain.exploration.service;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.Set;
import static com.planetory.backend.domain.exploration.service.SubmissionRequest.invalid;

/** 기존 목록과 같은 불투명 커서. 회원·모든 필터·크기에 묶고 SQL은 별도로 소유자를 제한한다. */
record HistoryQuery(long member, Long tic, Long candidate, String result, OffsetDateTime from,
                    OffsetDateTime to, int size, OffsetDateTime afterAt, Long afterId) {
    static HistoryQuery parse(long member, HistoryViews.Query q) {
        Long tic = empty(q.ticId()) ? null : ExplorationIds.parseTic(q.ticId()).orElseThrow(() -> invalid("ticId"));
        Long candidate = empty(q.candidateId()) ? null : ExplorationIds.parse(q.candidateId(), "c-").orElseThrow(() -> invalid("candidateId"));
        String result = empty(q.result()) ? "" : q.result();
        if (!Set.of("", "matched", "not_matched", "none_wrong", "ambiguous_match", "skipped").contains(result)) throw invalid("result");
        int size = 20;
        if (!empty(q.size())) {
            if (!q.size().matches("[1-9][0-9]{0,2}")) throw invalid("size");
            size = Integer.parseInt(q.size());
            if (size > 100) throw invalid("size");
        }
        OffsetDateTime from = date(q.from(), "from"), to = date(q.to(), "to");
        if (from != null && to != null && !from.isBefore(to)) throw invalid("to");
        HistoryQuery expected = new HistoryQuery(member, tic, candidate, result, from, to, size, null, null);
        if (empty(q.cursor())) return expected;
        try {
            if (q.cursor().length() > 2048) throw new IllegalArgumentException();
            String[] parts = new String(Base64.getUrlDecoder().decode(q.cursor()), StandardCharsets.UTF_8).split("\\|", -1);
            if (parts.length != 9 || !String.join("|", java.util.Arrays.copyOf(parts, 7)).equals(expected.binding())) throw new IllegalArgumentException();
            OffsetDateTime at = OffsetDateTime.parse(parts[7]);
            if (at.getYear()<1 || at.getYear()>9999) throw new IllegalArgumentException();
            long id = Long.parseLong(parts[8]);
            if (id <= 0) throw new IllegalArgumentException();
            return new HistoryQuery(member, tic, candidate, result, from, to, size, at, id);
        } catch (IllegalArgumentException | java.time.DateTimeException e) { throw invalid("cursor"); }
    }
    String next(OffsetDateTime at, long id) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString((binding()+"|"+at+"|"+id).getBytes(StandardCharsets.UTF_8));
    }
    private String binding() { return member+"|"+tic+"|"+candidate+"|"+result+"|"+from+"|"+to+"|"+size; }
    private static OffsetDateTime date(String value, String field) {
        if (empty(value)) return null;
        try {
            OffsetDateTime at=OffsetDateTime.parse(value).withOffsetSameInstant(ZoneOffset.UTC);
            if (at.getYear()<1 || at.getYear()>9999) throw invalid(field);
            return at;
        }
        catch (java.time.DateTimeException e) { throw invalid(field); }
    }
    private static boolean empty(String value) { return value == null || value.isEmpty(); }
}
