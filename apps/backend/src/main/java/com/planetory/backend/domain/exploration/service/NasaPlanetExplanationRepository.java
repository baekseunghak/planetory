package com.planetory.backend.domain.exploration.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.stereotype.Repository;

import static com.planetory.backend.domain.exploration.service.NasaPlanetExplanation.Content;

/** 한 문장씩 독립 커밋한다. 모델 호출 중 DB 트랜잭션을 유지하지 않는다. */
@Repository
class NasaPlanetExplanationRepository {

    private final JdbcClient jdbc;
    private final TransactionTemplate transactions;
    private final ObjectMapper json = new ObjectMapper();

    NasaPlanetExplanationRepository(JdbcClient jdbc, PlatformTransactionManager transactionManager) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(transactionManager);
    }

    Optional<Row> find(long candidateId, String hash, short sourceVersion,
                       String model, String promptVersion) {
        return jdbc.sql("""
                        SELECT e.status, e.content::text AS content, e.generated_at,
                               e.next_retry_at, e.in_flight_until, e.attempt_count, e.last_failure
                          FROM nasa_planet_explanation e
                          JOIN nasa_planet_info n ON n.candidate_id=e.candidate_id
                         WHERE e.candidate_id=:candidateId AND n.status='ready'
                           AND n.source_hash=:hash AND n.source_version=:sourceVersion
                           AND e.source_hash=:hash AND e.source_version=:sourceVersion
                           AND e.model_name=:model AND e.prompt_version=:promptVersion
                        """)
                .param("candidateId", candidateId).param("hash", hash)
                .param("sourceVersion", sourceVersion).param("model", model)
                .param("promptVersion", promptVersion)
                .query((rs, n) -> new Row(rs.getString("status"), decode(rs.getString("content")),
                        rs.getObject("generated_at", OffsetDateTime.class),
                        rs.getObject("next_retry_at", OffsetDateTime.class),
                        rs.getObject("in_flight_until", OffsetDateTime.class),
                        rs.getInt("attempt_count"),
                        rs.getString("last_failure")))
                .optional();
    }

    /** 시도권과 UTC 일별 사용량을 한 짧은 트랜잭션에서 확정한다. */
    Claim claimWithinQuota(long memberId, long candidateId, String hash, short sourceVersion,
                           String model, String promptVersion, OffsetDateTime now,
                           OffsetDateTime leaseUntil, int perMemberLimit, int globalLimit) {
        LocalDate day = now.withOffsetSameInstant(java.time.ZoneOffset.UTC).toLocalDate();
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
            Optional<Long> generation = claim(candidateId, hash, sourceVersion, model,
                    promptVersion, now, leaseUntil);
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

    private Optional<Long> claim(long candidateId, String hash, short sourceVersion,
                         String model, String promptVersion, OffsetDateTime now,
                         OffsetDateTime leaseUntil) {
        return jdbc.sql("""
                        INSERT INTO nasa_planet_explanation(candidate_id,source_hash,source_version,
                            model_name,prompt_version,status,last_attempt_at,next_retry_at,in_flight_until)
                        SELECT n.candidate_id,:hash,:sourceVersion,:model,:promptVersion,
                               'pending',:now,:now,:leaseUntil
                         FROM nasa_planet_info n
                         WHERE n.candidate_id=:candidateId AND n.status='ready'
                           AND n.source_hash=:hash AND n.source_version=:sourceVersion
                         FOR UPDATE OF n
                        ON CONFLICT (candidate_id) DO UPDATE SET
                            source_hash=EXCLUDED.source_hash, source_version=EXCLUDED.source_version,
                            model_name=EXCLUDED.model_name, prompt_version=EXCLUDED.prompt_version,
                            status='pending', content=NULL, generated_at=NULL,
                            last_attempt_at=:now, next_retry_at=:now, in_flight_until=:leaseUntil,
                            attempt_generation=nasa_planet_explanation.attempt_generation+1,
                            attempt_count=CASE WHEN nasa_planet_explanation.source_hash IS DISTINCT FROM EXCLUDED.source_hash
                                    OR nasa_planet_explanation.source_version IS DISTINCT FROM EXCLUDED.source_version
                                    OR nasa_planet_explanation.model_name IS DISTINCT FROM EXCLUDED.model_name
                                    OR nasa_planet_explanation.prompt_version IS DISTINCT FROM EXCLUDED.prompt_version
                                THEN 1 ELSE nasa_planet_explanation.attempt_count+1 END,
                            last_failure=NULL
                        WHERE nasa_planet_explanation.source_hash IS DISTINCT FROM EXCLUDED.source_hash
                           OR nasa_planet_explanation.source_version IS DISTINCT FROM EXCLUDED.source_version
                           OR nasa_planet_explanation.model_name IS DISTINCT FROM EXCLUDED.model_name
                           OR nasa_planet_explanation.prompt_version IS DISTINCT FROM EXCLUDED.prompt_version
                           OR (nasa_planet_explanation.status<>'ready'
                               AND nasa_planet_explanation.attempt_count<3
                               AND nasa_planet_explanation.next_retry_at<=:now
                               AND (nasa_planet_explanation.in_flight_until IS NULL
                                    OR nasa_planet_explanation.in_flight_until<=:now))
                        RETURNING attempt_generation
                        """)
                .param("candidateId", candidateId).param("hash", hash)
                .param("sourceVersion", sourceVersion).param("model", model)
                .param("promptVersion", promptVersion).param("now", now)
                .param("leaseUntil", leaseUntil)
                .query(Long.class).optional();
    }

    boolean ready(long memberId, long candidateId, long generation, String hash,
                  short sourceVersion, String name, Content content, OffsetDateTime now) {
        return jdbc.sql("""
                        UPDATE nasa_planet_explanation e
                           SET status='ready', content=CAST(:content AS jsonb), generated_at=:now,
                               in_flight_until=NULL, last_failure=NULL
                          FROM nasa_planet_info n
                         WHERE e.candidate_id=:candidateId AND e.attempt_generation=:generation
                           AND e.source_hash=:hash AND e.source_version=:sourceVersion
                           AND n.candidate_id=e.candidate_id AND n.status='ready'
                           AND n.source_hash=:hash AND n.source_version=:sourceVersion
                           AND n.archive_planet_name=:name
                        """ + NasaPlanetInfoRepository.CURRENT_TARGET_SQL)
                .param("memberId", memberId).param("candidateId", candidateId)
                .param("generation", generation).param("name", name)
                .param("hash", hash).param("sourceVersion", sourceVersion)
                .param("content", encode(content)).param("now", now).update() == 1;
    }

    void failed(long candidateId, long generation, String hash, short sourceVersion,
                String failure, OffsetDateTime retryAt) {
        jdbc.sql("""
                        UPDATE nasa_planet_explanation SET status='failed', in_flight_until=NULL,
                               next_retry_at=:retryAt, last_failure=:failure
                         WHERE candidate_id=:candidateId AND attempt_generation=:generation
                           AND source_hash=:hash AND source_version=:sourceVersion
                        """)
                .param("candidateId", candidateId).param("generation", generation)
                .param("hash", hash).param("sourceVersion", sourceVersion)
                .param("failure", failure).param("retryAt", retryAt).update();
    }

    private String encode(Content content) {
        try {
            return json.writeValueAsString(content);
        } catch (JsonProcessingException impossible) {
            throw new IllegalStateException("NASA explanation cannot be serialized", impossible);
        }
    }

    private Content decode(String value) {
        if (value == null) {
            return null;
        }
        try {
            return json.readValue(value, Content.class);
        } catch (JsonProcessingException corrupt) {
            throw new IllegalStateException("stored NASA explanation is invalid", corrupt);
        }
    }

    record Row(String status, Content content, OffsetDateTime generatedAt,
               OffsetDateTime retryAt, OffsetDateTime inFlightUntil, int attemptCount,
               String failure) {
    }

    record Claim(Optional<Long> generation, boolean limited) {
    }
}
