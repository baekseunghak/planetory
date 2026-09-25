package com.planetory.backend.domain.exploration.service;

import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeoutException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import static com.planetory.backend.domain.exploration.service.NasaPlanetExplanation.Content;
import static com.planetory.backend.domain.exploration.service.NasaPlanetExplanation.Lookup;

/** 266의 정상 자료만 설명한다. 267 별 단위 API가 이 후보별 계약을 호출한다. */
@Service
public class NasaPlanetExplanationService {

    private static final Logger log = LoggerFactory.getLogger(NasaPlanetExplanationService.class);
    private static final String PROMPT_VERSION = "nasa-ko-v4";

    private final NasaPlanetInfoService sourceService;
    private final NasaPlanetExplanationRepository repository;
    private final NasaPlanetExplanationGenerator generator;
    private final Clock clock;
    private final boolean enabled;
    private final String model;
    private final Duration timeout;
    private final Duration retryDelay;
    private final Semaphore permits;

    NasaPlanetExplanationService(NasaPlanetInfoService sourceService,
                                 NasaPlanetExplanationRepository repository,
                                 NasaPlanetExplanationGenerator generator, Clock clock,
                                 @Value("${planetory.nasa.explanation.enabled:false}") boolean enabled,
                                 @Value("${planetory.nasa.explanation.model:gpt-5.4-mini}") String model,
                                 @Value("${planetory.nasa.explanation.timeout:8s}") Duration timeout,
                                 @Value("${planetory.nasa.explanation.retry-delay:1h}") Duration retryDelay,
                                 @Value("${planetory.nasa.explanation.max-concurrent:1}") int maxConcurrent,
                                 @Value("${spring.ai.openai.chat.max-completion-tokens:320}") int maxOutputTokens) {
        if (model.isBlank() || model.length() > 100
                || timeout.isZero() || timeout.isNegative() || timeout.compareTo(Duration.ofSeconds(20)) > 0
                || retryDelay.compareTo(Duration.ofMinutes(1)) < 0 || retryDelay.compareTo(Duration.ofDays(1)) > 0
                || maxConcurrent < 1 || maxConcurrent > 4
                || maxOutputTokens < 64 || maxOutputTokens > 512) {
            throw new IllegalArgumentException("NASA explanation setting is out of range");
        }
        this.sourceService = sourceService;
        this.repository = repository;
        this.generator = generator;
        this.clock = clock;
        this.enabled = enabled;
        this.model = model;
        this.timeout = timeout;
        this.retryDelay = retryDelay;
        this.permits = new Semaphore(maxConcurrent);
    }

    /** 회원 자격 검사와 NASA 재확인을 266에 맡긴다. 모델 HTTPS 동안 트랜잭션을 열지 않는다. */
    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public Lookup lookup(long memberId, long candidateId) {
        NasaPlanetInfo.Lookup source = sourceService.lookup(memberId, candidateId);
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
        var cached = repository.find(candidateId, hash, version, model, PROMPT_VERSION);
        if (cached.isPresent() && "ready".equals(cached.get().status())) {
            return result(source, cached.get());
        }
        if (!enabled) {
            return new Lookup("disabled", source, null, null, model, PROMPT_VERSION, null, "disabled");
        }
        try {
            NasaPlanetExplanationText.instructions(source.planet(), hash);
        } catch (IllegalArgumentException invalidSource) {
            return new Lookup("invalid_source", source, null, null, model, PROMPT_VERSION,
                    null, "invalid_source");
        }
        if (!permits.tryAcquire()) {
            return new Lookup("busy", source, null, null, model, PROMPT_VERSION, null, "busy");
        }
        try {
            OffsetDateTime now = OffsetDateTime.now(clock);
            var generation = repository.claim(candidateId, hash, version, model, PROMPT_VERSION,
                    now, now.plus(timeout).plusSeconds(4));
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
                log.warn("NASA explanation failed: candidateId={}, reason={}", candidateId, failure);
                return repository.find(candidateId, hash, version, model, PROMPT_VERSION)
                        .map(row -> result(source, row))
                        .orElseGet(() -> new Lookup("source_changed", source, null, null,
                                model, PROMPT_VERSION, null, "source_changed"));
            }
            if (!repository.ready(candidateId, generation.get(), hash, version, content,
                    OffsetDateTime.now(clock))) {
                return new Lookup("source_changed", source, null, null, model, PROMPT_VERSION,
                        null, "source_changed");
            }
            return repository.find(candidateId, hash, version, model, PROMPT_VERSION)
                    .map(row -> result(source, row))
                    .orElseGet(() -> new Lookup("source_changed", source, null, null,
                            model, PROMPT_VERSION, null, "source_changed"));
        } finally {
            permits.release();
        }
    }

    private Lookup result(NasaPlanetInfo.Lookup source, NasaPlanetExplanationRepository.Row row) {
        boolean exhausted = row.attemptCount() == 3
                && ("failed".equals(row.status()) || ("pending".equals(row.status())
                && row.inFlightUntil() != null && !row.inFlightUntil().isAfter(OffsetDateTime.now(clock))));
        return new Lookup(exhausted ? "failed" : row.status(), source, row.content(), row.generatedAt(),
                model, PROMPT_VERSION, "ready".equals(row.status()) || exhausted ? null : row.retryAt(),
                exhausted && row.failure() == null ? "attempts_exhausted" : row.failure());
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
