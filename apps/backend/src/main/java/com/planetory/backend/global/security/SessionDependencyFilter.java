package com.planetory.backend.global.security;

import com.planetory.backend.global.error.ErrorCode;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.dao.DataAccessException;
import org.springframework.web.filter.OncePerRequestFilter;

/** 세션 필터의 읽기와 응답 종료 시 저장 실패를 같은 503 경계로 처리한다. */
public final class SessionDependencyFilter extends OncePerRequestFilter {
    private final SecurityErrorWriter errors;
    public SessionDependencyFilter(SecurityErrorWriter errors) { this.errors = errors; }
    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
            FilterChain chain) throws ServletException, IOException {
        try {
            // Spring Session의 OnCommittedResponseWrapper가 본문 전송/flush 전에 세션을 저장한다.
            chain.doFilter(request, response);
        } catch (Exception ex) {
            Throwable cause = ex;
            while (cause != null && !(cause instanceof DataAccessException)) cause = cause.getCause();
            if (cause == null || response.isCommitted()) {
                if (ex instanceof IOException io) throw io;
                if (ex instanceof ServletException servlet) throw servlet;
                if (ex instanceof RuntimeException runtime) throw runtime;
                throw new ServletException(ex);
            }
            response.reset();
            errors.write(response, ErrorCode.DEPENDENCY_UNAVAILABLE);
        }
    }
}
