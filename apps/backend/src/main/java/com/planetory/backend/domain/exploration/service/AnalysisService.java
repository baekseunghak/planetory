package com.planetory.backend.domain.exploration.service;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.OptionalLong;
import java.util.TreeSet;
import com.fasterxml.jackson.databind.JsonNode;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import com.planetory.backend.domain.exploration.service.AnalysisViews.Answer;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Curve;
import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveContext;
import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveQuery;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Periodogram;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Residual;
import com.planetory.backend.domain.exploration.service.AnalysisViews.Segment;
import com.planetory.backend.domain.gold.GoldCatalogRepository;
import com.planetory.backend.domain.gold.GoldCatalogViews;
import com.planetory.backend.domain.gold.GoldCatalogViews.Bundle;
import com.planetory.backend.domain.gold.GoldCatalogViews.LightCurveSegment;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.error.ErrorResponse.FieldError;

/**
 * 분석 화면의 곡선·주기도 조회 (탐사 API 5.2·5.3) [S15P21C206-140].
 *
 * <p>검사 순서는 5.1절과 같다: 공개된 별 → 회원이 연 별 → 현재 판. 그다음 요청 문맥을 현재 판과
 * 대조한다. 판·계산 버전이 다르면 제거 조합을 보기 전에 {@code BUNDLE_CHANGED}로 끝낸다. 어떤 후보를
 * 제거할 수 있는지는 현재 판에서만 뜻이 있다.
 *
 * <p>현재 판과 배열을 한 스냅샷에서 읽는다. 따로 읽으면 그사이 판이 바뀌어 방금 확인한 판의 주기도
 * 행이 지워진 것처럼 보일 수 있다(판이 archived가 되면 주기도 행을 지운다, ERD).
 */
@Service
@RequiredArgsConstructor
public class AnalysisService {

    static final String FLUX_UNIT = "normalized";

    private static final BigDecimal TWO = BigDecimal.valueOf(2);

    private final AnalysisRepository analysis;
    private final StarRepository stars;
    private final GoldCatalogRepository gold;
    private final ResidualResultReader residuals;

    /**
     * 곡선 (5.2절). 원본과 잔차 단계가 같은 형식이다.
     *
     * <p>잔차가 준비되지 않았으면 {@code segments}를 비워 202로 보낸다. 조회는 작업을 만들지 않는다(D-14).
     *
     * @throws BusinessException 미공개 {@code STAR_NOT_PUBLISHED}, 미발견 {@code STAR_LOCKED},
     *                           현재 판 없음 {@code DEPENDENCY_UNAVAILABLE}, 판·버전 불일치
     *                           {@code BUNDLE_CHANGED}, 요청 형식·제거 조합 오류 {@code VALIDATION_FAILED}
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Answer<Curve> curve(long memberId, long ticId, CurveQuery query) {
        Target target = resolve(memberId, ticId, query);

        if (target.context().curveStep() == 0) {
            List<Segment> original = segmentsOf(target).stream().map(s -> segmentOf(s, s.flux())).toList();
            return target.answer(curveOf(ticId, target, Residual.ORIGINAL, original), true);
        }

        ResidualResultReader.Lookup lookup = residuals.lookup(target.context());
        if (!lookup.completed()) {
            // 보내지 않을 원본 배열은 읽지 않는다.
            return target.answer(curveOf(ticId, target, residualOf(lookup), null), false);
        }
        List<Segment> residual = segmentsOf(target).stream()
                .map(s -> segmentOf(s, residualFlux(lookup, s)))
                .toList();
        return target.answer(curveOf(ticId, target, residualOf(lookup), residual), true);
    }

    /**
     * 주기도 (5.3절). 원본은 {@code periodograms} 행, 잔차 단계는 잔차 결과이며 격자는 같다.
     *
     * <p>잔차가 준비되지 않았으면 {@code power}를 비워 202로 보낸다.
     *
     * @throws BusinessException {@link #curve}와 같다
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Answer<Periodogram> periodogram(long memberId, long ticId, CurveQuery query) {
        Target target = resolve(memberId, ticId, query);
        Bundle bundle = target.bundle();
        GoldCatalogViews.Periodogram original = gold.findPeriodogram(bundle.id())
                .orElseThrow(() -> new IllegalStateException(
                        ExplorationIds.bundle(bundle.id()) + "은 현재 판인데 주기도 행이 없습니다. 적재 계약이 어긋났습니다."));

        if (target.context().curveStep() == 0) {
            return target.answer(periodogramOf(target, original, Residual.ORIGINAL, original.power()), true);
        }

        ResidualResultReader.Lookup lookup = residuals.lookup(target.context());
        if (!lookup.completed()) {
            return target.answer(periodogramOf(target, original, residualOf(lookup), null), false);
        }
        Float[] power = lookup.power();
        if (power == null || power.length != original.nPeriods()) {
            throw new IllegalStateException(target.context() + "의 잔차 주기도가 격자 크기와 맞지 않습니다.");
        }
        return target.answer(periodogramOf(target, original, residualOf(lookup), power), true);
    }

    private Target resolve(long memberId, long ticId, CurveQuery query) {
        if (!analysis.isPublished(ticId)) {
            throw new BusinessException(ErrorCode.STAR_NOT_PUBLISHED);
        }
        if (!stars.hasUnlocked(memberId, ticId)) {
            throw new BusinessException(ErrorCode.STAR_LOCKED);
        }
        Bundle bundle = gold.findCurrentBundle(ticId)
                .orElseThrow(() -> new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE));

        Requested requested = Requested.parse(query);
        String residualModelVersion = bundle.manifest().residualModelVersion();
        String periodogramConfigVersion = bundle.manifest().periodogramConfigVersion();
        if (requested.bundleId() != bundle.id()
                || differs(requested.residualModelVersion(), residualModelVersion)
                || differs(requested.periodogramConfigVersion(), periodogramConfigVersion)) {
            throw new BusinessException(ErrorCode.BUNDLE_CHANGED,
                    Map.of("currentBundleId", ExplorationIds.bundle(bundle.id())));
        }

        if (requested.curveStep() != requested.removed().size()) {
            throw invalid("curveStep", "제거한 후보 수와 같아야 합니다.");
        }
        if (!requested.removed().isEmpty()
                && !analysis.findMatchedActiveCandidateIds(memberId, ticId).containsAll(requested.removed())) {
            // 매칭하지 않은 후보와 은퇴한 후보를 구분하지 않는다. 구분하면 미매칭 후보 ID가 드러난다.
            throw invalid("removed", "이 별에서 매칭한 활성 후보만 제거할 수 있습니다.");
        }

        CurveContext context = new CurveContext(ExplorationIds.bundle(bundle.id()), requested.curveStep(),
                requested.removed().stream().map(ExplorationIds::candidate).toList(),
                residualModelVersion, periodogramConfigVersion);
        return new Target(bundle, context);
    }

    private static boolean differs(String requested, String current) {
        return requested != null && !requested.equals(current);
    }

    private static BusinessException invalid(String field, String reason) {
        return new BusinessException(ErrorCode.VALIDATION_FAILED, ErrorCode.VALIDATION_FAILED.getDefaultMessage(),
                List.of(new FieldError(field, reason)));
    }

    /** 판이 참조하는 세그먼트를 섹터 순으로. 섹터가 아니라 id로 읽어야 revision이 섞이지 않는다. */
    private List<LightCurveSegment> segmentsOf(Target target) {
        return gold.findSegments(target.bundle().manifest().segmentIds());
    }

