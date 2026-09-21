package com.planetory.backend.domain.exploration.service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.OptionalLong;
import java.util.Set;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import com.planetory.backend.domain.exploration.service.AnalysisViews.Answer;
import com.planetory.backend.domain.gold.GoldCatalogRepository;
import com.planetory.backend.domain.gold.GoldCatalogViews.Candidate;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.error.ErrorResponse.FieldError;

/**
 * 제출 조회·요청 ID 복구·상세 보기·다시 풀기 초안 (탐사 API 6.6·6.7·6.8절) [S15P21C206-145].
 *
 * <p>본문은 6.4절 제출 응답과 같고, 8.2절 기록 상세와도 같다. 그래서 만드는 함수도 하나다
 * ({@code HistoryService}). 두 벌이 되면 같은 제출이 화면마다 다른 진행·공개 상태를 말한다.
 *
 * <p>당시 값({@code original}·{@code serverDerived}·{@code match}·{@code judgment}·
 * {@code achievement.result})은 저장된 최초 응답이고, {@code achievement.star}·{@code progress}·
 * {@code publication}·{@code judgmentStatistics}는 조회 시점에 다시 만든다.
 */
@Service
@RequiredArgsConstructor
public class SubmissionLookupService {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final HistoryService histories;
    private final AnalysisService analysis;
    private final ResidualResultReader residuals;
    private final SubmissionService submissionService;
    private final SubmissionRepository submissions;
    private final StarRepository stars;
    private final GoldCatalogRepository gold;

    /**
     * 제출 한 건(6.6절). 본인 제출만 볼 수 있다.
     *
     * @throws BusinessException 없거나 형식이 다르면 {@code RESOURCE_NOT_FOUND}, 타인 제출이면 {@code FORBIDDEN}
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Answer<SubmissionViews.Result> byId(long member, String submissionId) {
        long id = ExplorationIds.parse(submissionId, ExplorationIds.SUBMISSION)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        return answer(histories.resultOf(member, id));
    }

    /**
     * 요청 ID로 찾기(6.6절). 응답을 잃은 뒤의 복구 경로다.
     *
     * <p>세 가지를 가른다 — 접수된 요청은 200, <b>아직 접수되지 않은</b> 요청은 404, <b>지금 처리 중인</b>
     * 요청은 409 {@code REQUEST_IN_PROGRESS}다. 404를 받은 화면은 같은 요청 ID로 다시 보내고, 409를 받은
     * 화면은 기다린다. 둘을 합치면 처리 중인 제출에 같은 ID를 또 보내게 된다.
     *
     * <p>처리 중인지는 6.1절이 쓰는 같은 권고 잠금으로 본다. <b>제출 행을 먼저 찾고</b> 없을 때만 잠금을
     * 확인한다 — 이미 접수된 요청까지 잠그면, 응답을 잃어 조회하는 동안 같은 요청의 재전송이 막힌다.
     *
     * @throws BusinessException 형식 오류 {@code VALIDATION_FAILED}, 미접수 {@code RESOURCE_NOT_FOUND},
     *                           처리 중 {@code REQUEST_IN_PROGRESS}, 타인 제출 {@code FORBIDDEN}
     */
    @Transactional(readOnly = true, isolation = Isolation.READ_COMMITTED)
    public Answer<SubmissionViews.Result> byRequest(long member, String requestId) {
        UUID id = uuid(requestId);
        try {
            return answer(histories.resultOfRequest(member, id));
        } catch (BusinessException e) {
            if (e.getErrorCode() != ErrorCode.RESOURCE_NOT_FOUND) {
                throw e;
            }
            // 행이 없다. 아직 안 온 요청인지, 지금 처리 중인 요청인지는 잠금만이 안다.
            throw submissions.tryRequestLock(id)
                    ? e
                    : new BusinessException(ErrorCode.REQUEST_IN_PROGRESS);
        }
    }

    /**
     * 오답 분기의 상세 보기(6.7절). 본문이 없고 반복 호출이 같은 대상을 준다.
     *
     * <p>대상은 <b>그 제출이 남긴 값</b>으로 정한다. {@code CURRENT_MATCH}는 그 제출이 매칭한 신호,
     * {@code CURRENT_CURVE_HINT}는 <b>그 제출의 곡선 문맥에서 제거되지 않은</b> 탐색 가능 후보 중
     * 세기가 가장 큰 하나다. 회원이 지금까지 매칭한 누적 집합이 아니다(RES-09) — 누적으로 세면 그 뒤의
     * 제출이 옛 제출의 힌트를 바꾼다.
     *
     * <p>대상이 없으면 409이고 {@code answer_viewed}도 켜지 않는다. 보지 못한 상세를 본 것으로
     * 적으면 튜토리얼 건너뛰기 조건이 잘못 열린다.
     *
     * @throws BusinessException 없는 제출 {@code RESOURCE_NOT_FOUND}, 타인 제출 {@code FORBIDDEN},
     *                           볼 대상 없음 {@code DETAIL_UNAVAILABLE}
     */
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public SubmissionViews.DetailView detailView(long member, String submissionId) {
        long id = ExplorationIds.parse(submissionId, ExplorationIds.SUBMISSION)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        var row = histories.ownedSubmission(member, id);
        JsonNode saved = row.submission().path("response_snapshot");
        // 당시 응답이 없으면 무엇을 보여 줄지 정할 근거가 없다. 현재 후보로 지어내지 않는다.
        if (!saved.isObject()) throw new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE);
        String targetKind = saved.path("detail").path("targetKind").isString()
                ? saved.path("detail").path("targetKind").asText() : null;
        if (targetKind == null) throw new BusinessException(ErrorCode.DETAIL_UNAVAILABLE);

