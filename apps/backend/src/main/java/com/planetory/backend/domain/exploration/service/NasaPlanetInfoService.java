package com.planetory.backend.domain.exploration.service;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.HexFormat;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import static com.planetory.backend.domain.exploration.service.NasaPlanetInfo.Lookup;
import static com.planetory.backend.domain.exploration.service.NasaPlanetInfo.Planet;

/** 267 별 단위 API가 호출하는 회원별 확정 후보 NASA 자료 경계. */
@Service
public class NasaPlanetInfoService {

    private static final Logger log = LoggerFactory.getLogger(NasaPlanetInfoService.class);
    private final NasaPlanetInfoRepository repository;
    private final NasaTapClient tap;
    private final Clock clock;
    private final boolean enabled;
    private final Duration readyTtl;
    private final Duration emptyTtl;
    private final Duration retryDelay;

    NasaPlanetInfoService(NasaPlanetInfoRepository repository, NasaTapClient tap, Clock clock,
                          @Value("${planetory.nasa.enabled:true}") boolean enabled,
                          @Value("${planetory.nasa.ready-ttl:7d}") Duration readyTtl,
                          @Value("${planetory.nasa.empty-ttl:1d}") Duration emptyTtl,
                          @Value("${planetory.nasa.retry-delay:5m}") Duration retryDelay) {
        if (readyTtl.isZero() || readyTtl.isNegative() || emptyTtl.isZero() || emptyTtl.isNegative()
                || retryDelay.isZero() || retryDelay.isNegative()) {
            throw new IllegalArgumentException("NASA refresh periods must be positive");
        }
        this.repository = repository;
        this.tap = tap;
        this.clock = clock;
        this.enabled = enabled;
        this.readyTtl = readyTtl;
        this.emptyTtl = emptyTtl;
        this.retryDelay = retryDelay;
    }

    /**
     * 회원이 이 후보를 수치 매칭했고 별을 열었으며 후보가 확정일 때만 호출한다.
     * 외부 HTTPS 동안 기존 DB 트랜잭션은 중지한다. NASA 결과로 Gold 판정은 변경하지 않는다.
     */
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public Lookup lookup(long memberId, long candidateId) {
        long ticId = repository.allowedTic(memberId, candidateId)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        List<String> names = repository.archiveNames(candidateId, ticId);
        if (names.size() != 1 || names.getFirst().isBlank()
                || repository.nameSharedWithAnotherCandidate(candidateId, ticId, names.getFirst())) {
            return new Lookup("identity_unresolved", null, null, null, null, "identity_unresolved", null);
        }
        String name = names.getFirst(); // 공급 검증을 전제로 한 archive 행성명. 유사명·주기 추측은 금지한다.
        OffsetDateTime now = OffsetDateTime.now(clock);
        var cached = repository.find(candidateId);
        if (cached.isPresent() && !sameIdentity(cached.get(), ticId, name)) {
            return new Lookup("identity_unresolved", null, null, null, null, "identity_changed", null);
        }
        if (!enabled) {
            return cached.map(row -> result(row, "disabled"))
                    .orElseGet(() -> new Lookup("temporarily_unavailable", null, null, null, null, "disabled", null));
        }
        if (cached.isPresent() && cached.get().nextRefreshAt().isAfter(now)) {
            return result(cached.get(), cached.get().refreshStatus());
        }
        var generation = repository.claim(candidateId, ticId, name, now,
                now.plus(tap.leaseDuration()));
        if (generation.isEmpty()) {
            return repository.find(candidateId).filter(row -> sameIdentity(row, ticId, name))
                    .map(row -> result(row, row.refreshStatus()))
                    .orElseGet(() -> new Lookup("identity_unresolved", null, null, null, null,
                            "identity_changed", null));
        }

        try {
            List<Planet> matches = tap.fetch(ticId).stream()
                    .filter(row -> name.equals(row.planetName())).toList();
            OffsetDateTime completedAt = OffsetDateTime.now(clock);
            if (matches.isEmpty()) {
                repository.notFound(candidateId, generation.get(), completedAt.plus(emptyTtl));
            } else if (matches.size() != 1 || !"Published Confirmed".equals(matches.getFirst().solutionType())) {
                repository.unresolved(candidateId, generation.get(), completedAt.plus(emptyTtl));
            } else {
                Planet planet = matches.getFirst();
                repository.ready(candidateId, generation.get(), planet, sha256(repository.encode(planet)),
                        completedAt, completedAt.plus(readyTtl));
            }
        } catch (NasaTapClient.FetchFailure failure) {
            log.warn("NASA PS refresh failed: candidateId={}, ticId={}, reason={}",
                    candidateId, ticId, failure.code());
            repository.failed(candidateId, generation.get(), failure.code(),
                    OffsetDateTime.now(clock).plus(retryDelay));
        }
        // generation 비교가 실패하면 다른 서버의 더 새 조회 결과를 돌려준다.
        return repository.find(candidateId).map(row -> result(row, row.refreshStatus()))
                .orElseThrow(() -> new IllegalStateException("NASA lookup row disappeared"));
    }

    private static boolean sameIdentity(NasaPlanetInfoRepository.Row row, long ticId, String name) {
        return row.ticId() == ticId && row.name().equals(name);
    }

    private static Lookup result(NasaPlanetInfoRepository.Row row, String refreshStatus) {
        String status = "pending".equals(row.status()) ? "refreshing" : row.status();
        return new Lookup(status, "ready".equals(status) ? row.planet() : null,
                row.fetchedAt(), row.changedAt(), row.hash(), refreshStatus, row.sourceVersion());
    }

    private static String sha256(String normalized) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(normalized.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
