package com.planetory.backend.domain.exploration;

import java.time.OffsetDateTime;
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

import com.planetory.backend.domain.exploration.controller.ResidualJobController;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Answer;
import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveContext;
import com.planetory.backend.domain.exploration.service.ResidualJobService;
import com.planetory.backend.domain.exploration.service.ResidualJobStore;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.JobAccepted;
import com.planetory.backend.domain.exploration.service.ResidualJobViews.JobStatus;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.error.GlobalExceptionHandler;
import com.planetory.backend.global.security.MemberPrincipal;

import static org.hamcrest.Matchers.containsString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 잔차 작업 API의 HTTP 표현 (탐사 API 7.1·7.2절) [S15P21C206-147].
 *
 * <p>상태 코드와 JSON 모양만 본다. 요청 규칙은 {@code ResidualJobTest}가 본다.
 */
class ResidualJobControllerTest {

    private static final String BODY = """
            {"target": {"bundleId": "b-2", "removedCandidateIds": ["c-401"],
                        "residualModelVersion": "rm-1", "periodogramConfigVersion": "pg-1"}}
            """;
    private static final CurveContext TARGET =
            new CurveContext("b-2", 1, List.of("c-401"), "rm-1", "pg-1");

    private final ResidualJobService jobs = mock(ResidualJobService.class);
    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        SecurityContextHolder.getContext().setAuthentication(
                new TestingAuthenticationToken(new MemberPrincipal(7L), null, "ROLE_USER"));
        mockMvc = MockMvcBuilders.standaloneSetup(new ResidualJobController(jobs))
                .setCustomArgumentResolvers(new AuthenticationPrincipalArgumentResolver())
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void 새_작업은_202이고_캐시는_200이다() throws Exception {
        when(jobs.request(anyLong(), anyLong(), any())).thenReturn(new Answer<>(
                new JobAccepted("rj-78", ResidualJobStore.QUEUED, false, null, 3, null, 2), false, "b-2"));

        mockMvc.perform(post("/api/v1/stars/123456789/residual-jobs")
                        .contentType("application/json").content(BODY))
                .andExpect(status().isAccepted())
                // D-5. 폴링 중에 판이 바뀌는 것을 화면이 추가 요청 없이 본다.
                .andExpect(header().string("X-Current-Bundle", "b-2"))
                .andExpect(jsonPath("$.jobId").value("rj-78"))
                .andExpect(jsonPath("$.status").value("QUEUED"))
                .andExpect(jsonPath("$.cacheHit").value(false))
                .andExpect(jsonPath("$.queuePosition").value(3))
                .andExpect(jsonPath("$.pollAfterSeconds").value(2))
                // 값이 없어도 필드는 남긴다. 빠지면 "없음"과 "모름"을 구분할 수 없다.
                .andExpect(content().string(containsString("\"estimatedSeconds\":null")));

        when(jobs.request(anyLong(), anyLong(), any())).thenReturn(new Answer<>(
                new JobAccepted(null, ResidualJobStore.COMPLETED, true, TARGET, null, null, null), true, "b-2"));

        mockMvc.perform(post("/api/v1/stars/123456789/residual-jobs")
                        .contentType("application/json").content(BODY))
                .andExpect(status().isOk())
                .andExpect(header().string("X-Current-Bundle", "b-2"))
                .andExpect(jsonPath("$.cacheHit").value(true))
                .andExpect(jsonPath("$.resultCurveContext.curveStep").value(1))
                .andExpect(content().string(containsString("\"jobId\":null")));
    }

    @Test
    void 대기열이_차면_429에_대기_시간과_돌고_있는_작업이_실린다() throws Exception {
        when(jobs.request(anyLong(), anyLong(), any())).thenThrow(new BusinessException(
                ErrorCode.RESIDUAL_QUEUE_FULL, Map.of("retryAfterSeconds", 12, "activeJobId", "rj-70")));

        mockMvc.perform(post("/api/v1/stars/123456789/residual-jobs")
                        .contentType("application/json").content(BODY))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.code").value("RESIDUAL_QUEUE_FULL"))
                .andExpect(jsonPath("$.retryAfterSeconds").value(12))
                .andExpect(jsonPath("$.activeJobId").value("rj-70"));
    }

    @Test
    void 상태_조회는_단계와_시각을_주고_없는_작업은_404다() throws Exception {
        OffsetDateTime at = OffsetDateTime.parse("2026-09-20T02:30:15Z");
        when(jobs.status(anyLong(), anyString())).thenReturn(new Answer<>(new JobStatus("rj-78", "123456789",
                TARGET, ResidualJobStore.PERIODOGRAM_CALCULATING, 1,
                new ResidualJobStore.Timeline(at, at, at, at, null), null, null, 0, 2), true, "b-9"));

        mockMvc.perform(get("/api/v1/residual-jobs/rj-78"))
                .andExpect(status().isOk())
                // 조회는 판을 보지 않아 409를 내지 않는다. 폴링이 판 교체를 보는 곳은 이 헤더뿐이다.
                .andExpect(header().string("X-Current-Bundle", "b-9"))
                .andExpect(jsonPath("$.queuePosition").value(0))
                .andExpect(jsonPath("$.jobId").value("rj-78"))
                .andExpect(jsonPath("$.ticId").value("123456789"))
                .andExpect(jsonPath("$.status").value("PERIODOGRAM_CALCULATING"))
                .andExpect(jsonPath("$.attempt").value(1))
                .andExpect(jsonPath("$.timeline.queuedAt").value("2026-09-20T02:30:15Z"))
                .andExpect(content().string(containsString("\"completedAt\":null")))
                .andExpect(content().string(containsString("\"failure\":null")))
                .andExpect(content().string(containsString("\"resultCurveContext\":null")));

        when(jobs.status(anyLong(), anyString()))
                .thenThrow(new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));

        mockMvc.perform(get("/api/v1/residual-jobs/rj-99"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("RESOURCE_NOT_FOUND"));
    }

    /** 형식이 다른 TIC은 발견하지 않은 별과 같은 응답으로 덮는다. 500이 되지 않는다. */
    @Test
    void 형식이_다른_TIC은_403이다() throws Exception {
        mockMvc.perform(post("/api/v1/stars/abc/residual-jobs")
                        .contentType("application/json").content(BODY))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("STAR_LOCKED"));
    }
}
