package com.planetory.backend.domain.exploration.service;

import java.util.ArrayList;
import java.util.List;
import com.planetory.backend.domain.gold.GoldCatalogViews.LightCurveSegment;

/** bin 중심 시각 기준. 중앙값의 신뢰구간이 아니라 구간 내 밝기 산포다. */
public record FoldedSnapshot(int bins, Float[] foldedFlux, Float[] foldedError) {
    public static final String VERSION = "folded-mad-v1";
    public static final int BINS = 150;

    public static FoldedSnapshot calculate(List<LightCurveSegment> segments, double period, double reference) {
        if (!Double.isFinite(period) || period <= 0 || !Double.isFinite(reference)) throw corrupt();
        List<List<Double>> groups = new ArrayList<>(BINS);
        for (int i = 0; i < BINS; i++) groups.add(new ArrayList<>());
        for (LightCurveSegment s : segments) {
            if (s.flux() == null || s.flux().length != s.nPoints() || !Double.isFinite(s.startBtjd())
                    || s.binMinutes().signum() <= 0) throw corrupt();
            for (int i = 0; i < s.nPoints(); i++) {
                Float flux = s.flux()[i];
                if (flux == null) continue;
                if (!Float.isFinite(flux)) throw corrupt();
                double cycle = (s.startBtjd() + (s.binMinutes().doubleValue() / 1440.0) * (i + 0.5) - reference) / period;
                if (!Double.isFinite(cycle)) throw corrupt();
                double phase = cycle % 1;
                if (phase < 0) phase += 1;
                if (phase >= 1) phase = 0;
                if (phase >= 0.5) phase -= 1;
                groups.get(Math.min(BINS - 1, (int) Math.floor((phase + 0.5) * BINS))).add((double) flux);
            }
        }
        Float[] flux = new Float[BINS], error = new Float[BINS];
        for (int i = 0; i < BINS; i++) {
            List<Double> values = groups.get(i);
            if (values.isEmpty()) continue;
            double center = median(values);
            flux[i] = asFloat(center);
            if (values.size() > 1) error[i] = asFloat(1.4826 * median(values.stream()
                    .map(v -> Math.abs(v - center)).toList()));
        }
        return new FoldedSnapshot(BINS, flux, error);
    }

    private static double median(List<Double> values) {
        double[] sorted = values.stream().mapToDouble(Double::doubleValue).sorted().toArray();
        int mid = sorted.length / 2;
        return sorted.length % 2 == 1 ? sorted[mid] : sorted[mid - 1] / 2 + sorted[mid] / 2;
    }
    private static float asFloat(double value) {
        float f = (float) value;
        if (!Float.isFinite(f)) throw corrupt();
        return f == 0 ? 0 : f;
    }
    private static IllegalStateException corrupt() { return new IllegalStateException("스냅샷 곡선 데이터가 유효하지 않습니다."); }
}
