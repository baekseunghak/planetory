package com.planetory.backend.domain.exploration.controller;

import com.planetory.backend.domain.exploration.service.ExplorationIds;
import com.planetory.backend.domain.exploration.service.StarResultService;
import com.planetory.backend.domain.exploration.service.StarResultViews.StarResult;
import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.domain.exploration.service.StarViews.ListFilter;
import com.planetory.backend.domain.exploration.service.StarViews.PublicStarSummary;
import com.planetory.backend.domain.exploration.service.StarViews.StarList;
import com.planetory.backend.domain.exploration.service.StarViews.StarDetail;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 선택한 별·내 행성 상세 (탐사 API 4.2) [S15P21C206-138].
 *
 * <p>경로·쿼리 값을 문자열로 받아 여기서 판별한다. 숫자 타입으로 받으면 변환 실패가
 * {@code MethodArgumentTypeMismatchException}이 되는데, 이 예외는 {@code ErrorResponse}를 구현하지 않아
 * 전역 처리기에서 500이 된다(S15P21C206-246).
 */
@RestController
@RequiredArgsConstructor
public class StarController {

    private final StarService stars;
    private final StarResultService starResults;

    @Operation(summary = "별 결과 페이지",
            description = "제출 이력이 있는 별의 진행·성과·매칭한 신호·제출 기록·곡선 단계·발견한 별을"
                    + " 모아 준다(RES-10). 제출한 적 없는 별과 없는 TIC은 같은 404다."
                    + " 매칭하지 못한 후보는 어떤 필드에도 나열하지 않는다(DEC-28)."
                    + " 조회는 열람 기록·진행·잔차 작업을 만들지 않는다.")
    @GetMapping("/api/v1/stars/{ticId}/result")
    public StarResult result(@AuthenticationPrincipal MemberPrincipal principal,
                             @PathVariable String ticId) {
        return starResults.result(principal.memberId(), tic(ticId, ErrorCode.RESOURCE_NOT_FOUND));
    }

    @Operation(summary = "내 별 상세",
            description = "발견한 별의 근접 뷰·도킹 패널·행성 목록이 공유한다. 미발견 별은 403 STAR_LOCKED."
                    + " TIC은 접두 없는 양의 정수이며 형식이 다르면 미발견과 같은 403으로 덮는다.")
    @GetMapping("/api/v1/me/stars/{ticId}")
    public StarDetail detail(@AuthenticationPrincipal MemberPrincipal principal,
                             @PathVariable String ticId) {
        return stars.detail(principal.memberId(), tic(ticId, ErrorCode.STAR_LOCKED));
    }

    @Operation(summary = "공개 별 요약",
            description = "게시판 헤더·출처 카드가 쓴다. 발견하지 않은 회원도 호출할 수 있다."
                    + " 미공개이거나 아무도 발견하지 않은 별, 형식이 다른 TIC은 404 STAR_NOT_PUBLISHED.")
    @GetMapping("/api/v1/stars/{ticId}")
    public PublicStarSummary publicSummary(@AuthenticationPrincipal MemberPrincipal principal,
                                           @PathVariable String ticId) {
        return stars.publicSummary(principal.memberId(), tic(ticId, ErrorCode.STAR_NOT_PUBLISHED));
    }

    @Operation(summary = "내 별 목록",
            description = "scope=submitted(기본)는 제출 이력이 있는 별, discovered는 발견한 별 전부."
                    + " 필터 stage·grade·ticId를 단독·복합으로 쓸 수 있고 계약 밖 값은 400."
                    + " 커서는 필터에도 묶이므로 조건을 바꾸면 처음부터 다시 읽는다.")
    @GetMapping("/api/v1/me/stars")
    public StarList myStars(@AuthenticationPrincipal MemberPrincipal principal,
                            @RequestParam(required = false) String scope,
                            @RequestParam(required = false) String sort,
                            @RequestParam(required = false) String size,
                            @RequestParam(required = false) String cursor,
                            @RequestParam(required = false) String stage,
                            @RequestParam(required = false) String grade,
                            @RequestParam(required = false) String ticId) {
        long memberId = principal.memberId();
        return stars.list(memberId, memberId, scope, sort, size(size), cursor,
                new ListFilter(stage, grade, ticId));
    }

    @Operation(summary = "타인 별 목록",
            description = "별 목록을 공개한 회원만 볼 수 있다. 비공개면 403 STAR_LIST_PRIVATE."
                    + " memberId는 회원 API가 주는 u-{id} 형식이며 그 밖의 값은 400 VALIDATION_FAILED."
                    + " scope=discovered는 본인 조회 전용이라 거절한다.")
    @GetMapping("/api/v1/members/{memberId}/stars")
    public StarList memberStars(@AuthenticationPrincipal MemberPrincipal principal,
                                @PathVariable String memberId,
                                @RequestParam(required = false) String scope,
                                @RequestParam(required = false) String sort,
                                @RequestParam(required = false) String size,
                                @RequestParam(required = false) String cursor,
                                @RequestParam(required = false) String stage,
                                @RequestParam(required = false) String grade,
                                @RequestParam(required = false) String ticId) {
        return stars.list(principal.memberId(), member(memberId), scope, sort, size(size), cursor,
                new ListFilter(stage, grade, ticId));
    }

    /**
     * 형식이 다른 TIC은 없는 별과 같은 응답으로 덮는다(ErrorCode의 별 존재 은닉 방침).
     *
     * @param masked 이 경로에서 없는 별에 주는 오류. 숫자 TIC으로 없는 별을 요청했을 때와 같아야 한다
     */
    private static long tic(String ticId, ErrorCode masked) {
        return ExplorationIds.parseTic(ticId).orElseThrow(() -> new BusinessException(masked));
    }

    /** 회원 식별자 형식의 정본은 서비스 API 명세({@code GET /api/v1/members/u-102})다. */
    private static long member(String memberId) {
        return ExplorationIds.parseMember(memberId)
                .orElseThrow(() -> new BusinessException(ErrorCode.VALIDATION_FAILED));
    }

    /** 상한·하한은 4.4절 규칙대로 서비스가 본다. 여기서는 숫자인지만 가른다. */
    private static Integer size(String size) {
        if (size == null) {
            return null;
        }
        try {
            return Integer.valueOf(size);
        } catch (NumberFormatException malformed) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
    }
}
