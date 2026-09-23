package com.planetory.backend.domain;

/** 탐사·커뮤니티 공통 공개 조건. pa=published_analyses, p=부모 posts 별칭이다. */
public final class PublicAnalysisVisibility {
    public static final String VISIBLE = "pa.unpublished_at IS NULL AND pa.hidden_at IS NULL AND pa.withdrawn_at IS NULL "
            + "AND p.kind='system_thread' AND p.status='visible' "
            + "AND EXISTS (SELECT 1 FROM users author WHERE author.id=pa.user_id AND author.status='active')";

    private PublicAnalysisVisibility() {}
}
