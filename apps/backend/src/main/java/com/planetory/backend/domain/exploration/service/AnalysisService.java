package com.planetory.backend.domain.exploration.service;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import com.fasterxml.jackson.databind.JsonNode;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

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
import com.planetory.backend.domain.gold.GoldCatalogRepository;
import com.planetory.backend.domain.gold.GoldCatalogViews;
import com.planetory.backend.domain.gold.GoldCatalogViews.Bundle;
import com.planetory.backend.domain.gold.GoldCatalogViews.Candidate;
import com.planetory.backend.domain.gold.GoldCatalogViews.LightCurveSegment;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.error.ErrorResponse.FieldError;

/**
 * 분석 진입과 곡선·주기도 조회 (탐사 API 5.1·5.2·5.3) [S15P21C206-140].
 *
 * <p>검사 순서는 5.1절과 같다: 공개된 별 → 회원이 연 별 → 현재 판. 곡선·주기도는 그다음 요청 문맥을
 * 현재 판과 대조한다. 판·계산 버전이 다르면 제거 조합을 보기 전에 {@code BUNDLE_CHANGED}로 끝낸다.
 * 어떤 후보를 제거할 수 있는지는 현재 판에서만 뜻이 있다.
 *
 * <p>현재 판과 배열을 한 스냅샷에서 읽는다. 따로 읽으면 그사이 판이 바뀌어 방금 확인한 판의 주기도
 * 행이 지워진 것처럼 보일 수 있다(판이 archived가 되면 주기도 행을 지운다, ERD).
 */
@Service
@RequiredArgsConstructor
public class AnalysisService {

    static final String FLUX_UNIT = "normalized";

    /** 한 곡선 단계가 매칭한 후보 하나를 더 제거한다. 단계 수 = 제거 후보 수다(2.1절). */
    static final String CURVE_STEP_RULE = "one_candidate_per_step";

    /** 분석을 시작하지 않아 진행 행이 없을 때의 단계(DB 기본값과 같다). */
    private static final String UNEXPLORED = "unexplored";
    private static final String COMPLETED = "completed";

    private static final double MINUTES_PER_DAY = 1440.0;
    private static final BigDecimal TWO = BigDecimal.valueOf(2);

    private final AnalysisRepository analysis;
    private final StarRepository stars;
    private final GoldCatalogRepository gold;
    private final ResidualResultReader residuals;
    private final TutorialRepository tutorials;
    private final OperationRuleRepository rules;
    private final ExplorationCompletionService completion;
    private final PlatformTransactionManager transactionManager;

