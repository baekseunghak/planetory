package com.planetory.backend.domain.auth.oauth;

import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.RequestEntity;
import org.springframework.security.oauth2.client.userinfo.DefaultOAuth2UserService;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserRequest;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserRequestEntityConverter;
import org.springframework.security.oauth2.client.userinfo.OAuth2UserService;
import org.springframework.security.oauth2.core.user.OAuth2User;

/** SSAFY 가이드가 지정한 GET Content-Type을 추가하고 나머지 처리는 표준 구현에 맡긴다. */
public class SsafyOAuth2UserService implements OAuth2UserService<OAuth2UserRequest, OAuth2User> {
    private final DefaultOAuth2UserService delegate = new DefaultOAuth2UserService();

    public SsafyOAuth2UserService() {
        var converter = new OAuth2UserRequestEntityConverter();
        delegate.setRequestEntityConverter(request -> {
            var entity = converter.convert(request);
            if (!request.getClientRegistration().getRegistrationId().equals("ssafy")) return entity;
            var headers = new HttpHeaders();
            headers.putAll(entity.getHeaders());
            headers.setContentType(MediaType.parseMediaType("application/x-www-form-urlencoded;charset=UTF-8"));
            return new RequestEntity<>(entity.getBody(), headers, entity.getMethod(), entity.getUrl());
        });
    }

    @Override public OAuth2User loadUser(OAuth2UserRequest request) { return delegate.loadUser(request); }
}
