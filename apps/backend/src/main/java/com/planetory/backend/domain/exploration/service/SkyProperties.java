package com.planetory.backend.domain.exploration.service;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 별 지도 전송 규격 [S15P21C206-137].
 *
 * <p>상수로 박혀 있던 값을 설정으로 뺀다. {@code S15P21C206-137} 측정에서 두 값이 첫 화면
 * 비용을 좌우하는데, 어떤 값이 맞는지는 프론트가 실제로 어떤 크기 상자를 요청하는지 봐야
 * 정해진다(215·W05). 근거 없이 상수를 바꾸면 나중에 또 바꾼다.
 *
 * <p>기본값은 지금 동작 그대로다. 이 판은 값을 바꾸지 않고 바꿀 수 있게만 한다.
 *
 * @param tileSize 정사각 타일 한 변. 응답 범위를 이 격자에 맞춰 넓히므로 <b>응답의 최소
 *                 단위</b>다. 코어처럼 조밀한 곳에서는 이보다 좁게 요청해도 이만큼 받는다.
 * @param maxBox   경계 상자 상한. 한 요청이 지도를 통째로 끌어오지 못하게 막는다(탐사 API 4.1).
 *                 예전에는 {@code tileSize * 64}로 묶여 있었으나 둘은 서로 다른 것을 막는
 *                 값이라 분리했다. 타일을 잘게 쪼갠다고 요청 상한까지 줄어들 이유가 없다.
 */
@ConfigurationProperties("planetory.sky")
public record SkyProperties(int tileSize, int maxBox) {

    public SkyProperties {
        if (tileSize <= 0) {
            throw new IllegalArgumentException("planetory.sky.tile-size는 양수여야 합니다: " + tileSize);
        }
        if (maxBox < tileSize) {
            // 상한이 타일보다 작으면 어떤 요청도 통과하지 못한다. 기동 때 잡는다.
            throw new IllegalArgumentException(
                    "planetory.sky.max-box는 tile-size 이상이어야 합니다: "
                            + maxBox + " < " + tileSize);
        }
        if (maxBox % tileSize != 0) {
            // 상한이 격자의 배수가 아니면 상한 크기 요청이 스냅 뒤 상한을 넘는다.
            throw new IllegalArgumentException(
                    "planetory.sky.max-box는 tile-size의 배수여야 합니다: "
                            + maxBox + " % " + tileSize);
        }
    }
}
