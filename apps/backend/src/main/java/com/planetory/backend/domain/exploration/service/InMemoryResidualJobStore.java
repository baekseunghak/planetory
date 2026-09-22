package com.planetory.backend.domain.exploration.service;

import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import com.planetory.backend.domain.exploration.service.AnalysisViews.CurveContext;

/**
 * 잔차 작업 저장소의 인스턴스 안 구현 [S15P21C206-147].
 *
 * <p><b>운영 저장소가 아니다.</b> 운영은 Redis이며({@code S15P21C206-89}) 이 구현은 그 어댑터가
 * 붙기 전까지 로컬 개발·테스트에서 계약을 지키게 한다. 인스턴스를 재시작하면 작업과 결과가
 * 사라지는데, 계약상 그것은 「Redis 유실」과 같은 상황이라 호출자가 이미 다룬다(7.2절 404).
 *
 * <p>모든 갱신을 한 자물쇠 안에서 한다. 상한 판정과 등록이 갈라지면 두 요청이 같은 빈자리를
 * 보고 둘 다 들어온다.
 */
@Component
@ConditionalOnProperty(name = "planetory.residual.store", havingValue = "memory", matchIfMissing = true)
@RequiredArgsConstructor
public class InMemoryResidualJobStore implements ResidualJobStore {

    private final ResidualJobProperties properties;
    private final Clock clock;

    private final Object lock = new Object();
    private final AtomicLong sequence = new AtomicLong();
    /** 등록 순서를 유지한다. 대기 순번이 그 순서다. */
    private final Map<String, Job> jobs = new LinkedHashMap<>();
    private final Map<String, Result> results = new LinkedHashMap<>();

    @Override
    public Optional<Job> find(String jobId) {
        synchronized (lock) {
            return Optional.ofNullable(jobs.get(jobId));
        }
    }

    @Override
    public Optional<Result> result(String cacheKey) {
        synchronized (lock) {
            return Optional.ofNullable(results.get(cacheKey));
        }
    }

    @Override
    public Optional<Job> active(String cacheKey) {
        synchronized (lock) {
            return jobs.values().stream().filter(job -> job.cacheKey().equals(cacheKey))
                    .filter(InMemoryResidualJobStore::running).findFirst();
        }
    }

    @Override
    public Optional<Integer> queuePosition(String jobId) {
        synchronized (lock) {
            Job job = jobs.get(jobId);
            if (job == null) {
                return Optional.empty();
            }
            return Optional.of(position(job));
        }
    }

    @Override
    public Enqueued enqueue(long memberId, long ticId, CurveContext target, String cacheKey) {
        synchronized (lock) {
            Result cached = results.get(cacheKey);
            if (cached != null) {
                // 호출자가 밖에서 본 뒤 여기 오는 사이에 끝났을 수 있다. 한 자물쇠 안에서 다시 본다.
                return new Enqueued.Cached(cached);
            }
            Optional<Job> same = active(cacheKey);
            if (same.isPresent()) {
                // 같은 계산을 기다리는 사람으로 적는다. 적지 않으면 상태를 조회할 수 없다(7.2절).
                Job shared = watch(same.get(), memberId);
                return new Enqueued.Merged(shared, position(shared));
            }
            // 회원당 상한이 먼저다. 같은 회원의 다른 작업을 알려 줘야 "기다리라"가 아니라
            // "이미 돌고 있다"고 안내할 수 있다(D-4).
            List<Job> mine = jobs.values().stream().filter(job -> job.watchedBy(memberId))
                    .filter(InMemoryResidualJobStore::running).toList();
            if (mine.size() >= properties.perMember()) {
                return new Enqueued.Full(properties.retryAfterSeconds(), mine.getFirst().jobId());
            }
            // 계산 중과 대기를 합쳐서 본다. 계산을 시작시키는 쪽이 늦으면 대기만 쌓이는데,
            // 그때도 자리는 찬 것이다.
            long holding = jobs.values().stream().filter(InMemoryResidualJobStore::running).count();
            if (holding >= (long) properties.maxRunning() + properties.maxQueued()) {
                return new Enqueued.Full(properties.retryAfterSeconds(), null);
            }

            String jobId = ExplorationIds.RESIDUAL_JOB + sequence.incrementAndGet();
            Job job = new Job(jobId, ticId, target, cacheKey, QUEUED, 1,
                    new Timeline(now(), null, null, null, null), null, Set.of(memberId));
            jobs.put(jobId, job);
            return new Enqueued.Created(job, position(job));
        }
    }

