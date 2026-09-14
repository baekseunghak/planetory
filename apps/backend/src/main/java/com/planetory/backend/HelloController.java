package com.planetory.backend;

import io.swagger.v3.oas.annotations.Operation;
import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@Profile("local")
@RestController
class HelloController {

    @Operation(summary = "개발 환경 동작 확인", description = "회원·DB 데이터를 변경하지 않는 예제 API입니다.")
    @GetMapping("/api/v1/hello")
    HelloResponse hello() {
        return new HelloResponse("Planetory 백엔드가 실행 중입니다.");
    }

    record HelloResponse(String message) {}
}
