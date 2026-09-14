package com.planetory.backend.global.config;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI planetoryOpenApi() {
        // 세션 쿠키 인증(SB-D14). 쿠키 이름은 인증 구현 시 확정한다.
        return new OpenAPI()
                .components(new Components().addSecuritySchemes("sessionCookie", new SecurityScheme()
                        .type(SecurityScheme.Type.APIKEY)
                        .in(SecurityScheme.In.COOKIE)
                        .name("SESSION")
                        .description("로그인 후 브라우저가 전달하는 세션 쿠키")))
                .info(new Info()
                        .title("Planetory API")
                        .description("Planetory 서비스 백엔드 API 문서. 오류 형식은 docs/service-api-spec.md 2.4절을 따른다.")
                        .version("v0.0.1"));
    }
}
