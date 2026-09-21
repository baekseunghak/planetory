package com.planetory.backend.domain.post.controller;

import com.planetory.backend.domain.post.service.SourceLinkService;
import com.planetory.backend.global.security.MemberPrincipal;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
public class SourceCardController {
    private final SourceLinkService sources;

    @GetMapping("/api/v1/source-cards")
    public ResponseEntity<Map<String, Object>> preview(@AuthenticationPrincipal MemberPrincipal principal,
            @RequestParam String type, @RequestParam String id, @RequestParam String ticId) {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(sources.preview(principal.memberId(), type, id, ticId));
    }
}
