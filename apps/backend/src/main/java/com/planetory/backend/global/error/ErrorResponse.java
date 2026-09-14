package com.planetory.backend.global.error;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** docs/service-api-spec.md 2.4절 오류 응답. fieldErrors는 값이 있을 때만 직렬화한다. */
public record ErrorResponse(
        String code,
        String message,
        @JsonInclude(JsonInclude.Include.NON_EMPTY) List<FieldError> fieldErrors) {

    public static ErrorResponse of(ErrorCode code) {
        return new ErrorResponse(code.name(), code.getDefaultMessage(), List.of());
    }

    public static ErrorResponse of(BusinessException e) {
        return new ErrorResponse(e.getErrorCode().name(), e.getMessage(), e.getFieldErrors());
    }

    public record FieldError(String field, String reason) {}
}
