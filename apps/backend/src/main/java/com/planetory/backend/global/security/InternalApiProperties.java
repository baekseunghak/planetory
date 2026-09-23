package com.planetory.backend.global.security;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 서비스 사이 내부 호출 설정 [S15P21C206-150].
 *
 * <p>Publisher가 판 전환을 알리는 경로({@code /internal/**})의 공유 비밀이다. 회원 세션이 아니라
 * 서비스 토큰으로 인증한다 — 부르는 쪽이 사람이 아니라 배치다.
 *
 * @param serviceToken 호출자가 {@code X-Planetory-Service-Token}으로 보내는 값. 비어 있으면
 *                     내부 경로 전체를 막는다. 설정하지 않은 환경에서 인증 없는 구멍이 열리는 것보다
 *                     부르지 못하는 편이 낫다
 */
@ConfigurationProperties("planetory.internal")
public record InternalApiProperties(String serviceToken) {

    public InternalApiProperties {
        serviceToken = serviceToken == null ? "" : serviceToken;
    }

    public boolean enabled() {
        return !serviceToken.isBlank();
    }
}
