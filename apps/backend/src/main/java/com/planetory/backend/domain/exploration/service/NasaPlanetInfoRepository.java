package com.planetory.backend.domain.exploration.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import static com.planetory.backend.domain.exploration.service.NasaPlanetInfo.Planet;

/** Gold는 읽기만 하고 266 전용 테이블만 갱신한다. 각 문장은 독립 트랜잭션이다. */
@Repository
class NasaPlanetInfoRepository {

    /** 완료 저장과 동시에 현재 회원 자격·단일 Archive 이름을 재검사한다. 두 저장소가 사용한다. */
    static final String CURRENT_TARGET_SQL = """
                         AND EXISTS (
                             SELECT 1 FROM candidates c
                               JOIN stars t ON t.tic_id=c.tic_id AND t.service_status='published'
                          LEFT JOIN candidate_dispositions d ON d.candidate_id=c.id
                              WHERE c.id=n.candidate_id AND c.tic_id=n.tic_id
                                AND c.status='active' AND c.is_confirmed
                                AND COALESCE(d.disposition, 'confirmed')='confirmed'
                                AND EXISTS (SELECT 1 FROM users m WHERE m.id=:memberId AND m.status='active')
                                AND EXISTS (SELECT 1 FROM star_unlocks u
                                             WHERE u.user_id=:memberId AND u.tic_id=c.tic_id)
                                AND EXISTS (SELECT 1 FROM submissions s
                                             WHERE s.user_id=:memberId AND s.tic_id=c.tic_id
                                               AND s.matched_candidate_id=c.id)
                                AND EXISTS (SELECT 1 FROM external_signal_references e
                                             WHERE e.candidate_id=c.id AND e.tic_id=c.tic_id
                                               AND e.source='archive' AND e.external_id=n.archive_planet_name)
                                AND NOT EXISTS (SELECT 1 FROM external_signal_references e
                                                 WHERE e.candidate_id=c.id AND e.tic_id=c.tic_id
                                                   AND e.source='archive'
                                                   AND e.external_id<>n.archive_planet_name)
                                AND NOT EXISTS (SELECT 1 FROM external_signal_references e
                                                 JOIN candidates other_candidate
                                                   ON other_candidate.id=e.candidate_id
                                                  AND other_candidate.status='active'
                                                WHERE e.tic_id=c.tic_id AND e.source='archive'
                                                  AND e.external_id=n.archive_planet_name
                                                  AND e.candidate_id<>c.id)
                         )
                        """;

    private final JdbcClient jdbc;
    private final ObjectMapper json = new ObjectMapper();

    NasaPlanetInfoRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    Optional<Long> allowedTic(long memberId, long candidateId) {
        return jdbc.sql("""
                        SELECT c.tic_id FROM candidates c
                          JOIN stars t ON t.tic_id=c.tic_id AND t.service_status='published'
                     LEFT JOIN candidate_dispositions d ON d.candidate_id=c.id
                         WHERE c.id=:candidateId AND c.status='active' AND c.is_confirmed
                           AND COALESCE(d.disposition, 'confirmed')='confirmed'
                           AND EXISTS (SELECT 1 FROM users m WHERE m.id=:memberId AND m.status='active')
                           AND EXISTS (SELECT 1 FROM star_unlocks u
                                        WHERE u.user_id=:memberId AND u.tic_id=c.tic_id)
                           AND EXISTS (SELECT 1 FROM submissions s
                                        WHERE s.user_id=:memberId AND s.tic_id=c.tic_id
                                          AND s.matched_candidate_id=c.id)
                        """)
                .param("memberId", memberId).param("candidateId", candidateId)
                .query(Long.class).optional();
    }

    List<String> archiveNames(long candidateId, long ticId) {
        return jdbc.sql("""
                        SELECT DISTINCT e.external_id
                          FROM external_signal_references e
                         WHERE e.candidate_id=:candidateId AND e.tic_id=:ticId AND e.source='archive'
                         ORDER BY e.external_id
                         LIMIT 2
                        """)
                .param("candidateId", candidateId).param("ticId", ticId)
                .query(String.class).list();
    }

    boolean nameSharedWithAnotherCandidate(long candidateId, long ticId, String name) {
        return jdbc.sql("""
                        SELECT EXISTS (SELECT 1 FROM external_signal_references e
                                        JOIN candidates other_candidate
                                          ON other_candidate.id=e.candidate_id
                                         AND other_candidate.status='active'
                                        WHERE e.tic_id=:ticId AND e.source='archive'
                                          AND e.external_id=:name AND e.candidate_id<>:candidateId)
                        """)
                .param("candidateId", candidateId).param("ticId", ticId).param("name", name)
                .query(Boolean.class).single();
    }

    Optional<Row> find(long candidateId) {
        return jdbc.sql("""
                        SELECT tic_id, archive_planet_name, status, normalized::text AS normalized,
                               source_hash, source_version, fetched_at, changed_at, next_refresh_at,
                               in_flight_until, last_refresh_status
                          FROM nasa_planet_info WHERE candidate_id=:candidateId
                        """)
                .param("candidateId", candidateId)
                .query((rs, n) -> new Row(rs.getLong("tic_id"), rs.getString("archive_planet_name"),
                        rs.getString("status"), decode(rs.getString("normalized")),
                        rs.getString("source_hash"), rs.getObject("source_version", Short.class),
                        rs.getObject("fetched_at", OffsetDateTime.class),
                        rs.getObject("changed_at", OffsetDateTime.class),
                        rs.getObject("next_refresh_at", OffsetDateTime.class),
                        rs.getObject("in_flight_until", OffsetDateTime.class),
                        rs.getString("last_refresh_status")))
                .optional();
    }

