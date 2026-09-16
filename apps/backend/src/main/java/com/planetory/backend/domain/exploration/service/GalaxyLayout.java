package com.planetory.backend.domain.exploration.service;

/**
 * 새로 열리는 별의 은하 월드 좌표를 정한다(탐사 API 4.1절, 별지도 표현 계약 1절).
 * 발견 트랜잭션 안에서 한 번 호출하며, 결과는 star_unlocks에 저장한 뒤 바꾸지 않는다.
 * 같은 입력은 같은 좌표를 반환해야 한다(재처리·재현).
 */
public interface GalaxyLayout {
    StarPosition place(long userId, long ticId);

    record StarPosition(double worldX, double worldY, double depthZ, String layoutVersion) {
        public StarPosition {
            if (!Double.isFinite(worldX) || !Double.isFinite(worldY) || !(depthZ >= -1 && depthZ <= 1)
                    || layoutVersion == null || layoutVersion.isBlank()) {
                throw new IllegalArgumentException("invalid galaxy position");
            }
        }
    }
}
