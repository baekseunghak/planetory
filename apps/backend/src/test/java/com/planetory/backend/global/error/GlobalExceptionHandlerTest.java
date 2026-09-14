package com.planetory.backend.global.error;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 컨트롤러 테스트 템플릿. {@code @WebMvcTest}는 웹 계층만 띄우므로 DB가 없어도 실행된다.
 * 도메인 컨트롤러 테스트는 같은 방식으로 controllers를 지정하고 서비스는 {@code @MockitoBean}으로 대체한다.
 */
@WebMvcTest(controllers = GlobalExceptionHandlerTest.ProbeController.class)
@Import({GlobalExceptionHandler.class, GlobalExceptionHandlerTest.ProbeController.class})
class GlobalExceptionHandlerTest {

    @Autowired MockMvc mockMvc;

    @Test
    @DisplayName("BusinessException은 ErrorCode의 HTTP 상태와 code·message로 변환된다")
    void businessExceptionUsesErrorCode() throws Exception {
        mockMvc.perform(get("/probe/not-found"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"))
                .andExpect(jsonPath("$.message").value("요청한 대상을 찾을 수 없습니다."))
                .andExpect(jsonPath("$.fieldErrors").doesNotExist());
    }

    @Test
    @DisplayName("@Valid 실패는 400 VALIDATION_FAILED와 fieldErrors를 반환한다")
    void validationFailureListsFieldErrors() throws Exception {
        mockMvc.perform(post("/probe/validate")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"nickname\":\"\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"))
                .andExpect(jsonPath("$.fieldErrors[0].field").value("nickname"));
    }

    @Test
    @DisplayName("Spring MVC 표준 예외는 원래 상태 코드를 유지한다 — 405·415·404")
    void springMvcExceptionsKeepTheirStatus() throws Exception {
        mockMvc.perform(post("/probe/not-found"))
                .andExpect(status().isMethodNotAllowed())
                .andExpect(jsonPath("$.code").value("METHOD_NOT_ALLOWED"));
        mockMvc.perform(post("/probe/validate").contentType(MediaType.TEXT_PLAIN).content("x"))
                .andExpect(status().isUnsupportedMediaType())
                .andExpect(jsonPath("$.code").value("UNSUPPORTED_MEDIA_TYPE"));
        mockMvc.perform(get("/probe/missing"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"));
    }

    @Test
    @DisplayName("예상하지 못한 예외는 500 INTERNAL_ERROR로 감추고 원문을 노출하지 않는다")
    void unexpectedExceptionIsMasked() throws Exception {
        mockMvc.perform(get("/probe/boom"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.code").value("INTERNAL_ERROR"))
                .andExpect(jsonPath("$.message").value("서버 오류가 발생했습니다."));
    }

    @RestController
    static class ProbeController {

        record NicknameRequest(@NotBlank String nickname) {}

        @GetMapping("/probe/not-found")
        void notFound() {
            throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        }

        @PostMapping("/probe/validate")
        void validate(@Valid @RequestBody NicknameRequest request) {}

        @GetMapping("/probe/boom")
        void boom() {
            throw new IllegalStateException("internal detail must not leak");
        }
    }
}
