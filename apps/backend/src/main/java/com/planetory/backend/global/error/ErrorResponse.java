package com.planetory.backend.global.error;

import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;
import java.util.Map;

/**
 * docs/service-api-spec.md 2.4절 오류 응답. fieldErrors는 값이 있을 때만 직렬화한다.
 *
 * <p>{@code details}는 코드마다 명세가 정한 추가 필드를 최상위에 펼친다. 예: 탐사 API
 * {@code BUNDLE_CHANGED}의 {@code currentBundleId}(탐사 API 2.3절). 비어 있으면 아무것도 쓰지 않는다.
 */
public record ErrorResponse(
        String code,
        String message,
        @JsonInclude(JsonInclude.Include.NON_EMPTY) List<FieldError> fieldErrors,
        @JsonAnyGetter Map<String, Object> details) {

    /** {@code details}가 최상위에 펼쳐지므로 기존 필드와 이름이 겹치면 같은 키가 두 번 나간다. */
    private static final List<String> RESERVED_KEYS = List.of("code", "message", "fieldErrors");

    public ErrorResponse {
        details = details == null ? Map.of() : Map.copyOf(details);
        for (String reserved : RESERVED_KEYS) {
            if (details.containsKey(reserved)) {
                throw new IllegalArgumentException(
                        "details에 " + reserved + "를 넣을 수 없습니다. 오류 응답 최상위 필드와 이름이 겹칩니다.");
            }
        }
    }

    public ErrorResponse(String code, String message, List<FieldError> fieldErrors) {
        this(code, message, fieldErrors, Map.of());
    }

    public static ErrorResponse of(ErrorCode code) {
        return new ErrorResponse(code.name(), code.getDefaultMessage(), List.of());
    }

    public static ErrorResponse of(BusinessException e) {
        return new ErrorResponse(e.getErrorCode().name(), e.getMessage(), e.getFieldErrors(),
                e.getDetails());
    }

    public record FieldError(String field, String reason) {}
}
