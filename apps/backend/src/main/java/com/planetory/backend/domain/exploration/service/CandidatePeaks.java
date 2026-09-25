package com.planetory.backend.domain.exploration.service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * 주기도에서 보여 줄 봉우리를 고른다 (탐사 API 5.4절) [S15P21C206-141].
 *
 * <p>후보표가 아니라 <b>현재 주기도</b>에서 뽑는다. 후보표에서 뽑으면 매칭 전에 후보 개수와 주기가
 * 드러난다(POL-05, EXP-02). 여기서 나오는 값에는 후보인지 아닌지가 들어 있지 않다.
 *
 * <p>순수 계산이다. 격자와 power 배열만 받고 DB·회원을 모른다. 규칙 fixture를 고정 배열로 검증할 수
 * 있도록 이 경계를 지킨다(완료 조건 검증 방법).
 *
 * <h2>고르는 규칙</h2>
 *
 * 미결 5(봉우리 추출 규칙)를 <b>이미 정해진 값에서 유도</b>한다. 새 숫자를 만들지 않는다 — 새 숫자는
 * 누군가 다시 정해야 하고, 정하지 않은 채 기본값이 굳는다.
 *
 * <ol>
 * <li><b>최소 간격 = {@code 2h+1}칸</b>(h는 판 manifest의 {@code fine_tune.half_width_cells}).
 *     <b>가까운 추천을 줄이는 정책이지 선택 가능 범위를 보존하는 규칙이 아니다.</b> 두 미세 조정
 *     범위가 닿지 않을 만큼만 떼어 놓는다. h=3에서 100번과 106번의 범위 {@code [97,103]}·
 *     {@code [103,109]}는 한 점에서 닿지만, 100번을 골라 106번까지 조정할 수는 없다. 목록에서 빠진
 *     주기도 주기도에서 직접 고를 수 있다(5.4절).</li>
 * <li><b>고조파 제외는 {@code matching.harmonic_multipliers}를 그대로 쓴다.</b> 제출이 「2배 맞음」
 *     이라고 판정하는 배수와 목록이 거르는 배수가 다르면 화면과 채점이 어긋난다. 다만 이것이
 *     <b>같은 신호임을 판정하는 것은 아니다</b> — 제출 매칭에는 위상·duration·관측 통과 조건이 더
 *     있다. 기준은 <b>정확한 배수 주기가 그 봉우리의 미세 조정 범위 안에 드는가</b>이며 칸 수로
 *     반올림해 비교하지 않는다.</li>
 * </ol>
 *
 * <p>둘 다 <b>이미 뽑힌 더 센 봉우리</b>를 기준으로만 본다. 약한 쪽이 밀려난다.
 */
final class CandidatePeaks {

    /**
     * 격자 계산의 반올림만 흡수하는 상대 여유.
     *
     * <p>칸 폭(로그 격자에서 {@code r-1})보다 여러 자릿수 작아 판정을 넓히지 않는다.
     * 이것이 없으면 {@code h=0}에서 범위가 한 점이라, 정확히 배수 자리에 있는 봉우리도
     * {@code pow} 반올림 차이(상대 1e-16 수준)만으로 빠져나가 고조파 규칙이 사실상 꾨진다.
     */
    private static final double GRID_EPSILON = 1e-12;

    private CandidatePeaks() {
    }

    /**
     * 주기 격자. 배열을 저장하지 않고 범위·점 수·간격 규칙으로 계산한다(5.3절).
     *
     * @param logSpaced 로그 간격이면 칸마다 비율이 같고, 아니면 칸마다 폭이 같다
     */
    record Grid(double minDays, double maxDays, int count, boolean logSpaced) {

        /** 로그 격자의 칸 비율 r. 선형 격자에는 뜻이 없다. */
        double ratio() {
            return count < 2 ? 1 : Math.pow(maxDays / minDays, 1.0 / (count - 1));
        }