        Candidate target = target(row, saved, targetKind);
        if (target == null) throw new BusinessException(ErrorCode.DETAIL_UNAVAILABLE);

        submissions.markDetailViewed(id, target.id());
        var disposition = submissions.disposition(target.id());
        Map<String, Object> signal = submissions.signal(member, target, disposition);
        // 6.7절 signal에는 해설이 있고 6.4절에는 없다. 공용 빌더를 넓히지 않고 여기서만 더한다.
        // 값은 아직 null이지만 키를 빼면 소비자가 「해설 없음」과 「모르는 응답」을 구분하지 못한다.
        signal.put("explanation", null);
        return new SubmissionViews.DetailView(ExplorationIds.submission(id), true, targetKind,
                signal, "CURRENT_MATCH".equals(targetKind) ? agrees(saved) : null,
                submissionService.tutorialState(member, row.tic()));
    }

    /**
     * 열어 볼 신호. <b>한 번 정한 대상은 바꾸지 않는다</b>(6.7절 「반복 호출은 같은 대상」).
     *
     * <p>힌트를 매번 다시 고르면 후보표가 갱신될 때 같은 제출의 답이 달라진다. 처음 고른 값을 제출에
     * 남기고 이후에는 그 신호를 상태와 무관하게 찾는다 — 한 번 보여 준 신호가 은퇴했다고 없던 일이
     * 되지는 않는다. 행 자체가 사라졌을 때만 볼 대상이 없다.
     */
    private Candidate target(HistoryRepository.Row row, JsonNode saved, String targetKind) {
        if ("CURRENT_MATCH".equals(targetKind)) {
            return matched(row.tic(), saved);
        }
        JsonNode chosen = row.submission().path("detail_target_candidate_id");
        return chosen.isNumber() ? byId(row.tic(), chosen.asLong()) : hint(row.tic(), saved);
    }

    private Candidate byId(long tic, long candidateId) {
        return gold.findCandidates(tic).stream().filter(c -> c.id() == candidateId).findFirst().orElse(null);
    }

    /** 그 제출이 매칭한 신호. 은퇴했어도 당시 매칭은 사라지지 않으므로 그대로 보여 준다. */
    private Candidate matched(long tic, JsonNode saved) {
        String candidateId = saved.path("match").path("candidateId").isString()
                ? saved.path("match").path("candidateId").asText() : null;
        if (candidateId == null) return null;
        return gold.findCandidates(tic).stream()
                .filter(c -> ExplorationIds.candidate(c.id()).equals(candidateId)).findFirst().orElse(null);
    }

    /** 그 제출 단계에서 아직 제거하지 않은 탐색 가능 후보 중 세기가 가장 큰 하나. 한 번에 하나만. */
    private Candidate hint(long tic, JsonNode saved) {
        Set<String> removed = new HashSet<>();
        saved.path("curveContext").path("removedCandidateIds").forEach(node -> removed.add(node.asText()));
        return gold.findCandidates(tic).stream()
                .filter(c -> c.status() == Candidate.Status.ACTIVE && c.discoverable())
                .filter(c -> !removed.contains(ExplorationIds.candidate(c.id())))
                .filter(c -> c.blsPower() != null)
                .max(Comparator.comparing(Candidate::blsPower)).orElse(null);
    }

    /** 당시 채점 결과를 그대로 읽는다. 미확정·모르겠음·채점 대상 아님은 값이 없다. */
    private static Boolean agrees(JsonNode saved) {
        String evaluation = saved.path("judgment").path("evaluation").asText();
        return switch (evaluation) {
            case "AGREES" -> Boolean.TRUE;
            case "DISAGREES" -> Boolean.FALSE;
            default -> null;
        };
    }

    /**
     * 다시 풀기 초안(6.8절). <b>조회만이며 아무것도 저장하지 않는다</b> — 새 제출·성과·진행이 생기지 않는다.
     *
     * <p>위상은 저장값을 복사하지 않고 <b>현재 판 기준 시각으로 다시 만든다</b>(HIS-02). 판이 바뀌면 같은
     * 통과가 다른 위상에 오므로, 절대 시각과 지속 시간에서 환산해야 창이 통과 위에 놓인다.
     *
     * <p>원 제출이 제거한 후보가 은퇴했으면 단계를 되살리지 못한다. 그때는 현재 진행 문맥으로 바꾸고
     * {@code restored.step=false}로 알린다(C02-R1). 대상 신호 자체가 은퇴했으면 409다.
     *
     * @throws BusinessException 없는 제출 {@code RESOURCE_NOT_FOUND}, 타인 제출 {@code FORBIDDEN},
     *                           대상 신호 은퇴 {@code CANDIDATE_RETIRED}
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public SubmissionViews.RetryDraft retryDraft(long member, String submissionId) {
        long id = ExplorationIds.parse(submissionId, ExplorationIds.SUBMISSION)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        var row = histories.ownedSubmission(member, id);
        JsonNode saved = row.submission().path("response_snapshot");
        if (!saved.isObject()) throw new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE);
        requireLivingTarget(row.tic(), saved);

        List<String> removed = new ArrayList<>();
        saved.path("curveContext").path("removedCandidateIds").forEach(node -> removed.add(node.asText()));
        var restored = analysis.retryContext(member, row.tic(), List.copyOf(removed));

        var residual = restored.context().curveStep() == 0
                ? AnalysisViews.Residual.ORIGINAL
                : lookupResidual(row.tic(), restored.context());
        return new SubmissionViews.RetryDraft(ExplorationIds.submission(id),
                restored.context().bundleId(), row.previous(), restored.context(),
                new SubmissionViews.Restored(restored.stepRestored(),
                        restored.stepRestored() ? null : "STEP_NOT_RESTORABLE"),
                draft(saved, restored.bundle().foldReferenceTimeBtjd()),
                residual, ExplorationIds.submission(id));
    }

    /** 대상 신호가 은퇴했으면 이어 풀 것이 없다. 매칭하지 않은 제출에는 대상이 없어 그대로 둔다. */
    private void requireLivingTarget(long tic, JsonNode saved) {
        String candidateId = saved.path("match").path("candidateId").isString()
                ? saved.path("match").path("candidateId").asText() : null;
        if (candidateId == null) {
            return;
        }
        boolean retired = gold.findCandidates(tic).stream()
                .filter(c -> ExplorationIds.candidate(c.id()).equals(candidateId))
                .anyMatch(c -> c.status() == Candidate.Status.RETIRED);
        if (retired) throw new BusinessException(ErrorCode.CANDIDATE_RETIRED);
    }

    /** 조회는 잔차 작업을 만들지 않는다(D-14). 결과도 작업도 없으면 둘 다 null이다. */
    private AnalysisViews.Residual lookupResidual(long tic, AnalysisViews.CurveContext context) {
        ResidualResultReader.Lookup lookup;
        try {
            lookup = residuals.lookup(tic, context);
        } catch (RuntimeException e) {
            throw new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE);
        }
        if (lookup == null) throw new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE);
        return new AnalysisViews.Residual(lookup.status(), lookup.jobId(), lookup.computedAt());
    }

    /** 판단·근거·메모는 비운다. 다시 푸는 것이지 옛 답을 다시 내는 것이 아니다. */
    private static SubmissionViews.Draft draft(JsonNode saved, double foldReferenceTimeBtjd) {
        JsonNode original = saved.path("original");
        JsonNode derived = saved.path("serverDerived");
        Double period = number(original, "periodDays");
        Double epoch = number(derived, "epochBtjd");
        Double duration = number(derived, "durationHours");
        Double start = null;
        Double end = null;
        if (period != null && period > 0 && epoch != null && duration != null) {
            double[] window = HistoryService.phaseWindow(period, epoch, duration, foldReferenceTimeBtjd);
            start = window[0];
            end = window[1];
        }
        var viewState = original.path("viewState").isObject()
                ? JSON.treeToValue(original.path("viewState"), SubmissionRequest.ViewState.class) : null;
        return new SubmissionViews.Draft(period, start, end, viewState, null, List.of(), null);
    }

    private static Double number(JsonNode node, String key) {
        return node.path(key).isNumber() ? node.path(key).asDouble() : null;
    }

    /** 지금 판을 헤더로 함께 준다(D-5). 별의 현재 판을 읽지 못하면 붙이지 않는다. */
    private Answer<SubmissionViews.Result> answer(SubmissionViews.Result result) {
        OptionalLong tic = ExplorationIds.parseTic(result.ticId());
        String current = tic.isEmpty() ? null : stars.findCurrentBundleId(tic.getAsLong()).orElse(null);
        return new Answer<>(result, true, current);
    }

    private static UUID uuid(String requestId) {
        try {
            return UUID.fromString(requestId);
        } catch (IllegalArgumentException | NullPointerException e) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED,
                    ErrorCode.VALIDATION_FAILED.getDefaultMessage(),
                    List.of(new FieldError("requestId", "UUID 형식이어야 합니다.")));
        }
    }
}
