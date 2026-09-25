package com.planetory.backend.domain.exploration.service;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.TimeoutException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import static com.planetory.backend.domain.exploration.service.NasaPlanetInfo.Planet;
import static com.planetory.backend.domain.exploration.service.NasaStarPlanetRepository.Catalog;
import static com.planetory.backend.domain.exploration.service.NasaStarPlanetRepository.ExplanationRow;
import static com.planetory.backend.domain.exploration.service.NasaStarPlanetRepository.PlanetRow;
import static com.planetory.backend.domain.exploration.service.NasaStarPlanetRepository.SourceEntry;

/** 답을 제출한 회원의 결과 페이지에만 NASA 전체 참고 목록을 별도로 제공한다. */
@Service
public class NasaStarPlanetService {

    private static final Logger log = LoggerFactory.getLogger(NasaStarPlanetService.class);
    private static final String PROMPT_VERSION = "nasa-ko-v4";

    private final NasaStarPlanetRepository repository;
    private final NasaPlanetInfoRepository normalized;
    private final NasaTapClient tap;
    private final NasaPlanetExplanationGenerator generator;
    private final NasaExplanationQuota quota;
    private final Clock clock;
    private final TransactionTemplate snapshot;
    private final boolean nasaEnabled;
    private final boolean explanationEnabled;
    private final String model;
    private final Duration readyTtl;
    private final Duration emptyTtl;
    private final Duration nasaRetry;
    private final Duration modelTimeout;
    private final Duration modelRetry;
    private final int dailyPerMember;
    private final int dailyGlobal;

    NasaStarPlanetService(NasaStarPlanetRepository repository, NasaPlanetInfoRepository normalized,
                          NasaTapClient tap, NasaPlanetExplanationGenerator generator,
                          NasaExplanationQuota quota, Clock clock, PlatformTransactionManager manager,
                          @Value("${planetory.nasa.enabled:true}") boolean nasaEnabled,
                          @Value("${planetory.nasa.ready-ttl:7d}") Duration readyTtl,
                          @Value("${planetory.nasa.empty-ttl:1d}") Duration emptyTtl,
                          @Value("${planetory.nasa.retry-delay:5m}") Duration nasaRetry,
                          @Value("${planetory.nasa.explanation.enabled:false}") boolean explanationEnabled,
                          @Value("${planetory.nasa.explanation.model:gpt-5.4-mini}") String model,
                          @Value("${planetory.nasa.explanation.timeout:8s}") Duration modelTimeout,
                          @Value("${planetory.nasa.explanation.retry-delay:1h}") Duration modelRetry,
                          @Value("${planetory.nasa.explanation.daily-per-member:0}") int dailyPerMember,
                          @Value("${planetory.nasa.explanation.daily-global:0}") int dailyGlobal) {
        if (readyTtl.isZero() || readyTtl.isNegative() || emptyTtl.isZero() || emptyTtl.isNegative()
                || nasaRetry.isZero() || nasaRetry.isNegative() || modelTimeout.isZero()
                || modelTimeout.isNegative() || modelTimeout.compareTo(Duration.ofSeconds(20)) > 0
                || modelRetry.compareTo(Duration.ofMinutes(1)) < 0 || modelRetry.compareTo(Duration.ofDays(1)) > 0
                || model.isBlank() || model.length() > 100 || dailyPerMember < 0 || dailyGlobal < 0
                || (explanationEnabled && (dailyPerMember == 0 || dailyGlobal == 0))) {
            throw new IllegalArgumentException("NASA star planet setting is out of range");
        }
        this.repository = repository;
        this.normalized = normalized;
        this.tap = tap;
        this.generator = generator;
        this.quota = quota;
        this.clock = clock;
        this.nasaEnabled = nasaEnabled;
        this.explanationEnabled = explanationEnabled;
        this.model = model;
        this.readyTtl = readyTtl;
        this.emptyTtl = emptyTtl;
        this.nasaRetry = nasaRetry;
        this.modelTimeout = modelTimeout;
        this.modelRetry = modelRetry;
        this.dailyPerMember = dailyPerMember;
        this.dailyGlobal = dailyGlobal;
        this.snapshot = new TransactionTemplate(manager);
        this.snapshot.setReadOnly(true);
        this.snapshot.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
    }

    public record Star(String ticId, String hostName) {}

