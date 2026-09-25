package com.planetory.backend.domain.exploration.service;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
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
                       NasaPlanetExplanation.Content content, String sourceStatus,
                       OffsetDateTime fetchedAt, String refreshStatus, OffsetDateTime generatedAt,
                       OffsetDateTime retryAt, String failure) {
    }

    /** 별 목록의 읽기 트랜잭션을 마친 뒤 후보별 외부 조회·설명을 실행한다. */
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public Bundle lookup(long memberId, long ticId) {
        var detail = stars.detail(memberId, ticId);
        List<Item> items = new ArrayList<>(detail.planets().items().size());
        for (var planet : detail.planets().items()) {
            if ("unconfirmed".equals(planet.kind())) {
                items.add(new Item(planet.candidateId(), planet.kind(), "not_applicable",
                        null, null, null, null, null, null, null));
                continue;
            }
            long candidateId = ExplorationIds.parse(planet.candidateId(), ExplorationIds.CANDIDATE)
                    .orElseThrow(() -> new IllegalStateException("Invalid candidate ID in star detail"));
            try {
                var found = explanations.lookup(memberId, candidateId);
                var source = found.source();
                boolean ready = "ready".equals(found.status());
                items.add(new Item(planet.candidateId(), planet.kind(), found.status(),
                        ready ? found.content() : null,
                        source == null ? null : source.status(),
                        source == null ? null : source.fetchedAt(),
                        source == null ? null : source.refreshStatus(),
                        ready ? found.generatedAt() : null, found.retryAt(), found.failure()));
            } catch (BusinessException noLongerEligible) {
                if (noLongerEligible.getErrorCode() != ErrorCode.RESOURCE_NOT_FOUND) {
                    throw noLongerEligible;
                }
                items.add(new Item(planet.candidateId(), planet.kind(), "source_unavailable",
                        null, "not_eligible", null, null, null, null, null));
            }
        }
        return new Bundle(detail.ticId(), detail.version(), List.copyOf(items));
    }
}