    /**
     * 분석 진입 (5.1절). 진입 시 완료 판정을 반영한 뒤 판·선택 규칙·진행 문맥을 한 스냅샷에서 읽는다.
     *
     * <p>완료 판정(9.3절 (b))은 진행 행을 잠그고 바꾸므로 스냅샷 읽기와 트랜잭션을 나눈다. 스냅샷
     * 격리에서 잠그면 같은 별에 동시에 제출한 트랜잭션과 부딪혀 직렬화 오류가 난다.
     *
     * <p>조회는 잔차 작업을 만들지 않는다(D-14). 복귀 문맥은 마지막 제출의 제거 조합이다. 그 조합에
     * 은퇴 후보가 있으면 이 판에서 매칭한 활성 후보 전체로 바꾸고 알린다(C02-R1).
     *
     * @throws BusinessException 미공개 {@code STAR_NOT_PUBLISHED}, 미발견 {@code STAR_LOCKED},
     *                           현재 판이나 현재 운영 규칙 없음 {@code DEPENDENCY_UNAVAILABLE}
     */
    public Answer<AnalysisContext> context(long memberId, long ticId) {
        new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
            openCurrentBundle(memberId, ticId);
            completion.evaluateAndApply(memberId, ticId);
        });
        TransactionTemplate snapshot = new TransactionTemplate(transactionManager);
        snapshot.setReadOnly(true);
        snapshot.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        return snapshot.execute(status -> readContext(memberId, ticId));
    }

    private Answer<AnalysisContext> readContext(long memberId, long ticId) {
        Bundle bundle = openCurrentBundle(memberId, ticId);
        OperationRule rule = rules.findCurrent()
                .orElseThrow(() -> new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE));
        List<LightCurveSegment> segments = gold.findSegments(bundle.manifest().segmentIds());
        if (segments.isEmpty()) {
            throw new IllegalStateException(ExplorationIds.bundle(bundle.id())
                    + "은 현재 판인데 세그먼트가 없습니다. 적재 계약이 어긋났습니다.");
        }
        List<Candidate> candidates = gold.findCandidates(ticId);
        Set<Long> matched = new TreeSet<>(analysis.findMatchedActiveCandidateIds(memberId, ticId));

        List<Long> lastRemoved = analysis.findLastSubmittedRemoval(memberId, ticId).orElse(List.of());
        // 매칭은 누적되므로 조합에서 빠진 후보는 은퇴한 후보다.
        boolean restorable = matched.containsAll(lastRemoved);
        CurveContext current = contextOf(bundle, restorable ? lastRemoved : matched);
        boolean signalLeft = candidates.stream().anyMatch(c -> c.status() == Candidate.Status.ACTIVE
                && c.discoverable() && !matched.contains(c.id()));
        CurveContext next = signalLeft ? contextOf(bundle, matched) : null;

        StarViews.StarInfo star = stars.findStar(ticId).orElseThrow(() -> new IllegalStateException(
                "공개된 별 " + ticId + "의 stars 행이 없습니다."));
        StarViews.Progress progress = stars.findProgress(memberId, ticId).orElse(null);
        int achievementCount = stars.countAchievements(memberId, ticId).count();

        AnalysisContext body = new AnalysisContext(
                String.valueOf(ticId),
                new StarSummary(star.sectorCount(), star.sectors(), star.tmag()),
                candidates.stream().anyMatch(c -> c.status() == Candidate.Status.ACTIVE && c.confirmed()),
                bundleOf(bundle, segments),
                selectionRulesOf(rule, bundle, segments),
                new ProgressSummary(
                        progress == null ? UNEXPLORED : progress.stage(),
                        progress == null || progress.currentCurveStep() == null ? 0 : progress.currentCurveStep(),
                        matched.stream().map(ExplorationIds::candidate).toList(),
                        progress == null ? null : progress.completionReason(),
                        progress != null && progress.reopenPending(),
                        achievementCount,
                        StarService.grade(achievementCount)),
                CurrentCurveContext.of(current, restorable ? null : CurrentCurveContext.STEP_NOT_RESTORABLE),
                residualStateOf(ticId, current),
                next,
                next == null ? null : residualStateOf(ticId, next),
                tutorialOf(memberId, ticId, rule, progress),
                rule.ruleVersion());
        return new Answer<>(body, true, ExplorationIds.bundle(bundle.id()));
    }

    /**
     * 곡선 (5.2절). 원본과 잔차 단계가 같은 형식이다.
     *
     * <p>잔차가 준비되지 않았으면 {@code segments}를 비워 202로 보낸다. 조회는 작업을 만들지 않는다(D-14).
     *
     * @throws BusinessException 미공개 {@code STAR_NOT_PUBLISHED}, 미발견 {@code STAR_LOCKED},
     *                           현재 판 없음 {@code DEPENDENCY_UNAVAILABLE}, 판·버전 불일치
     *                           {@code BUNDLE_CHANGED}, 요청 형식·제거 조합 오류 {@code VALIDATION_FAILED}
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Answer<Curve> curve(long memberId, long ticId, CurveQuery query) {
        Target target = resolve(memberId, ticId, query);

        if (target.context().curveStep() == 0) {
            List<Segment> original = segmentsOf(target).stream().map(s -> segmentOf(s, s.flux())).toList();
            return target.answer(curveOf(ticId, target, Residual.ORIGINAL, original), true);
        }

        ResidualResultReader.Lookup lookup = residuals.lookup(ticId, target.context());
        if (!lookup.completed()) {
            // 보내지 않을 원본 배열은 읽지 않는다.
            return target.answer(curveOf(ticId, target, residualOf(lookup), null), false);
        }
        List<Segment> residual = segmentsOf(target).stream()
                .map(s -> segmentOf(s, residualFlux(lookup, s)))
                .toList();
        return target.answer(curveOf(ticId, target, residualOf(lookup), residual), true);
    }

    /**
     * 주기도 (5.3절). 원본은 {@code periodograms} 행, 잔차 단계는 잔차 결과이며 격자는 같다.
     *
     * <p>잔차가 준비되지 않았으면 {@code power}를 비워 202로 보낸다.
     *
     * @throws BusinessException {@link #curve}와 같다
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Answer<Periodogram> periodogram(long memberId, long ticId, CurveQuery query) {
        Target target = resolve(memberId, ticId, query);
        Bundle bundle = target.bundle();
        GoldCatalogViews.Periodogram original = gold.findPeriodogram(bundle.id())
                .orElseThrow(() -> new IllegalStateException(
                        ExplorationIds.bundle(bundle.id()) + "은 현재 판인데 주기도 행이 없습니다. 적재 계약이 어긋났습니다."));

        if (target.context().curveStep() == 0) {
            return target.answer(periodogramOf(target, original, Residual.ORIGINAL, original.power()), true);
        }

        ResidualResultReader.Lookup lookup = residuals.lookup(ticId, target.context());
        if (!lookup.completed()) {
            return target.answer(periodogramOf(target, original, residualOf(lookup), null), false);
        }
        Float[] power = lookup.power();
        if (power == null || power.length != original.nPeriods()) {
            throw new IllegalStateException(target.context() + "의 잔차 주기도가 격자 크기와 맞지 않습니다.");
        }
        return target.answer(periodogramOf(target, original, residualOf(lookup), power), true);
    }

    /**
     * 6.8절 다시 풀기 초안의 곡선 문맥. 5.1절 복귀 문맥과 <b>같은 규칙</b>으로 정한다.
     *
     * <p>매칭은 누적되므로, 원 제출이 제거한 후보가 지금 매칭 집합에 없으면 그 후보는 은퇴한 것이다.
     * 그때는 단계를 되살리지 못하므로 <b>그 별의 현재 진행 문맥</b>으로 대체한다(C02-R1). 옛 조합을
     * 그대로 주면 5.2절 조회가 거절하는 문맥을 초안으로 건네게 된다.
     *
     * @param removedCandidateIds 원 제출의 제거 조합
     */
    @Transactional(readOnly = true)
    RetryContext retryContext(long memberId, long ticId, List<String> removedCandidateIds) {
        Bundle bundle = openCurrentBundle(memberId, ticId);
        Set<Long> matched = new TreeSet<>(analysis.findMatchedActiveCandidateIds(memberId, ticId));
        List<Long> removed = removedCandidateIds.stream()
                .map(id -> ExplorationIds.parse(id, ExplorationIds.CANDIDATE))
                .filter(OptionalLong::isPresent).map(OptionalLong::getAsLong).toList();
        boolean restorable = removed.size() == removedCandidateIds.size() && matched.containsAll(removed);
        return new RetryContext(bundle, contextOf(bundle, restorable ? removed : matched), restorable);
    }

    /** @param stepRestored 원 제출의 단계를 그대로 되살렸는지. 거짓이면 현재 진행 문맥이다 */
    record RetryContext(Bundle bundle, CurveContext context, boolean stepRestored) {
    }

    /**
     * 지금 판. 응답 헤더 {@code X-Current-Bundle}(D-5)에 쓴다.
     *
     * <p>별 접근을 다시 검사하지 않는다. 이미 통과한 요청의 응답에 값을 얹는 것이고, 여기서 또 막으면
     * 폴링이 판 교체 대신 권한 오류를 보게 된다. 판이 없으면 빈 값이며 헤더를 붙이지 않는다.
     */
    public Optional<String> currentBundleId(long ticId) {
        return gold.findCurrentBundle(ticId).map(bundle -> ExplorationIds.bundle(bundle.id()));
    }

    /** 5.1절 검사 순서: 공개된 별 → 회원이 연 별 → 현재 판. */
    private Bundle openCurrentBundle(long memberId, long ticId) {
        if (!analysis.isPublished(ticId)) {
            throw new BusinessException(ErrorCode.STAR_NOT_PUBLISHED);
        }
        if (!stars.hasUnlocked(memberId, ticId)) {
            throw new BusinessException(ErrorCode.STAR_LOCKED);
        }
        return gold.findCurrentBundle(ticId)
                .orElseThrow(() -> new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE));
    }

    /**
     * 잔차 계산 목표(7.1절). 곡선 조회(5.2절)와 <b>같은 검증</b>을 쓴다. 조회는 되는데 계산은 거절되는
     * 문맥이 생기지 않게 한 곳에서 판단한다.
     *
     * <p>원본은 제거할 것이 없어 계산 대상이 아니다. 7.1절이 빈 배열을 400으로 정한다.
     *
     * <p>본문에는 {@code curveStep}이 없다. <b>중복을 지운 제거 집합에서 센다</b>(2.1절 서버 정렬·중복
     * 제거). 같은 후보를 두 번 보낸 요청이 한 번 보낸 것과 같은 목표가 된다.
     *
     * @throws BusinessException 미공개·미발견·판 교체·형식·조합 오류는 {@link #curve}와 같다
     */
    @Transactional(readOnly = true)
    public CurveContext residualTarget(long memberId, long ticId, CurveQuery query) {
        CurveContext target = resolve(memberId, ticId, query, true).context();
        if (target.curveStep() == 0) {
            throw invalid("removed", "원본은 계산할 것이 없습니다. 제거할 후보를 하나 이상 주십시오.");
        }
        return target;
    }

    private Target resolve(long memberId, long ticId, CurveQuery query) {
        return resolve(memberId, ticId, query, false);
    }

    /**
     * @param stepFromRemoved 제거 집합에서 단계를 센다. 본문 요청(7.1절)에는 보낸 단계가 없어 대조할 것이
     *                        없다. 쿼리(5.2절)는 클라이언트가 보낸 값과 대조해 어긋난 요청을 거절한다
     */
    private Target resolve(long memberId, long ticId, CurveQuery query, boolean stepFromRemoved) {
        Bundle bundle = openCurrentBundle(memberId, ticId);

        Requested requested = Requested.parse(query);
        if (requested.bundleId() != bundle.id()
                || differs(requested.residualModelVersion(), bundle.manifest().residualModelVersion())
                || differs(requested.periodogramConfigVersion(), bundle.manifest().periodogramConfigVersion())) {
            throw new BusinessException(ErrorCode.BUNDLE_CHANGED,
                    Map.of("currentBundleId", ExplorationIds.bundle(bundle.id())));
        }

        if (!stepFromRemoved && requested.curveStep() != requested.removed().size()) {
            throw invalid("curveStep", "제거한 후보 수와 같아야 합니다.");
        }
        if (!requested.removed().isEmpty()
                && !analysis.findMatchedActiveCandidateIds(memberId, ticId).containsAll(requested.removed())) {
            // 매칭하지 않은 후보와 은퇴한 후보를 구분하지 않는다. 구분하면 미매칭 후보 ID가 드러난다.
            throw invalid("removed", "이 별에서 매칭한 활성 후보만 제거할 수 있습니다.");
        }
        return new Target(bundle, contextOf(bundle, requested.removed()));
    }

    /** 현재 판에서 이 후보들을 제거한 곡선 문맥. 제거 후보는 id 숫자 오름차순이다(2.1절). */
    private static CurveContext contextOf(Bundle bundle, Collection<Long> removed) {
        List<String> ids = new TreeSet<>(removed).stream().map(ExplorationIds::candidate).toList();
        return new CurveContext(ExplorationIds.bundle(bundle.id()), ids.size(), ids,
                bundle.manifest().residualModelVersion(), bundle.manifest().periodogramConfigVersion());
    }

    private static boolean differs(String requested, String current) {
        return requested != null && !requested.equals(current);
    }

    private static BusinessException invalid(String field, String reason) {
        return new BusinessException(ErrorCode.VALIDATION_FAILED, ErrorCode.VALIDATION_FAILED.getDefaultMessage(),
                List.of(new FieldError(field, reason)));
    }

    /**
     * 판 요약. 관측 범위의 끝은 마지막 bin의 끝이라 곡선 x축 범위와 같다.
     *
     * <p>한 판의 세그먼트는 비닝 규칙이 하나다(manifest {@code binning}). 여럿이면 적재 계약 위반이다.
     */
    private static BundleSummary bundleOf(Bundle bundle, List<LightCurveSegment> segments) {
        double start = segments.stream().mapToDouble(LightCurveSegment::startBtjd).min().orElseThrow();
        double end = segments.stream()
                .mapToDouble(s -> s.startBtjd() + s.nPoints() * s.binMinutes().doubleValue() / MINUTES_PER_DAY)
                .max().orElseThrow();
        Set<String> revisions = segments.stream().map(LightCurveSegment::binningRevision)
                .collect(Collectors.toCollection(TreeSet::new));
        if (revisions.size() != 1) {
            throw new IllegalStateException(ExplorationIds.bundle(bundle.id()) + "의 세그먼트 비닝 revision이 "
                    + revisions + "로 하나가 아닙니다. 적재 계약이 어긋났습니다.");
        }
        return new BundleSummary(ExplorationIds.bundle(bundle.id()), bundle.bundleVersion(), bundle.publishedAt(),
                bundle.foldReferenceTimeBtjd(), bundle.baseDays(), new double[] {start, end},
                bundle.manifest().residualModelVersion(), bundle.manifest().periodogramConfigVersion(),
                revisions.iterator().next(), CURVE_STEP_RULE);
    }

    /**
     * 선택 규칙. 폭 상한과 빈 구간 허용은 운영 규칙, 최소 창과 미세 조정 폭은 판에서 온다.
     *
     * <p>최소 창은 제공 곡선 케이던스의 2배다(SRS 5.1). 제공 곡선의 케이던스는 bin 크기다
     * (제출 매칭 규칙 v0 {@code minWindowDays}, S15P21C206-128).
     */
    private static SelectionRules selectionRulesOf(OperationRule rule, Bundle bundle,
                                                   List<LightCurveSegment> segments) {
        double minBinMinutes = segments.stream().map(LightCurveSegment::binMinutes)
                .min(Comparator.naturalOrder()).orElseThrow().doubleValue();
        JsonNode halfWidth = bundle.manifest().fineTune().get("half_width_cells");
        if (halfWidth == null || !halfWidth.isIntegralNumber() || !halfWidth.canConvertToInt()
                || halfWidth.intValue() < 0) {
            throw new IllegalStateException(ExplorationIds.bundle(bundle.id())
                    + "의 manifest.fine_tune.half_width_cells가 0 이상 정수가 아닙니다. 적재 계약이 어긋났습니다.");
        }
        OperationRule.Selection selection = rule.selection();
        return new SelectionRules(rule.ruleVersion(), 2 * minBinMinutes / MINUTES_PER_DAY,
                selection.phaseWidthMax(), selection.maxDurationMultipleOfSuggested(),
                selection.allowEmptyPhaseSpan(), new FineTune(halfWidth.intValue()));
    }

    /**
     * 튜토리얼 순번과 건너뛰기 가능 여부(SUB-12).
     *
     * <p>건너뛰기는 그 별을 완료 처리하므로 한 번이라도 완료한 튜토리얼 별은 건너뛸 수 없다. 재개돼도
     * 튜토리얼 완료는 유지한다(9.3절, {@code TutorialRepository.EVER_COMPLETED}).
     */
    private TutorialState tutorialOf(long memberId, long ticId, OperationRule rule, StarViews.Progress progress) {
        Integer seq = tutorials.findActiveSeq(ticId).orElse(null);
        boolean everCompleted = progress != null
                && (COMPLETED.equals(progress.stage()) || progress.completedAt() != null);
        if (seq == null || !rule.tutorial().skipEnabled() || everCompleted) {
            return new TutorialState(seq, false);
        }
        AnalysisRepository.Mismatches mismatches = analysis.countMismatches(memberId, ticId);
        return new TutorialState(seq,
                mismatches.total() >= rule.tutorial().skipAfter() && mismatches.latestAnswerViewed());
    }

    /** 원본 단계는 계산할 것이 없어 항상 완료다. */
    private Residual residualStateOf(long ticId, CurveContext context) {
        return context.curveStep() == 0 ? Residual.ORIGINAL : residualOf(residuals.lookup(ticId, context));
    }

    /** 판이 참조하는 세그먼트를 섹터 순으로. 섹터가 아니라 id로 읽어야 revision이 섞이지 않는다. */
    private List<LightCurveSegment> segmentsOf(Target target) {
        return gold.findSegments(target.bundle().manifest().segmentIds());
    }

    private static Curve curveOf(long ticId, Target target, Residual residual, List<Segment> segments) {
        return new Curve(String.valueOf(ticId), target.context().bundleId(),
                target.bundle().foldReferenceTimeBtjd(), target.context(), residual, FLUX_UNIT, segments);
    }

    private static Periodogram periodogramOf(Target target, GoldCatalogViews.Periodogram original,
                                             Residual residual, Float[] power) {
        Bundle bundle = target.bundle();
        return new Periodogram(target.context().bundleId(), target.context(), residual,
                original.periodMinDays(), original.periodMaxDays(), original.nPeriods(), gridRuleOf(bundle),
                // 주기가 관측 기간의 절반을 넘으면 통과를 두 번 볼 수 없다. 프론트가 그 구간을 음영 처리한다.
                bundle.baseDays().divide(TWO), power);
    }

    private static Residual residualOf(ResidualResultReader.Lookup lookup) {
        return new Residual(lookup.status(), lookup.jobId(), lookup.computedAt());
    }

    static Segment segmentOf(LightCurveSegment segment, Float[] flux) {
        return new Segment(ExplorationIds.segment(segment.id()), segment.sector(), segment.binningRevision(),
                segment.startBtjd(), segment.binMinutes(), segment.nPoints(), flux, segment.fluxScatter(),
                gapsOf(segment));
    }

    private static Float[] residualFlux(ResidualResultReader.Lookup lookup, LightCurveSegment segment) {
        Float[] flux = lookup.segmentFlux().get(segment.id());
        if (flux == null || flux.length != segment.nPoints()) {
            throw new IllegalStateException("잔차 결과가 " + ExplorationIds.segment(segment.id())
                    + "의 점 수와 맞지 않습니다.");
        }
        return flux;
    }

    /**
     * 빈 bin의 {@code [시작, 끝]} 폐구간 (Gold 게시 계약 4절). 어긋나면 적재 계약 위반이다.
     *
     * <p>DB JSONB를 읽은 노드를 그대로 응답에 싣지 않는다. 조회 모델의 노드와 HTTP 직렬화가 쓰는
     * Jackson 판이 달라, 그대로 두면 배열이 아니라 노드 객체의 속성이 나간다.
     */
    static List<int[]> gapsOf(LightCurveSegment segment) {
        JsonNode gaps = segment.gaps();
        if (gaps == null || !gaps.isArray()) {
            throw contractViolation(segment, "gaps가 배열이 아닙니다");
        }
        List<int[]> ranges = new ArrayList<>(gaps.size());
        for (JsonNode gap : gaps) {
            if (!gap.isArray() || gap.size() != 2
                    || !gap.get(0).isIntegralNumber() || !gap.get(1).isIntegralNumber()) {
                throw contractViolation(segment, "gaps 항목이 [시작, 끝] 정수 쌍이 아닙니다");
            }
            long start = gap.get(0).longValue();
            long end = gap.get(1).longValue();
            if (start < 0 || start > end || end >= segment.nPoints()) {
                throw contractViolation(segment, "gaps 범위 [" + start + ", " + end + "]가 점 범위를 벗어났습니다");
            }
            ranges.add(new int[] {(int) start, (int) end});
        }
        return ranges;
    }

    private static IllegalStateException contractViolation(LightCurveSegment segment, String detail) {
        return new IllegalStateException(ExplorationIds.segment(segment.id()) + "의 " + detail
                + ". 적재 계약이 어긋났습니다.");
    }

    /** 주기 격자 간격 규칙. 격자 배열은 저장하지 않으므로 이 값이 없으면 주기를 계산할 수 없다. */
    private static String gridRuleOf(Bundle bundle) {
        JsonNode spacing = bundle.manifest().periodGrid().get("spacing");
        if (spacing == null || !spacing.isTextual()) {
            throw new IllegalStateException(ExplorationIds.bundle(bundle.id())
                    + "의 manifest.period_grid.spacing이 없습니다. 적재 계약이 어긋났습니다.");
        }
        return spacing.asText();
    }

    private record Target(Bundle bundle, CurveContext context) {

        <T> Answer<T> answer(T body, boolean ready) {
            return new Answer<>(body, ready, context.bundleId());
        }
    }

    /**
     * 형식을 검사한 요청 문맥. 제거 후보는 id 숫자 오름차순으로 정렬하고 중복을 없앤다(2.1절).
     *
     * <p>계산 버전은 주면 대조하고 주지 않으면 대조하지 않는다. 쿼리 예시(5.2절)에는 없지만 2.1절이
     * 요청값이 다르면 {@code BUNDLE_CHANGED}로 거절하라고 한다.
     */
    private record Requested(long bundleId, int curveStep, List<Long> removed,
                             String residualModelVersion, String periodogramConfigVersion) {

        private static final int MAX_CURVE_STEP = Short.MAX_VALUE;

        static Requested parse(CurveQuery query) {
            List<FieldError> errors = new ArrayList<>();

            OptionalLong bundleId = ExplorationIds.parse(query.bundleId(), ExplorationIds.BUNDLE);
            if (bundleId.isEmpty()) {
                errors.add(new FieldError("bundleId", "b-<id> 형식이어야 합니다."));
            }

            int curveStep = parseCurveStep(query.curveStep());
            if (curveStep < 0) {
                errors.add(new FieldError("curveStep", "0 이상의 정수여야 합니다."));
            }

            TreeSet<Long> removed = new TreeSet<>();
            for (String value : query.removed() == null ? List.<String>of() : query.removed()) {
                if (value == null || value.isBlank()) {
                    continue;
                }
                OptionalLong id = ExplorationIds.parse(value.strip(), ExplorationIds.CANDIDATE);
                if (id.isEmpty()) {
                    errors.add(new FieldError("removed", "c-<id> 형식이어야 합니다."));
                    break;
                }
                removed.add(id.getAsLong());
            }

            if (!errors.isEmpty()) {
                throw new BusinessException(ErrorCode.VALIDATION_FAILED,
                        ErrorCode.VALIDATION_FAILED.getDefaultMessage(), errors);
            }
            return new Requested(bundleId.getAsLong(), curveStep, List.copyOf(removed),
                    blankToNull(query.residualModelVersion()), blankToNull(query.periodogramConfigVersion()));
        }

        /** 0 또는 앞자리 0이 없는 정수만. 형식이 틀리면 -1. */
        private static int parseCurveStep(String value) {
            if (value == null || value.isEmpty() || value.length() > 5
                    || (value.length() > 1 && value.charAt(0) == '0')) {
                return -1;
            }
            for (int i = 0; i < value.length(); i++) {
                if (value.charAt(i) < '0' || value.charAt(i) > '9') {
                    return -1;
                }
            }
            int step = Integer.parseInt(value);
            return step <= MAX_CURVE_STEP ? step : -1;
        }

        private static String blankToNull(String value) {
            return value == null || value.isBlank() ? null : value;
        }
    }
}
