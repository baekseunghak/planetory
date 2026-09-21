package com.planetory.backend.domain.exploration.controller;

import com.planetory.backend.domain.exploration.service.QuestService;
import com.planetory.backend.domain.exploration.service.QuestViews.CurrentChallenge;
import com.planetory.backend.domain.exploration.service.QuestViews.Quests;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** 퀘스트 패널(탐사 API 4.3)·현재 챌린지(서비스 API 11장) [S15P21C206-139, S15P21C206-168]. */
@RestController
@RequiredArgsConstructor
public class QuestController {

    private final QuestService quests;

    @Operation(summary = "현재 챌린지", description = "운영 active 회차와 튜토리얼 완료 자격·별 단위 참여자 수. 조회는 별을 열지 않는다.")
    @GetMapping("/api/v1/challenges/current")
    public CurrentChallenge currentChallenge(@AuthenticationPrincipal MemberPrincipal principal) {
        return quests.currentChallenge(principal.memberId());
    }

    @Operation(summary = "퀘스트 패널",
            description = "튜토리얼 다섯 칸·진행 중 챌린지·다시 열린 별. 홈 진입과 별 상태 변경 후 조회한다."
                    + " 조회는 별을 열지 않는다.")
    @GetMapping("/api/v1/me/quests")
    public Quests quests(@AuthenticationPrincipal MemberPrincipal principal) {
        return quests.quests(principal.memberId());
    }
}
