package com.planetory.backend.domain.exploration.service;

import com.planetory.backend.domain.PublicAnalysisVisibility;

import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import com.planetory.backend.domain.gold.GoldCatalogViews.Candidate;

/** 제출 저장과 최초 응답 보존. 모든 쓰기는 호출자 트랜잭션 안에서 한다. */
@Repository
@RequiredArgsConstructor
public class SubmissionRepository {
    private final JdbcClient jdbc;
    record Existing(long memberId, long ticId, String hash, Integer version, String response) {}
    record Inserted(long id, OffsetDateTime createdAt) {}
    record Disposition(String value, String answerClass, String planetTruth) {}

    boolean tryRequestLock(UUID requestId) {
        // UUID 해시 충돌은 일시 경합일 뿐이다. 동일성은 전체 UUID·회원·해시로 따로 확인한다.
        return jdbc.sql("SELECT pg_try_advisory_xact_lock(?)")
                .param(requestId.getMostSignificantBits() ^ requestId.getLeastSignificantBits())
                .query(Boolean.class).single();
    }
    Optional<Existing> existing(UUID requestId) {
        return jdbc.sql("SELECT user_id,tic_id,request_hash,request_hash_version,response_snapshot::text FROM submissions WHERE request_id=?")
                .param(requestId).query((r, n) -> new Existing(r.getLong(1), r.getLong(2), r.getString(3),
                        r.getObject(4, Integer.class), r.getString(5))).optional();
    }
    boolean lockMember(long memberId) {
        return jdbc.sql("SELECT id FROM users WHERE id=? AND status='active' FOR UPDATE")
                .param(memberId).query(Long.class).optional().isPresent();
    }
    void lockProgress(long memberId, long ticId) {
        jdbc.sql("INSERT INTO user_star_progress(user_id,tic_id) VALUES (?,?) ON CONFLICT(user_id,tic_id) DO NOTHING")
                .params(memberId, ticId).update();
        jdbc.sql("SELECT id FROM user_star_progress WHERE user_id=? AND tic_id=? FOR UPDATE")
                .params(memberId, ticId).query(Long.class).single();
    }
    boolean ownsRetry(long memberId, long ticId, long submissionId) {
        return jdbc.sql("SELECT EXISTS(SELECT 1 FROM submissions WHERE id=? AND user_id=? AND tic_id=?)")
                .params(submissionId, memberId, ticId).query(Boolean.class).single();
    }
    Set<Long> recognized(long memberId) {
        return Set.copyOf(jdbc.sql("SELECT candidate_id FROM user_candidate_achievements WHERE user_id=?")
                .param(memberId).query(Long.class).list());
    }
    Disposition disposition(long candidateId) {
        return jdbc.sql("SELECT disposition,answer_class,planet_truth FROM candidate_dispositions WHERE candidate_id=?")
                .param(candidateId).query((r, n) -> new Disposition(r.getString(1), r.getString(2), r.getString(3)))
                .optional().orElseThrow(() -> new com.planetory.backend.global.error.BusinessException(
                        com.planetory.backend.global.error.ErrorCode.DEPENDENCY_UNAVAILABLE));
    }
    Inserted insert(long memberId, long ticId, long bundleId, SubmissionRequest request, String hash,
                    String rule, double reference, SubmissionMatching.Derived derived,
                    SubmissionViews.Match match, String achievement, String evidenceJson) {
        var selection = request.selection();
        // V5는 duplicate를 포함해 matched_harmonic 외의 정정 열을 NULL로 요구한다.
        boolean harmonic = "matched_harmonic".equals(match.status());
        return jdbc.sql("""
                INSERT INTO submissions(user_id,tic_id,bundle_id,request_id,submission_kind,curve_step,
                    removed_candidate_ids,submitted_period,matched_period,harmonic_multiplier,phase_start,phase_end,
                    fold_reference_time_btjd,epoch_btjd,duration_hours,user_judgment,evidence_checks,match_result,
                    matched_candidate_id,achievement_result,retry_of_submission_id,correction_reason,
                    residual_model_version,periodogram_config_version,memo,rule_version,
                    source_peak_grid_index,source_peak_suggested_duration_hours,duration_limit_hours,
                    request_hash,request_hash_version,created_at)
                VALUES (:member,:tic,:bundle,:request,:kind,:step,:removed,:period,:corrected,:multiplier,:start,:end,
                    :reference,:epoch,:duration,:judgment,CAST(:evidence AS jsonb),:match,:candidate,:achievement,
                    :retry,:reason,:residual,:periodogram,:memo,:rule,:peak,:suggested,:limit,:hash,1,clock_timestamp())
                RETURNING id,created_at
                """)
                .param("member", memberId).param("tic", ticId).param("bundle", bundleId)
                .param("request", UUID.fromString(request.requestId())).param("kind", request.submissionKind())
                .param("step", request.curveContext().curveStep()).param("removed", request.removedIds().toArray(Long[]::new))
                .param("period", decimal(selection == null ? null : selection.periodDays()))
                .param("corrected", decimal(harmonic ? match.correctedPeriodDays() : null))
                .param("multiplier", decimal(harmonic ? match.harmonicMultiplier() : null))
                .param("start", decimal(selection == null ? null : selection.phaseStart()))
                .param("end", decimal(selection == null ? null : selection.phaseEnd())).param("reference", reference)
                .param("epoch", decimal(derived == null ? null : derived.epochBtjd()))
                .param("duration", decimal(derived == null ? null : derived.durationHours()))
                .param("judgment", request.userJudgment()).param("evidence", evidenceJson).param("match", match.status())
                .param("candidate", match.candidateId() == null ? null : SubmissionRequest.id(match.candidateId(), "c-", "match"))
                .param("achievement", achievement).param("retry", request.retryOfSubmissionId() == null ? null
                        : SubmissionRequest.id(request.retryOfSubmissionId(), "sub-", "retryOfSubmissionId"))
                .param("reason", harmonic ? match.correctionReason() : null)
                .param("residual", request.curveContext().residualModelVersion())
                .param("periodogram", request.curveContext().periodogramConfigVersion()).param("memo", request.memo())
                .param("rule", rule).param("peak", selection == null ? null : selection.sourcePeakGridIndex())
                .param("suggested", decimal(derived == null ? null : derived.sourcePeakSuggestedDurationHours()))
                .param("limit", decimal(derived == null ? null : derived.durationLimitHours())).param("hash", hash)
                .query((r, n) -> new Inserted(r.getLong(1), r.getObject(2, OffsetDateTime.class))).single();
    }
    long history(long submission, long member, long tic, String params, String versions) {
        return jdbc.sql("""
                INSERT INTO analysis_histories(submission_id,user_id,tic_id,snapshot_params,versions)
                VALUES (?,?,?,CAST(? AS jsonb),CAST(? AS jsonb)) RETURNING id
                """).params(submission, member, tic, params, versions).query(Long.class).single();
    }
    void snapshot(long history, FoldedSnapshot snapshot) {
        jdbc.sql("INSERT INTO analysis_snapshots(history_id,bins,folded_flux,folded_err) VALUES (?,?,?,?)")
                .params(history, snapshot.bins(), snapshot.foldedFlux(), snapshot.foldedError()).update();
    }
    void progress(long member, long tic, int curveStep, int planetCount, boolean skipped) {
        jdbc.sql("""
                UPDATE user_star_progress SET planet_count=:count,current_curve_step=:step,
                    progress_stage=CASE WHEN :skipped THEN 'completed'
                        WHEN progress_stage='unexplored' THEN 'in_progress' ELSE progress_stage END,
                    completion_reason=CASE WHEN :skipped THEN 'skipped' ELSE completion_reason END,
                    completed_at=CASE WHEN :skipped THEN COALESCE(completed_at,clock_timestamp()) ELSE completed_at END,
                    reopen_pending=CASE WHEN :skipped THEN false ELSE reopen_pending END
                WHERE user_id=:member AND tic_id=:tic
                """).param("member", member).param("tic", tic).param("step", curveStep)
                .param("count", planetCount).param("skipped", skipped).update();
    }
    /**
      * 6.7절 상세 보기. 이미 본 제출을 다시 봐도 값이 달라지지 않는다.
      *
      * <p>대상은 <b>처음 고른 것만</b> 남긴다. {@code COALESCE}가 그 일을 하므로 두 요청이 겹쳐도
      * 먼저 쓴 값이 이긴다. 매번 덮어쓰면 후보표가 바뀔 때 같은 제출의 답이 달라진다.
      *
      * <p><b>실제로 저장된 대상을 돌려준다.</b> 겹친 요청이 각자 고른 대상으로 응답을 만들면 저장은
      * 하나인데 같은 제출에 두 답이 나간다. 호출자는 이 값으로 응답을 만든다.
      *
      * @return 이 제출에 남은 대상 후보 ID
      */
    long markDetailViewed(long submissionId, long candidateId) {
        return jdbc.sql("UPDATE submissions SET answer_viewed = true,"
                        + " detail_target_candidate_id = COALESCE(detail_target_candidate_id, ?) WHERE id = ?"
                        + " RETURNING detail_target_candidate_id")
                .params(candidateId, submissionId).query(Long.class).single();
    }

