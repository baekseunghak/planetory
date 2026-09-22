package com.planetory.backend.domain.member.service;

import com.planetory.backend.domain.post.service.CommunityQuery;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.DateTimeException;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.stereotype.Component;
import org.springframework.util.MultiValueMap;

/** 팔로우 전용 커서·관리 식별자. 관리 ID에는 TIC·이름을 담지 않고 소유권은 DB에서 확인한다. */
@Component
public class FollowTokens {
    // ponytail: 단일 앱 수명 키. 재시작 후 목록을 처음부터 조회한다. 다중 인스턴스 도입 시 공유 키로 전환한다.
    private final byte[] key = new byte[32];
    public FollowTokens() { new SecureRandom().nextBytes(key); }

    public record Page(String binding, int size, OffsetDateTime at, int kind, Long id) {}

    public Page page(long member, String scope, MultiValueMap<String, String> params) {
        CommunityQuery.only(params, Set.of("size", "cursor"));
        long size = params.containsKey("size") ? positive(params.getFirst("size")) : 20;
        if (size > 100) throw invalid();
        String binding = "follow-v1|" + member + "|" + scope + "|" + size;
        if (!params.containsKey("cursor")) return new Page(binding, (int) size, null, 0, null);
        try {
            String[] p = read(params.getFirst("cursor")).split("\\|", -1);
            if (p.length != 7 || !String.join("|", java.util.Arrays.copyOf(p, 4)).equals(binding)) throw invalid();
            OffsetDateTime at = OffsetDateTime.parse(p[4]);
            if (at.getYear() < 1 || at.getYear() > 9999 || at.getNano() % 1000 != 0
                    || !Set.of("0", "1").contains(p[5]) || !scope.equals("feed") && !p[5].equals("0")) throw invalid();
            return new Page(binding, (int) size, at, Integer.parseInt(p[5]), positive(p[6]));
        } catch (DateTimeException e) { throw invalid(); }
    }
    public String next(Page page, OffsetDateTime at, int kind, long id) {
        return sign(page.binding() + "|" + at + "|" + kind + "|" + id);
    }
    public String management(long relation) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(("relation-v1|" + relation).getBytes(StandardCharsets.UTF_8));
    }
    public long relation(String token) {
        try {
            if (token == null || token.length() > 128) throw invalid();
            String[] p = new String(Base64.getUrlDecoder().decode(token), StandardCharsets.UTF_8).split("\\|", -1);
            if (p.length != 2 || !p[0].equals("relation-v1")) throw invalid();
            long id = positive(p[1]);
            if (!management(id).equals(token)) throw invalid();
            return id;
        } catch (BusinessException | IllegalArgumentException e) { throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND); }
    }
    private String sign(String payload) {
        String body = Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(StandardCharsets.UTF_8));
        return body + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(mac(body));
    }
    private String read(String token) {
        try {
            if (token == null || token.isEmpty() || token.length() > 1024) throw invalid();
            String[] p = token.split("\\.", -1);
            if (p.length != 2 || !MessageDigest.isEqual(mac(p[0]), Base64.getUrlDecoder().decode(p[1]))) throw invalid();
            String value = new String(Base64.getUrlDecoder().decode(p[0]), StandardCharsets.UTF_8);
            if (!sign(value).equals(token)) throw invalid();
            return value;
        } catch (IllegalArgumentException e) { throw invalid(); }
    }
    private byte[] mac(String body) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(body.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }
    private static long positive(String value) {
        if (value == null || !value.matches("[1-9][0-9]{0,18}")) throw invalid();
        try { return Long.parseLong(value); } catch (NumberFormatException e) { throw invalid(); }
    }
    private static BusinessException invalid() { return new BusinessException(ErrorCode.VALIDATION_FAILED); }
}