        double periodAt(int index) {
            if (count < 2) {
                return minDays;
            }
            return logSpaced
                    ? minDays * Math.pow(ratio(), index)
                    : minDays + (maxDays - minDays) * index / (count - 1);
        }

        /** {@code index} 칸의 폭. 로그 격자는 주기에 비례하므로 자리마다 다르다. */
        double cellWidthAt(int index) {
            if (count < 2) {
                return 0;
            }
            return logSpaced
                    ? periodAt(index) * (ratio() - 1)
                    : (maxDays - minDays) / (count - 1);
        }

    }

    /**
     * 고를 때 쓰는 규칙.
     *
     * @param halfWidthCells 판 manifest의 미세 조정 반폭 h. 최소 간격과 고조파 판정 범위가 여기서 나온다
     * @param harmonicMultipliers 운영 규칙 {@code matching.harmonic_multipliers}. 1은 자기 자신이라 건너뛴다
     */
    record Rules(int topN, int halfWidthCells, List<Double> harmonicMultipliers) {

        /** 두 미세 조정 범위가 닿지 않으려면 이만큼 떨어져야 한다. 추천을 줄이는 정책이다. */
        int minSeparationCells() {
            return 2 * halfWidthCells + 1;
        }
    }

    /**
     * 한 봉우리.
     *
     * @param gridIndex 같은 문맥·규칙 버전 안에서 사용자가 고른 봉우리의 식별값이다. {@code rank}는
     *                  정렬 결과라 제출에 쓰지 않는다(C02-R3)
     * @param power     주기도 {@code power[gridIndex]}의 float32 그대로다. double로 넓히면 JSON 숫자가
     *                  주기도 응답과 달라져 화면이 봉우리를 격자와 어긋난 것으로 거절한다 [S15P21C206-262]
     */
    record Peak(int rank, int gridIndex, double periodDays, float power,
                double fineTuneMinDays, double fineTuneMaxDays, double fineTuneStepDays) {
    }

    /**
     * 상위 봉우리를 센 순서로 고른다.
     *
     * <p>먼저 국소 최대를 모으고, 센 것부터 보면서 위 두 규칙에 걸리지 않는 것만 담는다. 이미 담은
     * 것보다 약한 쪽이 밀려나므로 결과는 <b>세기 내림차순</b>이고 동률은 낮은 칸이 앞이다.
     *
     * @param power 격자와 길이가 같은 세기 배열. null 칸은 없는 것으로 본다
     */
    static List<Peak> extract(Float[] power, Grid grid, Rules rules) {
        if (power == null || power.length != grid.count() || rules.topN() < 1) {
            return List.of();
        }
        List<Integer> maxima = localMaxima(power);
        maxima.sort(Comparator.<Integer, Double>comparing(i -> -power[i].doubleValue())
                .thenComparingInt(i -> i));

        List<Integer> picked = new ArrayList<>(rules.topN());
        for (int index : maxima) {
            if (picked.size() >= rules.topN()) {
                break;
            }
            if (picked.stream().noneMatch(chosen -> tooClose(index, chosen, grid, rules))) {
                picked.add(index);
            }
        }

        List<Peak> peaks = new ArrayList<>(picked.size());
        for (int rank = 0; rank < picked.size(); rank++) {
            int index = picked.get(rank);
            peaks.add(peakAt(rank + 1, index, power[index], grid, rules.halfWidthCells()));
        }
        return List.copyOf(peaks);
    }

    /**
     * 어떤 주기 P의 미세 조정 범위(5.4절). 목록에 없는 주기에도 같은 규칙을 쓴다.
     *
     * <p>{@code P × r^(−h) ~ P × r^(+h)}이며 step은 그 자리 격자 한 칸 폭이다. 격자를 벗어나지 않도록
     * 자른다 — 격자 밖 주기는 애초에 고를 수 없다.
     */
    static Peak peakAt(int rank, int gridIndex, float power, Grid grid, int halfWidthCells) {
        double[] range = fineTune(grid, gridIndex, halfWidthCells);
        return new Peak(rank, gridIndex, grid.periodAt(gridIndex), power,
                range[0], range[1], grid.cellWidthAt(gridIndex));
    }