    void saveResponse(long submission, String response) {
        if (jdbc.sql("UPDATE submissions SET response_snapshot=CAST(? AS jsonb) WHERE id=? AND response_snapshot IS NULL")
                .params(response, submission).update() != 1) throw new IllegalStateException("최초 제출 응답 저장 실패");
    }
    /** COM-14: 채점형은 첫 매칭, 미확정은 최신 유효 공개 한 건/회원이다. */
    Map<String, Object> statistics(long candidate, Disposition disposition) {
        boolean graded = "graded".equals(disposition.answerClass());
        String source = graded ? """
                SELECT DISTINCT ON (s.user_id) s.user_judgment FROM submissions s
                WHERE s.matched_candidate_id=? AND s.match_result IN ('matched','matched_harmonic')
                ORDER BY s.user_id,s.created_at,s.id
                """ : """
                SELECT DISTINCT ON (s.user_id) s.user_judgment FROM published_analyses pa
                JOIN posts p ON p.id=pa.post_id JOIN analysis_histories h ON h.id=pa.history_id
                JOIN submissions s ON s.id=h.submission_id
                WHERE pa.candidate_id=? AND %s
                ORDER BY s.user_id,s.created_at DESC,s.id DESC
                """.formatted(PublicAnalysisVisibility.VISIBLE);
        return jdbc.sql("SELECT count(*) AS total, count(*) FILTER (WHERE user_judgment='LIKELY_PLANET') AS likely,"
                + " count(*) FILTER (WHERE user_judgment='UNLIKELY_PLANET') AS unlikely,"
                + " count(*) FILTER (WHERE user_judgment='UNSURE') AS unsure,clock_timestamp() AS at FROM ("+source+") votes")
                .param(candidate).query((r,n)-> {
                    long total=r.getLong("total"), likely=r.getLong("likely"), unlikely=r.getLong("unlikely"), unsure=r.getLong("unsure");
                    Map<String,Object> result=new LinkedHashMap<>();
                    result.put("kind",graded?"graded":"public_analyses");
                    if (graded) {
                        result.put("matchedMemberCount",total);
                        result.put("agreementPercent",percent("planet".equals(disposition.planetTruth())?likely:unlikely,total));
                    } else {
                        result.put("candidateId",ExplorationIds.candidate(candidate)); result.put("participantCount",total);
                        result.put("likelyPlanet",likely); result.put("unlikelyPlanet",unlikely); result.put("unsure",unsure);
                        result.put("percentages",total==0?null:Map.of("likelyPlanet",percent(likely,total),
                                "unlikelyPlanet",percent(unlikely,total),"unsure",percent(unsure,total)));
                        result.put("asOf",r.getObject("at",OffsetDateTime.class));
                    }
                    return result;
                }).single();
    }
    private static Double percent(long count,long total) { return total==0?null:Math.round(count*1000.0/total)/10.0; }
    Map<String, Object> signal(long member, Candidate candidate, Disposition disposition) {
        Map<String, Object> signal = new LinkedHashMap<>();
        signal.put("candidateId", ExplorationIds.candidate(candidate.id()));
        signal.put("disposition", AchievementRepository.apiDisposition(disposition.value()));
        signal.put("answerClass", disposition.answerClass());
        signal.put("planetTruth", disposition.planetTruth());
        Map<String, Object> bls = new LinkedHashMap<>();
        bls.put("periodDays", candidate.periodDays()); bls.put("epochBtjd", candidate.epochBtjd());
        bls.put("durationHours", candidate.durationHours()); bls.put("depthPpm", candidate.depthPpm());
        // Gold 현재 스키마에는 SDE/SNR 열이 없다. 없는 수치를 만들어 내지 않는다.
        bls.put("sde", null); bls.put("snr", null); signal.put("bls", bls);
        Map<String, Object> ai = jdbc.sql("""
                SELECT x.status,e.score,e.verdict,x.model_version FROM ai_evaluations e
                JOIN ai_executions x ON x.id=e.execution_id WHERE e.candidate_id=?
                ORDER BY x.started_at DESC,e.id DESC LIMIT 1
                """).param(candidate.id()).query((r, n) -> {
                    Map<String,Object> m = new LinkedHashMap<>();
                    m.put("status", r.getString(1)); m.put("score", r.getBigDecimal(2));
                    m.put("verdict", r.getString(3)); m.put("modelVersion", r.getString(4)); return m;
                }).optional().orElseGet(() -> {
                    Map<String,Object> m = new LinkedHashMap<>(); m.put("status", "not_evaluated");
                    m.put("score", null); m.put("verdict", null); m.put("modelVersion", null); return m;
                });
        signal.put("ai", ai);
        signal.put("external", jdbc.sql("SELECT source,external_id,disposition,fetched_on FROM external_signal_references WHERE candidate_id=? ORDER BY id")
                .param(candidate.id()).query((r, n) -> {
                    Map<String,Object> m = new LinkedHashMap<>();
                    m.put("source", r.getString(1)); m.put("externalId", r.getString(2));
                    m.put("disposition", r.getString(3)); m.put("fetchedOn", r.getObject(4, java.time.LocalDate.class)); return m;
                }).list());
        signal.put("relabel", jdbc.sql("SELECT relabeled_at,relabel_disposition FROM user_candidate_achievements WHERE user_id=? AND candidate_id=? AND relabeled_at IS NOT NULL")
                .params(member,candidate.id()).query((r,n)->new AchievementViews.Relabel(
                        r.getObject(1,OffsetDateTime.class),AchievementRepository.apiDisposition(r.getString(2)))).optional().orElse(null));
        return signal;
    }
    private static BigDecimal decimal(Double value) { return value == null ? null : BigDecimal.valueOf(value); }
}
