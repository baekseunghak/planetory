package com.planetory.backend.domain.auth.oauth;

import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.SecurityErrorWriter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.filter.OncePerRequestFilter;

/** 가이드의 대문자 Code도 수용한다. state 값의 생성·검증은 Spring Security 그대로 유지한다. */
public class SsafyCallbackFilter extends OncePerRequestFilter {
    private final SecurityErrorWriter errors;
    public SsafyCallbackFilter(SecurityErrorWriter errors) { this.errors = errors; }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (!request.getMethod().equals("GET")
                || !request.getRequestURI().equals(request.getContextPath() + "/login/oauth2/code/ssafy")
                || request.getParameterValues("Code") == null) {
            chain.doFilter(request, response);
            return;
        }
        String[] code = request.getParameterValues("Code");
        if (code.length != 1 || code[0].isBlank() || request.getParameterValues("code") != null) {
            errors.write(response, ErrorCode.AUTH_REQUIRED);
            return;
        }
        Map<String, String[]> params = new LinkedHashMap<>(request.getParameterMap());
        params.remove("Code");
        params.put("code", code);
        chain.doFilter(new HttpServletRequestWrapper(request) {
            @Override public Map<String, String[]> getParameterMap() { return Collections.unmodifiableMap(params); }
            @Override public Enumeration<String> getParameterNames() { return Collections.enumeration(params.keySet()); }
            @Override public String[] getParameterValues(String name) { return params.get(name); }
            @Override public String getParameter(String name) {
                String[] values = params.get(name);
                return values == null || values.length == 0 ? null : values[0];
            }
        }, response);
    }
}
