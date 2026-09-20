package com.planetory.backend.domain.exploration.service;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 온라인 잔차 작업 설정 (탐사 API 7장, D-3·D-4) [S15P21C206-147].
 *
 * <p>기본값은 병합 결정 그대로다. 회원당 진행 작업 1개, 전체 동시 계산 2개, 대기 20개.
 * 실제 수치는 부하 시험 뒤 {@code S15P21C206-89}의 공통 설정과 맞춘다.
 *
 * @param pollAfterSeconds 다음 조회까지 쉴 시간. 프론트는 이 값을 그대로 따른다(D-3, Q08)
 * @param retryAfterSeconds 대기열이 찼을 때 다시 요청하기까지 쉴 시간
 * @param maxRunning 동시에 계산할 수 있는 작업 수
 * @param maxQueued 계산을 기다릴 수 있는 작업 수
 * @param perMember 회원당 진행 작업 수. 1이면 한 사람이 동시에 하나만 돌린다(D-4)
 */
@ConfigurationProperties("planetory.residual")
public record ResidualJobProperties(int pollAfterSeconds, int retryAfterSeconds,
                                    int maxRunning, int maxQueued, int perMember) {

    public ResidualJobProperties {
        if (pollAfterSeconds < 0 || retryAfterSeconds < 0) {
            throw new IllegalArgumentException("planetory.residual의 대기 시간은 음수일 수 없습니다.");
        }
        if (maxRunning <= 0 || maxQueued < 0 || perMember <= 0) {
            throw new IllegalArgumentException("planetory.residual의 동시 실행·대기 상한이 올바르지 않습니다.");
        }
    }
}
