package com.planetory.backend.domain.post.service;

import com.planetory.backend.domain.PublicAnalysisVisibility;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/** 공개 History 투영의 현재 접근 권한 검사. */
@Service
@RequiredArgsConstructor
public class PublicAnalysisAccess {
    private final JdbcClient jdbc;

    /** 148 공개 투영의 콜백. 반환 직전에도 새 DB 상태와 실제 공개→History 관계를 검사한다. */
    public void check(long memberId, long analysisId, long historyId) {
        if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')")
                .param(memberId).query(Boolean.class).single()) {
            throw new BusinessException(ErrorCode.AUTH_REQUIRED);
        }
        if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM published_analyses pa JOIN posts p ON p.id=pa.post_id "
                        + "WHERE pa.id=? AND pa.history_id=? AND " + PublicAnalysisVisibility.VISIBLE + ")")
                .params(analysisId, historyId).query(Boolean.class).single()) {
            throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        }
    }
}