    @Override
    public void advance(String jobId, int attempt, String status) {
        synchronized (lock) {
            Job job = current(jobId, attempt);
            if (job == null) {
                return;
            }
            Timeline timeline = switch (status) {
                case RESIDUAL_CALCULATING -> withResidualStarted(job.timeline());
                case RESIDUAL_READY -> withResidualReady(job.timeline());
                case PERIODOGRAM_CALCULATING -> withPeriodogramStarted(job.timeline());
                default -> throw new IllegalArgumentException("이 상태로는 옮길 수 없습니다: " + status);
            };
            jobs.put(jobId, new Job(job.jobId(), job.ticId(), job.target(), job.cacheKey(),
                    status, job.attempt(), timeline, null, job.watchers()));
        }
    }

    @Override
    public void complete(String jobId, int attempt, Result result) {
        synchronized (lock) {
            Job job = current(jobId, attempt);
            if (job == null) {
                return;
            }
            Timeline timeline = job.timeline();
            jobs.put(jobId, new Job(job.jobId(), job.ticId(), job.target(), job.cacheKey(),
                    COMPLETED, job.attempt(),
                    new Timeline(timeline.queuedAt(), timeline.residualStartedAt(), timeline.residualReadyAt(),
                            timeline.periodogramStartedAt(), now()),
                    null, job.watchers()));
            results.put(job.cacheKey(), result);
        }
    }

    @Override
    public void fail(String jobId, int attempt, Failure failure) {
        synchronized (lock) {
            Job job = current(jobId, attempt);
            if (job == null) {
                return;
            }
            jobs.put(jobId, new Job(job.jobId(), job.ticId(), job.target(), job.cacheKey(),
                    FAILED, job.attempt(), job.timeline(), failure, job.watchers()));
        }
    }

    @Override
    public int evictOtherBundles(long ticId, long currentBundleId) {
        // 접두에 구분자를 붙여 비교한다. 붙이지 않으면 tic:400이 tic:4001을, b-1이 b-12를 함께 지운다.
        String star = "tic:" + ticId + ":";
        String keep = star + ExplorationIds.bundle(currentBundleId) + ":";
        synchronized (lock) {
            int before = jobs.size() + results.size();
            jobs.values().removeIf(job -> job.ticId() == ticId
                    && !job.cacheKey().startsWith(keep));
            results.keySet().removeIf(key -> key.startsWith(star) && !key.startsWith(keep));
            return before - (jobs.size() + results.size());
        }
    }

    /**
     * 작업과 결과를 모두 버린다. <b>테스트에서만 쓴다.</b> 운영 저장소는 Redis의 TTL이 이 일을 한다.
     * 이 구현에는 만료가 없어 한 인스턴스가 살아 있는 동안 기록이 남는다.
     */
    void clear() {
        synchronized (lock) {
            jobs.clear();
            results.clear();
        }
    }

    /** 늦게 도착한 옛 시도의 보고는 버린다. 끝난 작업도 되살리지 않는다(7.3절). */
    private Job current(String jobId, int attempt) {
        Job job = jobs.get(jobId);
        if (job == null || job.attempt() != attempt || !running(job)) {
            return null;
        }
        return job;
    }

    /** 같은 목표를 요청한 회원을 기다리는 사람으로 더한다. */
    private Job watch(Job job, long memberId) {
        if (job.watchedBy(memberId)) {
            return job;
        }
        Set<Long> watchers = new LinkedHashSet<>(job.watchers());
        watchers.add(memberId);
        Job shared = new Job(job.jobId(), job.ticId(), job.target(), job.cacheKey(), job.status(), job.attempt(),
                job.timeline(), job.failure(), Set.copyOf(watchers));
        jobs.put(job.jobId(), shared);
        return shared;
    }

    /** 아직 끝나지 않은 작업. */
    private static boolean running(Job job) {
        return !COMPLETED.equals(job.status()) && !FAILED.equals(job.status());
    }

    /** 0이면 계산 중이고, N이면 앞에 기다리는 작업이 N개다. */
    private int position(Job job) {
        if (!QUEUED.equals(job.status())) {
            return 0;
        }
        List<String> waiting = new ArrayList<>(jobs.values().stream()
                .filter(other -> QUEUED.equals(other.status())).map(Job::jobId).toList());
        return Math.max(waiting.indexOf(job.jobId()), 0);
    }

    private OffsetDateTime now() {
        return OffsetDateTime.now(clock);
    }

    private Timeline withResidualStarted(Timeline from) {
        return new Timeline(from.queuedAt(), now(), from.residualReadyAt(),
                from.periodogramStartedAt(), from.completedAt());
    }

    private Timeline withResidualReady(Timeline from) {
        return new Timeline(from.queuedAt(), from.residualStartedAt(), now(),
                from.periodogramStartedAt(), from.completedAt());
    }

    private Timeline withPeriodogramStarted(Timeline from) {
        return new Timeline(from.queuedAt(), from.residualStartedAt(), from.residualReadyAt(),
                now(), from.completedAt());
    }
}
