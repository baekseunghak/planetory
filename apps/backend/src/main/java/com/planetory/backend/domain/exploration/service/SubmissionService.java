package com.planetory.backend.domain.exploration.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import com.planetory.backend.domain.gold.GoldCatalogRepository;
import com.planetory.backend.domain.gold.GoldCatalogViews.*;
import com.planetory.backend.domain.member.repository.MemberSettingsRepository;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import static com.planetory.backend.domain.exploration.service.SubmissionRequest.invalid;
import static com.planetory.backend.domain.exploration.service.SubmissionViews.*;

/** 제출 전용 멱등 트랜잭션(6.3절). 잔차 작업이나 공개 분석을 생성하지 않는다. */
@Service
@RequiredArgsConstructor
public class SubmissionService {
    // 고정 정규화 v1. HTTP 전역 설정을 바꿔도 기존 요청 해시가 달라지지 않는다.
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private final SubmissionRepository submissions;
    private final AnalysisRepository analysis;
    private final StarRepository stars;
    private final GoldCatalogRepository gold;
    private final OperationRuleRepository rules;
    private final ResidualResultReader residuals;
    private final ObjectProvider<SubmissionPeakReader> peaks;
    private final AchievementService achievements;
    private final ExplorationCompletionService completion;
    private final TutorialProgressService tutorialProgress;
    private final TutorialRepository tutorials;
    private final MemberSettingsRepository settings;
    private final SkyService sky;
    private final PlatformTransactionManager transactions;

    public record Answer(JsonNode body, boolean replay, String currentBundleId) {}