    /**
     * {@code gridIndex}에서 미세 조정으로 닿을 수 있는 주기 범위 {@code [최소, 최대]}.
     *
     * <p>격자를 벗어나지 않도록 자른다. 격자 밖 주기는 애초에 고를 수 없으므로 고조파 판정도 화면이
     * 실제로 고를 수 있는 범위로 해야 한다.
     */
    private static double[] fineTune(Grid grid, int gridIndex, int halfWidthCells) {
        int low = Math.max(0, gridIndex - halfWidthCells);
        int high = Math.min(grid.count() - 1, gridIndex + halfWidthCells);
        return new double[] {grid.periodAt(low), grid.periodAt(high)};
    }

    /**
     * 양옆보다 높은 자리.
     *
     * <p>세 가지를 함께 만족해야 한다 — 왼쪽보다 <b>높고</b>, 오른쪽보다 낮지 않고, 있는 이웃 중
     * 적어도 하나보다는 <b>실제로 높다</b>. 마지막 조건이 없으면 값이 모두 같은 주기도에서 첫 칸이
     * 봉우리가 된다. 평평한 봉우리는 왼쪽 조건 때문에 첫 칸만 남는다.
     *
     * <p>끝 칸과 값이 없는 이웃은 <b>조건을 걸지 않되 높이의 근거로도 세지 않는다.</b> 없는 값을
     * 낮다고 보면 배열 끝이 언제나 봉우리가 된다.
     */
    private static List<Integer> localMaxima(Float[] power) {
        List<Integer> maxima = new ArrayList<>();
        for (int i = 0; i < power.length; i++) {
            if (!usable(power, i)) {
                continue;
            }
            boolean hasLeft = usable(power, i - 1);
            boolean hasRight = usable(power, i + 1);
            boolean aboveLeft = hasLeft && power[i] > power[i - 1];
            boolean aboveRight = hasRight && power[i] > power[i + 1];
            if ((!hasLeft || aboveLeft) && (!hasRight || power[i] >= power[i + 1])
                    && (aboveLeft || aboveRight)) {
                maxima.add(i);
            }
        }
        return maxima;
    }

    private static boolean usable(Float[] power, int index) {
        return index >= 0 && index < power.length && power[index] != null && Float.isFinite(power[index]);
    }

    /**
     * 이미 고른 봉우리와 너무 가깝거나 그 고조파인가.
     *
     * <p>두 기준의 뜻이 다르다. <b>간격</b>은 가까운 추천을 줄이는 정책이고, <b>고조파</b>는 정확한
     * 배수 주기가 이 봉우리의 미세 조정 범위 안에 드는지다.
     *
     * <p>고조파는 <b>주기 값으로 직접</b> 본다. 배수 자리를 칸 수로 반올림하면 격자에 따라 최대 반
     * 칸이 어긋나, 조정해도 닿을 수 없는 봉우리가 제외된다 — 0.5~40일 5000점 h=3에서 1000번의 2배
     * 자리는 1790.74번이고 1794번은 실제 3.26칸 떨어져 있는데, 반올림하면 3칸으로 보여 제외됐다
     * (S15P21C206-141 리뷰, 윤성용).
     */
    private static boolean tooClose(int index, int chosen, Grid grid, Rules rules) {
        if (Math.abs(index - chosen) < rules.minSeparationCells()) {
            return true;
        }
        double[] reachable = fineTune(grid, index, rules.halfWidthCells());
        for (double multiple : rules.harmonicMultipliers()) {
            if (multiple <= 0 || multiple == 1) {
                continue;
            }
            double target = grid.periodAt(chosen) * multiple;
            double slack = target * GRID_EPSILON;
            if (target >= reachable[0] - slack && target <= reachable[1] + slack) {
                return true;
            }
        }
        return false;
    }
}
