package com.planetory.backend.domain.exploration.service;

import org.springframework.stereotype.Component;

/**
 * `personal-spiral-v1` 은하 배치 [S15P21C206-136].
 *
 * <p>{@code docs/development/sky-reference/reference.mjs}의 {@code layout()}을 옮긴 것이다.
 * 같은 순번은 항상 같은 좌표를 준다. 회원·별과 무관하게 순번만으로 정해지므로 모든 계정이
 * 같은 은하 형상을 발견 순서대로 채운다(SRS HOME-02, ERD `layout_version`).
 *
 * <p>정확도는 {@code sky-reference/vectors.json}의 허용 오차(위치 1e-6, 깊이 1e-9)로 검증한다.
 * JavaScript와 같은 결과를 내려면 난수기의 32비트 연산 의미를 그대로 지켜야 한다.
 * {@code Math.imul}은 Java의 {@code int} 곱과 같고, {@code >>> 0}은 부호 없는 해석이다.
 *
 * <p>저장된 좌표는 바꾸지 않는다. 조회 때 다시 계산하지 말고 `star_unlocks`에 적힌 값을 읽는다.
 */
@Component
public class PersonalSpiralGalaxyLayout implements GalaxyLayout {

    public static final String LAYOUT_VERSION = "personal-spiral-v1";

    /** 정규화 깊이를 월드 깊이로 되돌리는 배율. 프론트 투영과 공유한다. */
    public static final int DEPTH_SCALE = 256;

    /** 앞선 순번 여섯 개는 시제품 화면을 재현하기 위해 좌표를 고정한다. */
    private static final double[][] ANCHORS = {
            {760, 430, 18}, {-380, -255, 15}, {135, 350, -12},
            {-650, 315, 25}, {400, -360, 22}, {-200, -540, 8}
    };

    @Override
    public StarPosition place(int layoutOrdinal) {
        if (layoutOrdinal < 0) {
            throw new IllegalArgumentException("layoutOrdinal은 0 이상이어야 합니다: " + layoutOrdinal);
        }
        Random random = new Random(layoutOrdinal);
        double x;
        double y;
        double z;

        if (layoutOrdinal % 10 < 2) {
            // 중앙부. 팔에 얹지 않고 가우시안으로 흩는다.
            x = random.gaussian() * 122;
            y = random.gaussian() * 112;
            z = random.gaussian() * 45;
        } else {
            double radius = 85 + Math.pow(random.next(), 0.72) * 1140;
            double theta = layoutOrdinal % 7 == 0
                    // 일곱 번째마다 팔에서 떨어뜨려 규칙성을 깬다.
                    ? random.next() * Math.PI * 2
                    : (layoutOrdinal % 4) * Math.PI / 2
                            + Math.pow(radius / 1200, 0.7) * 5.6
                            + random.gaussian() * (0.075 + radius / 17000);
            double spread = random.gaussian() * (layoutOrdinal % 9 == 0 ? 115 : 26);
            x = Math.cos(theta) * (radius + spread);
            y = Math.sin(theta) * (radius + spread);
            // 바깥으로 갈수록 얇아진다.
            z = random.gaussian() * (10 + 19 * (1 - radius / 1350));
        }

        if (layoutOrdinal < ANCHORS.length) {
            double[] anchor = ANCHORS[layoutOrdinal];
            x = anchor[0];
            y = anchor[1];
            z = anchor[2];
        }

        return new StarPosition(x, y, clampDepth(z / DEPTH_SCALE), LAYOUT_VERSION);
    }

    private static double clampDepth(double depth) {
        return Math.max(-1, Math.min(1, depth));
    }

    /**
     * 참조 구현의 난수기. 32비트 연산이라 {@code int}로 다루고 값을 쓸 때만 부호 없이 읽는다.
     * 순번마다 같은 수열을 주므로 재계산해도 결과가 같다.
     */
    private static final class Random {

        private int seed;

        private Random(int layoutOrdinal) {
            this.seed = (layoutOrdinal + 71) * 0x9E3779B1;
        }

        private double next() {
            seed += 0x6D2B79F5;
            int t = seed;
            t = (t ^ (t >>> 15)) * (t | 1);
            t ^= t + (t ^ (t >>> 7)) * (t | 61);
            return Integer.toUnsignedLong(t ^ (t >>> 14)) / 4294967296.0;
        }

        /** Box-Muller. 한 번에 난수를 둘 쓰므로 호출 순서가 좌표를 바꾼다. */
        private double gaussian() {
            return Math.sqrt(-2 * Math.log(Math.max(0.00001, next()))) * Math.cos(2 * Math.PI * next());
        }
    }
}