    public record Item(String planetId, String name, String sourceStatus,
                       StarPlanetExplanationService.Facts facts, String sourceHash,
                       Short sourceVersion, OffsetDateTime fetchedAt, OffsetDateTime changedAt,
                       String explanationStatus, NasaPlanetExplanation.Content explanation,
                       OffsetDateTime generatedAt, OffsetDateTime retryAt, String failure,
                       String model, String promptVersion) {}

    public record Bundle(Star star, String status, boolean complete, OffsetDateTime fetchedAt,
                         String refreshStatus, OffsetDateTime retryAt, List<Item> planets) {}

    private record Override(String status, OffsetDateTime retryAt, String failure) {}

    private record Prepared(String status, String hostName, List<SourceEntry> entries) {}

    /** 폴링은 DB만 읽는다. 열리지 않은 별과 skipped 이력뿐인 별은 같은 404다. */
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public Bundle read(long memberId, long ticId) {
        return bundle(memberId, ticId, null, null);
    }

    /** 버튼 클릭당 TIC 한 건을 조회한다. 기본 캐시 기간에는 외부 요청을 반복하지 않는다. */
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public Bundle requestCatalog(long memberId, long ticId) {
        repository.requireAccess(memberId, ticId);
        Catalog existing = repository.catalog(ticId).orElse(null);
        if (!nasaEnabled) {
            return withRefresh(bundle(memberId, ticId, null, null), "disabled");
        }
        OffsetDateTime now = OffsetDateTime.now(clock);
        if (existing != null && existing.nextRefreshAt().isAfter(now)) {
            return bundle(memberId, ticId, null, null);
        }
        var generation = repository.claimCatalog(memberId, ticId, now, now.plus(tap.leaseDuration()));
        if (generation.isEmpty()) {
            return bundle(memberId, ticId, null, null);
        }
        try {
            Prepared prepared = prepare(ticId, tap.fetch(ticId));
            OffsetDateTime completed = OffsetDateTime.now(clock);
            repository.saveCatalog(memberId, ticId, generation.get(), prepared.status(),
                    prepared.hostName(), prepared.entries(), completed,
                    completed.plus("empty".equals(prepared.status()) || "partial".equals(prepared.status())
                            ? emptyTtl : readyTtl));
        } catch (NasaTapClient.FetchFailure failure) {
            log.warn("NASA PS star refresh failed: ticId={}, reason={}", ticId, failure.code());
            repository.failCatalog(memberId, ticId, generation.get(), failure.code(),
                    OffsetDateTime.now(clock).plus(nasaRetry));
        }
        return bundle(memberId, ticId, null, null);
    }

    /** 선택한 행성 하나만 생성한다. 다른 행성의 설명과 결과 화면은 기다리지 않는다. */
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public Bundle requestExplanation(long memberId, long ticId, String planetId) {
        repository.requireAccess(memberId, ticId);
        if (planetId == null || !planetId.matches("np-[0-9a-f]{64}")) {
            throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        }
        PlanetRow planet = repository.planet(ticId, planetId)
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        if (!"ready".equals(planet.status()) || planet.planet() == null
                || planet.hash() == null || planet.version() == null || planet.version() != 1) {
            return bundle(memberId, ticId, null, null);
        }
        try {
            NasaPlanetExplanationText.instructions(planet.planet(), planet.hash());
        } catch (IllegalArgumentException invalidSource) {
            return bundle(memberId, ticId, planetId, new Override("invalid_source", null, "invalid_source"));
        }
        String hash = planet.hash();
        short version = planet.version();
        ExplanationRow cached = repository.explanation(ticId, planetId, hash, version,
                model, PROMPT_VERSION).orElse(null);
        if (cached != null && "ready".equals(cached.status())) return bundle(memberId, ticId, null, null);
        if (!explanationEnabled) return bundle(memberId, ticId, null, null);
        OffsetDateTime now = OffsetDateTime.now(clock);
        Catalog catalog = repository.catalog(ticId).orElse(null);
        if (catalog == null || catalog.fetchedAt() == null || !catalog.nextRefreshAt().isAfter(now)
                || !("ok".equals(catalog.refreshStatus()) || "partial".equals(catalog.refreshStatus()))
                || (catalog.inFlightUntil() != null && catalog.inFlightUntil().isAfter(now))) {
            return bundle(memberId, ticId, planetId,
                    new Override("source_unavailable", null, "refresh_required"));
        }
        if (cached != null && (("pending".equals(cached.status()) && cached.inFlightUntil() != null
                && cached.inFlightUntil().isAfter(now)) || cached.attemptCount() >= 3
                || ("failed".equals(cached.status()) && cached.retryAt().isAfter(now)))) {
            return bundle(memberId, ticId, null, null);
        }
        if (!quota.tryAcquire()) {
            return bundle(memberId, ticId, planetId, new Override("busy", null, "busy"));
        }
        try {
            var claim = quota.claim(memberId, now, dailyPerMember, dailyGlobal,
                    () -> repository.claimExplanation(memberId, ticId, planetId, hash, version,
                            model, PROMPT_VERSION, now, now.plus(modelTimeout).plusSeconds(4)));
            if (claim.limited()) {
                OffsetDateTime reset = now.withOffsetSameInstant(ZoneOffset.UTC).toLocalDate()
                        .plusDays(1).atStartOfDay().atOffset(ZoneOffset.UTC);
                return bundle(memberId, ticId, planetId, new Override("quota_exceeded", reset, "daily_limit"));
            }
            if (claim.generation().isEmpty()) return bundle(memberId, ticId, null, null);
            long generation = claim.generation().get();
            NasaPlanetExplanation.Content content;
            try {
                content = NasaPlanetExplanationText.render(generator.generate(planet.planet(), hash),
                        planet.planet(), hash);
            } catch (RuntimeException failure) {
                String code = failure instanceof IllegalArgumentException ? "invalid_output" : failureCode(failure);
                repository.requireAccess(memberId, ticId);
                repository.failExplanation(memberId, ticId, planetId, generation, hash, version,
                        code, OffsetDateTime.now(clock).plus(modelRetry));
                log.warn("NASA star planet explanation failed: reason={}", code);
                return bundle(memberId, ticId, null, null);
            }
            repository.requireAccess(memberId, ticId);
            if (!repository.readyExplanation(memberId, ticId, planetId, generation, hash, version,
                    content, OffsetDateTime.now(clock))) {
                return bundle(memberId, ticId, planetId, new Override("source_changed", null, "source_changed"));
            }
            return bundle(memberId, ticId, null, null);
        } finally {
            quota.release();
        }
    }

