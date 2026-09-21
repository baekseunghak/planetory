package com.planetory.backend.domain.exploration.service;

import java.util.List;
import java.util.OptionalLong;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import com.planetory.backend.domain.exploration.service.AnalysisViews.Answer;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.error.ErrorResponse.FieldError;

/**
 * 제출 조회와 요청 ID 복구 (탐사 API 6.6절) [S15P21C206-145].
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

    private final HistoryService histories;
    private final SubmissionRepository submissions;
    private final StarRepository stars;

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
