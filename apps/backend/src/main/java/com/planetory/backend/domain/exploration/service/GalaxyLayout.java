package com.planetory.backend.domain.exploration.service;

/**
 * 새로 열리는 별의 은하 월드 좌표를 정한다(탐사 API 4.1절, 별지도 표현 계약 1절).
 * 발견 트랜잭션 안에서 한 번 호출하며, 결과는 star_unlocks에 저장한 뒤 바꾸지 않는다.
 *
 * <p>입력은 회원별 발견 순번 하나다. 회원·별에 따라 달라지지 않으므로 모든 계정이 같은 은하
 * 형상을 발견 순서대로 채운다(SRS HOME-02). 같은 순번은 항상 같은 좌표를 반환해야 한다
 * (재처리·재현).
 */
public interface GalaxyLayout {

    /**
     * @param layoutOrdinal 회원별 발견 순번(0부터). {@code star_unlocks.layout_ordinal}과 같은 값이다.
     */
    StarPosition place(int layoutOrdinal);

    record StarPosition(double worldX, double worldY, double depthZ, String layoutVersion) {
        public StarPosition {
            if (!Double.isFinite(worldX) || !Double.isFinite(worldY) || !(depthZ >= -1 && depthZ <= 1)
                    || layoutVersion == null || layoutVersion.isBlank()) {
                throw new IllegalArgumentException("invalid galaxy position");
            }
        }
    }
}