    private Bundle bundle(long memberId, long ticId, String selected, Override override) {
        Bundle result = snapshot.execute(ignored -> {
            repository.requireAccess(memberId, ticId);
            Catalog catalog = repository.catalog(ticId).orElse(null);
            OffsetDateTime now = OffsetDateTime.now(clock);
            if (catalog == null) {
                return new Bundle(new Star(Long.toString(ticId), null), "not_requested", false,
                        null, null, null, List.of());
            }
            boolean current = catalog.fetchedAt() != null && catalog.nextRefreshAt().isAfter(now)
                    && ("ok".equals(catalog.refreshStatus()) || "partial".equals(catalog.refreshStatus()));
            boolean complete = current && "ok".equals(catalog.refreshStatus())
                    && ("ready".equals(catalog.status()) || "empty".equals(catalog.status()));
            String status = catalog.status();
            boolean refreshing = catalog.inFlightUntil() != null && catalog.inFlightUntil().isAfter(now);
            if (refreshing) status = "pending";
            else if (catalog.fetchedAt() != null && !current) status = "stale";
            boolean interrupted = catalog.inFlightUntil() != null && !catalog.inFlightUntil().isAfter(now);
            if (catalog.fetchedAt() == null && "pending".equals(status) && interrupted) {
                status = "temporarily_unavailable";
            }
            List<Item> items = new ArrayList<>();
            for (PlanetRow planet : repository.planets(ticId)) {
                items.add(item(ticId, planet, now, planet.planetId().equals(selected) ? override : null));
            }
            return new Bundle(new Star(Long.toString(ticId), catalog.hostName()), status, complete,
                    catalog.fetchedAt(), interrupted ? "interrupted" : catalog.refreshStatus(),
                    complete ? null : catalog.inFlightUntil() != null && catalog.inFlightUntil().isAfter(now)
                            ? catalog.inFlightUntil() : catalog.nextRefreshAt(), List.copyOf(items));
        });
        repository.requireAccess(memberId, ticId);
        return result;
    }

