package com.planetory.backend.domain.exploration.service;

/**
 * 잔차·주기도 계산을 실제로 돌리는 곳 (내부 호출 프로토콜) [S15P21C206-147].
 *
 * <p>구현은 Worker HTTP 어댑터({@code S15P21C206-88})가 제공한다. Backend가 current Gold를 읽어
 * 요청을 조립하고 {@code POST /internal/v1/derived-compute}로 잔차 → 주기도 순서로 부르며,
 * 결과를 채택하기 전에 판이 아직 {@code current}인지 다시 확인한다
 * ({@code contracts/derived-compute/README.md}).
 *
 * <p><b>구현이 없으면 작업을 만들지 않는다.</b> 만들어 두면 아무도 진행시키지 않는 QUEUED가 쌓이고,
 * 화면은 계산이 도는 줄 안다. 그래서 요청은 503으로 거절한다(7.1절 요청 자체가 상태를 만들지 않는다).
 */
@FunctionalInterface
public interface ResidualComputeRunner {

    /**
     * 이 작업을 계산한다. 호출은 즉시 돌아오고 진행은 {@link ResidualJobStore}에 기록한다.
     *
     * <p>같은 키의 작업은 하나만 들어온다. 중복 병합은 저장소가 이미 걸렀다.
     */
    void start(ResidualJobStore.Job job);
}
