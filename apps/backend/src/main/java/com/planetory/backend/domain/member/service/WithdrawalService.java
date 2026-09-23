package com.planetory.backend.domain.member.service;

import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.domain.auth.service.AuthSessionService;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Service
@RequiredArgsConstructor
@Slf4j
public class WithdrawalService {
    public static final String POLICY_VERSION = "withdrawal-v1";
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final long[] RETRY_MINUTES = {5, 15, 60, 180, 360};
    private final JdbcClient jdbc;
    private final MemberService members;
    private final AuthSessionService sessions;
    private final PlatformTransactionManager transactions;

    public record Status(String requestId, String status, String message, Instant effectiveAt) {}
    public record Prepared(Status status, String receipt) {}
    private record Row(UUID id, long userId, String status, String receiptHash, Instant effectiveAt) {}

    public Prepared prepare(long memberId, String version) {
        checkVersion(version);
        byte[] secret = new byte[32];
        RANDOM.nextBytes(secret);
        String receipt = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
        Status result = new TransactionTemplate(transactions).execute(tx -> {
            members.lockActive(memberId);
            UUID id = jdbc.sql("SELECT id FROM withdrawal_requests WHERE user_id=?")
                    .param(memberId).query(UUID.class).optional().orElseGet(UUID::randomUUID);
            jdbc.sql("""
                    INSERT INTO withdrawal_requests(id,user_id,policy_version,receipt_hash,status)
                    VALUES(?,?,?,?,'READY')
                    ON CONFLICT(user_id) DO UPDATE SET policy_version=EXCLUDED.policy_version,
                      receipt_hash=EXCLUDED.receipt_hash,created_at=clock_timestamp()
                    """).params(id, memberId, POLICY_VERSION, hash(secret)).update();
            return status(id);
        });
        return new Prepared(result, receipt);
    }

    public Status confirm(long memberId, UUID id, String version, String confirmation) {
        if (!"탈퇴".equals(confirmation)) throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        checkVersion(version);
        new TransactionTemplate(transactions).executeWithoutResult(tx -> {
            members.lockActive(memberId);
            Row request = row(id);
            if (request.userId() != memberId || !"READY".equals(request.status())) {
                throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
            }
            if (!POLICY_VERSION.equals(jdbc.sql("SELECT policy_version FROM withdrawal_requests WHERE id=?")
                    .param(id).query(String.class).single())) throw new BusinessException(ErrorCode.POLICY_CHANGED);
            jdbc.sql("UPDATE users SET status='withdrawn',withdrawn_at=clock_timestamp() WHERE id=?")
                    .param(memberId).update();
            jdbc.sql("UPDATE published_analyses SET withdrawn_at=clock_timestamp() WHERE user_id=? AND withdrawn_at IS NULL")
                    .param(memberId).update();
            jdbc.sql("UPDATE withdrawal_requests SET status='PROCESSING',effective_at=clock_timestamp(),next_attempt_at=clock_timestamp() WHERE id=?")
                    .param(id).update();
        });
        cleanup(id);
        return status(id);
    }

