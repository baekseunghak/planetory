package com.planetory.backend.domain.exploration.service;

import java.util.List;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 봉우리 추출 규칙 (탐사 API 5.4절) [S15P21C206-141].
 *
 * <p>고정 power 배열로 규칙만 본다. DB·회원·HTTP가 없다 — 규칙이 틀렸을 때 다른 이유로 깨지지
 * 않아야 수치를 고칠 수 있다.
 *
 * <p>격자는 주기 1~1024일에 101칸이라 비율이 {@code 2^0.1}이고 <b>2배가 정확히 10칸</b>이다. 고조파
 * 규칙을 자리 계산 오차 없이 볼 수 있어 이 격자를 쓴다.
 */
class CandidatePeaksTest {

    private static final CandidatePeaks.Grid GRID = new CandidatePeaks.Grid(1, 1024, 101, true);
    /** 운영 규칙 rule-0의 값이다. 여기서 새로 정하지 않는다. */
    private static final List<Double> HARMONICS = List.of(1.0, 2.0, 0.5);

    private static CandidatePeaks.Rules rules(int topN, int halfWidthCells) {
        return new CandidatePeaks.Rules(topN, halfWidthCells, HARMONICS);
    }

    private static Float[] flat(int size) {
        Float[] power = new Float[size];
        java.util.Arrays.fill(power, 0f);
        return power;
    }

    private static Float[] peaksAt(int size, int... indexAndPower) {
        Float[] power = flat(size);
        for (int i = 0; i < indexAndPower.length; i += 2) {
            power[indexAndPower[i]] = indexAndPower[i + 1] / 100f;
        }
        return power;
    }

    private static List<Integer> indexes(List<CandidatePeaks.Peak> peaks) {
        return peaks.stream().map(CandidatePeaks.Peak::gridIndex).toList();
    }

    // ---------- 상위 N과 정렬 ----------

    @Test
    void 센_순서로_상위_N개만_고른다() {
        Float[] power = peaksAt(101, 10, 40, 30, 90, 50, 70, 70, 60, 90, 20);

        var peaks = CandidatePeaks.extract(power, GRID, rules(3, 1));

        assertEquals(List.of(30, 50, 70), indexes(peaks), "세기 내림차순이다");
        assertEquals(List.of(1, 2, 3), peaks.stream().map(CandidatePeaks.Peak::rank).toList());
        assertEquals(0.9, peaks.getFirst().power(), 1e-6);
        assertEquals(3, peaks.size(), "상위 N에서 끊는다. 0.40·0.20은 빠진다");
    }

    /**
     * 화면은 봉우리 power를 주기도 {@code power[gridIndex]}와 상대 1e-9로 대조한다. float32를 double로
     * 넓혀 내보내면 {@code 239.87599}가 {@code 239.87599182128906}이 되어 모든 봉우리가 거절됐다 [S15P21C206-262].
     */
    @Test
    void 봉우리_세기는_주기도_원소와_같은_JSON_숫자다() {
        Float[] power = flat(101);
        power[30] = 239.87599f;

        var peak = CandidatePeaks.extract(power, GRID, rules(1, 1)).getFirst();

        var json = tools.jackson.databind.json.JsonMapper.builder().build();
        assertEquals(json.writeValueAsString(power[30]), json.writeValueAsString(peak.power()));
    }

    /** {@code rank}는 정렬 결과이고 {@code gridIndex}가 식별값이다(C02-R3). */
    @Test
    void 세기가_같으면_낮은_칸이_앞이다() {
        Float[] power = peaksAt(101, 20, 50, 60, 50);

        var peaks = CandidatePeaks.extract(power, GRID, rules(10, 1));

        assertEquals(List.of(20, 60), indexes(peaks));
    }

    // ---------- 최소 간격 ----------

    /** 미세 조정 범위가 겹치는 두 봉우리는 사용자에게 같은 선택이다. 약한 쪽이 밀려난다. */
    @Test
    void 미세_조정_범위가_겹치면_약한_쪽을_버린다() {
        Float[] power = peaksAt(101, 50, 90, 52, 80);

        assertEquals(List.of(50), indexes(CandidatePeaks.extract(power, GRID, rules(10, 1))),
                "h=1이면 3칸 미만은 겹친다");
        assertEquals(List.of(50, 52), indexes(CandidatePeaks.extract(power, GRID, rules(10, 0))),
                "h=0이면 1칸만 떨어져도 따로 고를 수 있다");
    }

