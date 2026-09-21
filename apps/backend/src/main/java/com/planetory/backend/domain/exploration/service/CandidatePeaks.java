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
 *     미세 조정 범위가 겹치는 두 봉우리는 사용자에게 <b>같은 선택</b>이다 — 어느 쪽을 골라도 같은
 *     주기로 맞출 수 있다. 목록에 둘 다 두면 자리만 차지한다.</li>
 * <li><b>고조파 제외는 {@code matching.harmonic_multipliers}를 그대로 쓴다.</b> 제출이 「이 주기는
 *     저 후보의 2배다」라고 판정하는 배수와, 목록이 「이 봉우리는 위 봉우리의 2배다」라고 판정하는
 *     배수가 다르면 화면과 채점이 어긋난다. 허용 오차는 <b>{@code h}칸</b>이다 — 그 봉우리를 미세
 *     조정해 정확히 그 배수에 닿을 수 있으면 같은 고조파로 본다.</li>
 * </ol>
 *
 * <p>둘 다 <b>이미 뽑힌 더 센 봉우리</b>를 기준으로만 본다. 약한 쪽이 밀려난다.
 */
final class CandidatePeaks {

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

        /** 배수 {@code multiple}이 격자에서 몇 칸인지. 로그 격자에서만 자리에 무관하게 일정하다. */
        int cellsFor(double multiple, int from) {
            double target = periodAt(from) * multiple;
            if (target <= 0) {
                return Integer.MAX_VALUE;
            }
            double exact = logSpaced
                    ? Math.log(target / minDays) / Math.log(ratio())
                    : (target - minDays) * (count - 1) / (maxDays - minDays);
            return (int) Math.round(exact) - from;
        }
    }

    /**
     * 고를 때 쓰는 규칙.
     *
     * @param halfWidthCells 판 manifest의 미세 조정 반폭 h. 최소 간격과 고조파 허용 오차가 여기서 나온다
     * @param harmonicMultipliers 운영 규칙 {@code matching.harmonic_multipliers}. 1은 자기 자신이라 건너뛴다
     */
    record Rules(int topN, int halfWidthCells, List<Double> harmonicMultipliers) {

        /** 미세 조정 범위가 겹치지 않으려면 이만큼 떨어져야 한다. */
        int minSeparationCells() {
            return 2 * halfWidthCells + 1;
        }
    }

    /**
     * 한 봉우리.
     *
     * @param gridIndex 같은 문맥·규칙 버전 안에서 사용자가 고른 봉우리의 식별값이다. {@code rank}는
     *                  정렬 결과라 제출에 쓰지 않는다(C02-R3)
     */
    record Peak(int rank, int gridIndex, double periodDays, double power,
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
            peaks.add(peakAt(rank + 1, index, power[index].doubleValue(), grid, rules.halfWidthCells()));
        }
        return List.copyOf(peaks);
    }

    /**
     * 어떤 주기 P의 미세 조정 범위(5.4절). 목록에 없는 주기에도 같은 규칙을 쓴다.
     *
     * <p>{@code P × r^(−h) ~ P × r^(+h)}이며 step은 그 자리 격자 한 칸 폭이다. 격자를 벗어나지 않도록
     * 자른다 — 격자 밖 주기는 애초에 고를 수 없다.
     */
    static Peak peakAt(int rank, int gridIndex, double power, Grid grid, int halfWidthCells) {
        double period = grid.periodAt(gridIndex);
        int low = Math.max(0, gridIndex - halfWidthCells);
        int high = Math.min(grid.count() - 1, gridIndex + halfWidthCells);
        return new Peak(rank, gridIndex, period, power,
                grid.periodAt(low), grid.periodAt(high), grid.cellWidthAt(gridIndex));
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
     * <p>두 기준의 폭이 다르다. <b>겹침</b>은 두 미세 조정 범위가 닿는지라 {@code 2h+1}칸이고,
     * <b>고조파</b>는 이 봉우리를 조정해 그 배수에 닿을 수 있는지라 {@code h}칸이다. 고조파에도
     * {@code 2h+1}을 쓰면 배수 자리에서 한참 떨어진 봉우리까지 고조파로 몰아 목록이 비어 간다.
     */
    private static boolean tooClose(int index, int chosen, Grid grid, Rules rules) {
        if (Math.abs(index - chosen) < rules.minSeparationCells()) {
            return true;
        }
        for (double multiple : rules.harmonicMultipliers()) {
            if (multiple <= 0 || multiple == 1) {
                continue;
            }
            int cells = grid.cellsFor(multiple, chosen);
            if (cells != Integer.MAX_VALUE
                    && Math.abs(index - (chosen + cells)) <= rules.halfWidthCells()) {
                return true;
            }
        }
        return false;
    }
}
