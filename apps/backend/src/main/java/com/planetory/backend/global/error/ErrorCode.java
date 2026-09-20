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
    TIC_MISMATCH(HttpStatus.BAD_REQUEST, "게시글과 같은 별의 자료만 첨부할 수 있습니다."),
    NICKNAME_CONFLICT(HttpStatus.CONFLICT, "이미 사용 중인 닉네임입니다."),
    AUTH_REQUIRED(HttpStatus.UNAUTHORIZED, "로그인이 필요합니다."),
    FORBIDDEN(HttpStatus.FORBIDDEN, "접근 권한이 없습니다."),
    RESOURCE_NOT_FOUND(HttpStatus.NOT_FOUND, "요청한 대상을 찾을 수 없습니다."),
    // 별이 있는지는 숨기지 않는다. 열리지 않았다는 사실만 알린다(탐사 API 2.4, NFR-06, AT-64).
    STAR_LOCKED(HttpStatus.FORBIDDEN, "아직 발견하지 않은 별입니다."),
    // 이쪽은 반대로 존재를 드러내지 않는다. 없는 TIC과 미공개 별을 같은 응답으로 덮는다.
    STAR_NOT_PUBLISHED(HttpStatus.NOT_FOUND, "요청한 대상을 찾을 수 없습니다."),
    STAR_LIST_PRIVATE(HttpStatus.FORBIDDEN, "별 목록을 공개하지 않은 회원입니다."),
    // 요청의 판·계산 버전이 현재 판과 다르다. 본문에 currentBundleId를 싣는다(탐사 API 2.3).
    BUNDLE_CHANGED(HttpStatus.CONFLICT, "분석 중인 판이 바뀌었습니다. 최신 판을 다시 불러와 주세요."),
    IDEMPOTENCY_CONFLICT(HttpStatus.CONFLICT, "같은 요청 ID에 다른 제출이 있습니다."),
    REQUEST_IN_PROGRESS(HttpStatus.CONFLICT, "같은 요청을 처리 중입니다."),
    PUBLICATION_NOT_ELIGIBLE(HttpStatus.CONFLICT, "공개할 수 없는 분석 기록입니다."),
    THREAD_HIDDEN(HttpStatus.CONFLICT, "공식 스레드를 이용할 수 없습니다."),
    PUBLICATION_HIDDEN(HttpStatus.CONFLICT, "숨겨진 분석은 공개 상태로 설정할 수 없습니다."),
    SUBMISSION_CONTEXT_NOT_READY(HttpStatus.CONFLICT, "제출할 곡선이 준비되지 않았습니다."),
    STAR_ALREADY_COMPLETED(HttpStatus.CONFLICT, "이미 탐색을 완료한 별입니다."),
    SKIP_NOT_AVAILABLE(HttpStatus.CONFLICT, "지금은 튜토리얼을 건너뛸 수 없습니다."),
    EPOCH_OUT_OF_RANGE(HttpStatus.BAD_REQUEST, "선택한 구간을 관측 범위 안에 배치할 수 없습니다."),
    DEPENDENCY_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, "일시적으로 처리할 수 없습니다. 잠시 후 다시 시도해 주세요."),
    GRAPH_TEMPORARILY_UNAVAILABLE(HttpStatus.SERVICE_UNAVAILABLE, "판이 변경되어 그래프를 불러오지 못했습니다. 다시 조회해 주세요."),
    INTERNAL_ERROR(HttpStatus.INTERNAL_SERVER_ERROR, "서버 오류가 발생했습니다.");

    private final HttpStatus status;
    private final String defaultMessage;
}
