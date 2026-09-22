package com.planetory.backend.domain.post.service;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.planetory.backend.domain.PublicAnalysisVisibility;
import com.planetory.backend.domain.exploration.service.AchievementService;
import com.planetory.backend.domain.exploration.service.ExplorationIds;
import com.planetory.backend.domain.exploration.service.HistoryService;
import com.planetory.backend.domain.exploration.service.SubmissionViews.UnlockedStar;
import com.planetory.backend.domain.exploration.service.StarViews;
import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.domain.exploration.service.SubmissionService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

/** 신호 한 건의 공개·성과·별 발견을 같은 트랜잭션으로 확정한다. */
@Service
@RequiredArgsConstructor
public class PublicAnalysisService {
    private final JdbcClient jdbc;
    private final HistoryService histories;
    private final AchievementService achievements;
    private final SubmissionService submissions;
    private final StarService stars;

    public record Achievement(String result, boolean newlyRecognized, List<UnlockedStar> unlockedStars,
                              StarViews.Achievement star, int unlockShortfall) {}
    public record Published(String analysisId, String threadId, String historyId, boolean isPublic,
                            boolean created, boolean achievementGranted, boolean newlyGranted,
                            String skyVersion, Achievement achievement, Map<String, Object> judgmentSummary) {}
    private record Existing(long id, long thread, long candidate, boolean isPublic) {}
    public record Visibility(String analysisId, boolean isPublicByAuthor, boolean isModerationHidden,
                             boolean isEffectivelyPublic) {
        @JsonProperty("isPublic")
        public boolean isPublic() { return isEffectivelyPublic; }
    }
    private record Managed(long owner, boolean isPublic, boolean hidden) {}

    @Transactional(isolation = Isolation.READ_COMMITTED)
    public Visibility visibility(long member, String analysisId, boolean isPublic) {
        long id = ExplorationIds.parse(analysisId, ExplorationIds.PUBLIC_ANALYSIS)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        // 161과 같은 회원 선잠금. 부모→공개 행 순서로 잠가 DB 운영 숨김과 직렬화한다.
        if (jdbc.sql("SELECT id FROM users WHERE id=? AND status='active' FOR UPDATE")
                .param(member).query(Long.class).optional().isEmpty()) {
            throw new BusinessException(ErrorCode.AUTH_REQUIRED);
        }
        long thread = jdbc.sql("SELECT post_id FROM published_analyses WHERE id=?")
                .param(id).query(Long.class).optional()
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        String parentStatus = jdbc.sql("SELECT status FROM posts WHERE id=? AND kind='system_thread' FOR UPDATE")
                .param(thread).query(String.class).optional()
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        Managed row = jdbc.sql("SELECT user_id, unpublished_at IS NULL, hidden_at IS NOT NULL "
                        + "FROM published_analyses WHERE id=? FOR UPDATE")
                .param(id).query((r, n) -> new Managed(r.getLong(1), r.getBoolean(2), r.getBoolean(3)))
                .optional().orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        boolean parentVisible = "visible".equals(parentStatus);
        if (row.owner() != member) {
            throw new BusinessException(row.isPublic() && !row.hidden() && parentVisible
                    ? ErrorCode.FORBIDDEN : ErrorCode.RESOURCE_NOT_FOUND);
        }
        if (isPublic && !parentVisible) throw new BusinessException(ErrorCode.THREAD_HIDDEN);
        if (isPublic && row.hidden()) throw new BusinessException(ErrorCode.PUBLICATION_HIDDEN);
        if (row.isPublic() != isPublic) {
            jdbc.sql("UPDATE published_analyses SET unpublished_at=" + (isPublic ? "NULL" : "clock_timestamp()")
                    + " WHERE id=?").param(id).update();
        }
        return new Visibility(analysisId, isPublic, row.hidden() || "hidden".equals(parentStatus),
                isPublic && !row.hidden() && parentVisible);
    }