    public Status receipt(UUID id, String secret) {
        if (secret == null || secret.isBlank()) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        Row row = jdbc.sql("""
                SELECT id,user_id,status,receipt_hash,effective_at FROM withdrawal_requests
                WHERE id=? AND created_at>clock_timestamp()-interval '90 days'
                """).param(id).query((r, n) -> new Row(r.getObject("id", UUID.class), r.getLong("user_id"),
                r.getString("status"), r.getString("receipt_hash"), r.getTimestamp("effective_at") == null
                        ? null : r.getTimestamp("effective_at").toInstant()))
                .optional().orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
        byte[] supplied;
        try { supplied = java.util.Base64.getUrlDecoder().decode(secret); }
        catch (IllegalArgumentException ex) { throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND); }
        if (!MessageDigest.isEqual(row.receiptHash().getBytes(StandardCharsets.US_ASCII),
                hash(supplied).getBytes(StandardCharsets.US_ASCII))) {
            throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        }
        return status(id);
    }

    public Status retryFailed(UUID id) {
        new TransactionTemplate(transactions).executeWithoutResult(tx -> {
            if (jdbc.sql("""
                    UPDATE withdrawal_requests SET status='PROCESSING',attempts=0,next_attempt_at=clock_timestamp()
                    WHERE id=? AND status='FAILED' AND effective_at IS NOT NULL
                    """).param(id).update() != 1) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        });
        cleanup(id);
        return status(id);
    }

    @Scheduled(fixedDelay = 60_000)
    public void retryDue() {
        List<UUID> due = jdbc.sql("""
                SELECT id FROM withdrawal_requests WHERE status='PROCESSING'
                  AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at LIMIT 20
                """).query(UUID.class).list();
        due.forEach(this::cleanup);
    }

    @Scheduled(cron = "0 0 3 * * *", zone = "Asia/Seoul")
    public void prune() { jdbc.sql("SELECT prune_withdrawal_retention()").query((r, n) -> true).single(); }

    private void cleanup(UUID id) {
        try {
            new TransactionTemplate(transactions).executeWithoutResult(tx -> {
                Row request = jdbc.sql("""
                        SELECT id,user_id,status,receipt_hash,effective_at FROM withdrawal_requests
                        WHERE id=? FOR UPDATE
                        """).param(id).query((r, n) -> new Row(r.getObject("id", UUID.class), r.getLong("user_id"),
                        r.getString("status"), r.getString("receipt_hash"), r.getTimestamp("effective_at").toInstant()))
                        .single();
                if (!"PROCESSING".equals(request.status())) return;
                sessions.invalidateMember(request.userId());
                jdbc.sql("SELECT cleanup_withdrawn_member(?)").param(request.userId()).query((r, n) -> true).single();
                jdbc.sql("""
                        UPDATE withdrawal_requests SET status='COMPLETED',completed_at=clock_timestamp(),
                          attempts=attempts+1,next_attempt_at=NULL WHERE id=?
                        """).param(id).update();
            });
        } catch (RuntimeException failure) {
            log.warn("Withdrawal cleanup failed: request={} exception={}", id, failure.getClass().getSimpleName());
            new TransactionTemplate(transactions).executeWithoutResult(tx -> {
                jdbc.sql("""
                        UPDATE withdrawal_requests SET attempts=attempts+1,
                          status=CASE WHEN attempts>=5 THEN 'FAILED' ELSE 'PROCESSING' END,
                          next_attempt_at=CASE WHEN attempts>=5 THEN NULL ELSE
                            clock_timestamp()+make_interval(mins=>?::integer) END
                        WHERE id=? AND status='PROCESSING'
                        """).params(RETRY_MINUTES[Math.min(attempts(id), 4)], id).update();
            });
        }
    }

    private int attempts(UUID id) {
        return jdbc.sql("SELECT attempts FROM withdrawal_requests WHERE id=?")
                .param(id).query(Integer.class).single();
    }

    private Status status(UUID id) {
        Row row = row(id);
        String message = switch (row.status()) {
            case "READY" -> "탈퇴가 아직 확정되지 않았습니다.";
            case "PROCESSING" -> "계정 이용이 종료됐으며 데이터 정리 중입니다.";
            case "COMPLETED" -> "계정 이용 종료와 데이터 정리가 완료됐습니다.";
            default -> "계정 이용은 종료됐으며 데이터 정리가 지연 중입니다.";
        };
        return new Status(id.toString(), row.status(), message, row.effectiveAt());
    }

    private Row row(UUID id) {
        return jdbc.sql("SELECT id,user_id,status,receipt_hash,effective_at FROM withdrawal_requests WHERE id=?")
                .param(id).query((r, n) -> new Row(r.getObject("id", UUID.class), r.getLong("user_id"),
                        r.getString("status"), r.getString("receipt_hash"),
                        r.getTimestamp("effective_at") == null ? null : r.getTimestamp("effective_at").toInstant()))
                .optional().orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
    }

    private void checkVersion(String version) {
        if (!POLICY_VERSION.equals(version)) throw new BusinessException(ErrorCode.POLICY_CHANGED);
    }

    private static String hash(byte[] input) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(input)); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
}
