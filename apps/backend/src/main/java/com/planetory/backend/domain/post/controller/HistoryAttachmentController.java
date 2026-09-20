package com.planetory.backend.domain.post.controller;

import com.planetory.backend.domain.exploration.service.AchievementViews;
import com.planetory.backend.domain.exploration.service.AnalysisViews;
import com.planetory.backend.domain.exploration.service.HistoryViews.*;
import com.planetory.backend.domain.post.service.HistoryAttachmentService;
import com.planetory.backend.domain.post.service.HistoryAttachmentService.Parent;
import com.planetory.backend.global.security.MemberPrincipal;
import io.swagger.v3.oas.annotations.Operation;
import java.time.OffsetDateTime;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 글과 댓글의 첨부가 공유하는 부모 권한·응답 매핑을 글 도메인에서 함께 관리한다. */
@RestController
@RequiredArgsConstructor
public class HistoryAttachmentController {
    private final HistoryAttachmentService attachments;

    /** 부모 외형과 judgment만 서비스 계약으로 매핑하고 탐사 Graph는 그대로 사용한다. */
    public record Attachment(Parent parentType, String parentId, String historyId, String ticId, String candidateId,
                             OffsetDateTime submittedAt, String judgment, List<String> evidenceChecks, String memo,
                             PublicOriginal original, PublicDerived serverDerived, PublicMatch match,
                             AnalysisViews.CurveContext curveContext, Versions versions, Graph graph,
                             AchievementViews.Relabel relabel) {
        static Attachment of(Parent parent, String parentId, PublicHistory value) {
            return new Attachment(parent, parentId, value.historyId(), value.ticId(), value.candidateId(), value.submittedAt(),
                    value.userJudgment(), value.evidenceChecks(), value.memo(), value.original(), value.serverDerived(),
                    value.match(), value.curveContext(), value.versions(), value.graph(), value.relabel());
        }
    }

    @Operation(summary = "게시글 History 첨부 공개 조회")
    @GetMapping("/api/v1/posts/{postId}/history-attachments/{historyId}")
    public ResponseEntity<Attachment> post(@AuthenticationPrincipal MemberPrincipal member, @PathVariable String postId,
            @PathVariable String historyId, @RequestParam(defaultValue = "CURRENT") String graphMode,
            @RequestParam(defaultValue = "true") boolean includeGraph) {
        return read(member, Parent.POST, postId, historyId, graphMode, includeGraph);
    }

    @Operation(summary = "댓글 History 첨부 공개 조회")
    @GetMapping("/api/v1/comments/{commentId}/history-attachments/{historyId}")
    public ResponseEntity<Attachment> comment(@AuthenticationPrincipal MemberPrincipal member, @PathVariable String commentId,
            @PathVariable String historyId, @RequestParam(defaultValue = "CURRENT") String graphMode,
            @RequestParam(defaultValue = "true") boolean includeGraph) {
        return read(member, Parent.COMMENT, commentId, historyId, graphMode, includeGraph);
    }

    private ResponseEntity<Attachment> read(MemberPrincipal member, Parent parent, String parentId, String historyId,
                                            String mode, boolean includeGraph) {
        var content = attachments.read(member.memberId(), parent, HistoryAttachmentService.parentId(parent, parentId),
                historyId, mode, includeGraph);
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(Attachment.of(parent, parentId, content));
    }
}
