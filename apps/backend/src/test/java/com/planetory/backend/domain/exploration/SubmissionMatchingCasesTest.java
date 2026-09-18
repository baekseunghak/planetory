package com.planetory.backend.domain.exploration;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

import com.planetory.backend.domain.exploration.service.OperationRule;
import com.planetory.backend.domain.exploration.service.SubmissionMatching;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Candidate;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Derived;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Evaluation;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Match;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Observation;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.ObservedWindow;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Peak;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Rules;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Selection;
import com.planetory.backend.domain.exploration.service.SubmissionMatching.Validation;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 제출 매칭 공통 표본 대조 [S15P21C206-142].
 *
 * <p>{@code docs/api/exploration/matching-cases.v0.json}의 기대값은 참조 구현 {@code matching-v0.cjs}가 계산했다
 * (S15P21C206-128). Java 구현이 같은 입력으로 같은 검증·서버 산정·판정을 내는지 사례마다 본다. 비교할 때의
 * 반올림은 참조 구현과 같다(소수 6자리, 표시 duration은 2자리).
 */
class SubmissionMatchingCasesTest {

    private static final File CONTRACT_DIR = new File("../../docs/api/exploration");
    private static final ObjectMapper JSON = new ObjectMapper();

    /** 지속시간 비율 범위. 규칙 JSON에는 문장으로만 있고 참조 구현도 0.5·2를 쓴다. */
    private static final double DURATION_RATIO_MIN = 0.5;
    private static final double DURATION_RATIO_MAX = 2;

    @TestFactory
    List<DynamicTest> 공통_표본의_검증과_서버_산정과_매칭을_재현한다() throws IOException {
        JsonNode rulesJson = JSON.readTree(new File(CONTRACT_DIR, "matching-rules.v0.json"));
        JsonNode fixture = JSON.readTree(new File(CONTRACT_DIR, "matching-cases.v0.json"));
        assertEquals(rulesJson.get("ruleVersion").asText(), fixture.get("ruleVersion").asText());
        Rules rules = rulesOf(rulesJson);
        Map<Integer, Peak> peaks = peaksOf(fixture.get("peaks"));

        List<DynamicTest> tests = new ArrayList<>();
        for (JsonNode example : fixture.get("cases")) {
            tests.add(DynamicTest.dynamicTest(example.get("id").asText(),
                    () -> reproduce(fixture, example, rules, peaks)));
        }
        assertTrue(tests.size() >= 31, "표본 사례가 빠졌다");
        return tests;
    }

