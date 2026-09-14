package com.planetory.backend.global.error;

import java.util.List;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * 전역 예외 변환. 도메인 예외는 {@link BusinessException}을 상속해 {@link ErrorCode}만 지정하면 여기서 처리된다.
 * 내부 장애를 "자료가 없음"으로 바꿔 반환하지 않으며, 실패 응답에 타인의 비공개 값·원문을 담지 않는다.
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(BusinessException.class)
    public ResponseEntity<ErrorResponse> handleBusiness(BusinessException e) {
        return ResponseEntity.status(e.getErrorCode().getStatus()).body(ErrorResponse.of(e));
    }

    // @Valid 검증 실패 → 400, 필드별 사유 포함
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidation(MethodArgumentNotValidException e) {
        List<ErrorResponse.FieldError> fieldErrors = e.getBindingResult().getFieldErrors().stream()
                .map(f -> new ErrorResponse.FieldError(f.getField(), f.getDefaultMessage()))
                .toList();
        ErrorCode code = ErrorCode.VALIDATION_FAILED;
        return ResponseEntity.status(code.getStatus())
                .body(new ErrorResponse(code.name(), code.getDefaultMessage(), fieldErrors));
    }

    // JSON 파싱 실패·본문 누락 → 400
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ErrorResponse> handleUnreadable(HttpMessageNotReadableException e) {
        return ResponseEntity.status(ErrorCode.VALIDATION_FAILED.getStatus())
                .body(ErrorResponse.of(ErrorCode.VALIDATION_FAILED));
    }

    // 그 외 → 500. 원인은 로그에만 남긴다.
    // 단, Spring MVC 표준 예외(없는 경로 404, 메서드 405, 미디어 타입 415, 파라미터 누락 400 등)는
    // 자체 상태 코드를 유지한다. 이 분기가 없으면 전부 500이 된다.
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleUnexpected(Exception e) {
        if (e instanceof org.springframework.web.ErrorResponse springMvc) {
            HttpStatus status = HttpStatus.valueOf(springMvc.getStatusCode().value());
            if (status.is4xxClientError()) {
                return ResponseEntity.status(status).body(fromStatus(status));
            }
        }
        log.error("Unhandled exception", e);
        return ResponseEntity.status(ErrorCode.INTERNAL_ERROR.getStatus())
                .body(ErrorResponse.of(ErrorCode.INTERNAL_ERROR));
    }

    private static ErrorResponse fromStatus(HttpStatus status) {
        return switch (status) {
            case BAD_REQUEST -> ErrorResponse.of(ErrorCode.VALIDATION_FAILED);
            case NOT_FOUND -> ErrorResponse.of(ErrorCode.RESOURCE_NOT_FOUND);
            default -> new ErrorResponse(status.name(), "허용되지 않는 요청 형식입니다.", List.of());
        };
    }
}