    // 부분 유일 인덱스의 ON CONFLICT와 행 잠금이 필요하므로 이 저장 경로는 JdbcClient를 사용한다.
    // 같은 DataSource의 AchievementService도 이 트랜잭션에 참여한다(Propagation.MANDATORY).
    @Transactional(isolation = Isolation.READ_COMMITTED)
    public Published publish(long member, String historyId) {
        long history = ExplorationIds.parse(historyId, "h-")
                .orElseThrow(() -> new BusinessException(ErrorCode.VALIDATION_FAILED));
        // FK 쓰기보다 먼저 잠근다. 제출·튜토리얼·성과 발견과 같은 회원 잠금 순서다.
        if (jdbc.sql("SELECT id FROM users WHERE id=? AND status='active' FOR UPDATE")
                .param(member).query(Long.class).optional().isEmpty()) {
            throw new BusinessException(ErrorCode.AUTH_REQUIRED);
        }
        long owner = jdbc.sql("SELECT user_id FROM analysis_histories WHERE id=?")
                .param(history).query(Long.class).optional()
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        if (owner != member) throw new BusinessException(ErrorCode.FORBIDDEN);

        var existing = jdbc.sql("""
                SELECT pa.id, pa.post_id, pa.candidate_id,
                    %s AS is_public
                FROM published_analyses pa JOIN posts p ON p.id=pa.post_id
                WHERE pa.history_id=? AND pa.user_id=?
                """.formatted(PublicAnalysisVisibility.VISIBLE)).params(history, member).query((r, n) -> new Existing(r.getLong(1), r.getLong(2),
                        r.getLong(3), r.getBoolean(4))).optional();
        if (existing.isPresent()) {
            var old = existing.get();
            var recognition = achievements.existingRecognition(member, old.candidate());
            return response(old.id(), old.thread(), historyId, old.isPublic(), false, recognition,
                    achievements.publicationStars(member, old.id()),
                    submissions.publicJudgmentSummary(old.candidate()));
        }

        var basis = histories.publicationBasis(member, historyId);
        stars.requireOpenStarBoard(basis.ticId());
        if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM candidates WHERE id=? AND tic_id=?)")
                .params(basis.candidateId(), basis.ticId()).query(Boolean.class).single()) {
            throw new BusinessException(ErrorCode.PUBLICATION_NOT_ELIGIBLE);
        }
        // 최초 생성 경합과 공개 후보 요약 본문은 DB가 처리한다(V19). GET에서 본문을 채우지 않는다.
        jdbc.sql("""
                INSERT INTO posts(kind, user_id, candidate_id, board, tic_id, title, body, status)
                VALUES ('system_thread', NULL, ?, 'star', ?, ?, '', 'visible')
                ON CONFLICT (candidate_id) WHERE kind='system_thread' DO NOTHING
                """).params(basis.candidateId(), basis.ticId(),
                        "TIC " + basis.ticId() + " 신호 " + ExplorationIds.candidate(basis.candidateId()) + " 밝기 분석")
                .update();
        // 운영 숨김과 직렬화한다. 숨겨진 스레드 대신 새 스레드를 만들지 않는다.
        long thread = jdbc.sql("SELECT id FROM posts WHERE kind='system_thread' AND candidate_id=? "
                        + "AND tic_id=? AND status='visible' FOR UPDATE")
                .params(basis.candidateId(), basis.ticId()).query(Long.class).optional()
                .orElseThrow(() -> new BusinessException(ErrorCode.THREAD_HIDDEN));
        long analysis = jdbc.sql("""
                INSERT INTO published_analyses(post_id, user_id, candidate_id, history_id, published_at)
                VALUES (?, ?, ?, ?, clock_timestamp()) RETURNING id
                """).params(thread, member, basis.candidateId(), history).query(Long.class).single();
        var recognition = achievements.recognize(member, basis.candidateId(),
                AchievementService.AchievementType.UNCONFIRMED, basis.submissionId(), analysis);
        return response(analysis, thread, historyId, true, true, recognition,
                recognition.unlockedStars().stream()
                        .map(s -> new UnlockedStar(Long.toString(s.ticId()), s.position())).toList(),
                submissions.publicJudgmentSummary(basis.candidateId()));
    }

    private static Published response(long analysis, long thread, String history, boolean isPublic, boolean created,
                                      AchievementService.Recognition recognition, List<UnlockedStar> unlockedStars,
                                      Map<String, Object> summary) {
        return new Published(ExplorationIds.publicAnalysis(analysis), "st-" + thread, history, isPublic, created,
                true, recognition.newlyRecognized(), recognition.skyVersion(),
                new Achievement(recognition.newlyRecognized() ? "recognized" : "already_recognized",
                        recognition.newlyRecognized(), unlockedStars, recognition.star(),
                        recognition.unlockShortfall()), summary);
    }
}