    /** V9가 넣은 초기 규칙이 표본의 규칙과 다르면 표본 대조가 운영 판정을 보증하지 못한다. */
    @Test
    void 초기_운영_규칙_rule_0은_공통_표본의_규칙과_같다() throws IOException {
        JsonNode rulesJson = JSON.readTree(new File(CONTRACT_DIR, "matching-rules.v0.json"));
        String sql;
        try (InputStream in = getClass().getResourceAsStream("/db/migration/V9__operation_rules.sql")) {
            sql = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        String seed = sql.substring(sql.indexOf("jsonb_set('") + "jsonb_set('".length(), sql.indexOf("}'::JSONB") + 1);
        JsonNode values = JSON.readTree(seed);
        JsonNode selection = values.get("selection");
        JsonNode matching = values.get("matching");
        List<Double> multipliers = new ArrayList<>();
        matching.get("harmonic_multipliers").forEach(m -> multipliers.add(m.asDouble()));
        OperationRule rule0 = new OperationRule("rule-0", null,
                new OperationRule.Selection(selection.get("phase_width_max").asDouble(),
                        selection.get("max_duration_multiple_of_suggested").asDouble(),
                        selection.get("allow_empty_phase_span").asBoolean()),
                new OperationRule.Matching(multipliers,
                        matching.get("n_transits_cap").isNull() ? null : matching.get("n_transits_cap").asInt(),
                        matching.get("duration_ratio_min").asDouble(), matching.get("duration_ratio_max").asDouble(),
                        matching.get("min_overlap_transits").asInt(), matching.get("dominance_ratio").asDouble(),
                        matching.get("min_score_gap").asDouble(), matching.get("overlap_ratio_tolerance").asDouble()),
                null, null, null, null);

        assertEquals(rulesOf(rulesJson), Rules.of(rule0, rulesJson.at("/validation/minWindowDays/value").asDouble()));
    }

    private static void reproduce(JsonNode fixture, JsonNode example, Rules rules, Map<Integer, Peak> peaks) {
        assertTrue(example.path("rulesOverride").isMissingNode() || example.get("rulesOverride").isNull(),
                "규칙을 바꾸는 사례는 아직 지원하지 않는다");
        ObjectNode bundle = fixture.get("bundle").deepCopy();
        if (example.hasNonNull("bundleOverride")) {
            bundle.setAll((ObjectNode) example.get("bundleOverride"));
        }
        Observation observation = observationOf(bundle);
        List<Candidate> candidates = candidatesOf(example.hasNonNull("candidates")
                ? example.get("candidates") : fixture.get("candidates"));
        if ("reversed".equals(example.path("candidateOrder").asText())) {
            Collections.reverse(candidates);
        }
        JsonNode selectionJson = example.get("selection");
        Selection selection = new Selection(selectionJson.get("periodDays").asDouble(),
                selectionJson.get("phaseStart").asDouble(), selectionJson.get("phaseEnd").asDouble(),
                selectionJson.hasNonNull("sourcePeakGridIndex") ? selectionJson.get("sourcePeakGridIndex").asInt() : null);
        JsonNode expected = example.get("expected");

        Validation validation = SubmissionMatching.validate(observation, rules, selection, "LIKELY_PLANET", List.of(),
                peaks);
        JsonNode expectedValidation = expected.get("validation");
        if (!expectedValidation.get("ok").asBoolean()) {
            assertFalse(validation.ok(), "검증에서 거절돼야 한다");
            assertEquals(expectedValidation.get("field").asText(), validation.rejection().field());
            assertEquals(expectedValidation.get("code").asText(), validation.rejection().reason().name());
            return;
        }
        assertTrue(validation.ok(), () -> "거절됐다: " + validation.rejection());

        Derived derived = validation.derived();
        JsonNode serverDerived = expected.get("serverDerived");
        assertEquals(serverDerived.get("phaseCenter").asDouble(), round(derived.phaseCenter()), "phaseCenter");
        assertEquals(serverDerived.get("epochBtjd").asDouble(), round(derived.epochBtjd()), "epochBtjd");
        assertEquals(serverDerived.get("durationHours").asDouble(), round(derived.durationHours()), "durationHours");
        assertEquals(serverDerived.get("durationHoursDisplay").asDouble(), display(derived.durationHours()),
                "표시 duration");
        assertEquals(nullableDouble(serverDerived.get("sourcePeakSuggestedDurationHours")),
                derived.sourcePeakSuggestedDurationHours());
        assertEquals(nullableDouble(serverDerived.get("durationLimitHours")), derived.durationLimitHours());

        Match match = SubmissionMatching.match(observation, rules, selection, derived, candidates,
                idsOf(example.get("removedCandidateIds")));
        JsonNode expectedMatch = expected.get("match");
        assertEquals(expectedMatch.get("status").asText(), match.status().value(), "status");
        assertEquals(nullableId(expectedMatch.get("candidateId")), match.candidateId(), "candidateId");
        assertEquals(nullableDouble(expectedMatch.get("harmonicMultiplier")), match.harmonicMultiplier(), "배율");
        assertEquals(nullableDouble(expectedMatch.get("correctedPeriodDays")),
                match.correctedPeriodDays() == null ? null : round(match.correctedPeriodDays()), "정정 주기");
        assertEquals(expectedMatch.get("decision").asText(), match.decision(), "decision");
        assertEquals(idsOf(expectedMatch.get("rankedCandidateIds")), match.rankedCandidateIds(), "순위");

        JsonNode dominance = expectedMatch.get("dominance");
        if (dominance.isNull()) {
            assertNull(match.dominance());
        } else {
            assertEquals(dominance.get("s1").asDouble(), round(match.dominance().s1()), "s1");
            assertEquals(dominance.get("s2").asDouble(), round(match.dominance().s2()), "s2");
            assertEquals(dominance.get("r1").asDouble(), round(match.dominance().r1()), "r1");
            assertEquals(dominance.get("r2").asDouble(), round(match.dominance().r2()), "r2");
            assertEquals(dominance.get("gapOk").asBoolean(), match.dominance().gapOk(), "gapOk");
            assertEquals(dominance.get("ratioOk").asBoolean(), match.dominance().ratioOk(), "ratioOk");
            assertEquals(dominance.get("overlapOk").asBoolean(), match.dominance().overlapOk(), "overlapOk");
            assertEquals(dominance.get("tie").asBoolean(), match.dominance().tie(), "tie");
        }

        List<Evaluation> passing = match.evaluations().stream().filter(Evaluation::pass)
                .sorted(Comparator.comparingLong(Evaluation::candidateId).thenComparingDouble(Evaluation::multiplier))
                .toList();
        JsonNode expectedPassing = expected.get("passingEvaluations");
        assertEquals(expectedPassing.size(), passing.size(), "통과 평가 수");
        for (int i = 0; i < passing.size(); i++) {
            JsonNode want = expectedPassing.get(i);
            Evaluation got = passing.get(i);
            String at = "passingEvaluations[" + i + "] ";
            assertEquals(idOf(want.get("candidateId").asText()), got.candidateId(), at + "candidateId");
            assertEquals(want.get("multiplier").asDouble(), got.multiplier(), at + "multiplier");
            assertEquals(want.get("score").asDouble(), round(got.score()), at + "score");
            assertEquals(want.get("ePeriod").asDouble(), round(got.ePeriod()), at + "ePeriod");
            assertEquals(want.get("eEpoch").asDouble(), round(got.eEpoch()), at + "eEpoch");
            assertEquals(want.get("eDuration").asDouble(), round(got.eDuration()), at + "eDuration");
            assertEquals(want.get("overlapTransits").asInt(), got.overlapTransits(), at + "overlapTransits");
            assertEquals(want.get("nTransits").asInt(), got.nTransits(), at + "nTransits");
        }
    }

    private static Rules rulesOf(JsonNode rules) {
        List<Double> multipliers = new ArrayList<>();
        rules.at("/matching/harmonicMultipliers/value").forEach(m -> multipliers.add(m.asDouble()));
        JsonNode cap = rules.at("/matching/nTransits/cap");
        return new Rules(rules.at("/validation/minWindowDays/value").asDouble(),
                rules.at("/validation/phaseWidthMax/value").asDouble(),
                rules.at("/validation/maxDurationMultipleOfSuggested/value").asDouble(),
                rules.at("/validation/allowEmptyPhaseSpan/value").asBoolean(),
                multipliers, cap.isNull() ? null : cap.asInt(), DURATION_RATIO_MIN, DURATION_RATIO_MAX,
                rules.at("/matching/conditions/overlap/minOverlapTransits").asInt(),
                rules.at("/matching/dominance/dominanceRatio/value").asDouble(),
                rules.at("/matching/dominance/minScoreGap/value").asDouble(),
                rules.at("/matching/dominance/overlapRatioTolerance/value").asDouble());
    }

    private static Observation observationOf(JsonNode bundle) {
        double cadence = bundle.get("cadenceDays").asDouble();
        List<ObservedWindow> windows = new ArrayList<>();
        bundle.get("observedWindows").forEach(w -> windows.add(
                new ObservedWindow(w.get(0).asDouble(), w.get(1).asDouble(), cadence)));
        return new Observation(bundle.get("foldReferenceTimeBtjd").asDouble(),
                bundle.get("observationBounds").get(0).asDouble(), bundle.get("observationBounds").get(1).asDouble(),
                windows, bundle.at("/periodGrid/periodMinDays").asDouble(),
                bundle.at("/periodGrid/periodMaxDays").asDouble());
    }

    private static Map<Integer, Peak> peaksOf(JsonNode peaks) {
        Map<Integer, Peak> byIndex = new HashMap<>();
        peaks.forEach(p -> byIndex.put(p.get("gridIndex").asInt(), new Peak(p.get("gridIndex").asInt(),
                p.at("/fineTune/periodMinDays").asDouble(), p.at("/fineTune/periodMaxDays").asDouble(),
                p.get("suggestedDurationHours").asDouble())));
        return byIndex;
    }

    private static List<Candidate> candidatesOf(JsonNode candidates) {
        List<Candidate> list = new ArrayList<>();
        candidates.forEach(c -> list.add(new Candidate(idOf(c.get("id").asText()), c.get("periodDays").asDouble(),
                c.get("epochBtjd").asDouble(), c.get("durationHours").asDouble())));
        return list;
    }

    private static List<Long> idsOf(JsonNode ids) {
        List<Long> list = new ArrayList<>();
        if (ids != null && !ids.isNull()) {
            ids.forEach(id -> list.add(idOf(id.asText())));
        }
        return list;
    }

    private static long idOf(String id) {
        return Long.parseLong(id.substring(2));
    }

    private static Long nullableId(JsonNode node) {
        return node == null || node.isNull() ? null : idOf(node.asText());
    }

    private static Double nullableDouble(JsonNode node) {
        return node == null || node.isNull() ? null : node.asDouble();
    }

    /** 참조 구현의 {@code Math.round(x × 10⁶) / 10⁶}. */
    private static double round(double value) {
        return Math.round(value * 1e6) / 1e6;
    }

    /** 참조 구현의 {@code Number(x.toFixed(2))}. toFixed는 double의 정확한 값을 반올림하고 동률이면 큰 쪽이다. */
    private static double display(double hours) {
        return new BigDecimal(hours).setScale(2, RoundingMode.HALF_UP).doubleValue();
    }
}
