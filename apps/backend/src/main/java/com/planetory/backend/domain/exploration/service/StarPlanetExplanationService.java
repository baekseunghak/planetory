package com.planetory.backend.domain.exploration.service;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.math.BigDecimal;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** 회원의 별 상세 목록을 후보별 한국어 설명과 같은 ID로 묶는다. */
@Service
@RequiredArgsConstructor
public class StarPlanetExplanationService {

    private final StarService stars;
    private final NasaPlanetExplanationService explanations;

    public record Bundle(String ticId, String version, List<Item> items) {
    }

    public record Item(String candidateId, String kind, String status,
                       NasaPlanetExplanation.Content content, Facts facts, String sourceStatus,
                       OffsetDateTime fetchedAt, String refreshStatus, OffsetDateTime generatedAt,
                       OffsetDateTime retryAt, String failure) {
    }

    /** NASA PS의 검증된 기본 해. HTML 문헌 원문은 공개하지 않는다. */
    public record Facts(String planetName, Measurement orbitalPeriod, Measurement radius,
                        Measurement mass, String discoveryMethod, Integer discoveryYear,
                        Boolean controversial, String sourceTable, String sourceUrl) {
    }

    public record Measurement(String value, String errorPlus, String errorMinus,
                              Integer limit, String unit, String reference) {
    }

    /** 저장 결과만 조회한다. */
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public Bundle read(long memberId, long ticId) {
        return read(memberId, ticId, null, null);
    }

    /** 버튼으로 고른 확정 후보만 생성한다. 응답 직전 별과 회원 자격을 다시 읽는다. */
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public Bundle request(long memberId, long ticId, String candidateId) {
        long selected = ExplorationIds.parse(candidateId, ExplorationIds.CANDIDATE)
                .orElseThrow(() -> new BusinessException(ErrorCode.VALIDATION_FAILED));
        var detail = stars.detail(memberId, ticId);
        if (detail.planets().items().stream().noneMatch(item ->
                item.candidateId().equals(candidateId) && "confirmed".equals(item.kind()))) {
            throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        }
        NasaPlanetExplanation.Lookup requested = null;
        try {
            requested = explanations.lookup(memberId, selected);
        } catch (BusinessException noLongerEligible) {
            if (noLongerEligible.getErrorCode() != ErrorCode.RESOURCE_NOT_FOUND) {
                throw noLongerEligible;
            }
        }
        return read(memberId, ticId, candidateId, requested);
    }

    private Bundle read(long memberId, long ticId, String requestedCandidate,
                        NasaPlanetExplanation.Lookup requested) {
        var detail = stars.detail(memberId, ticId);
        List<Item> items = new ArrayList<>(detail.planets().items().size());
        for (var planet : detail.planets().items()) {
            if ("unconfirmed".equals(planet.kind())) {
                items.add(new Item(planet.candidateId(), planet.kind(), "not_applicable",
                        null, null, null, null, null, null, null, null));
                continue;
            }
            long candidateId = ExplorationIds.parse(planet.candidateId(), ExplorationIds.CANDIDATE)
                    .orElseThrow(() -> new IllegalStateException("Invalid candidate ID in star detail"));
            try {
                var found = explanations.read(memberId, candidateId);
                if (planet.candidateId().equals(requestedCandidate) && requested != null
                        && !"ready".equals(found.status()) && !"pending".equals(found.status())) {
                    var requestedSource = requested.source();
                    var currentSource = found.source();
                    if (("quota_exceeded".equals(requested.status()) || "busy".equals(requested.status()))
                            && requestedSource != null && currentSource != null
                            && "ready".equals(requestedSource.status()) && "ready".equals(currentSource.status())
                            && Objects.equals(requestedSource.sourceHash(), currentSource.sourceHash())
                            && Objects.equals(requestedSource.sourceVersion(), currentSource.sourceVersion())) {
                        found = requested;
                    } else if ("source_unavailable".equals(requested.status())
                            && requestedSource != null && currentSource != null
                            && "temporarily_unavailable".equals(requestedSource.status())
                            && "disabled".equals(requestedSource.refreshStatus())
                            && "not_requested".equals(currentSource.status())) {
                        found = requested;
                    }
                }
                var source = found.source();
                boolean ready = "ready".equals(found.status());
                items.add(new Item(planet.candidateId(), planet.kind(), found.status(),
                        ready ? found.content() : null, facts(source),
                        source == null ? null : source.status(),
                        source == null ? null : source.fetchedAt(),
                        source == null ? null : source.refreshStatus(),
                        ready ? found.generatedAt() : null, found.retryAt(), found.failure()));
            } catch (BusinessException noLongerEligible) {
                if (noLongerEligible.getErrorCode() != ErrorCode.RESOURCE_NOT_FOUND) {
                    throw noLongerEligible;
                }
                items.add(new Item(planet.candidateId(), planet.kind(), "source_unavailable",
                        null, null, "not_eligible", null, null, null, null, null));
            }
        }
        return new Bundle(detail.ticId(), detail.version(), List.copyOf(items));
    }

    static Facts facts(NasaPlanetInfo.Lookup source) {
        if (source == null || !"ready".equals(source.status()) || source.planet() == null
                || source.sourceVersion() == null || source.sourceVersion() != 1
                || source.sourceHash() == null || !source.sourceHash().matches("[0-9a-f]{64}")) {
            return null;
        }
        var planet = source.planet();
        try {
            NasaPlanetExplanationText.instructions(planet, source.sourceHash());
            return new Facts(planet.planetName(), measure(planet.periodDays()),
                    measure(planet.radiusEarth()), measure(planet.massEarth()),
                    plain(planet.discoveryMethod()), planet.discoveryYear(), planet.controversial(),
                    "ps", "https://exoplanetarchive.ipac.caltech.edu/");
        } catch (IllegalArgumentException invalidSource) {
            return null;
        }
    }

    private static Measurement measure(NasaPlanetInfo.Measurement value) {
        return value == null ? null : new Measurement(decimal(value.value()), decimal(value.errorPlus()),
                decimal(value.errorMinus()), value.limit(), value.unit(), plain(value.reference()));
    }

    private static String decimal(BigDecimal value) {
        if (value == null) return null;
        if (value.precision() > 20 || value.scale() > 12 || value.scale() < -12) {
            throw new IllegalArgumentException("NASA measurement is out of display range");
        }
        return value.toPlainString();
    }

    private static String plain(String value) {
        if (value == null || value.length() > 240 || value.chars().anyMatch(c ->
                c == '<' || c == '>' || c == '&' || Character.isISOControl(c))) {
            return null;
        }
        return value;
    }
}
