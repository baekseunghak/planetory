package com.planetory.backend.domain.exploration.service;

import org.springframework.stereotype.Component;

/**
 * 임시 구현: 은하 배치 함수(S15P21C206-139)가 병합되기 전까지 모든 별을 원점에 둔다.
 * 139의 GalaxyLayout 구현이 들어오면 이 클래스를 삭제한다. 두 구현이 함께 있으면 빈 중복으로 기동이 실패한다.
 * 이 버전으로 저장된 개발 DB 행은 v1.2 최초 제공 전에 초기화한다(한 회원 지도에 배치 버전을 섞지 않는다).
 */
@Component
public class BootstrapGalaxyLayout implements GalaxyLayout {
    static final String VERSION = "bootstrap-0";

    @Override
    public StarPosition place(long userId, long ticId) {
        return new StarPosition(0, 0, 0, VERSION);
    }
}
