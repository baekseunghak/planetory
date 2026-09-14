package com.planetory.backend.global.error;

import java.util.List;
import lombok.Getter;

/**
 * 업무 규칙 위반 예외의 베이스. 도메인 예외는 이 클래스를 상속하고 {@link ErrorCode}만 지정한다.
 * 도메인마다 핸들러 메서드를 추가하지 않도록 {@link GlobalExceptionHandler}가 한 곳에서 변환한다.
 */
@Getter
public class BusinessException extends RuntimeException {

    private final ErrorCode errorCode;
    private final List<ErrorResponse.FieldError> fieldErrors;

    public BusinessException(ErrorCode errorCode) {
        this(errorCode, errorCode.getDefaultMessage(), List.of());
    }

    public BusinessException(ErrorCode errorCode, String message) {
        this(errorCode, message, List.of());
    }

    public BusinessException(ErrorCode errorCode, String message, List<ErrorResponse.FieldError> fieldErrors) {
        super(message);
        this.errorCode = errorCode;
        this.fieldErrors = List.copyOf(fieldErrors);
    }
}
