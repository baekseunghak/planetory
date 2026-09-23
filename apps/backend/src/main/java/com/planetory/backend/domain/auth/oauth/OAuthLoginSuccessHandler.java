package com.planetory.backend.domain.auth.oauth;

import com.planetory.backend.domain.auth.service.AuthSessionService;
import com.planetory.backend.domain.member.service.MemberService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.SecurityErrorWriter;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.URI;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataAccessException;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.client.authentication.OAuth2AuthenticationToken;
import org.springframework.security.oauth2.client.web.HttpSessionOAuth2AuthorizedClientRepository;
import org.springframework.security.web.authentication.AuthenticationSuccessHandler;
import org.springframework.stereotype.Component;
import org.springframework.transaction.CannotCreateTransactionException;

@Component
@Slf4j
public class OAuthLoginSuccessHandler implements AuthenticationSuccessHandler {
    private final MemberService members;
    private final AuthSessionService sessions;
    private final SecurityErrorWriter errors;
    private final String successUrl;

    public OAuthLoginSuccessHandler(MemberService members, AuthSessionService sessions, SecurityErrorWriter errors,
                                   @Value("${app.auth.success-url:/api/v1/me}") String successUrl) {
        // 같은 출처의 고정 경로로만 이동한다. 요청 파라미터·SavedRequest는 사용하지 않는다.
        URI uri = URI.create(successUrl);
        if (!successUrl.startsWith("/") || successUrl.startsWith("//") || successUrl.contains("\\")
                || uri.isAbsolute() || uri.getRawAuthority() != null) {
            throw new IllegalArgumentException("app.auth.success-url must be a same-origin path");
        }
        this.members = members;
        this.sessions = sessions;
        this.errors = errors;
        this.successUrl = successUrl;
    }

    @Override
    public void onAuthenticationSuccess(HttpServletRequest request, HttpServletResponse response,
                                        Authentication authentication) throws IOException, ServletException {
        var oauth = (OAuth2AuthenticationToken) authentication;
        // 외부 API를 계속 호출하지 않으므로 제공자 access/refresh token은 로그인 직후 폐기한다.
        new HttpSessionOAuth2AuthorizedClientRepository().removeAuthorizedClient(
                oauth.getAuthorizedClientRegistrationId(), oauth, request, response);
        try {
            var member = members.login(oauth.getAuthorizedClientRegistrationId(), oauth.getName());
            sessions.login(member, request, response);
        } catch (BusinessException e) {
            log.warn("OAuth member initialization failed: branch=business code={} exception={}",
                    e.getErrorCode(), e.getClass().getSimpleName());
            sessions.logout(request, response);
            errors.write(response, e.getErrorCode());
            return;
        } catch (DataAccessException | CannotCreateTransactionException e) {
            log.error("OAuth member initialization failed: branch=database code={} exception={}",
                    ErrorCode.DEPENDENCY_UNAVAILABLE, e.getClass().getSimpleName());
            sessions.logout(request, response);
            errors.write(response, ErrorCode.DEPENDENCY_UNAVAILABLE);
            return;
        } catch (RuntimeException e) {
            log.error("OAuth member initialization failed: branch=unexpected code={} exception={}",
                    ErrorCode.INTERNAL_ERROR, e.getClass().getSimpleName());
            sessions.logout(request, response);
            errors.write(response, ErrorCode.INTERNAL_ERROR);
            return;
        }
        response.sendRedirect(request.getContextPath() + successUrl);
    }
}
