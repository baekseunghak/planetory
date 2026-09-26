package com.planetory.backend.domain.exploration.service;

import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Optional;
import java.util.concurrent.Semaphore;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** 모든 NASA 설명 경로의 모델 동시 수와 UTC 일별 시도권을 공유한다. */
@Component
class NasaExplanationQuota {

    private final JdbcClient jdbc;
    private final TransactionTemplate transactions;
    private final Semaphore permits;

    NasaExplanationQuota(JdbcClient jdbc, PlatformTransactionManager transactionManager,
                         @Value("${planetory.nasa.explanation.max-concurrent:1}") int maxConcurrent) {
        if (maxConcurrent < 1 || maxConcurrent > 4) {
            throw new IllegalArgumentException("NASA explanation concurrency setting is out of range");
        }
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
        this.permits = new Semaphore(maxConcurrent);
    }

    boolean tryAcquire() {
        return permits.tryAcquire();
    }

    void release() {
        permits.release();
    }

    /** 새 모델 작업의 임대와 두 사용량을 같은 짧은 트랜잭션에서 확정한다. */
    Claim claim(long memberId, OffsetDateTime now, int perMemberLimit, int globalLimit,
                Supplier<Optional<Long>> leaseClaim) {
        LocalDate day = now.withOffsetSameInstant(ZoneOffset.UTC).toLocalDate();
        return transactions.execute(ignored -> {
            // ponytail: 전역 일일 잠금. 실제 모델 처리량이 커지면 날짜별 잠금으로 분리한다.
            jdbc.sql("SELECT pg_advisory_xact_lock(267268)").query((rs, n) -> true).single();
            int memberUsed = jdbc.sql("""
                            SELECT COALESCE((SELECT attempt_count FROM nasa_explanation_daily_usage
                                             WHERE usage_day=:day AND member_id=:memberId), 0)
                            """)
                    .param("day", day).param("memberId", memberId).query(Integer.class).single();
            int globalUsed = jdbc.sql("""
                            SELECT COALESCE((SELECT attempt_count FROM nasa_explanation_daily_total
                                             WHERE usage_day=:day), 0)
                            """)
                    .param("day", day).query(Integer.class).single();
            if (memberUsed >= perMemberLimit || globalUsed >= globalLimit) {
                return new Claim(Optional.empty(), true);
            }
            Optional<Long> generation = leaseClaim.get();
            generation.ifPresent(value -> jdbc.sql("""
                            INSERT INTO nasa_explanation_daily_usage(usage_day,member_id,attempt_count)
                            VALUES (:day,:memberId,1)
                            ON CONFLICT (usage_day,member_id) DO UPDATE SET
                                attempt_count=nasa_explanation_daily_usage.attempt_count+1
                            """)
                    .param("day", day).param("memberId", memberId).update());
            generation.ifPresent(value -> jdbc.sql("""
                            INSERT INTO nasa_explanation_daily_total(usage_day,attempt_count)
                            VALUES (:day,1)
                            ON CONFLICT (usage_day) DO UPDATE SET
                                attempt_count=nasa_explanation_daily_total.attempt_count+1
                            """)
                    .param("day", day).update());
            return new Claim(generation, false);
        });
    }

    record Claim(Optional<Long> generation, boolean limited) {
    }
}