    private Item item(long ticId, PlanetRow planet, OffsetDateTime now, Override override) {
        var source = new NasaPlanetInfo.Lookup(planet.status(), planet.planet(),
                planet.fetchedAt(), planet.changedAt(), planet.hash(), null, planet.version());
        var facts = StarPlanetExplanationService.facts(source);
        String sourceStatus = facts == null && "ready".equals(planet.status())
                ? "invalid_source" : planet.status();
        if (!"ready".equals(sourceStatus)) {
            return new Item(planet.planetId(), planet.name(), sourceStatus, null, null, null,
                    planet.fetchedAt(), planet.changedAt(), "source_unavailable", null,
                    null, null, null, model, PROMPT_VERSION);
        }
        ExplanationRow explanation = repository.explanation(ticId, planet.planetId(),
                planet.hash(), planet.version(), model, PROMPT_VERSION).orElse(null);
        String status;
        OffsetDateTime retryAt = null;
        String failure = null;
        if (explanation == null || (!explanationEnabled && !"ready".equals(explanation.status()))) {
            status = explanationEnabled ? "not_requested" : "disabled";
        } else if ("ready".equals(explanation.status())) {
            status = "ready";
        } else if ("pending".equals(explanation.status()) && explanation.inFlightUntil() != null
                && explanation.inFlightUntil().isAfter(now)) {
            status = "pending";
        } else {
            status = "failed".equals(explanation.status()) || "pending".equals(explanation.status())
                    ? "failed" : explanation.status();
            retryAt = explanation.attemptCount() >= 3 ? null : explanation.retryAt();
            failure = "pending".equals(explanation.status()) ? "interrupted" : explanation.failure();
        }
        if (override != null && !"ready".equals(status) && !"pending".equals(status)) {
            status = override.status();
            retryAt = override.retryAt();
            failure = override.failure();
        }
        boolean ready = "ready".equals(status);
        return new Item(planet.planetId(), planet.name(), sourceStatus, facts,
                planet.hash(), planet.version(), planet.fetchedAt(), planet.changedAt(), status,
                ready ? explanation.content() : null, ready ? explanation.generatedAt() : null,
                retryAt, failure, model, PROMPT_VERSION);
    }

    private Prepared prepare(long ticId, List<Planet> fetched) throws NasaTapClient.FetchFailure {
        Map<String, List<Planet>> byName = new TreeMap<>();
        String host = null;
        for (Planet planet : fetched) {
            if (!safeName(planet.planetName())) throw new NasaTapClient.FetchFailure("invalid_response");
            if (planet.hostName() != null) {
                if (!safeName(planet.hostName()) || (host != null && !host.equals(planet.hostName()))) {
                    throw new NasaTapClient.FetchFailure("invalid_response");
                }
                host = planet.hostName();
            }
            byName.computeIfAbsent(planet.planetName(), ignored -> new ArrayList<>()).add(planet);
        }
        List<SourceEntry> entries = new ArrayList<>();
        for (var group : byName.entrySet()) {
            if (group.getValue().stream().noneMatch(p -> "Published Confirmed".equals(p.solutionType()))) {
                continue;
            }
            String id = "np-" + NasaPlanetInfoService.sha256(ticId + ":" + group.getKey());
            if (group.getValue().size() != 1) {
                entries.add(new SourceEntry(id, group.getKey(), "identity_unresolved", null, null));
                continue;
            }
            Planet planet = group.getValue().getFirst();
            String hash = NasaPlanetInfoService.sha256(normalized.encode(planet));
            try {
                NasaPlanetExplanationText.instructions(planet, hash);
                var source = new NasaPlanetInfo.Lookup("ready", planet, null, null, hash, null, (short) 1);
                if (StarPlanetExplanationService.facts(source) == null) {
                    throw new IllegalArgumentException("invalid NASA display facts");
                }
                entries.add(new SourceEntry(id, group.getKey(), "ready", planet, hash));
            } catch (IllegalArgumentException invalidPlanet) {
                entries.add(new SourceEntry(id, group.getKey(), "invalid_source", null, null));
            }
        }
        String status = entries.isEmpty() ? "empty"
                : entries.stream().allMatch(row -> "ready".equals(row.status())) ? "ready" : "partial";
        return new Prepared(status, host, List.copyOf(entries));
    }

    private static boolean safeName(String value) {
        return value != null && !value.isBlank() && value.length() <= 120
                && value.chars().noneMatch(c -> c == '<' || c == '>' || c == '&' || Character.isISOControl(c));
    }

    private static String failureCode(Throwable failure) {
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            if (cause instanceof TimeoutException || cause instanceof java.net.SocketTimeoutException
                    || cause instanceof java.net.http.HttpTimeoutException
                    || cause.getClass().getSimpleName().contains("Timeout")) return "timeout";
        }
        return "model_error";
    }

    private static Bundle withRefresh(Bundle bundle, String refreshStatus) {
        return new Bundle(bundle.star(), bundle.status(), bundle.complete(), bundle.fetchedAt(),
                refreshStatus, bundle.retryAt(), bundle.planets());
    }
}
