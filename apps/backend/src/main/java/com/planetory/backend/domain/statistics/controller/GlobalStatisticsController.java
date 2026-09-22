package com.planetory.backend.domain.statistics.controller;

import com.planetory.backend.domain.statistics.service.GlobalStatisticsService;
import com.planetory.backend.domain.post.service.CommunityQuery;
import com.planetory.backend.global.security.MemberPrincipal;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
public class GlobalStatisticsController {
    private final GlobalStatisticsService statistics;

    @GetMapping("/api/v1/statistics")
    public ResponseEntity<GlobalStatisticsService.Statistics> read(@AuthenticationPrincipal MemberPrincipal member,
            @RequestParam MultiValueMap<String,String> params) {
        CommunityQuery.only(params,Set.of());
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(statistics.read(member.memberId()));
    }
}
