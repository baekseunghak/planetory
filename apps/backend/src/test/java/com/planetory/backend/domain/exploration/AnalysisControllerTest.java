package com.planetory.backend.domain.exploration;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.method.annotation.AuthenticationPrincipalArgumentResolver;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import com.planetory.backend.domain.exploration.controller.AnalysisController;
import com.planetory.backend.domain.exploration.service.AnalysisService;
import com.planetory.backend.domain.exploration.service.AnalysisViews.AnalysisContext;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Answer;
import com.planetory.backend.domain.exploration.service.AnalysisViews.BundleSummary;
import com.planetory.backend.domain.exploration.service.AnalysisViews.CurrentCurveContext;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Curve;
import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveContext;
import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveQuery;
import com.planetory.backend.domain.exploration.service.AnalysisViews.FineTune;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Periodogram;
import com.planetory.backend.domain.exploration.service.AnalysisViews.ProgressSummary;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Residual;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Segment;
import com.planetory.backend.domain.exploration.service.AnalysisViews.SelectionRules;
import com.planetory.backend.domain.exploration.service.AnalysisViews.StarSummary;
import com.planetory.backend.domain.exploration.service.AnalysisViews.TutorialState;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.error.GlobalExceptionHandler;
import com.planetory.backend.global.security.MemberPrincipal;

import static org.hamcrest.Matchers.containsString;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 분석 진입·곡선·주기도의 HTTP 표현 [S15P21C206-140]. 상태 코드·헤더·JSON 모양만 본다. 조회 규칙은
 * {@link AnalysisDataTest}가 본다.
 *
 * <p>컨트롤러만 띄운다. {@code @WebMvcTest} 슬라이스에는 Spring Security가 올라오지 않아
 * {@code @AuthenticationPrincipal} 해석기가 없고, 회원이 null로 들어온다. 해석기와 전역 예외 변환을 직접
 * 등록하고 테스트 스레드의 보안 문맥에 회원을 넣는다. 로그인 절차 자체는 AuthIntegrationTest가 본다.
 */
class AnalysisControllerTest {

    private final AnalysisService analysis = mock(AnalysisService.class);
    private MockMvc mockMvc;

    private static final CurveContext STEP_1 =
            new CurveContext("b-2", 1, List.of("c-401"), "rm-1", "pg-1");

