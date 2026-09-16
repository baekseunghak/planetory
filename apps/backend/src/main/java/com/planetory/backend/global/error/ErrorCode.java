package com.planetory.backend.global.error;

import lombok.Getter;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;

/**
 * API 오류 코드. 프론트는 {@code code}로 분기한다(docs/service-api-spec.md 2.4절).
 * 도메인 코드는 담당자가 여기에 추가한다. HTTP 매핑은 명세의 제안을 따른다.
 */
@Getter
@RequiredArgsConstructor
public enum ErrorCode {

    VALIDATION_FAILED(HttpStatus.BAD_REQUEST, "요청 값이 올바르지 않습니다."),
    NICKNAME_CONFLICT(HttpStatus.CONFLICT, "이미 사용 중인 닉네임입니다."),
    AUTH_REQUIRED(HttpStatus.UNAUTHORIZED, "로그인이 필요합니다."),
    FORBIDDEN(HttpStatus.FORBIDDEN, "접근 권한이 없습니다."),
    RESOURCE_NOT_FOUND(HttpStatus.NOT_FOUND, "요청한 대상을 찾을 수 없습니다."),
    DEPENDENCY_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, "일시적으로 처리할 수 없습니다. 잠시 후 다시 시도해 주세요."),
    INTERNAL_ERROR(HttpStatus.INTERNAL_SERVER_ERROR, "서버 오류가 발생했습니다.");

    private final HttpStatus status;
    private final String defaultMessage;
}