    private static Curve curveOf(long ticId, Target target, Residual residual, List<Segment> segments) {
        return new Curve(String.valueOf(ticId), target.context().bundleId(),
                target.bundle().foldReferenceTimeBtjd(), target.context(), residual, FLUX_UNIT, segments);
    }

    private static Periodogram periodogramOf(Target target, GoldCatalogViews.Periodogram original,
                                             Residual residual, Float[] power) {
        Bundle bundle = target.bundle();
        return new Periodogram(target.context().bundleId(), target.context(), residual,
                original.periodMinDays(), original.periodMaxDays(), original.nPeriods(), gridRuleOf(bundle),
                // 주기가 관측 기간의 절반을 넘으면 통과를 두 번 볼 수 없다. 프론트가 그 구간을 음영 처리한다.
                bundle.baseDays().divide(TWO), power);
    }

    private static Residual residualOf(ResidualResultReader.Lookup lookup) {
        return new Residual(lookup.status(), lookup.jobId(), lookup.computedAt());
    }

    private static Segment segmentOf(LightCurveSegment segment, Float[] flux) {
        return new Segment(ExplorationIds.segment(segment.id()), segment.sector(), segment.binningRevision(),
                segment.startBtjd(), segment.binMinutes(), segment.nPoints(), flux, segment.fluxScatter(),
                gapsOf(segment));
    }

    private static Float[] residualFlux(ResidualResultReader.Lookup lookup, LightCurveSegment segment) {
        Float[] flux = lookup.segmentFlux().get(segment.id());
        if (flux == null || flux.length != segment.nPoints()) {
            throw new IllegalStateException("잔차 결과가 " + ExplorationIds.segment(segment.id())
                    + "의 점 수와 맞지 않습니다.");
        }
        return flux;
    }

