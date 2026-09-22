package com.planetory.backend.domain.exploration.controller;

import com.planetory.backend.domain.exploration.service.ExplorationIds;
import com.planetory.backend.domain.exploration.service.PublicSkyService;
import com.planetory.backend.domain.exploration.service.PublicSkyViews;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

@RestController
@RequiredArgsConstructor
@RequestMapping("/api/v1/members/{memberId}")
public class PublicSkyController {
    private final PublicSkyService sky;

    // 성공과 권한 철회/검증 오류 모두 캐시에 남기지 않는다. 401은 SecurityErrorWriter가 처리한다.
    @ModelAttribute
    void noStore(HttpServletResponse response) { response.setHeader("Cache-Control", "no-store"); }

    @Operation(summary = "공개 은하 메타")
    @GetMapping("/sky")
    public PublicSkyViews.Meta meta(@PathVariable String memberId) {
        return sky.meta(member(memberId));
    }

    @Operation(summary = "공개 은하 전체 보유 별 타일")
    @GetMapping("/sky/tiles")
    public PublicSkyViews.Tile tiles(@AuthenticationPrincipal MemberPrincipal principal,
            @PathVariable String memberId, @RequestParam String level,
            @RequestParam String x, @RequestParam String y, @RequestParam String w,
            @RequestParam String h, @RequestParam String version,
            @RequestParam(required = false) String limit, @RequestParam(required = false) String cursor) {
        long owner = member(memberId);
        try {
            return sky.tiles(principal.memberId(), owner, Integer.parseInt(level), Double.parseDouble(x),
                    Double.parseDouble(y), Double.parseDouble(w), Double.parseDouble(h), version,
                    limit == null ? null : Integer.valueOf(limit), cursor);
        } catch (NumberFormatException e) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
    }

    @Operation(summary = "공개 은하 소유 별·성과 행성 상세")
    @GetMapping("/stars/{ticId}")
    public PublicSkyViews.Detail detail(@PathVariable String memberId, @PathVariable String ticId) {
        return sky.detail(member(memberId), ExplorationIds.parseTic(ticId)
                .orElseThrow(PublicSkyController::unavailable));
    }

    private static long member(String id) {
        return ExplorationIds.parseMember(id).orElseThrow(PublicSkyController::unavailable);
    }
    private static BusinessException unavailable() { return new BusinessException(ErrorCode.PUBLIC_SKY_NOT_AVAILABLE); }
}
