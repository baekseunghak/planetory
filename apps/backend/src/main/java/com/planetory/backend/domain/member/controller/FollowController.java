package com.planetory.backend.domain.member.controller;

import com.planetory.backend.domain.member.service.FollowService;
import com.planetory.backend.domain.member.service.FollowTokens;
import com.planetory.backend.domain.post.service.CommunityQuery;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import org.springframework.dao.DataAccessException;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;

@RestController
@RequiredArgsConstructor
public class FollowController {
    private final FollowService follows;
    private final FollowTokens tokens;

    @Operation(summary = "회원·별 팔로우 현재 상태 조회·설정·해제")
    @RequestMapping(value = "/api/v1/me/following/{targets:members|stars}/{target}", method = {RequestMethod.GET, RequestMethod.PUT, RequestMethod.DELETE})
    public ResponseEntity<?> relation(@AuthenticationPrincipal MemberPrincipal member, @PathVariable String targets,
            @PathVariable String target, @RequestParam MultiValueMap<String, String> params, jakarta.servlet.http.HttpServletRequest request) {
        CommunityQuery.only(params, Set.of());
        String kind = targets.equals("members") ? "MEMBER" : "STAR";
        long id = CommunityQuery.id(target, kind.equals("MEMBER") ? "u-" : "");
        return response(() -> request.getMethod().equals("GET") ? follows.relation(member.memberId(), kind, id)
                : follows.change(member.memberId(), kind, id, request.getMethod().equals("PUT")));
    }

    @Operation(summary = "공개 팔로우 수치")
    @GetMapping("/api/v1/members/{memberId}/follow-summary")
    public ResponseEntity<?> summary(@AuthenticationPrincipal MemberPrincipal member, @PathVariable String memberId,
            @RequestParam MultiValueMap<String, String> params) {
        CommunityQuery.only(params, Set.of());
        return response(() -> follows.summary(member.memberId(), CommunityQuery.id(memberId, "u-")));
    }

    @Operation(summary = "본인 회원·별 팔로잉 목록")
    @GetMapping("/api/v1/me/following/{scope:members|stars}")
    public ResponseEntity<?> following(@AuthenticationPrincipal MemberPrincipal member, @PathVariable String scope,
            @RequestParam MultiValueMap<String, String> params) {
        return response(() -> follows.list(member.memberId(), scope, tokens.page(member.memberId(), scope, params)));
    }

    @Operation(summary = "본인 팔로워 목록")
    @GetMapping("/api/v1/me/followers")
    public ResponseEntity<?> followers(@AuthenticationPrincipal MemberPrincipal member, @RequestParam MultiValueMap<String, String> params) {
        return response(() -> follows.list(member.memberId(), "followers", tokens.page(member.memberId(), "followers", params)));
    }

    @Operation(summary = "비공개 관심 별 관계 관리 목록")
    @GetMapping("/api/v1/me/following/unavailable-stars")
    public ResponseEntity<?> unavailable(@AuthenticationPrincipal MemberPrincipal member, @RequestParam MultiValueMap<String, String> params) {
        return response(() -> follows.unavailable(member.memberId(), tokens.page(member.memberId(), "unavailable-stars", params)));
    }

    @Operation(summary = "본인 관리 관계 결과 확인·해제")
    @RequestMapping(value = "/api/v1/me/following/relations/{relationId}", method = {RequestMethod.GET, RequestMethod.DELETE})
    public ResponseEntity<?> managed(@AuthenticationPrincipal MemberPrincipal member, @PathVariable String relationId,
            @RequestParam MultiValueMap<String, String> params, jakarta.servlet.http.HttpServletRequest request) {
        CommunityQuery.only(params, Set.of());
        return response(() -> request.getMethod().equals("GET") ? follows.managed(member.memberId(), relationId)
                : follows.removeManaged(member.memberId(), relationId));
    }

    private static ResponseEntity<?> response(java.util.function.Supplier<?> action) {
        try { return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(action.get()); }
        catch (DataAccessException e) { throw new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE); }
    }
}
