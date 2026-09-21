package com.planetory.backend.domain.post.service;

import com.fasterxml.jackson.annotation.JsonUnwrapped;
import com.planetory.backend.domain.exploration.service.ExplorationIds;
import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.TransientDataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.MultiValueMap;
import tools.jackson.databind.JsonNode;

@Service
@RequiredArgsConstructor
@Slf4j
public class PublicAnalysisBatchService {
    private final JdbcClient jdbc;
    private final PublicAnalysisService publications;
    private final StarService stars;

    public sealed interface Result permits Success, Failure {}
    public record Success(String status, @JsonUnwrapped PublicAnalysisService.Published publication) implements Result {}
    public record Error(String code, String message) {}
    public record Failure(String historyId, String status, Error error, boolean retryable) implements Result {}
    public record Batch(List<Result> results) {}
    public record Candidate(String historyId, String submissionId, String ticId, String candidateId,
                            OffsetDateTime submittedAt, String userJudgment) {}
    public record Page(List<Candidate> items, String nextCursor, boolean hasMore) {}
    private record Own(long id, long tic, String candidate) {}

    /** 바깥 트랜잭션을 배제해 각 publish 프록시 호출의 commit/rollback을 독립시킨다. */
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public Batch publish(long member, JsonNode request) {
        if (request == null || !request.isObject() || request.size() != 2
                || !request.path("ticId").isString() || !request.path("items").isArray()
                || request.path("items").isEmpty() || request.path("items").size() > 20) throw invalid();
        long tic = ExplorationIds.parseTic(request.path("ticId").stringValue()).orElseThrow(PublicAnalysisBatchService::invalid);
        var ids = new ArrayList<Long>();
        for (var item : request.path("items")) {
            if (!item.isObject() || item.size() != 1 || !item.path("historyId").isString()) throw invalid();
            long id = ExplorationIds.parse(item.path("historyId").stringValue(), "h-").orElseThrow(PublicAnalysisBatchService::invalid);
            if (ids.contains(id)) throw invalid();
            ids.add(id);
        }
        // 타인·없는 기록에서는 신호를 읽지 않는다. 존재/소유권 오류는 단건 경로가 항목별로 판정한다.
        var own = jdbc.sql("""
                SELECT h.id,h.tic_id,s.response_snapshot #>> '{match,candidateId}' AS candidate
                FROM analysis_histories h JOIN submissions s ON s.id=h.submission_id
                WHERE h.user_id=:member AND s.user_id=:member AND h.id IN (:ids)
                """).param("member", member).param("ids", ids)
                .query((r, n) -> new Own(r.getLong(1), r.getLong(2), r.getString(3))).list();
        var signals = new HashSet<String>();
        for (var row : own) {
            if (ExplorationIds.parse(row.candidate(), ExplorationIds.CANDIDATE).isPresent()
                    && !signals.add(row.candidate())) throw invalid();
        }
        var results = new ArrayList<Result>();
        for (long id : ids) {
            String history = "h-" + id;
            try {
                if (own.stream().anyMatch(row -> row.id() == id && row.tic() != tic))
                    throw new BusinessException(ErrorCode.TIC_MISMATCH);
                var result = publications.publish(member, history);
                results.add(new Success(result.isPublic() ? "PUBLISHED" : "NOT_PUBLISHED", result));
            } catch (BusinessException e) {
                // 503만으로 재시도 가능성을 추측하지 않는다. 근거 없는 snapshot 손상도 503이다.
                results.add(failure(history, e.getErrorCode(), Boolean.TRUE.equals(e.getDetails().get("retryable"))));
            } catch (TransientDataAccessException e) {
                results.add(failure(history, ErrorCode.DEPENDENCY_UNAVAILABLE, true));
            } catch (RuntimeException e) {
                // 결과 불명·내부 결함을 성공이나 자동 재시도 대상으로 바꾸지 않는다. DB 메시지는 반환하지 않는다.
                log.error("Batch publication failed: {}", e.getClass().getSimpleName());
                results.add(failure(history, ErrorCode.INTERNAL_ERROR, false));
            }
        }
        return new Batch(List.copyOf(results));
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Page candidates(long member, MultiValueMap<String, String> params) {
        CommunityQuery.only(params, Set.of("ticId", "size", "cursor"));
        long tic = ExplorationIds.parseTic(params.getFirst("ticId")).orElseThrow(PublicAnalysisBatchService::invalid);
        long size = params.containsKey("size")
                ? ExplorationIds.parseTic(params.getFirst("size")).orElseThrow(PublicAnalysisBatchService::invalid) : 20;
        if (size > 100) throw invalid();
        String binding = "batch-candidates-v1|" + member + "|" + tic + "|" + size;
        OffsetDateTime afterAt = null;
        Long afterId = null;
        if (params.containsKey("cursor")) {
            String cursor = params.getFirst("cursor");
            try {
                if (cursor == null || cursor.isEmpty() || cursor.length() > 1024) throw invalid();
                String[] parts = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8).split("\\|", -1);
                if (parts.length != 6 || !String.join("|", java.util.Arrays.copyOf(parts, 4)).equals(binding)) throw invalid();
                afterAt = OffsetDateTime.parse(parts[4]);
                afterId = ExplorationIds.parseTic(parts[5]).orElseThrow(PublicAnalysisBatchService::invalid);
                if (afterAt.getYear() < 1 || afterAt.getYear() > 9999 || afterAt.getNano() % 1000 != 0
                        || !next(binding, afterAt, afterId).equals(cursor)) throw invalid();
            } catch (IllegalArgumentException | java.time.DateTimeException e) { throw invalid(); }
        }
        stars.requireOpenStarBoard(tic);
        // 먼저 적격 미공개 기록의 신호별 대표를 선택한 뒤 커서와 LIMIT을 적용한다.
        var query = jdbc.sql("""
                WITH representatives AS (
                    SELECT DISTINCT ON (c.id) h.id AS history_id,s.id AS submission_id,c.id AS candidate_id,
                        s.created_at,s.user_judgment
                    FROM analysis_histories h JOIN submissions s ON s.id=h.submission_id
                    JOIN candidates c ON ('c-' || c.id)=s.response_snapshot #>> '{match,candidateId}' AND c.tic_id=h.tic_id
                    WHERE h.user_id=:member AND s.user_id=:member AND h.tic_id=:tic AND s.tic_id=:tic
                        AND s.response_snapshot #>> '{signal,answerClass}'='analysis'
                        AND s.response_snapshot #>> '{match,status}' IN ('matched','matched_harmonic','duplicate')
                        AND NOT EXISTS(SELECT 1 FROM published_analyses pa WHERE pa.history_id=h.id)
                        AND NOT EXISTS(SELECT 1 FROM posts p WHERE p.kind='system_thread' AND p.candidate_id=c.id AND p.status<>'visible')
                    ORDER BY c.id,s.created_at DESC,s.id DESC
                )
                SELECT * FROM representatives
                """ + (afterId == null ? "" : " WHERE (created_at,submission_id)<(:at,:id)")
                + " ORDER BY created_at DESC,submission_id DESC LIMIT :limit")
                .param("member", member).param("tic", tic).param("limit", size + 1);
        if (afterId != null) query.param("at", afterAt).param("id", afterId);
        var rows = query.query((r, n) -> new Candidate("h-" + r.getLong("history_id"),
                ExplorationIds.submission(r.getLong("submission_id")), Long.toString(tic),
                ExplorationIds.candidate(r.getLong("candidate_id")), r.getObject("created_at", OffsetDateTime.class),
                r.getString("user_judgment"))).list();
        boolean more = rows.size() > size;
        var page = rows.subList(0, Math.min(rows.size(), (int) size));
        String cursor = more ? next(binding, page.getLast().submittedAt(),
                ExplorationIds.parse(page.getLast().submissionId(), ExplorationIds.SUBMISSION).orElseThrow()) : null;
        return new Page(List.copyOf(page), cursor, more);
    }

    private static String next(String binding, OffsetDateTime at, long id) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString((binding + "|" + at + "|" + id).getBytes(StandardCharsets.UTF_8));
    }
    private static Failure failure(String history, ErrorCode code, boolean retryable) {
        return new Failure(history, "FAILED", new Error(code.name(), code.getDefaultMessage()), retryable);
    }
    private static BusinessException invalid() { return new BusinessException(ErrorCode.VALIDATION_FAILED); }
}
