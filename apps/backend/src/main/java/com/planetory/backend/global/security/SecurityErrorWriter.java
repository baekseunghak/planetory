package com.planetory.backend.global.security;

import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.error.ErrorResponse;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

/** Security 필터의 예외는 MVC advice를 거치지 않으므로 같은 응답 DTO로 직접 쓴다. */
@Component
@RequiredArgsConstructor
public class SecurityErrorWriter {
    private final ObjectMapper mapper;

    public void write(HttpServletResponse response, ErrorCode code) throws IOException {
        response.setStatus(code.getStatus().value());
        response.setContentType("application/json");
        response.setCharacterEncoding("UTF-8");
        response.setHeader("Cache-Control", "no-store");
        response.getWriter().write(mapper.writeValueAsString(ErrorResponse.of(code)));
    }
}
