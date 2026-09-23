package com.planetory.backend.domain.member.service;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** 회원·용도·경계에 묶인 토큰. 모든 API 인스턴스가 같은 서버 키를 사용한다. */
@Component
public class NotificationTokens {
    private final byte[] key;
    public NotificationTokens(@Value("${NOTIFICATION_SIGNING_KEY:}") String key) {
        this.key = key.getBytes(StandardCharsets.UTF_8);
    }
    public String sign(long member, String purpose, String value) {
        String body = Base64.getUrlEncoder().withoutPadding().encodeToString(
                (member + "|" + purpose + "|" + value).getBytes(StandardCharsets.UTF_8));
        return body + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(mac(body));
    }
    public String verify(long member, String purpose, String token) {
        if (token == null || token.length() > 1024) throw invalid();
        try {
            String[] parts = token.split("\\.", -1);
            if (parts.length != 2 || !MessageDigest.isEqual(mac(parts[0]), Base64.getUrlDecoder().decode(parts[1])))
                throw invalid();
            String body = new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8);
            String prefix = member + "|" + purpose + "|";
            if (!body.startsWith(prefix)) throw invalid();
            String value = body.substring(prefix.length());
            if (!sign(member, purpose, value).equals(token)) throw invalid();
            return value;
        } catch (IllegalArgumentException e) { throw invalid(); }
    }
    private byte[] mac(String body) {
        if (key.length < 32) throw new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE);
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(body.getBytes(StandardCharsets.UTF_8));
        } catch (GeneralSecurityException e) { throw new IllegalStateException(e); }
    }
    private static BusinessException invalid() { return new BusinessException(ErrorCode.VALIDATION_FAILED); }
}