    /** 간격은 판의 h를 따라간다. 여기에 별도 설정을 두지 않는다. */
    @Test
    void 최소_간격은_판의_미세_조정_반폭에서_나온다() {
        Float[] power = peaksAt(101, 20, 90, 26, 80);

        assertEquals(List.of(20, 26), indexes(CandidatePeaks.extract(power, GRID, rules(10, 2))),
                "h=2면 5칸 간격이라 6칸은 남는다");
        assertEquals(List.of(20), indexes(CandidatePeaks.extract(power, GRID, rules(10, 3))),
                "h=3이면 7칸 미만이라 밀려난다");
    }

    // ---------- 고조파 제외 ----------

    /** 제출이 「2배 맞음」이라고 판정하는 배수와 목록이 거르는 배수가 같아야 한다. */
    @Test
    void 이미_고른_봉우리의_고조파는_버린다() {
        // 50번 칸이 32일이면 60번이 64일(2배), 40번이 16일(0.5배)이다.
        Float[] power = peaksAt(101, 50, 90, 60, 80, 40, 70, 30, 60);

        var peaks = CandidatePeaks.extract(power, GRID, rules(10, 1));

        assertEquals(List.of(50, 30), indexes(peaks), "2배·0.5배는 빠지고 4분의 1은 남는다");
        assertEquals(32.0, peaks.getFirst().periodDays(), 1e-9);
        assertEquals(8.0, peaks.getLast().periodDays(), 1e-9);
    }

    /** 배수 목록이 비면 고조파를 거르지 않는다. 규칙은 운영 규칙이 정한다. */
    @Test
    void 배수_목록이_비면_고조파도_남는다() {
        Float[] power = peaksAt(101, 50, 90, 60, 80);

        var peaks = CandidatePeaks.extract(power, GRID,
                new CandidatePeaks.Rules(10, 1, List.of()));

        assertEquals(List.of(50, 60), indexes(peaks));
    }

    /**
     * 경계 바로 안과 바로 밖. 50번이 32일이면 60번이 정확히 2배(64일)다.
     *
     * <p>h=1에서 61번의 범위는 {@code [60번, 62번]}이라 2배 주기를 하한으로 품고, 62번의 범위는
     * {@code [61번, 63번]}이라 2배 주기가 한 칸 아래로 빠진다.
     */
    @Test
    void 고조파_판정은_미세_조정_범위_경계에서_갈린다() {
        assertEquals(List.of(50),
                indexes(CandidatePeaks.extract(peaksAt(101, 50, 90, 61, 80), GRID, rules(10, 1))),
                "2배 주기가 범위 안이다");
        assertEquals(List.of(50, 62),
                indexes(CandidatePeaks.extract(peaksAt(101, 50, 90, 62, 80), GRID, rules(10, 1))),
                "2배 주기가 범위 밖이면 남는다");
    }

    /**
     * 배수 자리가 정수 칸에 놓이지 않는 격자 (S15P21C206-141 리뷰, 윤성용).
     *
     * <p>0.5~40일 5000점에서 1000번의 2배 자리는 <b>1790.74번</b>이다. 1794번은 실제로 3.26칸
     * 떨어져 있어 h=3으로 조정해도 그 주기에 닿을 수 없는데, 자리를 반올림(1791번)해 칸 수로 비교하면
     * 3칸으로 보여 잘못 빠졌다. 주기 값으로 직접 보면 남는다.
     */
    @Test
    void 배수_자리가_칸에_맞지_않는_격자에서도_닿는지로_가른다() {
        var grid = new CandidatePeaks.Grid(0.5, 40, 5000, true);

        assertEquals(List.of(1000, 1794),
                indexes(CandidatePeaks.extract(peaksAt(5000, 1000, 90, 1794, 70), grid, rules(10, 3))),
                "2배 주기가 1794번 범위의 아래로 빠진다");
        assertEquals(List.of(1000),
                indexes(CandidatePeaks.extract(peaksAt(5000, 1000, 90, 1791, 80), grid, rules(10, 3))),
                "1791번 범위에는 2배 주기가 들어온다");
    }

