package com.planetory.backend.domain.exploration;

import com.planetory.backend.domain.exploration.controller.StarController;
import com.planetory.backend.domain.exploration.service.NasaPlanetExplanation;
import com.planetory.backend.domain.exploration.service.NasaPlanetExplanationService;
import com.planetory.backend.domain.exploration.service.NasaPlanetInfo;
import com.planetory.backend.domain.exploration.service.StarPlanetExplanationService;
import com.planetory.backend.domain.exploration.service.StarResultService;
import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.domain.exploration.service.StarViews;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.error.GlobalExceptionHandler;
import com.planetory.backend.global.security.MemberPrincipal;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.web.method.annotation.AuthenticationPrincipalArgumentResolver;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.hamcrest.Matchers.nullValue;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 별 목록의 후보만 설명하고 후보별 실패를 격리하는 공개 응답 [S15P21C206-267]. */
class StarPlanetExplanationHttpTest {

    private static final OffsetDateTime NOW = OffsetDateTime.parse("2026-09-25T00:00:00Z");
    private final StarService stars = mock(StarService.class);
    private final NasaPlanetExplanationService explanations = mock(NasaPlanetExplanationService.class);
    private MockMvc mvc;

    @BeforeEach
    void setUp() {
        SecurityContextHolder.getContext().setAuthentication(
                new TestingAuthenticationToken(new MemberPrincipal(7L), null, "ROLE_USER"));
        mvc = MockMvcBuilders.standaloneSetup(new StarController(stars, mock(StarResultService.class),
                        new StarPlanetExplanationService(stars, explanations)))
                .setCustomArgumentResolvers(new AuthenticationPrincipalArgumentResolver())
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void 별_목록_순서대로_설명을_주고_한_후보의_자격상실_뒤에도_계속한다() throws Exception {
        when(stars.detail(7L, 123L)).thenReturn(detail(List.of(
                item(401, "confirmed"), item(402, "confirmed"),
                item(403, "unconfirmed"), item(404, "confirmed"))));
        var raw = new NasaPlanetInfo.Planet("ps", "<script>raw name</script>", "raw host",
                "TIC 123", "Published Confirmed", false,
                new NasaPlanetInfo.Measurement(new BigDecimal("9"), new BigDecimal("0.1"),
                        new BigDecimal("-0.2"), 0, "days", null), null, null,
                "Transit", 2020, "<a href='raw'>raw reference</a>");
        var source = new NasaPlanetInfo.Lookup("ready", raw, NOW, NOW, "a".repeat(64), "ok", (short) 1);
        var content = new NasaPlanetExplanation.Content("이 행성은 TOI-700 b입니다.",
                "공전주기는 9일입니다.", "반지름은 지구의 1.2배입니다.",
                "질량 값은 없습니다.", "별빛이 어두워지는 현상으로 발견됐습니다.");
        when(explanations.lookup(7L, 401L)).thenReturn(new NasaPlanetExplanation.Lookup(
                "ready", source, content, NOW, "gpt-5.4-mini", "nasa-ko-v3", null, null));
        when(explanations.lookup(7L, 402L))
                .thenThrow(new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        when(explanations.lookup(7L, 404L)).thenReturn(new NasaPlanetExplanation.Lookup(
                "source_unavailable", new NasaPlanetInfo.Lookup("not_found", null, null, null,
                        null, "not_found", null), content, null, "gpt-5.4-mini", "nasa-ko-v3",
                null, "not_found"));

        String json = mvc.perform(get("/api/v1/me/stars/123/planet-explanations"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ticId").value("123"))
                .andExpect(jsonPath("$.version").value("map-v7"))
                .andExpect(jsonPath("$.items.length()").value(4))
                .andExpect(jsonPath("$.items[0].candidateId").value("c-401"))
                .andExpect(jsonPath("$.items[0].status").value("ready"))
                .andExpect(jsonPath("$.items[0].content.name").value(content.name()))
                .andExpect(jsonPath("$.items[0].fetchedAt").exists())
                .andExpect(jsonPath("$.items[1].candidateId").value("c-402"))
                .andExpect(jsonPath("$.items[1].status").value("source_unavailable"))
                .andExpect(jsonPath("$.items[1].sourceStatus").value("not_eligible"))
                .andExpect(jsonPath("$.items[1].content").value(nullValue()))
                .andExpect(jsonPath("$.items[2].candidateId").value("c-403"))
                .andExpect(jsonPath("$.items[2].status").value("not_applicable"))
                .andExpect(jsonPath("$.items[2].sourceStatus").value(nullValue()))
                .andExpect(jsonPath("$.items[3].candidateId").value("c-404"))
                .andExpect(jsonPath("$.items[3].status").value("source_unavailable"))
                .andExpect(jsonPath("$.items[3].sourceStatus").value("not_found"))
                .andExpect(jsonPath("$.items[3].content").value(nullValue()))
                .andExpect(jsonPath("$.count").doesNotExist())
                .andReturn().getResponse().getContentAsString();

        assertFalse(json.contains("raw name"));
        assertFalse(json.contains("raw reference"));
        assertFalse(json.contains("sourceHash"));
        assertFalse(json.contains("gpt-5.4-mini"));
        assertFalse(json.contains("errorPlus"));
        assertFalse(json.contains("errorMinus"));
        assertFalse(json.contains("+0.1"));
        assertFalse(json.contains("-0.2"));
        verify(explanations).lookup(7L, 401L);
        verify(explanations).lookup(7L, 402L);
        verify(explanations, never()).lookup(7L, 403L);
        verify(explanations).lookup(7L, 404L);
    }

    @Test
    void 미발견과_잘못된_TIC은_같은_STAR_LOCKED다() throws Exception {
        when(stars.detail(7L, 999L)).thenThrow(new BusinessException(ErrorCode.STAR_LOCKED));
        for (String tic : List.of("999", "abc", "0", "01")) {
            mvc.perform(get("/api/v1/me/stars/" + tic + "/planet-explanations"))
                    .andExpect(status().isForbidden())
                    .andExpect(jsonPath("$.code").value("STAR_LOCKED"));
        }
        verifyNoInteractions(explanations);
    }

    private static StarViews.PlanetItem item(long candidate, String kind) {
        return new StarViews.PlanetItem("c-" + candidate, kind, 9.0, 1000);
    }

    private static StarViews.StarDetail detail(List<StarViews.PlanetItem> items) {
        return new StarViews.StarDetail("123", NOW, null, null, null,
                new StarViews.Planets(items.size(), false, items), null, null, null,
                "map-v7", null);
    }
}
