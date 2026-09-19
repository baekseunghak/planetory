package com.planetory.backend.domain.exploration;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.method.annotation.AuthenticationPrincipalArgumentResolver;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import com.planetory.backend.domain.exploration.controller.AchievementController;
import com.planetory.backend.domain.exploration.service.AchievementService;
import com.planetory.backend.domain.exploration.service.AchievementViews.AchievementItem;
import com.planetory.backend.domain.exploration.service.AchievementViews.AchievementList;
import com.planetory.backend.domain.exploration.service.AchievementViews.Relabel;
import com.planetory.backend.domain.exploration.service.AchievementViews.UnlockedStar;
import com.planetory.backend.domain.exploration.service.ExplorationSummaryService.AchievementSummary;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.error.GlobalExceptionHandler;
import com.planetory.backend.global.security.MemberPrincipal;

import static org.hamcrest.Matchers.containsString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 성과 조회의 HTTP 표현 [S15P21C206-144]. 상태 코드와 JSON 모양만 본다. 조회 규칙은
 * {@code AchievementServiceTest}가 본다.
 *
 * <p>{@link AnalysisControllerTest}와 같은 이유로 컨트롤러만 띄우고 인증 해석기와 전역 예외 변환을 직접
 * 등록한다.
 */
class AchievementControllerTest {

    private final AchievementService achievements = mock(AchievementService.class);
    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        SecurityContextHolder.getContext().setAuthentication(
                new TestingAuthenticationToken(new MemberPrincipal(7L), null, "ROLE_USER"));
        mockMvc = MockMvcBuilders.standaloneSetup(new AchievementController(achievements))
                .setCustomArgumentResolvers(new AuthenticationPrincipalArgumentResolver())
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void 성과_조회는_명세_9_1절_모양으로_나가고_없는_값도_필드를_남긴다() throws Exception {
        when(achievements.list(anyLong(), any(), any(), any())).thenReturn(sample());

        mockMvc.perform(get("/api/v1/me/achievements"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.summary.discoveredStarCount").value(57))
                .andExpect(jsonPath("$.summary.startedStarCount").value(12))
                .andExpect(jsonPath("$.summary.completedStarCount").value(5))
                .andExpect(jsonPath("$.summary.recognizedTotal").value(9))
                .andExpect(jsonPath("$.summary.byType.fp").value(1))
                .andExpect(jsonPath("$.summary.gradeDistribution.SSS").value(0))
                .andExpect(jsonPath("$.items[0].achievementId").value("ach-31"))
                .andExpect(jsonPath("$.items[0].ticId").value("123456789"))
                .andExpect(jsonPath("$.items[0].candidateId").value("c-401"))
                .andExpect(jsonPath("$.items[0].type").value("confirmed"))
                .andExpect(jsonPath("$.items[0].recognizedSubmissionId").value("sub-6990"))
                .andExpect(jsonPath("$.items[0].recognizedAt").value("2026-09-10T02:30:15Z"))
                .andExpect(jsonPath("$.items[0].unlockedStars[0].ticId").value("123456790"))
                .andExpect(jsonPath("$.items[1].recognizedAnalysisId").value("pa-601"))
                .andExpect(jsonPath("$.items[1].relabel.newDisposition").value("UNCONFIRMED"))
                .andExpect(jsonPath("$.hasNext").value(false))
                // 값이 없어도 필드는 남긴다. 빠지면 "없음"과 "모름"을 구분할 수 없다.
                .andExpect(content().string(containsString("\"recognizedAnalysisId\":null")))
                .andExpect(content().string(containsString("\"relabel\":null")))
                .andExpect(content().string(containsString("\"nextCursor\":null")));
    }

    @Test
    void 조회_조건은_검사하지_않고_그대로_서비스에_넘긴다() throws Exception {
        when(achievements.list(anyLong(), any(), any(), any())).thenReturn(sample());

        mockMvc.perform(get("/api/v1/me/achievements?ticId=123456789&size=2&cursor=abc"))
                .andExpect(status().isOk());

        verify(achievements).list(7L, "123456789", "2", "abc");
    }

    @Test
    void 계약_밖_조건은_400_VALIDATION_FAILED다() throws Exception {
        when(achievements.list(anyLong(), any(), any(), any()))
                .thenThrow(new BusinessException(ErrorCode.VALIDATION_FAILED));

        mockMvc.perform(get("/api/v1/me/achievements?size=abc"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
    }

    private static AchievementList sample() {
        Map<String, Long> byType = new LinkedHashMap<>();
        byType.put("confirmed", 5L);
        byType.put("unconfirmed", 3L);
        byType.put("fp", 1L);
        Map<String, Long> grades = new LinkedHashMap<>();
        grades.put("A", 3L);
        grades.put("S", 1L);
        grades.put("SS", 1L);
        grades.put("SSS", 0L);
        OffsetDateTime at = OffsetDateTime.parse("2026-09-10T02:30:15Z");
        return new AchievementList(new AchievementSummary(57, 12, 5, 9, byType, grades), List.of(
                new AchievementItem("ach-31", "123456789", "c-401", "confirmed", "sub-6990", null, at, null,
                        List.of(new UnlockedStar("123456790"))),
                new AchievementItem("ach-30", "123456789", "c-402", "unconfirmed", "sub-6980", "pa-601", at,
                        new Relabel(at, "UNCONFIRMED"), List.of())),
                null, false);
    }
}
