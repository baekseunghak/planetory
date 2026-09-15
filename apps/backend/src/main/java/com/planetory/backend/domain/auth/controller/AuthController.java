package com.planetory.backend.domain.auth.controller;

import com.planetory.backend.domain.auth.dto.CsrfResponse;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.oauth2.client.registration.ClientRegistrationRepository;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
public class AuthController {
    private final ObjectProvider<ClientRegistrationRepository> clients;

    @GetMapping(value = "/login", produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> loginPage() {
        var repository = clients.getIfAvailable();
        String links = "";
        if (repository != null && repository.findByRegistrationId("google") != null) {
            links += "<li><a href='/oauth2/authorization/google'>Google로 로그인</a></li>";
        }
        if (repository != null && repository.findByRegistrationId("ssafy") != null) {
            links += "<li><a href='/oauth2/authorization/ssafy'>SSAFY로 로그인</a></li>";
        }
        return ResponseEntity.status(links.isEmpty() ? 503 : 200).body("""
                <!doctype html><html lang="ko"><head><meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <title>Planetory 로그인</title></head><body><main><h1>Planetory 로그인</h1>
                %s</main></body></html>
                """.formatted(links.isEmpty() ? "<p>현재 로그인을 이용할 수 없습니다.</p>" : "<ul>" + links + "</ul>"));
    }

    @Operation(summary = "CSRF 토큰 조회", description = "로그인 후 다시 조회하고 변경 요청의 headerName 헤더로 token을 보냅니다.")
    @GetMapping("/api/v1/auth/csrf")
    public CsrfResponse csrf(CsrfToken token) {
        return new CsrfResponse(token.getHeaderName(), token.getToken());
    }
}
