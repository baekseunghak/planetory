package com.planetory.backend.domain.exploration.service;

import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.error.ErrorResponse.FieldError;
import tools.jackson.core.JsonParser;
import tools.jackson.core.JsonToken;
import tools.jackson.databind.DeserializationContext;
import tools.jackson.databind.annotation.JsonDeserialize;
import tools.jackson.databind.deser.std.StdDeserializer;

/** 6.1절 원본 입력. 서버 파생값을 포함한 알려지지 않은 필드는 저장·해시에 쓰지 않는다. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record SubmissionRequest(String requestId, String submissionKind, Context curveContext,
                                Selection selection, String userJudgment, List<String> evidenceChecks,
                                String memo, ViewState viewState, String retryOfSubmissionId) {
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Context(String bundleId, @JsonDeserialize(using = IntegerInput.class) Integer curveStep, List<String> removedCandidateIds,
                          String residualModelVersion, String periodogramConfigVersion) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Selection(Double periodDays, @JsonDeserialize(using = IntegerInput.class) Integer sourcePeakGridIndex, Double phaseStart, Double phaseEnd) {
        SubmissionMatching.Selection matching() {
            return new SubmissionMatching.Selection(periodDays, phaseStart, phaseEnd, sourcePeakGridIndex);
        }
    }
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ViewState(Viewport periodogramViewport, Double foldedXZoomRatio) {}
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Viewport(Double minDays, Double maxDays) {}

    /** JSON 소수를 정수로 잘라 곡선 단계나 봉우리 번호로 받아들이지 않는다. */
    public static final class IntegerInput extends StdDeserializer<Integer> {
        public IntegerInput() { super(Integer.class); }
        @Override public Integer deserialize(JsonParser parser, DeserializationContext context) {
            if (!parser.hasToken(JsonToken.VALUE_NUMBER_INT)) return context.reportInputMismatch(Integer.class, "정수 JSON 값이 필요합니다.");
            return parser.getIntValue();
        }
    }

    public SubmissionRequest normalized() {
        UUID uuid;
        try { uuid = UUID.fromString(requestId); }
        catch (RuntimeException e) { throw invalid("requestId"); }
        if (uuid.version() != 4 || uuid.variant() != 2 || !uuid.toString().equalsIgnoreCase(requestId)) {
            throw invalid("requestId");
        }
        if (submissionKind == null || !Set.of("candidate", "no_candidate", "skipped").contains(submissionKind)) {
            throw invalid("submissionKind");
        }
        Context c = curveContext;
        if (c == null || c.curveStep() == null || c.curveStep() < 0 || c.curveStep() > Short.MAX_VALUE
                || c.removedCandidateIds() == null || c.removedCandidateIds().size() > Short.MAX_VALUE
                || c.residualModelVersion() == null || c.residualModelVersion().isBlank()
                || c.periodogramConfigVersion() == null || c.periodogramConfigVersion().isBlank()) {
            throw invalid("curveContext");
        }
        id(c.bundleId(), "b-", "curveContext.bundleId");
        TreeSet<Long> removed = new TreeSet<>();
        for (String value : c.removedCandidateIds()) removed.add(id(value, "c-", "curveContext.removedCandidateIds"));
        if (c.curveStep() != removed.size()) throw invalid("curveContext.curveStep");
        List<String> evidence = evidenceChecks == null ? List.of() : evidenceChecks;
        if (evidence.size() > 3 || evidence.stream().anyMatch(v -> v == null
                || !Set.of("oddeven", "secondary", "ushape").contains(v))) throw invalid("evidenceChecks");
        evidence = List.copyOf(new TreeSet<>(evidence));
        if ("candidate".equals(submissionKind)) {
            if (selection == null || !finite(selection.periodDays()) || !finite(selection.phaseStart())
                    || !finite(selection.phaseEnd())) throw invalid("selection.periodDays");
            if (userJudgment == null || !Set.of("LIKELY_PLANET", "UNLIKELY_PLANET", "UNSURE").contains(userJudgment)) {
                throw invalid("userJudgment");
            }
            if (selection.sourcePeakGridIndex() != null && selection.sourcePeakGridIndex() < 0) {
                throw invalid("selection.sourcePeakGridIndex");
            }
        } else if (selection != null || userJudgment != null || !evidence.isEmpty()) {
            throw invalid("selection");
        }
        if (memo != null && memo.codePointCount(0, memo.length()) > 200) throw invalid("memo");
        if (viewState != null) {
            Double zoom = viewState.foldedXZoomRatio();
            if (zoom != null && (!finite(zoom) || zoom < 1 || zoom > 32)) throw invalid("viewState.foldedXZoomRatio");
            Viewport viewport = viewState.periodogramViewport();
            if (viewport != null && (!finite(viewport.minDays()) || !finite(viewport.maxDays())
                    || viewport.minDays() <= 0 || viewport.maxDays() <= viewport.minDays())) {
                throw invalid("viewState.periodogramViewport");
            }
        }
        if (retryOfSubmissionId != null) id(retryOfSubmissionId, "sub-", "retryOfSubmissionId");
        Selection normalizedSelection = selection == null ? null : new Selection(zero(selection.periodDays()),
                selection.sourcePeakGridIndex(), zero(selection.phaseStart()), zero(selection.phaseEnd()));
        return new SubmissionRequest(uuid.toString(), submissionKind,
                new Context(c.bundleId(), c.curveStep(), removed.stream().map(ExplorationIds::candidate).toList(),
                        c.residualModelVersion(), c.periodogramConfigVersion()),
                normalizedSelection, userJudgment, evidence, memo,
                viewState != null && viewState.periodogramViewport() == null && viewState.foldedXZoomRatio() == null
                        ? null : viewState, retryOfSubmissionId);
    }

    List<Long> removedIds() { return curveContext.removedCandidateIds().stream().map(v -> id(v, "c-", "curveContext")).toList(); }
    static long id(String value, String prefix, String field) {
        return ExplorationIds.parse(value, prefix).orElseThrow(() -> invalid(field));
    }
    static boolean finite(Double value) { return value != null && Double.isFinite(value); }
    private static double zero(double value) { return value == 0 ? 0 : value; }
    static BusinessException invalid(String field) {
        return new BusinessException(ErrorCode.VALIDATION_FAILED, ErrorCode.VALIDATION_FAILED.getDefaultMessage(),
                List.of(new FieldError(field, "요청 값이 올바르지 않습니다.")));
    }
}
