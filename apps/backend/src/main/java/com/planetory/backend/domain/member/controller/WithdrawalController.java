package com.planetory.backend.domain.member.controller;

import com.planetory.backend.domain.auth.service.AuthSessionService;
import com.planetory.backend.domain.member.service.WithdrawalService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
public class WithdrawalController {
    private final WithdrawalService withdrawals;
    private final AuthSessionService sessions;
    @Value("${planetory.withdrawal.enabled:false}") private boolean enabled;

    public record Policy(boolean available, String version, List<String> effects,
                         List<String> retention, List<String> rejoining) {}
    public record UnavailablePolicy(boolean available, String reason) {}
    public record PrepareRequest(String policyVersion) {}
    public record ConfirmRequest(String policyVersion, String confirmation) {}

    @GetMapping("/api/v1/me/withdrawal-policy")
    public Object policy() {
        if (!enabled) return new UnavailablePolicy(false, "탈퇴 정책을 준비하고 있습니다.");
        return new Policy(true, WithdrawalService.POLICY_VERSION,
                List.of("탈퇴 확정 즉시 계정 이용과 모든 기기의 보호 접근이 종료되며 취소할 수 없습니다.",
                        "일반 글·댓글은 작성자 연결을 제거하고 ‘탈퇴한 회원’으로 표시합니다.",
                        "개인 분석·History·첨부·공개 분석과 팔로우·반응은 확정 즉시 공개와 집계에서 제외됩니다."),
                List.of("개인 기록과 관계는 보통 1시간 이내, 늦어도 24시간 이내 정리를 목표로 합니다.",
                        "작성자 연결을 제거한 일반 글·댓글 본문은 탈퇴 후 1년간 유지한 뒤 삭제합니다. 식별 정보가 있는 본문은 별도 삭제·가림을 요청할 수 있습니다.",
                        "재식별할 수 없는 과거 통계는 생성 후 1년, 최소 탈퇴 처리 기록과 결과 조회는 신청 후 90일 보관합니다."),
                List.of("데이터 정리가 완료되면 같은 제공자로 별도 대기기간 없이 새 계정을 만들 수 있습니다.",
                        "새 계정에는 이전 기록·성과·별 발견·팔로우가 복원되지 않습니다."));
    }

    @PostMapping("/api/v1/me/withdrawal-requests")
    public WithdrawalService.Status prepare(@AuthenticationPrincipal MemberPrincipal principal,
            @RequestBody PrepareRequest request, HttpServletResponse response) {
        requireEnabled();
        var prepared = withdrawals.prepare(principal.memberId(), request == null ? null : request.policyVersion());
        response.addHeader(HttpHeaders.SET_COOKIE, ResponseCookie.from("WITHDRAWAL_RECEIPT", prepared.receipt())
                .httpOnly(true).secure(true).sameSite("Strict")
                .path("/api/v1/withdrawal-requests/" + prepared.status().requestId())
                .maxAge(Duration.ofDays(90)).build().toString());
        return prepared.status();
    }

    @PostMapping("/api/v1/me/withdrawal-requests/{requestId}/confirm")
    public WithdrawalService.Status confirm(@AuthenticationPrincipal MemberPrincipal principal,
            @PathVariable String requestId, @RequestBody ConfirmRequest request,
            HttpServletRequest servletRequest, HttpServletResponse servletResponse) {
        requireEnabled();
        var status = withdrawals.confirm(principal.memberId(), id(requestId),
                request == null ? null : request.policyVersion(), request == null ? null : request.confirmation());
        if (status.effectiveAt() != null) sessions.logout(servletRequest, servletResponse);
        return status;
    }

    @GetMapping("/api/v1/withdrawal-requests/{requestId}")
    public WithdrawalService.Status receipt(@PathVariable String requestId,
            @CookieValue(value = "WITHDRAWAL_RECEIPT", required = false) String secret) {
        return withdrawals.receipt(id(requestId), secret);
    }

    @PostMapping("/api/v1/operator/withdrawal-requests/{requestId}/retry")
    public WithdrawalService.Status retry(@PathVariable String requestId) {
        return withdrawals.retryFailed(id(requestId));
    }

    private static UUID id(String text) {
        try { return UUID.fromString(text); }
        catch (IllegalArgumentException ex) { throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND); }
    }

    private void requireEnabled() {
        if (!enabled) throw new BusinessException(ErrorCode.WITHDRAWAL_UNAVAILABLE);
    }
}
