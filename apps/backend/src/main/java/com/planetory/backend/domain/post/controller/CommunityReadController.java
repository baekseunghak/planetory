package com.planetory.backend.domain.post.controller;

import com.planetory.backend.domain.post.service.CommunityQuery;
import com.planetory.backend.domain.post.service.CommunityReadService;
import com.planetory.backend.domain.post.service.HotTopicsQuery;
import com.planetory.backend.domain.member.service.FollowTokens;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
public class CommunityReadController {
    private final CommunityReadService community;
    private final FollowTokens followTokens;

    @io.swagger.v3.oas.annotations.Operation(summary = "본인 팔로잉 피드")
    @GetMapping("/api/v1/community/following-feed")
    public ResponseEntity<CommunityReadService.FollowingFeed> following(@AuthenticationPrincipal MemberPrincipal member,
            @RequestParam MultiValueMap<String, String> params) {
        try {
            return response(community.following(member.memberId(), followTokens.page(member.memberId(), "feed", params)));
        } catch (org.springframework.dao.DataAccessException e) { throw new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE); }
    }

    @GetMapping("/api/v1/community/hot-topics")
    public ResponseEntity<CommunityReadService.Feed> hotTopics(@AuthenticationPrincipal MemberPrincipal member,
            @RequestParam MultiValueMap<String, String> params) {
        return response(community.hotTopics(member.memberId(), HotTopicsQuery.parse(params)));
    }

    @GetMapping("/api/v1/community/feed")
    public ResponseEntity<CommunityReadService.Feed> feed(@AuthenticationPrincipal MemberPrincipal member,
            @RequestParam MultiValueMap<String, String> params) {
        return response(community.feed(member.memberId(), CommunityQuery.feed(params)));
    }

    @GetMapping("/api/v1/signal-threads/{threadId}")
    public ResponseEntity<CommunityReadService.Thread> thread(@AuthenticationPrincipal MemberPrincipal member,
            @PathVariable String threadId, @RequestParam MultiValueMap<String, String> params) {
        CommunityQuery.only(params, Set.of());
        return response(community.thread(member.memberId(), CommunityQuery.id(threadId, "st-")));
    }

    @GetMapping("/api/v1/signal-threads/{threadId}/analyses")
    public ResponseEntity<CommunityReadService.Analyses> analyses(@AuthenticationPrincipal MemberPrincipal member,
            @PathVariable String threadId, @RequestParam MultiValueMap<String, String> params) {
        return response(community.analyses(member.memberId(), CommunityQuery.analyses(CommunityQuery.id(threadId, "st-"), params)));
    }

    @GetMapping("/api/v1/public-analyses/{analysisId}")
    public ResponseEntity<CommunityReadService.PublicAnalysis> analysis(@AuthenticationPrincipal MemberPrincipal member,
            @PathVariable String analysisId, @RequestParam MultiValueMap<String, String> params) {
        CommunityQuery.only(params, Set.of("graphMode", "includeGraph"));
        String include = params.containsKey("includeGraph") ? params.getFirst("includeGraph") : "true";
        if (!Set.of("true", "false").contains(include)) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        String mode = params.containsKey("graphMode") ? params.getFirst("graphMode") : "CURRENT";
        return response(community.analysis(member.memberId(), CommunityQuery.id(analysisId, "pa-"), mode, Boolean.parseBoolean(include)));
    }

    private static <T> ResponseEntity<T> response(T body) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(body);
    }
}