    /** 반폭이 0이면 고를 수 있는 주기가 그 칸 하나뿐이라, 자리가 정확히 맞을 때만 고조파다. */
    @Test
    void 반폭이_0이면_정확히_맞는_자리만_고조파다() {
        // 50번이 32일이면 60번이 정확히 64일(2배)이고 65번은 아니다.
        Float[] power = peaksAt(101, 50, 90, 60, 80, 65, 70);

        assertEquals(List.of(50, 65), indexes(CandidatePeaks.extract(power, GRID, rules(10, 0))));
    }

    // ---------- 미세 조정 범위 ----------

    /** 하드코딩 금지(완료 조건 3). 격자 비율 r과 반폭 h로만 만든다. */
    @Test
    void 미세_조정_범위는_격자_비율과_반폭으로_계산한다() {
        Float[] power = peaksAt(101, 50, 90);

        var peak = CandidatePeaks.extract(power, GRID, rules(10, 3)).getFirst();

        double r = GRID.ratio();
        assertEquals(32.0 * Math.pow(r, -3), peak.fineTuneMinDays(), 1e-9);
        assertEquals(32.0 * Math.pow(r, 3), peak.fineTuneMaxDays(), 1e-9);
        assertEquals(32.0 * (r - 1), peak.fineTuneStepDays(), 1e-9, "step은 그 자리 한 칸 폭이다");
    }

    /** 로그 격자는 칸 폭이 주기에 비례한다. 짧은 주기에서 좁다. */
    @Test
    void 칸_폭은_주기에_비례한다() {
        Float[] power = peaksAt(101, 10, 90, 50, 80);

        var peaks = CandidatePeaks.extract(power, GRID, rules(10, 1));
        var shorter = peaks.stream().filter(p -> p.gridIndex() == 10).findFirst().orElseThrow();
        var longer = peaks.stream().filter(p -> p.gridIndex() == 50).findFirst().orElseThrow();

        assertEquals(longer.fineTuneStepDays() / longer.periodDays(),
                shorter.fineTuneStepDays() / shorter.periodDays(), 1e-12);
        assertTrue(shorter.fineTuneStepDays() < longer.fineTuneStepDays());
    }

    /** 격자 밖 주기는 고를 수 없으므로 범위를 자른다. */
    @Test
    void 격자_끝에서는_범위를_자른다() {
        Float[] power = peaksAt(101, 0, 90, 100, 80);

        var peaks = CandidatePeaks.extract(power, GRID, rules(10, 3));
        var first = peaks.stream().filter(p -> p.gridIndex() == 0).findFirst().orElseThrow();
        var last = peaks.stream().filter(p -> p.gridIndex() == 100).findFirst().orElseThrow();

        assertEquals(1.0, first.fineTuneMinDays(), 1e-9, "격자 아래로 내려가지 않는다");
        assertEquals(1024.0, last.fineTuneMaxDays(), 1e-9, "격자 위로 올라가지 않는다");
    }

    // ---------- 모양이 이상한 배열 ----------

    @Test
    void 평평한_봉우리는_첫_칸만_남긴다() {
        Float[] power = flat(101);
        power[40] = 0.9f;
        power[41] = 0.9f;
        power[42] = 0.9f;

        assertEquals(List.of(40), indexes(CandidatePeaks.extract(power, GRID, rules(10, 0))));
    }

    @Test
    void 끝_칸도_봉우리가_될_수_있다() {
        Float[] power = peaksAt(101, 0, 90, 100, 80);

        assertEquals(List.of(0, 100), indexes(CandidatePeaks.extract(power, GRID, rules(10, 1))));
    }

    @Test
    void 빈_배열과_길이_불일치와_평평한_주기도는_빈_목록이다() {
        assertTrue(CandidatePeaks.extract(null, GRID, rules(10, 1)).isEmpty());
        assertTrue(CandidatePeaks.extract(new Float[] {1f, 2f}, GRID, rules(10, 1)).isEmpty(),
                "격자와 길이가 다르면 무엇이 맞는지 알 수 없다");
        assertTrue(CandidatePeaks.extract(flat(101), GRID, rules(10, 1)).isEmpty(),
                "모두 같은 값이면 봉우리가 없다");
    }

    @Test
    void 값이_없는_칸은_건너뛴다() {
        Float[] power = peaksAt(101, 50, 90);
        power[70] = null;
        power[71] = Float.NaN;

        assertEquals(List.of(50), indexes(CandidatePeaks.extract(power, GRID, rules(10, 1))));
    }
}
