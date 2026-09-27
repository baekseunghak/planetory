package com.planetory.backend.domain.exploration.service;

import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.concurrent.TimeoutException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import static com.planetory.backend.domain.exploration.service.NasaPlanetExplanation.Content;
import static com.planetory.backend.domain.exploration.service.NasaPlanetExplanation.Lookup;

/** 266의 정상 자료만 설명한다. 268의 GET 조회와 POST 생성을 후보별로 분리한다. */
@Service
public class NasaPlanetExplanationService {

    private static final Logger log = LoggerFactory.getLogger(NasaPlanetExplanationService.class);
    private static final String PROMPT_VERSION = "nasa-ko-v5";

    private final NasaPlanetInfoService sourceService;
    private final NasaPlanetExplanationRepository repository;
    private final NasaExplanationQuota quota;
    private final NasaPlanetExplanationGenerator generator;
    private final Clock clock;
    private final boolean enabled;
    private final String model;
    private final Duration timeout;
    private final Duration retryDelay;
    private final int dailyPerMember;
    private final int dailyGlobal;

    NasaPlanetExplanationService(NasaPlanetInfoService sourceService,
                                 NasaPlanetExplanationRepository repository,
                                 NasaExplanationQuota quota,
                                 NasaPlanetExplanationGenerator generator, Clock clock,
                                 @Value("${planetory.nasa.explanation.enabled:false}") boolean enabled,
                                 @Value("${planetory.nasa.explanation.model:gpt-5.4-mini}") String model,
                                 @Value("${planetory.nasa.explanation.timeout:8s}") Duration timeout,
                                 @Value("${planetory.nasa.explanation.retry-delay:1h}") Duration retryDelay,
                                 @Value("${planetory.nasa.explanation.daily-per-member:0}") int dailyPerMember,
                                 @Value("${planetory.nasa.explanation.daily-global:0}") int dailyGlobal,
                                 @Value("${spring.ai.openai.chat.max-completion-tokens:320}") int maxOutputTokens) {
        if (model.isBlank() || model.length() > 100
                || timeout.isZero() || timeout.isNegative() || timeout.compareTo(Duration.ofSeconds(20)) > 0
                || retryDelay.compareTo(Duration.ofMinutes(1)) < 0 || retryDelay.compareTo(Duration.ofDays(1)) > 0
                || dailyPerMember < 0 || dailyPerMember > 1000
                || dailyGlobal < 0 || dailyGlobal > 100000
                || (enabled && (dailyPerMember == 0 || dailyGlobal == 0))
                || maxOutputTokens < 64 || maxOutputTokens > 512) {
            throw new IllegalArgumentException("NASA explanation setting is out of range");
        }
        this.sourceService = sourceService;
        this.repository = repository;
        this.quota = quota;
        this.generator = generator;
        this.clock = clock;
        this.enabled = enabled;
        this.model = model;
        this.timeout = timeout;
        this.retryDelay = retryDelay;
        this.dailyPerMember = dailyPerMember;
        this.dailyGlobal = dailyGlobal;
    }

    /** 회원 자격 검사와 NASA 재확인을 266에 맡긴다. 모델 HTTPS 동안 트랜잭션을 열지 않는다. */
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public Lookup lookup(long memberId, long candidateId) {
        return lookup(memberId, candidateId, true);
    }

    /** 현재 권한과 저장 상태만 조회한다. NASA와 모델은 호출하지 않는다. */
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public Lookup read(long memberId, long candidateId) {
        return lookup(memberId, candidateId, false);
    }

