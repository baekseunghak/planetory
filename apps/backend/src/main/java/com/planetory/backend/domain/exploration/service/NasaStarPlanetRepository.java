package com.planetory.backend.domain.exploration.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import static com.planetory.backend.domain.exploration.service.NasaPlanetExplanation.Content;
import static com.planetory.backend.domain.exploration.service.NasaPlanetInfo.Planet;

/** TIC별 외부 참고 자료만 저장한다. 후보·Gold·성과 테이블은 갱신하지 않는다. */
@Repository
class NasaStarPlanetRepository {

    private static final String ACCESS = " " + """
            EXISTS (SELECT 1 FROM users m JOIN submissions s ON s.user_id=m.id
                     WHERE m.id=:memberId AND m.status='active' AND s.tic_id=:ticId
                       AND s.submission_kind IN ('candidate','no_candidate'))
            """ + " ";

    private final JdbcClient jdbc;
    private final TransactionTemplate transactions;
    private final ObjectMapper json = new ObjectMapper();

    NasaStarPlanetRepository(JdbcClient jdbc, PlatformTransactionManager manager) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(manager);
    }

    void requireAccess(long memberId, long ticId) {
        if (!jdbc.sql("SELECT " + ACCESS).param("memberId", memberId).param("ticId", ticId)
                .query(Boolean.class).single()) {
            throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        }
    }

    Optional<Catalog> catalog(long ticId) {
        return jdbc.sql("""
                        SELECT status,host_name,fetched_at,next_refresh_at,in_flight_until,last_refresh_status
                          FROM nasa_star_catalog WHERE tic_id=:ticId
                        """)
                .param("ticId", ticId)
                .query((rs, n) -> new Catalog(rs.getString("status"), rs.getString("host_name"),
                        rs.getObject("fetched_at", OffsetDateTime.class),
                        rs.getObject("next_refresh_at", OffsetDateTime.class),
                        rs.getObject("in_flight_until", OffsetDateTime.class),
                        rs.getString("last_refresh_status"))).optional();
    }

    List<PlanetRow> planets(long ticId) {
        return jdbc.sql("""
                        SELECT planet_id,planet_name,status,normalized::text AS normalized,
                               source_hash,source_version,fetched_at,changed_at
                          FROM nasa_star_planet WHERE tic_id=:ticId AND active
                         ORDER BY planet_name,planet_id
                        """)
                .param("ticId", ticId)
                .query((rs, n) -> new PlanetRow(rs.getString("planet_id"),
                        rs.getString("planet_name"), rs.getString("status"),
                        decode(rs.getString("normalized"), Planet.class), rs.getString("source_hash"),
                        rs.getObject("source_version", Short.class),
                        rs.getObject("fetched_at", OffsetDateTime.class),
                        rs.getObject("changed_at", OffsetDateTime.class))).list();
    }

    Optional<PlanetRow> planet(long ticId, String planetId) {
        return jdbc.sql("""
                        SELECT planet_id,planet_name,status,normalized::text AS normalized,
                               source_hash,source_version,fetched_at,changed_at
                          FROM nasa_star_planet
                         WHERE tic_id=:ticId AND planet_id=:planetId AND active
                        """)
                .param("ticId", ticId).param("planetId", planetId)
                .query((rs, n) -> new PlanetRow(rs.getString("planet_id"),
                        rs.getString("planet_name"), rs.getString("status"),
                        decode(rs.getString("normalized"), Planet.class), rs.getString("source_hash"),
                        rs.getObject("source_version", Short.class),
                        rs.getObject("fetched_at", OffsetDateTime.class),
                        rs.getObject("changed_at", OffsetDateTime.class))).optional();
    }

    Optional<Long> claimCatalog(long memberId, long ticId, OffsetDateTime now,
                                OffsetDateTime leaseUntil) {
        return jdbc.sql("""
                        INSERT INTO nasa_star_catalog(tic_id,status,next_refresh_at,in_flight_until,
                                                      last_refresh_status)
                        SELECT :ticId,'pending',:now,:leaseUntil,'in_progress'
                         WHERE """ + ACCESS + """
                        ON CONFLICT (tic_id) DO UPDATE SET
                            in_flight_until=:leaseUntil,
                            attempt_generation=nasa_star_catalog.attempt_generation+1,
                            last_refresh_status='in_progress'
                        WHERE nasa_star_catalog.next_refresh_at<=:now
                          AND (nasa_star_catalog.in_flight_until IS NULL
                               OR nasa_star_catalog.in_flight_until<=:now)
                        RETURNING attempt_generation
                        """)
                .param("memberId", memberId).param("ticId", ticId)
                .param("now", now).param("leaseUntil", leaseUntil)
                .query(Long.class).optional();
    }

    boolean saveCatalog(long memberId, long ticId, long generation, String status,
                        String hostName, List<SourceEntry> entries, OffsetDateTime now,
                        OffsetDateTime nextRefresh) {
        return Boolean.TRUE.equals(transactions.execute(ignored -> {
            requireAccess(memberId, ticId);
            int updated = jdbc.sql("""
                            UPDATE nasa_star_catalog
                               SET status=:status,host_name=:hostName,fetched_at=:now,
                                   next_refresh_at=:nextRefresh,in_flight_until=NULL,
                                   last_refresh_status=:refreshStatus
                             WHERE tic_id=:ticId AND attempt_generation=:generation
                            """)
                    .param("status", status).param("hostName", hostName).param("now", now)
                    .param("nextRefresh", nextRefresh).param("refreshStatus", "partial".equals(status) ? "partial" : "ok")
                    .param("ticId", ticId).param("generation", generation).update();
            if (updated == 0) return false;
            jdbc.sql("UPDATE nasa_star_planet SET active=FALSE WHERE tic_id=:ticId")
                    .param("ticId", ticId).update();
            for (SourceEntry entry : entries) {
                jdbc.sql("""
                                INSERT INTO nasa_star_planet(tic_id,planet_id,planet_name,active,status,
                                    normalized,source_hash,source_version,fetched_at,changed_at)
                                VALUES (:ticId,:planetId,:name,TRUE,:status,CAST(:normalized AS jsonb),
                                        :hash,:version,:now,:now)
                                ON CONFLICT (tic_id,planet_id) DO UPDATE SET
                                    active=TRUE,status=EXCLUDED.status,normalized=EXCLUDED.normalized,
                                    source_hash=EXCLUDED.source_hash,source_version=EXCLUDED.source_version,
                                    fetched_at=:now,
                                    changed_at=CASE WHEN nasa_star_planet.source_hash IS DISTINCT FROM EXCLUDED.source_hash
                                             OR nasa_star_planet.status IS DISTINCT FROM EXCLUDED.status
                                        THEN :now ELSE nasa_star_planet.changed_at END
                                """)
                        .param("ticId", ticId).param("planetId", entry.planetId())
                        .param("name", entry.name()).param("status", entry.status())
                        .param("normalized", entry.planet() == null ? null : encode(entry.planet()))
                        .param("hash", entry.hash()).param("version", entry.planet() == null ? null : (short) 1)
                        .param("now", now).update();
            }
            return true;
        }));
    }

    void failCatalog(long memberId, long ticId, long generation, String failure,
                     OffsetDateTime nextRefresh) {
        jdbc.sql("""
                        UPDATE nasa_star_catalog SET
                            status=CASE WHEN fetched_at IS NULL THEN 'temporarily_unavailable' ELSE status END,
                            next_refresh_at=:nextRefresh,in_flight_until=NULL,last_refresh_status=:failure
                         WHERE tic_id=:ticId AND attempt_generation=:generation
                           AND """ + ACCESS)
                .param("memberId", memberId).param("ticId", ticId).param("generation", generation)
                .param("failure", failure).param("nextRefresh", nextRefresh).update();
    }

    Optional<ExplanationRow> explanation(long ticId, String planetId, String hash,
                                         short version, String model, String prompt) {
        return jdbc.sql("""
                        SELECT e.status,e.content::text AS content,e.generated_at,e.next_retry_at,
                               e.in_flight_until,e.attempt_count,e.last_failure
                          FROM nasa_star_planet_explanation e
                          JOIN nasa_star_planet p ON p.tic_id=e.tic_id AND p.planet_id=e.planet_id
                         WHERE e.tic_id=:ticId AND e.planet_id=:planetId AND p.active
                           AND p.status='ready' AND p.source_hash=:hash AND p.source_version=:version
                           AND e.source_hash=:hash AND e.source_version=:version
                           AND e.model_name=:model AND e.prompt_version=:prompt
                        """)
                .param("ticId", ticId).param("planetId", planetId).param("hash", hash)
                .param("version", version).param("model", model).param("prompt", prompt)
                .query((rs, n) -> new ExplanationRow(rs.getString("status"),
                        decode(rs.getString("content"), Content.class),
                        rs.getObject("generated_at", OffsetDateTime.class),
                        rs.getObject("next_retry_at", OffsetDateTime.class),
                        rs.getObject("in_flight_until", OffsetDateTime.class),
                        rs.getInt("attempt_count"), rs.getString("last_failure"))).optional();
    }

    Optional<Long> claimExplanation(long memberId, long ticId, String planetId, String hash,
                                    short version, String model, String prompt, OffsetDateTime now,
                                    OffsetDateTime leaseUntil) {
        return jdbc.sql("""
                        INSERT INTO nasa_star_planet_explanation(tic_id,planet_id,source_hash,source_version,
                            model_name,prompt_version,status,next_retry_at,in_flight_until)
                        SELECT p.tic_id,p.planet_id,:hash,:version,:model,:prompt,'pending',:now,:leaseUntil
                          FROM nasa_star_planet p
                         WHERE p.tic_id=:ticId AND p.planet_id=:planetId AND p.active
                           AND p.status='ready' AND p.source_hash=:hash AND p.source_version=:version
                           AND """ + ACCESS + """
                         FOR UPDATE OF p
                        ON CONFLICT (tic_id,planet_id) DO UPDATE SET
                            source_hash=EXCLUDED.source_hash,source_version=EXCLUDED.source_version,
                            model_name=EXCLUDED.model_name,prompt_version=EXCLUDED.prompt_version,
                            status='pending',content=NULL,generated_at=NULL,next_retry_at=:now,
                            in_flight_until=:leaseUntil,
                            attempt_generation=nasa_star_planet_explanation.attempt_generation+1,
                            attempt_count=CASE WHEN nasa_star_planet_explanation.source_hash IS DISTINCT FROM EXCLUDED.source_hash
                                    OR nasa_star_planet_explanation.source_version IS DISTINCT FROM EXCLUDED.source_version
                                    OR nasa_star_planet_explanation.model_name IS DISTINCT FROM EXCLUDED.model_name
                                    OR nasa_star_planet_explanation.prompt_version IS DISTINCT FROM EXCLUDED.prompt_version
                                THEN 1 ELSE nasa_star_planet_explanation.attempt_count+1 END,
                            last_failure=NULL
                        WHERE nasa_star_planet_explanation.source_hash IS DISTINCT FROM EXCLUDED.source_hash
                           OR nasa_star_planet_explanation.source_version IS DISTINCT FROM EXCLUDED.source_version
                           OR nasa_star_planet_explanation.model_name IS DISTINCT FROM EXCLUDED.model_name
                           OR nasa_star_planet_explanation.prompt_version IS DISTINCT FROM EXCLUDED.prompt_version
                           OR (nasa_star_planet_explanation.status<>'ready'
                               AND nasa_star_planet_explanation.attempt_count<3
                               AND nasa_star_planet_explanation.next_retry_at<=:now
                               AND (nasa_star_planet_explanation.in_flight_until IS NULL
                                    OR nasa_star_planet_explanation.in_flight_until<=:now))
                        RETURNING attempt_generation
                        """)
                .param("memberId", memberId).param("ticId", ticId).param("planetId", planetId)
                .param("hash", hash).param("version", version).param("model", model)
                .param("prompt", prompt).param("now", now).param("leaseUntil", leaseUntil)
                .query(Long.class).optional();
    }

    boolean readyExplanation(long memberId, long ticId, String planetId, long generation,
                             String hash, short version, Content content, OffsetDateTime now) {
        return jdbc.sql("""
                        UPDATE nasa_star_planet_explanation e
                           SET status='ready',content=CAST(:content AS jsonb),generated_at=:now,
                               in_flight_until=NULL,last_failure=NULL
                          FROM nasa_star_planet p
                         WHERE e.tic_id=:ticId AND e.planet_id=:planetId
                           AND e.attempt_generation=:generation AND e.source_hash=:hash
                           AND e.source_version=:version
                           AND p.tic_id=e.tic_id AND p.planet_id=e.planet_id AND p.active
                           AND p.status='ready' AND p.source_hash=:hash AND p.source_version=:version
                           AND """ + ACCESS)
                .param("memberId", memberId).param("ticId", ticId).param("planetId", planetId)
                .param("generation", generation).param("hash", hash).param("version", version)
                .param("content", encode(content)).param("now", now).update() == 1;
    }

    void failExplanation(long memberId, long ticId, String planetId, long generation,
                         String hash, short version, String failure, OffsetDateTime retryAt) {
        jdbc.sql("""
                        UPDATE nasa_star_planet_explanation SET status='failed',in_flight_until=NULL,
                               next_retry_at=:retryAt,last_failure=:failure
                         WHERE tic_id=:ticId AND planet_id=:planetId AND attempt_generation=:generation
                           AND source_hash=:hash AND source_version=:version AND """ + ACCESS)
                .param("memberId", memberId).param("ticId", ticId).param("planetId", planetId)
                .param("generation", generation).param("hash", hash).param("version", version)
                .param("failure", failure).param("retryAt", retryAt).update();
    }

    private String encode(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (JsonProcessingException impossible) {
            throw new IllegalStateException("NASA cache cannot be serialized", impossible);
        }
    }

    private <T> T decode(String value, Class<T> type) {
        if (value == null) return null;
        try {
            return json.readValue(value, type);
        } catch (JsonProcessingException corrupt) {
            throw new IllegalStateException("stored NASA cache is invalid", corrupt);
        }
    }

    record Catalog(String status, String hostName, OffsetDateTime fetchedAt,
                   OffsetDateTime nextRefreshAt, OffsetDateTime inFlightUntil,
                   String refreshStatus) {}

    record SourceEntry(String planetId, String name, String status, Planet planet, String hash) {}

    record PlanetRow(String planetId, String name, String status, Planet planet, String hash,
                     Short version, OffsetDateTime fetchedAt, OffsetDateTime changedAt) {}

    record ExplanationRow(String status, Content content, OffsetDateTime generatedAt,
                          OffsetDateTime retryAt, OffsetDateTime inFlightUntil,
                          int attemptCount, String failure) {}
}