    Optional<Long> claim(long candidateId, long ticId, String name, OffsetDateTime now,
                         OffsetDateTime leaseUntil) {
        return jdbc.sql("""
                        INSERT INTO nasa_planet_info(candidate_id,tic_id,archive_planet_name,status,
                            last_attempt_at,next_refresh_at,in_flight_until,last_refresh_status)
                        VALUES (:candidateId,:ticId,:name,'pending',:now,:now,:leaseUntil,'in_progress')
                        ON CONFLICT (candidate_id) DO UPDATE SET
                            attempt_generation=nasa_planet_info.attempt_generation+1,
                            last_attempt_at=:now, in_flight_until=:leaseUntil,
                            last_refresh_status='in_progress'
                        WHERE nasa_planet_info.tic_id=EXCLUDED.tic_id
                          AND nasa_planet_info.archive_planet_name=EXCLUDED.archive_planet_name
                          AND nasa_planet_info.next_refresh_at<=:now
                          AND (nasa_planet_info.in_flight_until IS NULL
                               OR nasa_planet_info.in_flight_until<=:now)
                        RETURNING attempt_generation
                        """)
                .param("candidateId", candidateId).param("ticId", ticId).param("name", name)
                .param("now", now).param("leaseUntil", leaseUntil)
                .query(Long.class).optional();
    }

    void ready(long memberId, long candidateId, long ticId, String name,
               long generation, Planet planet, String hash,
               OffsetDateTime now, OffsetDateTime nextRefresh) {
        jdbc.sql("""
                        UPDATE nasa_planet_info n SET status='ready', normalized=CAST(:normalized AS jsonb),
                               source_hash=:hash, source_version=1, fetched_at=:now,
                               changed_at=CASE WHEN source_hash IS DISTINCT FROM :hash THEN :now
                                               ELSE changed_at END,
                               next_refresh_at=:nextRefresh, in_flight_until=NULL, last_refresh_status='ok'
                         WHERE n.candidate_id=:candidateId AND n.attempt_generation=:generation
                           AND n.tic_id=:ticId AND n.archive_planet_name=:name
                        """ + CURRENT_TARGET_SQL)
                .param("normalized", encode(planet)).param("hash", hash).param("now", now)
                .param("nextRefresh", nextRefresh).param("memberId", memberId)
                .param("candidateId", candidateId).param("ticId", ticId).param("name", name)
                .param("generation", generation).update();
    }

    void notFound(long memberId, long candidateId, long ticId, String name,
                  long generation, OffsetDateTime nextRefresh) {
        // 이전 정상 JSON은 보존하되 status=not_found이므로 소비자에게 표시하지 않는다.
        jdbc.sql("""
                        UPDATE nasa_planet_info n SET status='not_found', next_refresh_at=:nextRefresh,
                               in_flight_until=NULL, last_refresh_status='not_found'
                         WHERE n.candidate_id=:candidateId AND n.attempt_generation=:generation
                           AND n.tic_id=:ticId AND n.archive_planet_name=:name
                        """ + CURRENT_TARGET_SQL)
                .param("nextRefresh", nextRefresh).param("candidateId", candidateId)
                .param("generation", generation).param("memberId", memberId)
                .param("ticId", ticId).param("name", name).update();
    }

    void unresolved(long memberId, long candidateId, long ticId, String name,
                    long generation, OffsetDateTime nextRefresh) {
        jdbc.sql("""
                        UPDATE nasa_planet_info n SET status='identity_unresolved',
                               next_refresh_at=:nextRefresh, in_flight_until=NULL,
                               last_refresh_status='identity_unresolved'
                         WHERE n.candidate_id=:candidateId AND n.attempt_generation=:generation
                           AND n.tic_id=:ticId AND n.archive_planet_name=:name
                        """ + CURRENT_TARGET_SQL)
                .param("nextRefresh", nextRefresh).param("candidateId", candidateId)
                .param("generation", generation).param("memberId", memberId)
                .param("ticId", ticId).param("name", name).update();
    }

    void failed(long memberId, long candidateId, long ticId, String name,
                long generation, String failure, OffsetDateTime nextRefresh) {
        jdbc.sql("""
                        UPDATE nasa_planet_info n
                           SET status=CASE WHEN normalized IS NOT NULL AND status='ready' THEN 'ready'
                                           WHEN status IN ('not_found', 'identity_unresolved') THEN status
                                           ELSE 'temporarily_unavailable' END,
                               next_refresh_at=:nextRefresh, in_flight_until=NULL,
                               last_refresh_status=:failure
                         WHERE n.candidate_id=:candidateId AND n.attempt_generation=:generation
                           AND n.tic_id=:ticId AND n.archive_planet_name=:name
                        """ + CURRENT_TARGET_SQL)
                .param("nextRefresh", nextRefresh).param("failure", failure)
                .param("candidateId", candidateId).param("generation", generation)
                .param("memberId", memberId).param("ticId", ticId).param("name", name).update();
    }

    String encode(Planet planet) {
        try {
            return json.writeValueAsString(planet);
        } catch (JsonProcessingException impossible) {
            throw new IllegalStateException("normalized NASA data cannot be serialized", impossible);
        }
    }

    private Planet decode(String value) {
        if (value == null) {
            return null;
        }
        try {
            return json.readValue(value, Planet.class);
        } catch (JsonProcessingException corrupt) {
            throw new IllegalStateException("stored NASA data is invalid", corrupt);
        }
    }

    record Row(long ticId, String name, String status, Planet planet, String hash, Short sourceVersion,
               OffsetDateTime fetchedAt, OffsetDateTime changedAt,
               OffsetDateTime nextRefreshAt, OffsetDateTime inFlightUntil, String refreshStatus) {
    }
}
