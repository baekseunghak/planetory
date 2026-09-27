package com.planetory.backend.domain.exploration.service;

import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.function.Supplier;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.dao.DataAccessException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import com.planetory.backend.domain.gold.GoldCatalogRepository;
import com.planetory.backend.domain.gold.GoldCatalogViews.*;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import static com.planetory.backend.domain.exploration.service.HistoryViews.*;
import static com.planetory.backend.domain.exploration.service.SubmissionRequest.invalid;

/** History 읽기 전용 경계. 저장/재판정/진행 갱신/잔차 작업 생성은 하지 않는다. */
@Service
@RequiredArgsConstructor
public class HistoryService {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private final HistoryRepository histories;
    private final GoldCatalogRepository gold;
    private final ResidualResultReader residuals;
    private final StarRepository stars;
    private final AnalysisRepository analysis;
    private final SubmissionRepository submissions;
    private final PlatformTransactionManager transactions;

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Page list(long member, Query query) {
        HistoryQuery q = HistoryQuery.parse(member, query);
        List<HistoryRepository.Row> rows = histories.list(q);
        boolean more = rows.size() > q.size();
        List<HistoryRepository.Row> page = rows.subList(0, Math.min(rows.size(), q.size()));
        String cursor = more ? q.next(page.getLast().submittedAt(), page.getLast().submissionId()) : null;
        return new Page(page.stream().map(this::item).toList(), cursor, more);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Detail detail(long member, String historyId) {
        var row = own(member, id(historyId));
        var result = currentResult(row);
        var view = result.original().viewState();
        return new Detail(row.historyId(), result, versions(row),
                new SnapshotParams(view == null ? null : view.periodogramViewport(),
                        view == null ? null : view.foldedXZoomRatio(),
                        new FoldSettings(result.serverDerived().foldReferenceTimeBtjd()),
                        result.serverDerived().centroidDataStatus()), row.previous(), row.relabel(), row.createdAt());
    }

    public record PublicationBasis(long submissionId, long ticId, long candidateId) {}

    /** 첫 공개 자격은 제출 당시 판정이다. 현재 라벨·후보 목록으로 재판정하지 않는다(F07-Q2). */
    @Transactional(propagation = Propagation.MANDATORY)
    public PublicationBasis publicationBasis(long member, String historyId) {
        var row = own(member, id(historyId));
        var saved = row.submission().path("response_snapshot");
        if (!saved.isObject()) throw unavailable();
        if (!publicationEligible(saved)) throw new BusinessException(ErrorCode.PUBLICATION_NOT_ELIGIBLE);
        long candidate = ExplorationIds.parse(saved.path("match").path("candidateId").asText(), ExplorationIds.CANDIDATE)
                .orElseThrow(HistoryService::unavailable);
        if (row.submission().path("user_id").asLong() != member
                || row.submission().path("tic_id").asLong() != row.tic()) throw unavailable();
        return new PublicationBasis(row.submissionId(), row.tic(), candidate);
    }

    private static boolean publicationEligible(JsonNode saved) {
        return "analysis".equals(saved.path("signal").path("answerClass").asText())
                && Set.of("matched", "matched_harmonic", "duplicate").contains(saved.path("match").path("status").asText());
    }

    public Graph graph(long member, String historyId, String mode) {
        long id = id(historyId);
        return graph(mode(mode), false, () -> own(member, id));
    }

    /**
     * S07/S14 전용 내부 진입점. 호출자가 매번 부모 공개 상태와 실제 연결 관계를 검증해야 한다.
     * checkAccess는 DB 조회만 하며 실패 시 예외를 던진다. 공개 HTTP 경로 자체는 여기서 열지 않는다.
     * 그래프를 별도 조회하여 503일 때도 이 공개 내용은 보존할 수 있다.
     */
    public PublicHistory publicContent(String historyId, Runnable checkAccess) {
        long id = id(historyId);
        Objects.requireNonNull(checkAccess);
        PublicHistory content = read(() -> {
            checkAccess.run();
            var row = find(id);
            var s = row.submission();
            var match = match(row);
            return new PublicHistory(row.historyId(), Long.toString(row.tic()), candidate(s), row.submittedAt(),
                    text(s,"user_judgment"), JSON.convertValue(s.path("evidence_checks"),
                    new tools.jackson.core.type.TypeReference<List<String>>() {}), text(s,"memo"),
                    new PublicOriginal(number(s,"submitted_period"), integer(s,"source_peak_grid_index"),
                            number(s,"phase_start"), number(s,"phase_end")),
                    new PublicDerived(number(s,"epoch_btjd"),number(s,"duration_hours")),
                    new PublicMatch(match.status(),match.correctedPeriodDays(),match.harmonicMultiplier()),
                    submittedContext(row),versions(row),null,row.relabel());
        }, TransactionDefinition.ISOLATION_REPEATABLE_READ);
        read(() -> { checkAccess.run(); return true; }, TransactionDefinition.ISOLATION_READ_COMMITTED);
        return content;
    }

    /** 재시도와 반환 직전에도 부모 권한을 다시 검사한다. 타인의 jobId는 반환하지 않는다. */
    public Graph publicGraph(String historyId, String mode, Runnable checkAccess) {
        long id = id(historyId);
        Objects.requireNonNull(checkAccess);
        return graph(mode(mode), true, () -> { checkAccess.run(); return find(id); });
    }

    private record GraphAttempt(Graph graph, long bundle, RuntimeException failure) {}

    private Graph graph(String mode, boolean publicRead, Supplier<HistoryRepository.Row> authorized) {
        for (int attempt = 0; attempt < 2; attempt++) {
            GraphAttempt result = read(() -> {
                var row = authorized.get();
                Bundle current = gold.findCurrentBundle(row.tic()).orElseThrow(HistoryService::unavailable);
                try { return new GraphAttempt(buildGraph(row,current,mode,publicRead),current.id(),null); }
                catch (BusinessException e) {
                    if (e.getErrorCode()!=ErrorCode.DEPENDENCY_UNAVAILABLE) throw e;
                    return new GraphAttempt(null,current.id(),e);
                }
                catch (IllegalStateException | DataAccessException e) {
                    // 적재/캐시 배열 계약 위반도 정상적인 빈 그래프로 숨기지 않는다.
                    return new GraphAttempt(null,current.id(),unavailable());
                }
            }, TransactionDefinition.ISOLATION_REPEATABLE_READ);
            // RR 트랜잭션 안에서 다시 검사하면 archived 전환을 볼 수 없다. 새 스냅샷에서 검사한다.
            boolean valid = read(() -> {
                var row = authorized.get();
                return !mode.equals("CURRENT") || histories.stillCurrent(row.tic(),result.bundle());
            }, TransactionDefinition.ISOLATION_READ_COMMITTED);
            if (valid) {
                if (result.failure()!=null) throw result.failure();
                return result.graph();
            }
        }
        throw new BusinessException(ErrorCode.GRAPH_TEMPORARILY_UNAVAILABLE);
    }

    private Graph buildGraph(HistoryRepository.Row row, Bundle current, String mode, boolean publicRead) {
        var submitted = submittedContext(row);
        Set<String> active = gold.findCandidates(row.tic()).stream().filter(c -> c.status()==Candidate.Status.ACTIVE)
                .map(c -> ExplorationIds.candidate(c.id())).collect(Collectors.toSet());
        boolean restorable = active.containsAll(submitted.removedCandidateIds());
        String fallback = restorable ? null : "RETIRED_CANDIDATE";
        var context = context(current, restorable ? submitted.removedCandidateIds() : List.of());
        AnalysisViews.Curve curve = null;
        Snapshot snapshot = null;
        if (mode.equals("SUBMITTED")) {
            snapshot = histories.snapshot(row.id()).orElse(null);
            if (snapshot!=null) validate(snapshot);
        } else {
            ResidualResultReader.Lookup lookup = null;
            if (context.curveStep() > 0) {
                try { lookup = residuals.lookup(current.ticId(), context); }
                catch (RuntimeException e) { throw unavailable(); }
                if (lookup == null) throw unavailable();
                if (publicRead && !lookup.completed()) {
                    context = context(current,List.of());
                    fallback = "RESIDUAL_NOT_AVAILABLE";
                }
            }
            List<AnalysisViews.Segment> segments = null;
            AnalysisViews.Residual state;
            if (context.curveStep()==0) {
                state = AnalysisViews.Residual.ORIGINAL;
                segments = segments(current).stream().map(s -> AnalysisService.segmentOf(s,s.flux())).toList();
            } else {
                state = new AnalysisViews.Residual(lookup.status(),publicRead ? null : lookup.jobId(),lookup.computedAt());
                if (lookup.completed()) {
                    var completed = lookup;
                    segments = segments(current).stream().map(s -> AnalysisService.segmentOf(s,residualFlux(completed,s))).toList();
                }
            }
            curve = new AnalysisViews.Curve(Long.toString(row.tic()),ExplorationIds.bundle(current.id()),current.foldReferenceTimeBtjd(),
                    context,state,AnalysisService.FLUX_UNIT,segments);
        }
        return new Graph(row.historyId(),new Reproduction(ExplorationIds.bundle(row.bundle()),ExplorationIds.bundle(current.id()),
                row.bundle()!=current.id(),fallback==null,fallback,current.foldReferenceTimeBtjd()),selection(row,current,mode),curve,snapshot,
                text(row.versions(),"snapshotVersion"));
    }

    private List<LightCurveSegment> segments(Bundle bundle) {
        List<LightCurveSegment> segments = gold.findSegments(bundle.ticId(), bundle.manifest().segmentIds());
        if (segments.isEmpty() || segments.size()!=bundle.manifest().segmentIds().size()) throw unavailable();
        for (var s : segments) if (s.ticId()!=bundle.ticId() || s.flux()==null || s.flux().length!=s.nPoints()) throw unavailable();
        return segments;
    }
    private static void validate(Snapshot snapshot) {
        if (snapshot.bins()!=150 || snapshot.foldedFlux().length!=150 || snapshot.foldedError().length!=150) throw unavailable();
        for (int i=0;i<150;i++) {
            Float flux=snapshot.foldedFlux()[i],error=snapshot.foldedError()[i];
            if (flux!=null && !Float.isFinite(flux) || error!=null && (!Float.isFinite(error) || error<0)
                    || flux==null && error!=null) throw unavailable();
        }
    }
    private static Float[] residualFlux(ResidualResultReader.Lookup lookup, LightCurveSegment s) {
        Float[] values = lookup.segmentFlux()==null ? null : lookup.segmentFlux().get(s.id());
        if (values==null || values.length!=s.nPoints()) throw unavailable();
        for (int i=0;i<values.length;i++) {
            if ((values[i]==null)!=(s.flux()[i]==null) || values[i]!=null && !Float.isFinite(values[i])) throw unavailable();
        }
        return values;
    }
    private static Selection selection(HistoryRepository.Row row, Bundle bundle, String mode) {
        var s = row.submission();
        Double period=number(s,"submitted_period"), epoch=number(s,"epoch_btjd"), duration=number(s,"duration_hours");
        Double start=null,end=null;
        if (mode.equals("CURRENT") && period!=null && epoch!=null && duration!=null) {
            double[] window=phaseWindow(period,epoch,duration,bundle.foldReferenceTimeBtjd());
            start=window[0]; end=window[1];
        }
        var match=match(row);
        return new Selection(period,match.correctedPeriodDays(),match.harmonicMultiplier(),epoch,duration,start,end);
    }
    private static AnalysisViews.CurveContext context(Bundle b,List<String> removed) {
        return new AnalysisViews.CurveContext(ExplorationIds.bundle(b.id()),removed.size(),removed,
                b.manifest().residualModelVersion(),b.manifest().periodogramConfigVersion());
    }
    private static AnalysisViews.CurveContext submittedContext(HistoryRepository.Row row) {
        var s=row.submission();
        List<String> removed = JSON.convertValue(s.path("removed_candidate_ids"),new tools.jackson.core.type.TypeReference<List<Long>>() {})
                .stream().sorted().map(ExplorationIds::candidate).toList();
        return new AnalysisViews.CurveContext(ExplorationIds.bundle(row.bundle()),s.path("curve_step").asInt(),removed,
                text(s,"residual_model_version"),text(s,"periodogram_config_version"));
    }
    private Item item(HistoryRepository.Row row) {
        var s=row.submission();
        return new Item(row.historyId(),ExplorationIds.submission(row.submissionId()),Long.toString(row.tic()),candidate(s),
                text(s,"submission_kind"),text(s,"match_result"),text(s,"user_judgment"),text(s,"achievement_result"),
                row.submittedAt(),ExplorationIds.bundle(row.bundle()),row.previous(),s.path("curve_step").asInt(),row.publication(),
                row.granted(),row.snapshotAvailable(),row.detailAvailable(),s.path("answer_viewed").asBoolean(),row.relabel(),
                s.path("retry_of_submission_id").isNumber()?ExplorationIds.submission(s.path("retry_of_submission_id").asLong()):null);
    }
    private Versions versions(HistoryRepository.Row row) {
        var v=row.versions();
        // 현재 값으로 채우지 않는다. 당시 저장하지 않은 preprocess/pipeline 정보는 null이다.
        return new Versions(first(v,"data","bundleVersion"),text(v,"preprocess"),text(v,"pipeline"),
                first(v,"rule","ruleVersion"),first(v,"residualModel","residualModelVersion"),
                first(v,"periodogramConfig","periodogramConfigVersion"),text(v,"snapshotVersion"));
    }
    private SubmissionViews.Result currentResult(HistoryRepository.Row row) {
        JsonNode saved=row.submission().path("response_snapshot");
        // 최초 판정의 근거가 없는 legacy 기록을 현재 후보로 재판정하지 않는다.
        if (!saved.isObject()) throw unavailable();
        var first=JSON.treeToValue(saved,SubmissionViews.Result.class);
        var counted=stars.countAchievements(row.member(),row.tic());
        var star=new StarViews.Achievement(counted.count(),StarService.grade(counted.count()),counted.byType());
        var progress=stars.findProgress(row.member(),row.tic()).orElse(null);
        var matched=analysis.findMatchedActiveCandidateIds(row.member(),row.tic());
        var candidates=gold.findCandidates(row.tic());
        long remaining=candidates.stream().filter(c -> c.status()==Candidate.Status.ACTIVE && c.discoverable() && !matched.contains(c.id())).count();
        var p=progress==null ? new SubmissionViews.Progress("unexplored",null,false,0,List.of(),remaining)
                : new SubmissionViews.Progress(progress.stage(),progress.completionReason(),progress.reopenPending(),
                    progress.currentCurveStep()==null?0:progress.currentCurveStep(),matched.stream().sorted().map(ExplorationIds::candidate).toList(),remaining);
        var selected=candidates.stream().filter(c -> ExplorationIds.candidate(c.id()).equals(first.match().candidateId())).findFirst().orElse(null);
        var disposition=selected==null?null:submissions.disposition(selected.id());
        boolean eligible=publicationEligible(saved);
        var publication=new SubmissionViews.Publication(row.publication().isPublic()?"PUBLISHED":
                row.publication().isModerationHidden()?"HIDDEN":eligible?"UNPUBLISHED":"NOT_ELIGIBLE",row.publication().publicAnalysisId());
        return new SubmissionViews.Result(first.submissionId(),first.historyId(),first.requestId(),first.ticId(),first.bundleId(),
                first.ruleVersion(),first.submittedAt(),first.submissionKind(),first.curveContext(),first.original(),first.serverDerived(),
                first.match(),selected==null?null:submissions.signal(row.member(),selected,disposition),first.judgment(),first.skyVersion(),
                new SubmissionViews.Achievement(first.achievement().result(),first.achievement().newlyRecognized(),first.achievement().unlockedStars(),star),
                p,publication,selected==null?null:submissions.statistics(selected.id(),disposition),
                new SubmissionViews.Detail(first.detail().available(),first.detail().targetKind(),row.submission().path("answer_viewed").asBoolean()),
                first.tutorial(),first.nextActions());
    }
    /**
     * 6.6절 제출 조회. 8.2절 상세와 <b>같은 본문</b>이며 키만 제출 ID다.
     *
     * <p>당시 값과 조회 시점 값을 가르는 규칙이 하나뿐이어야 해서 같은 재구성 함수를 쓴다. 두 벌이 되면
     * 같은 제출이 화면마다 다른 진행·공개 상태를 말한다.
     *
     * @throws BusinessException 없으면 {@code RESOURCE_NOT_FOUND}, 타인 제출이면 {@code FORBIDDEN}
     */
    SubmissionViews.Result resultOf(long member, long submissionId) {
        return currentResult(ownedSubmission(member, submissionId));
    }

    /** 6.6절 응답 유실 복구. 찾은 제출이 타인 것이면 6.6절과 같은 403이다. */
    SubmissionViews.Result resultOfRequest(long member, java.util.UUID requestId) {
        return currentResult(owned(member, histories.findByRequest(requestId)));
    }

    /** 6.7·6.8절은 본문을 다시 만들지 않고 저장된 당시 응답만 읽는다. */
    HistoryRepository.Row ownedSubmission(long member, long submissionId) {
        return owned(member, histories.findBySubmission(submissionId));
    }

    private HistoryRepository.Row owned(long member, java.util.Optional<HistoryRepository.Row> found) {
        var row = found.orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        if (row.member() != member) throw new BusinessException(ErrorCode.FORBIDDEN);
        return row;
    }

    /**
     * 현재 판 기준 시각으로 위상 창을 다시 만든다(HIS-02). <b>저장된 위상을 복사하지 않는다</b> — 판이
     * 바뀌면 같은 통과가 다른 위상에 온다. 절대 시각과 지속 시간만이 판을 건너도 같은 값이다.
     *
     * <p>8.3절 {@code CURRENT}와 6.8절 다시 풀기 초안이 같은 식을 쓴다. 두 벌이 되면 같은 제출을
     * 이어 풀 때와 되돌아볼 때 창이 다른 자리에 그려진다.
     *
     * @return {@code [phaseStart, phaseEnd]}. 끝은 1을 넘을 수 있다 — 창이 경계를 지나면 이어진 값이다
     */
    static double[] phaseWindow(double period, double epochBtjd, double durationHours, double foldReferenceTimeBtjd) {
        double center = (epochBtjd - foldReferenceTimeBtjd) / period;
        center -= Math.floor(center);
        double width = durationHours / 24 / period;
        double start = center - width / 2;
        start -= Math.floor(start);
        return new double[] {start, start + width};
    }

    private static SubmissionViews.Match match(HistoryRepository.Row row) {
        JsonNode original=row.versions().path("originalMatch");
        if (original.isObject()) return JSON.treeToValue(original,SubmissionViews.Match.class);
        var s=row.submission();
        return new SubmissionViews.Match(text(s,"match_result"),candidate(s),number(s,"harmonic_multiplier"),
                number(s,"matched_period"),text(s,"correction_reason"),null);
    }
    private HistoryRepository.Row own(long member,long id) {
        var row=find(id);
        if (row.member()!=member) throw new BusinessException(ErrorCode.FORBIDDEN);
        return row;
    }
    private HistoryRepository.Row find(long id) { return histories.find(id).orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND)); }
    private static long id(String value) { return ExplorationIds.parse(value,"h-").orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND)); }
    private static String mode(String mode) {
        if (mode==null) return "CURRENT";
        if (!Set.of("CURRENT","SUBMITTED").contains(mode)) throw invalid("mode");
        return mode;
    }
    private <T> T read(Supplier<T> action,int isolation) {
        var tx=new TransactionTemplate(transactions);
        tx.setReadOnly(true); tx.setIsolationLevel(isolation);
        tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        return tx.execute(status -> action.get());
    }
    private static String text(JsonNode node,String key) { return node.path(key).isString()?node.path(key).asText():null; }
    private static String first(JsonNode n,String a,String b) { return text(n,a)==null?text(n,b):text(n,a); }
    private static Double number(JsonNode n,String key) { return n.path(key).isNumber()?n.path(key).asDouble():null; }
    private static Integer integer(JsonNode n,String key) { return n.path(key).isIntegralNumber()?n.path(key).asInt():null; }
    private static String candidate(JsonNode s) { return s.path("matched_candidate_id").isNumber()?ExplorationIds.candidate(s.path("matched_candidate_id").asLong()):null; }
    private static BusinessException unavailable() { return new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE); }
}
