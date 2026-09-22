package com.planetory.backend.domain.statistics.controller;

import com.planetory.backend.domain.statistics.service.PersonalStatisticsService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
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
public class PersonalStatisticsController {
    private final PersonalStatisticsService statistics;

    @GetMapping("/api/v1/me/statistics")
    public ResponseEntity<PersonalStatisticsService.Response> read(@AuthenticationPrincipal MemberPrincipal principal,
            @RequestParam Map<String,String> parameters) {
        if(!parameters.isEmpty()) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(statistics.read(principal.memberId()));
    }
}