    private Lookup lookup(long memberId, long candidateId, boolean generate) {
        NasaPlanetInfo.Lookup source = generate ? sourceService.lookup(memberId, candidateId)
                : sourceService.read(memberId, candidateId);
        if ("not_requested".equals(source.status())) {
            return new Lookup("not_requested", source, null, null,
                    model, PROMPT_VERSION, null, null);
        }
        if (!"ready".equals(source.status()) || source.planet() == null
                || source.sourceHash() == null || source.sourceVersion() == null) {
            return new Lookup("source_unavailable", source, null, null, model, PROMPT_VERSION,
                    null, source.refreshStatus());
        }
        String hash = source.sourceHash();
        short version = source.sourceVersion();
        if (version != 1 || !hash.matches("[0-9a-f]{64}")) {
            return new Lookup("invalid_source", source, null, null, model, PROMPT_VERSION,
                    null, "invalid_source");
        }
        try {
            NasaPlanetExplanationText.instructions(source.planet(), hash);
        } catch (IllegalArgumentException invalidSource) {
            return new Lookup("invalid_source", source, null, null, model, PROMPT_VERSION,
                    null, "invalid_source");
        }
        var cached = repository.find(candidateId, hash, version, model, PROMPT_VERSION);
        if (cached.isPresent() && "ready".equals(cached.get().status())) {
            return result(source, cached.get());
        }
        if (!enabled) {
            return new Lookup("disabled", source, null, null, model, PROMPT_VERSION, null, "disabled");
        }
        if (!generate) {
            return cached.map(row -> result(source, row))
                    .orElseGet(() -> new Lookup("not_requested", source, null, null,
                            model, PROMPT_VERSION, null, null));
        }
        OffsetDateTime now = OffsetDateTime.now(clock);
        if (cached.isPresent()) {
            var row = cached.get();
            if (("pending".equals(row.status()) && row.inFlightUntil() != null
                    && row.inFlightUntil().isAfter(now))
                    || row.attemptCount() >= 3
                    || ("failed".equals(row.status()) && row.retryAt().isAfter(now))) {
                return result(source, row);
            }
        }
        if (!quota.tryAcquire()) {
            return new Lookup("busy", source, null, null, model, PROMPT_VERSION, null, "busy");
        }
        try {
            var claim = repository.claimWithinQuota(memberId, candidateId, hash, version,
                    model, PROMPT_VERSION, now, now.plus(timeout).plusSeconds(4),
                    dailyPerMember, dailyGlobal);
            if (claim.limited()) {
                var current = repository.find(candidateId, hash, version, model, PROMPT_VERSION);
                if (current.isPresent() && ("ready".equals(current.get().status())
                        || "pending".equals(current.get().status()))) {
                    return result(source, current.get());
                }
                return new Lookup("quota_exceeded", source, null, null, model, PROMPT_VERSION,
                        now.withOffsetSameInstant(ZoneOffset.UTC).toLocalDate().plusDays(1)
                                .atStartOfDay().atOffset(ZoneOffset.UTC), "daily_limit");
            }
            var generation = claim.generation();
            if (generation.isEmpty()) {
                return repository.find(candidateId, hash, version, model, PROMPT_VERSION)
                        .map(row -> result(source, row))
                        .orElseGet(() -> new Lookup("source_changed", source, null, null,
                                model, PROMPT_VERSION, null, "source_changed"));
            }
            Content content;
            try {
                content = NasaPlanetExplanationText.render(generator.generate(source.planet(), hash),
                        source.planet(), hash);
            } catch (RuntimeException modelOrValidationFailure) {
                String failure = modelOrValidationFailure instanceof IllegalArgumentException
                        ? "invalid_output" : failureCode(modelOrValidationFailure);
                repository.failed(candidateId, generation.get(), hash, version, failure,
                        OffsetDateTime.now(clock).plus(retryDelay));
                // 검증 실패 메시지는 항목 이름뿐이다. 모델·HTTP 오류 메시지는 상위 응답 본문을 담을 수 있어 종류만 남긴다.
                log.warn("NASA explanation failed: reason={}, detail={}", failure,
                        modelOrValidationFailure instanceof IllegalArgumentException
                                ? modelOrValidationFailure.getMessage() : modelOrValidationFailure.getClass().getSimpleName());
                sourceService.requireEligible(memberId, candidateId);
                return repository.find(candidateId, hash, version, model, PROMPT_VERSION)
                        .map(row -> result(source, row))
                        .orElseGet(() -> new Lookup("source_changed", source, null, null,
                                model, PROMPT_VERSION, null, "source_changed"));
            }
            sourceService.requireCurrentTarget(memberId, candidateId, source.planet().planetName());
            if (!repository.ready(memberId, candidateId, generation.get(), hash, version,
                    source.planet().planetName(), content, OffsetDateTime.now(clock))) {
                return new Lookup("source_changed", source, null, null, model, PROMPT_VERSION,
                        null, "source_changed");
            }
            sourceService.requireCurrentTarget(memberId, candidateId, source.planet().planetName());
            return repository.find(candidateId, hash, version, model, PROMPT_VERSION)
                    .map(row -> result(source, row))
                    .orElseGet(() -> new Lookup("source_changed", source, null, null,
                            model, PROMPT_VERSION, null, "source_changed"));
        } finally {
            quota.release();
        }
    }

    private Lookup result(NasaPlanetInfo.Lookup source, NasaPlanetExplanationRepository.Row row) {
        boolean interrupted = "pending".equals(row.status()) && row.inFlightUntil() != null
                && !row.inFlightUntil().isAfter(OffsetDateTime.now(clock));
        boolean exhausted = row.attemptCount() == 3 && ("failed".equals(row.status()) || interrupted);
        return new Lookup(interrupted ? "failed" : row.status(), source, row.content(), row.generatedAt(),
                model, PROMPT_VERSION, "ready".equals(row.status()) || exhausted ? null : row.retryAt(),
                exhausted && row.failure() == null ? "attempts_exhausted"
                        : interrupted ? "interrupted" : row.failure());
    }

    private static String failureCode(Throwable failure) {
        for (Throwable cause = failure; cause != null; cause = cause.getCause()) {
            if (cause instanceof TimeoutException || cause instanceof java.net.SocketTimeoutException
                    || cause instanceof java.net.http.HttpTimeoutException
                    || cause.getClass().getSimpleName().contains("Timeout")) {
                return "timeout";
            }
        }
        return "model_error";
    }
}