    @BeforeEach
    void setUp() {
        SecurityContextHolder.getContext().setAuthentication(
                new TestingAuthenticationToken(new MemberPrincipal(7L), null, "ROLE_USER"));
        mockMvc = MockMvcBuilders.standaloneSetup(new AnalysisController(analysis))
                .setCustomArgumentResolvers(new AuthenticationPrincipalArgumentResolver())
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void 분석_진입은_200과_현재_판_헤더로_나가고_복귀_안내는_있을_때만_싣는다() throws Exception {
        when(analysis.context(anyLong(), anyLong())).thenReturn(new Answer<>(analysisContext(null), true, "b-2"));

        mockMvc.perform(get("/api/v1/stars/123456789/analysis-context"))
                .andExpect(status().isOk())
                .andExpect(header().string(AnalysisController.CURRENT_BUNDLE_HEADER, "b-2"))
                .andExpect(jsonPath("$.bundle.observationBounds[1]").value(2570.12))
                // revision은 섹터마다 달라 판이 아니라 곡선의 세그먼트에 싣는다(Gold 계약 4.1).
                .andExpect(jsonPath("$.bundle.binningRevision").doesNotExist())
                .andExpect(jsonPath("$.selectionRules.version").value("rule-3"))
                .andExpect(jsonPath("$.selectionRules.fineTune.halfWidthCells").value(3))
                .andExpect(jsonPath("$.currentCurveContext.removedCandidateIds[0]").value("c-401"))
                .andExpect(jsonPath("$.currentCurveContext.notice").doesNotExist())
                // 값이 없어도 필드는 남긴다. 빠지면 "없음"과 "모름"을 구분할 수 없다.
                .andExpect(content().string(containsString("\"completionReason\":null")))
                .andExpect(content().string(containsString("\"grade\":null")))
                .andExpect(content().string(containsString("\"nextCurveContext\":null")))
                .andExpect(content().string(containsString("\"tutorial\":{\"seq\":null,\"skipAvailable\":false}")));

        when(analysis.context(anyLong(), anyLong())).thenReturn(
                new Answer<>(analysisContext(CurrentCurveContext.STEP_NOT_RESTORABLE), true, "b-2"));
        mockMvc.perform(get("/api/v1/stars/123456789/analysis-context"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.currentCurveContext.notice").value("STEP_NOT_RESTORABLE"));
    }

    private static AnalysisContext analysisContext(String notice) {
        return new AnalysisContext("123456789", new StarSummary(3, List.of(14, 41, 54), 9.8), true,
                new BundleSummary("b-2", "v7", null, 1683.4231, new BigDecimal("81.4"),
                        new double[] {1683.35, 2570.12}, "rm-1", "pg-1", "one_candidate_per_step"),
                new SelectionRules("rule-3", 0.0139, 0.25, 3, false, new FineTune(3)),
                new ProgressSummary("in_progress", 1, List.of("c-401"), null, false, 0, null),
                new CurrentCurveContext("b-2", 1, List.of("c-401"), "rm-1", "pg-1", notice),
                new Residual("COMPLETED", null, null), null, null,
                new TutorialState(null, false), "rule-3");
    }

    @Test
    void 준비된_곡선은_200과_현재_판_헤더로_나간다() throws Exception {
        Segment segment = new Segment("seg-1", 14, "10m-v1", 1683.35, new BigDecimal("10"), 4,
                new Float[] {1.0001f, 0.9998f, null, 1.0003f}, new BigDecimal("0.0012"), List.of(new int[] {2, 2}));
        Curve curve = new Curve("123456789", "b-2", 1683.4231,
                new CurveContext("b-2", 0, List.of(), "rm-1", "pg-1"),
                new Residual("COMPLETED", null, null), "normalized", List.of(segment));
        when(analysis.curve(anyLong(), anyLong(), any())).thenReturn(new Answer<>(curve, true, "b-2"));

        mockMvc.perform(get("/api/v1/stars/123456789/curves?bundleId=b-2&curveStep=0"))
                .andExpect(status().isOk())
                .andExpect(header().string(AnalysisController.CURRENT_BUNDLE_HEADER, "b-2"))
                .andExpect(jsonPath("$.segments[0].binningRevision").value("10m-v1"))
                .andExpect(jsonPath("$.segments[0].gaps[0][0]").value(2))
                .andExpect(jsonPath("$.segments[0].gaps[0][1]").value(2))
                .andExpect(jsonPath("$.segments[0].binMinutes").value(10))
                .andExpect(jsonPath("$.residual.computedAt").doesNotExist())
                // 결측과 미계산은 null로 남아야 한다. 필드가 빠지면 프론트가 둘을 구분할 수 없다.
                .andExpect(content().string(containsString("\"flux\":[1.0001,0.9998,null,1.0003]")))
                .andExpect(content().string(containsString("\"residual\":{\"status\":\"COMPLETED\",\"jobId\":null}")));
    }

    @Test
    void 준비되지_않은_잔차는_202와_빈_배열로_나간다() throws Exception {
        Curve curve = new Curve("123456789", "b-2", 1683.4231, STEP_1,
                new Residual(null, null, null), "normalized", null);
        when(analysis.curve(anyLong(), anyLong(), any())).thenReturn(new Answer<>(curve, false, "b-2"));
        Periodogram periodogram = new Periodogram("b-2", STEP_1, new Residual(null, null, null),
                new BigDecimal("0.5"), new BigDecimal("46.0"), 5000, "log", new BigDecimal("40.7"), null);
        when(analysis.periodogram(anyLong(), anyLong(), any())).thenReturn(new Answer<>(periodogram, false, "b-2"));

        mockMvc.perform(get("/api/v1/stars/1/curves?bundleId=b-2&curveStep=1&removed=c-401"))
                .andExpect(status().isAccepted())
                .andExpect(header().string(AnalysisController.CURRENT_BUNDLE_HEADER, "b-2"))
                .andExpect(content().string(containsString("\"residual\":{\"status\":null,\"jobId\":null}")))
                .andExpect(content().string(containsString("\"segments\":null")));
        mockMvc.perform(get("/api/v1/stars/1/periodogram?bundleId=b-2&curveStep=1&removed=c-401"))
                .andExpect(status().isAccepted())
                .andExpect(header().string(AnalysisController.CURRENT_BUNDLE_HEADER, "b-2"))
                .andExpect(jsonPath("$.nPeriods").value(5000))
                .andExpect(content().string(containsString("\"power\":null")));
    }

    @Test
    void 판이_바뀌면_409와_현재_판_ID를_본문에_싣는다() throws Exception {
        when(analysis.curve(anyLong(), anyLong(), any())).thenThrow(
                new BusinessException(ErrorCode.BUNDLE_CHANGED, Map.of("currentBundleId", "b-3")));

        mockMvc.perform(get("/api/v1/stars/1/curves?bundleId=b-2&curveStep=0"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("BUNDLE_CHANGED"))
                .andExpect(jsonPath("$.currentBundleId").value("b-3"))
                .andExpect(jsonPath("$.details").doesNotExist());
    }

    /** 추가 필드가 없는 오류는 기존 모양 그대로다. */
    /**
     * 숫자가 아닌 TIC.
     *
     * <p>경로 변수를 {@code long}으로 받으면 {@code MethodArgumentTypeMismatchException}이 나는데
     * 이 예외는 {@code ErrorResponse}를 구현하지 않아 전역 처리기에서 500이 된다. 문자열로 받아
     * 없는 별과 같은 응답으로 덮는지 세 경로 모두 본다.
     */
    @Test
    void 숫자가_아닌_TIC은_없는_별과_같은_404로_덮는다() throws Exception {
        for (String path : List.of("/api/v1/stars/abc/analysis-context",
                "/api/v1/stars/abc/curves?bundleId=b-2&curveStep=0",
                "/api/v1/stars/abc/periodogram?bundleId=b-2&curveStep=0",
                "/api/v1/stars/01/curves?bundleId=b-2&curveStep=0",
                "/api/v1/stars/-1/curves?bundleId=b-2&curveStep=0")) {
            mockMvc.perform(get(path))
                    .andExpect(status().isNotFound())
                    .andExpect(jsonPath("$.code").value("STAR_NOT_PUBLISHED"));
        }
        verifyNoInteractions(analysis);
    }

    @Test
    void 추가_필드가_없는_오류는_코드와_메시지만_나간다() throws Exception {
        when(analysis.periodogram(anyLong(), anyLong(), any())).thenThrow(new BusinessException(ErrorCode.STAR_LOCKED));

        mockMvc.perform(get("/api/v1/stars/1/periodogram?bundleId=b-2&curveStep=0"))
                .andExpect(status().isForbidden())
                .andExpect(content().json("{\"code\":\"STAR_LOCKED\",\"message\":\"아직 발견하지 않은 별입니다.\"}", true));
    }

    @Test
    void removed는_쉼표로_잇거나_반복해도_같게_받는다() throws Exception {
        Curve curve = new Curve("1", "b-2", 1.0, STEP_1, new Residual(null, null, null), "normalized", null);
        when(analysis.curve(anyLong(), anyLong(), any())).thenReturn(new Answer<>(curve, false, "b-2"));

        mockMvc.perform(get("/api/v1/stars/1/curves?bundleId=b-2&curveStep=2&removed=c-9,c-10"));
        mockMvc.perform(get("/api/v1/stars/1/curves?bundleId=b-2&curveStep=2&removed=c-9&removed=c-10"));

        ArgumentCaptor<CurveQuery> captor = ArgumentCaptor.forClass(CurveQuery.class);
        verify(analysis, times(2)).curve(eq(7L), eq(1L), captor.capture());
        assertEquals(List.of("c-9", "c-10"), captor.getAllValues().get(0).removed());
        assertEquals(List.of("c-9", "c-10"), captor.getAllValues().get(1).removed());
        assertEquals("2", captor.getAllValues().get(0).curveStep());
    }
}