    /**
     * 빈 bin의 {@code [시작, 끝]} 폐구간 (Gold 게시 계약 4절). 어긋나면 적재 계약 위반이다.
     *
     * <p>DB JSONB를 읽은 노드를 그대로 응답에 싣지 않는다. 조회 모델의 노드와 HTTP 직렬화가 쓰는
     * Jackson 판이 달라, 그대로 두면 배열이 아니라 노드 객체의 속성이 나간다.
     */
    static List<int[]> gapsOf(LightCurveSegment segment) {
        JsonNode gaps = segment.gaps();
        if (gaps == null || !gaps.isArray()) {
            throw contractViolation(segment, "gaps가 배열이 아닙니다");
        }
        List<int[]> ranges = new ArrayList<>(gaps.size());
        for (JsonNode gap : gaps) {
            if (!gap.isArray() || gap.size() != 2
                    || !gap.get(0).isIntegralNumber() || !gap.get(1).isIntegralNumber()) {
                throw contractViolation(segment, "gaps 항목이 [시작, 끝] 정수 쌍이 아닙니다");
            }
            long start = gap.get(0).longValue();
            long end = gap.get(1).longValue();
            if (start < 0 || start > end || end >= segment.nPoints()) {
                throw contractViolation(segment, "gaps 범위 [" + start + ", " + end + "]가 점 범위를 벗어났습니다");
            }
            ranges.add(new int[] {(int) start, (int) end});
        }
        return ranges;
    }

    private static IllegalStateException contractViolation(LightCurveSegment segment, String detail) {
        return new IllegalStateException(ExplorationIds.segment(segment.id()) + "의 " + detail
                + ". 적재 계약이 어긋났습니다.");
    }

    /** 주기 격자 간격 규칙. 격자 배열은 저장하지 않으므로 이 값이 없으면 주기를 계산할 수 없다. */
    private static String gridRuleOf(Bundle bundle) {
        JsonNode spacing = bundle.manifest().periodGrid().get("spacing");
        if (spacing == null || !spacing.isTextual()) {
            throw new IllegalStateException(ExplorationIds.bundle(bundle.id())
                    + "의 manifest.period_grid.spacing이 없습니다. 적재 계약이 어긋났습니다.");
        }
        return spacing.asText();
    }

    private record Target(Bundle bundle, CurveContext context) {

        <T> Answer<T> answer(T body, boolean ready) {
            return new Answer<>(body, ready, context.bundleId());
        }
    }

    /**
     * 형식을 검사한 요청 문맥. 제거 후보는 id 숫자 오름차순으로 정렬하고 중복을 없앤다(2.1절).
     *
     * <p>계산 버전은 주면 대조하고 주지 않으면 대조하지 않는다. 쿼리 예시(5.2절)에는 없지만 2.1절이
     * 요청값이 다르면 {@code BUNDLE_CHANGED}로 거절하라고 한다.
     */
    private record Requested(long bundleId, int curveStep, List<Long> removed,
                             String residualModelVersion, String periodogramConfigVersion) {

        private static final int MAX_CURVE_STEP = Short.MAX_VALUE;

        static Requested parse(CurveQuery query) {
            List<FieldError> errors = new ArrayList<>();

            OptionalLong bundleId = ExplorationIds.parse(query.bundleId(), ExplorationIds.BUNDLE);
            if (bundleId.isEmpty()) {
                errors.add(new FieldError("bundleId", "b-<id> 형식이어야 합니다."));
            }

            int curveStep = parseCurveStep(query.curveStep());
            if (curveStep < 0) {
                errors.add(new FieldError("curveStep", "0 이상의 정수여야 합니다."));
            }

            TreeSet<Long> removed = new TreeSet<>();
            for (String value : query.removed() == null ? List.<String>of() : query.removed()) {
                if (value == null || value.isBlank()) {
                    continue;
                }
                OptionalLong id = ExplorationIds.parse(value.strip(), ExplorationIds.CANDIDATE);
                if (id.isEmpty()) {
                    errors.add(new FieldError("removed", "c-<id> 형식이어야 합니다."));
                    break;
                }
                removed.add(id.getAsLong());
            }

            if (!errors.isEmpty()) {
                throw new BusinessException(ErrorCode.VALIDATION_FAILED,
                        ErrorCode.VALIDATION_FAILED.getDefaultMessage(), errors);
            }
            return new Requested(bundleId.getAsLong(), curveStep, List.copyOf(removed),
                    blankToNull(query.residualModelVersion()), blankToNull(query.periodogramConfigVersion()));
        }

        /** 0 또는 앞자리 0이 없는 정수만. 형식이 틀리면 -1. */
        private static int parseCurveStep(String value) {
            if (value == null || value.isEmpty() || value.length() > 5
                    || (value.length() > 1 && value.charAt(0) == '0')) {
                return -1;
            }
            for (int i = 0; i < value.length(); i++) {
                if (value.charAt(i) < '0' || value.charAt(i) > '9') {
                    return -1;
                }
            }
            int step = Integer.parseInt(value);
            return step <= MAX_CURVE_STEP ? step : -1;
        }

        private static String blankToNull(String value) {
            return value == null || value.isBlank() ? null : value;
        }
    }
}
