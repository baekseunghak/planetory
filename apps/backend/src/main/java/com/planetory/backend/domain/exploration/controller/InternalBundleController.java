package com.planetory.backend.domain.exploration.controller;

import io.swagger.v3.oas.annotations.Operation;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import com.planetory.backend.domain.exploration.service.BundleActivationService;
import com.planetory.backend.domain.exploration.service.ExplorationIds;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

/**
 * Publisher가 판 전환을 알리는 내부 경로 (탐사 API 10장 3단계) [S15P21C206-150].
 *
 * <p>회원 API가 아니라 서비스 사이 호출이다. 인증은 {@code InternalTokenFilter}의 서비스 토큰이
 * 맡고 여기에 회원 문맥은 없다.
 *
 * <p>알림은 정본이 아니다(10장). 그래서 같은 판을 여러 번 알려도, 지난 판을 알려도 200이다 —
 * 호출자가 재시도를 멈출 수 있어야 하고, 실패를 반환하면 이미 끝난 전환을 계속 다시 보내게 된다.
 * 실제로 무엇을 했는지는 본문의 수로 알린다.
 */
@RestController
@RequiredArgsConstructor
public class InternalBundleController {

    private final BundleActivationService activation;

    /**
     * 후처리 결과.
     *
     * @param applied 현재 판이어서 실제로 후처리했으면 true. 지난 판이면 false이고 나머지는 0이다
     */
    public record ActivationResponse(boolean applied, String bundleId, String ticId,
                                     int evictedCacheEntries, int completedMembers, int reopenedMembers,
                                     int relabeledAchievements) {
    }

    @Operation(summary = "판 전환 후처리",
            description = "current 전환 뒤 Publisher가 부른다. 이전 판 잔차 캐시 정리, 완료 재판정과 재개,"
                    + " 외부 라벨 표식을 실행한다. 멱등이라 같은 판을 다시 알려도 결과가 같다.")
    @PostMapping("/internal/bundles/{bundleId}/activated")
    public ResponseEntity<ActivationResponse> activated(@PathVariable String bundleId) {
        long bundle = ExplorationIds.parse(bundleId, ExplorationIds.BUNDLE)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        var result = activation.onBundleActivated(bundle);
        return ResponseEntity.ok()
                .header("Cache-Control", "no-store")
                .body(new ActivationResponse(result.applied(), bundleId,
                        result.applied() ? String.valueOf(result.ticId()) : null,
                        result.evicted(), result.completed(), result.reopened(), result.relabeled()));
    }
}
