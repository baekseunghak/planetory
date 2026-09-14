package com.planetory.backend.global.error;

import java.util.List;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

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

    // 매핑되지 않은 경로 → 404
    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<ErrorResponse> handleNoResource(NoResourceFoundException e) {
        return ResponseEntity.status(ErrorCode.RESOURCE_NOT_FOUND.getStatus())
                .body(ErrorResponse.of(ErrorCode.RESOURCE_NOT_FOUND));
    }

    // 그 외 → 500. 원인은 로그에만 남긴다.
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleUnexpected(Exception e) {
        log.error("Unhandled exception", e);
        return ResponseEntity.status(ErrorCode.INTERNAL_ERROR.getStatus())
                .body(ErrorResponse.of(ErrorCode.INTERNAL_ERROR));
    }
}