    public Answer submit(long memberId, long ticId, SubmissionRequest input) {
        if (input == null) throw invalid("body");
        SubmissionRequest request = input.normalized();
        String hash = fingerprint(ticId, request);
        TransactionTemplate tx = new TransactionTemplate(transactions);
        tx.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        // 잠금을 얻기 전에 snapshot이 잡힌다. 그 사이 커밋된 요청의 UNIQUE 충돌도 새 트랜잭션에서 재조회한다.
        for (int attempt = 0; ; attempt++) {
            try { return tx.execute(status -> process(memberId, ticId, request, hash)); }
            catch (PessimisticLockingFailureException | DuplicateKeyException e) {
                if (attempt == 2) throw new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE);
                // execute가 롤백을 마친 뒤에만 대기한다. 커밋된 요청의 중복 키는 즉시 재조회한다.
                if (e instanceof PessimisticLockingFailureException) {
                    try { Thread.sleep(ThreadLocalRandom.current().nextLong(10, 31) * (attempt + 1)); }
                    catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw unavailable();
                    }
                }
            }
        }
    }

    private Answer process(long member, long tic, SubmissionRequest request, String hash) {
        UUID requestId = UUID.fromString(request.requestId());
        if (!submissions.tryRequestLock(requestId)) throw new BusinessException(ErrorCode.REQUEST_IN_PROGRESS);
        if (!submissions.lockMember(member)) throw new BusinessException(ErrorCode.AUTH_REQUIRED);
        var existing = submissions.existing(requestId);
        if (existing.isPresent()) {
            var old = existing.get();
            if (old.memberId() != member || old.ticId() != tic) throw new BusinessException(ErrorCode.IDEMPOTENCY_CONFLICT);
            // 도입 전 기록에는 최초 응답을 복구할 근거가 없다. 신규 처리나 재판정으로 대신하지 않는다.
            if (old.version() == null || old.response() == null) throw new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE);
            if (old.version() != 1 || !hash.equals(old.hash())) throw new BusinessException(ErrorCode.IDEMPOTENCY_CONFLICT);
            JsonNode body = JSON.readTree(old.response());
            return new Answer(body, true, stars.findCurrentBundleId(tic).orElse(body.get("bundleId").asText()));
        }
        if (!analysis.isPublished(tic)) throw new BusinessException(ErrorCode.STAR_NOT_PUBLISHED);
        if (!stars.hasUnlocked(member, tic)) throw new BusinessException(ErrorCode.STAR_LOCKED);
        Bundle bundle = gold.findCurrentBundle(tic).orElseThrow(SubmissionService::unavailable);
        var context = request.curveContext();
        if (!context.bundleId().equals(ExplorationIds.bundle(bundle.id()))
                || !context.residualModelVersion().equals(bundle.manifest().residualModelVersion())
                || !context.periodogramConfigVersion().equals(bundle.manifest().periodogramConfigVersion())) {
            throw new BusinessException(ErrorCode.BUNDLE_CHANGED, Map.of("currentBundleId", ExplorationIds.bundle(bundle.id())));
        }
        List<Long> removed = request.removedIds();
        if (!analysis.findMatchedActiveCandidateIds(member, tic).containsAll(removed)) throw invalid("curveContext");
        if (request.retryOfSubmissionId() != null && !submissions.ownsRetry(member, tic,
                SubmissionRequest.id(request.retryOfSubmissionId(), "sub-", "retryOfSubmissionId"))) {
            throw invalid("retryOfSubmissionId");
        }
        submissions.lockProgress(member, tic);
        OperationRule rule = rules.findCurrent().orElseThrow(SubmissionService::unavailable);
        Integer seq = tutorials.findActiveSeq(tic).orElse(null);
        StarViews.Progress before = stars.findProgress(member, tic).orElseThrow();
        boolean skipped = "skipped".equals(request.submissionKind());
        boolean candidateSubmission = "candidate".equals(request.submissionKind());
        if ("no_candidate".equals(request.submissionKind()) && "completed".equals(before.stage())) {
            throw new BusinessException(ErrorCode.STAR_ALREADY_COMPLETED);
        }
        if (skipped && !skipAvailable(member, tic, rule, seq, before)) throw new BusinessException(ErrorCode.SKIP_NOT_AVAILABLE);
        List<Candidate> candidates = gold.findCandidates(tic);
        SubmissionMatching.Derived derived = null;
        SubmissionViews.Match match = new SubmissionViews.Match(skipped ? "skipped" : "none_wrong", null, null, null, null);
        Candidate selected = null;
        SubmissionRepository.Disposition disposition = null;
        FoldedSnapshot snapshot = null;
        if (candidateSubmission) {
            List<LightCurveSegment> segments = curve(bundle, context);
            Periodogram periodogram = gold.findPeriodogram(bundle.id()).orElseThrow(SubmissionService::unavailable);
            var observation = SubmissionMatching.observationOf(bundle, segments, periodogram);
            var matchingRules = SubmissionMatching.Rules.of(rule, SubmissionMatching.minWindowDays(segments));
            var selection = request.selection().matching();
            Map<Integer, SubmissionMatching.Peak> selectedPeaks = Map.of();
            if (selection.sourcePeakGridIndex() != null) {
                SubmissionPeakReader reader = peaks.getIfAvailable();
                if (reader == null) throw unavailable();
                try { selectedPeaks = reader.read(curveContext(context), rule.ruleVersion()); }
                catch (RuntimeException e) { throw unavailable(); }
                if (selectedPeaks == null) throw unavailable();
            }
            var validation = SubmissionMatching.validate(observation, matchingRules, selection,
                    request.userJudgment(), request.evidenceChecks(), selectedPeaks);
            if (!validation.ok()) {
                if (validation.rejection().reason() == SubmissionMatching.Reason.EPOCH_OUT_OF_RANGE) {
                    throw new BusinessException(ErrorCode.EPOCH_OUT_OF_RANGE);
                }
                throw invalid(validation.rejection().field());
            }
            derived = validation.derived();
            var matched = SubmissionMatching.markDuplicate(SubmissionMatching.match(observation, matchingRules,
                    selection, derived, SubmissionMatching.candidatesToCompare(candidates, removed), removed), submissions.recognized(member));
            boolean harmonic = matched.harmonicMultiplier() != null && matched.harmonicMultiplier() != 1;
            match = new SubmissionViews.Match(matched.status().value(), matched.candidateId() == null ? null
                    : ExplorationIds.candidate(matched.candidateId()), harmonic ? matched.harmonicMultiplier() : null,
                    harmonic ? matched.correctedPeriodDays() : null,
                    !harmonic ? null : matched.harmonicMultiplier() == 2 ? "P/2 alias" : "2P alias");
            if (matched.candidateId() != null) {
                selected = candidates.stream().filter(c -> c.id() == matched.candidateId()).findFirst().orElseThrow();
                disposition = submissions.disposition(selected.id());
                try { snapshot = FoldedSnapshot.calculate(segments, selection.periodDays(), bundle.foldReferenceTimeBtjd()); }
                catch (IllegalStateException e) { throw unavailable(); }
            }
        }
        String judgment = evaluation(request.userJudgment(), disposition);
        String achievement = selected == null ? "none" : "duplicate".equals(match.status()) ? "already_recognized"
                : "analysis".equals(disposition.answerClass()) ? "pending_publish"
                : "AGREES".equals(judgment) ? "recognized" : "judgment_mismatch";
        var row = submissions.insert(member, tic, bundle.id(), request, hash, rule.ruleVersion(),
                bundle.foldReferenceTimeBtjd(), derived, match, achievement, JSON.writeValueAsString(request.evidenceChecks()));
        Original original = original(request);
        Derived server = new Derived(bundle.foldReferenceTimeBtjd(), derived == null ? null : derived.phaseCenter(),
                derived == null ? null : derived.epochBtjd(), derived == null ? null : derived.durationHours(),
                derived == null ? null : derived.sourcePeakSuggestedDurationHours(),
                derived == null ? null : derived.durationLimitHours(), "unavailable");
        long history = submissions.history(row.id(), member, tic, JSON.writeValueAsString(original),
                JSON.writeValueAsString(Map.of("ruleVersion", rule.ruleVersion(), "bundleVersion", bundle.bundleVersion(),
                        "residualModelVersion", context.residualModelVersion(), "periodogramConfigVersion", context.periodogramConfigVersion(),
                        "snapshotVersion", FoldedSnapshot.VERSION, "originalMatch", match)));
        if (snapshot != null) submissions.snapshot(history, snapshot);
        AchievementService.Recognition recognition = null;
        if ("recognized".equals(achievement)) {
            recognition = achievements.recognize(member, selected.id(), "fp".equals(disposition.value())
                    ? AchievementService.AchievementType.FP : AchievementService.AchievementType.CONFIRMED, row.id(), null);
        }
        if (!"ambiguous_match".equals(match.status())) {
            submissions.progress(member, tic, context.curveStep(), stars.findMyPlanets(member, tic).size(), skipped);
            if (candidateSubmission) completion.evaluateAndApply(member, tic);
        }
        if (Integer.valueOf(1).equals(seq)) settings.completeOnboarding(member);
        if (!"ambiguous_match".equals(match.status()) && (candidateSubmission || skipped)) tutorialProgress.onTutorialCompleted(member, tic);
        var progress = stars.findProgress(member, tic).orElseThrow();
        Set<Long> matchedIds = analysis.findMatchedActiveCandidateIds(member, tic);
        long remaining = candidates.stream().filter(c -> c.status() == Candidate.Status.ACTIVE && c.discoverable()
                && !matchedIds.contains(c.id())).count();
        var counted = stars.countAchievements(member, tic);
        var star = new StarViews.Achievement(counted.count(), StarService.grade(counted.count()), counted.byType());
        boolean eligible = selected != null && "analysis".equals(disposition.answerClass());
        String target = "not_matched".equals(match.status()) || "none_wrong".equals(match.status()) ? "CURRENT_CURVE_HINT"
                : selected != null && ("judgment_mismatch".equals(achievement) || "already_recognized".equals(achievement)
                    || "pending_publish".equals(achievement))
                    ? "CURRENT_MATCH" : null;
        List<String> actions = new ArrayList<>();
        if ("ambiguous_match".equals(match.status())) actions.add("RETRY");
        else {
            if (target != null) { actions.add("VIEW_DETAIL"); actions.add("RETRY"); }
            if (selected != null && remaining > 0) actions.add("NEXT_CURVE");
            if (eligible) { actions.add("PUBLISH_ANALYSIS"); actions.add("LATER"); }
            if (selected != null) actions.add("GO_HOME");
            if ("not_matched".equals(match.status())) actions.add("DISCUSS");
            actions.add("VIEW_RESULT");
        }
        boolean canSkip = skipAvailable(member, tic, rule, seq, progress);
        if (canSkip && !"ambiguous_match".equals(match.status())) actions.add("SKIP_TUTORIAL");
        Result result = new Result(ExplorationIds.submission(row.id()), "h-" + history, request.requestId(),
                Long.toString(tic), context.bundleId(), rule.ruleVersion(), row.createdAt(), request.submissionKind(), context,
                original, server, match, selected == null ? null : submissions.signal(member, selected, disposition),
                new Judgment(request.userJudgment(), judgment), sky.version(member),
                new Achievement(achievement, recognition != null && recognition.newlyRecognized(), recognition == null ? List.of()
                        : recognition.unlockedStars().stream().map(s -> new UnlockedStar(Long.toString(s.ticId()), s.position())).toList(), star),
                new Progress(progress.stage(), progress.completionReason(), progress.reopenPending(), progress.currentCurveStep(),
                        matchedIds.stream().sorted().map(ExplorationIds::candidate).toList(), remaining),
                new Publication(eligible ? "UNPUBLISHED" : "NOT_ELIGIBLE", null),
                selected == null ? null : submissions.statistics(selected.id(), disposition),
                new Detail(target != null, target, false), new AnalysisViews.TutorialState(seq, canSkip), List.copyOf(actions));
        String response = JSON.writeValueAsString(result);
        submissions.saveResponse(row.id(), response);
        return new Answer(JSON.readTree(response), false, context.bundleId());
    }

    private List<LightCurveSegment> curve(Bundle bundle, SubmissionRequest.Context context) {
        List<LightCurveSegment> segments = gold.findSegments(bundle.manifest().segmentIds());
        if (segments.isEmpty() || segments.size() != bundle.manifest().segmentIds().size()) throw unavailable();
        if (context.curveStep() > 0) {
            ResidualResultReader.Lookup lookup;
            try { lookup = residuals.lookup(bundle.ticId(), curveContext(context)); }
            catch (RuntimeException e) { throw unavailable(); }
            if (lookup == null) throw unavailable();
            if (!lookup.completed()) throw new BusinessException(ErrorCode.SUBMISSION_CONTEXT_NOT_READY,
                    Map.of("residual", new AnalysisViews.Residual(lookup.status(), lookup.jobId(), lookup.computedAt())));
            if (lookup.segmentFlux() == null) throw unavailable();
            segments = segments.stream().map(s -> {
                Float[] flux = lookup.segmentFlux().get(s.id());
                if (flux == null || flux.length != s.nPoints()) throw unavailable();
                for (int i = 0; i < flux.length; i++) {
                    if ((s.flux()[i] == null) != (flux[i] == null)) throw unavailable();
                }
                return new LightCurveSegment(s.id(), s.ticId(), s.sector(), s.binningRevision(), s.startBtjd(),
                        s.binMinutes(), s.nPoints(), flux.clone(), s.fluxScatter(), s.gaps());
            }).toList();
        }
        boolean observed = false;
        for (var s : segments) for (Float f : s.flux()) {
            if (f != null) { if (!Float.isFinite(f)) throw unavailable(); observed = true; }
        }
        if (!observed) throw unavailable();
        return segments;
    }
    private static AnalysisViews.CurveContext curveContext(SubmissionRequest.Context c) {
        return new AnalysisViews.CurveContext(c.bundleId(), c.curveStep(), c.removedCandidateIds(), c.residualModelVersion(), c.periodogramConfigVersion());
    }
    private boolean skipAvailable(long member, long tic, OperationRule rule, Integer seq, StarViews.Progress progress) {
        if (seq == null || !rule.tutorial().skipEnabled() || "completed".equals(progress.stage()) || progress.completedAt() != null) return false;
        var failures = analysis.countMismatches(member, tic);
        return failures.total() >= rule.tutorial().skipAfter() && failures.latestAnswerViewed();
    }
    private static Original original(SubmissionRequest r) {
        var s = r.selection();
        return new Original(s == null ? null : s.periodDays(), s == null ? null : s.sourcePeakGridIndex(),
                s == null ? null : s.phaseStart(), s == null ? null : s.phaseEnd(), r.userJudgment(), r.evidenceChecks(), r.memo(), r.viewState());
    }
    private static String evaluation(String judgment, SubmissionRepository.Disposition d) {
        if (d == null) return "NOT_APPLICABLE";
        if ("analysis".equals(d.answerClass())) return "UNSCORED";
        if ("UNSURE".equals(judgment)) return "UNSURE";
        return ("confirmed".equals(d.value()) && "LIKELY_PLANET".equals(judgment))
                || ("fp".equals(d.value()) && "UNLIKELY_PLANET".equals(judgment)) ? "AGREES" : "DISAGREES";
    }
    static String fingerprint(long ticId, SubmissionRequest request) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(("submission-v1\n" + ticId + "\n" + JSON.writeValueAsString(request)).getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    private static BusinessException unavailable() { return new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE); }
}
