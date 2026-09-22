package com.planetory.backend.global.security;

import jakarta.servlet.FilterChain;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import tools.jackson.databind.ObjectMapper;

import static org.junit.jupiter.api.Assertions.*;

/** 내부 경로의 서비스 토큰 검사 [S15P21C206-150]. */
class InternalTokenFilterTest {

    private static final String TOKEN = "publisher-token";

    private final MockHttpServletResponse response = new MockHttpServletResponse();
    private final AtomicBoolean passed = new AtomicBoolean();
    private final FilterChain chain = (request, res) -> passed.set(true);

    @Test
    void 내부_경로가_아니면_검사하지_않는다() throws Exception {
        filter(TOKEN).doFilter(request("/api/v1/me", null), response, chain);

        assertTrue(passed.get());
        assertEquals(200, response.getStatus());
    }

    @Test
    void 토큰이_맞으면_통과한다() throws Exception {
        filter(TOKEN).doFilter(request("/internal/bundles/b-1/activated", TOKEN), response, chain);

        assertTrue(passed.get());
    }

    @Test
    void 토큰이_없거나_틀리면_401이다() throws Exception {
        for (String presented : new String[] {null, "", "publisher-toke", "publisher-token2", "다른값"}) {
            var eachResponse = new MockHttpServletResponse();
            passed.set(false);

            filter(TOKEN).doFilter(request("/internal/bundles/b-1/activated", presented), eachResponse, chain);

            assertFalse(passed.get(), "막아야 한다: " + presented);
            assertEquals(401, eachResponse.getStatus());
            assertTrue(eachResponse.getContentAsString().contains("AUTH_REQUIRED"));
        }
    }

    /** 설정 누락이 인증 없는 경로로 이어지면 안 된다. 빈 토큰과 빈 헤더가 맞아떨어져도 막는다. */
    @Test
    void 토큰을_설정하지_않았으면_모두_막는다() throws Exception {
        for (String configured : new String[] {null, "", "   "}) {
            var eachResponse = new MockHttpServletResponse();
            passed.set(false);

            filter(configured).doFilter(request("/internal/bundles/b-1/activated", configured),
                    eachResponse, chain);

            assertFalse(passed.get(), "막아야 한다: " + configured);
            assertEquals(401, eachResponse.getStatus());
        }
    }

    private static InternalTokenFilter filter(String configured) {
        return new InternalTokenFilter(new InternalApiProperties(configured),
                new SecurityErrorWriter(new ObjectMapper()),
                org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher
                        .withDefaults().matcher(InternalTokenFilter.PATTERN));
    }

    private static MockHttpServletRequest request(String path, String token) {
        var request = new MockHttpServletRequest("POST", path);
        if (token != null) {
            request.addHeader(InternalTokenFilter.HEADER, token);
        }
        return request;
    }
}
