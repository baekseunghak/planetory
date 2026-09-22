package com.planetory.backend.global.security;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.session.Session;
import org.springframework.session.SessionRepository;

/** 단일 앱의 Redis 저장 경계. 세션 내용은 Redis에만 보관한다. */
public final class RedisSessions<S extends Session> implements SessionRepository<S> {
    public static final String LAST_ACTIVITY = "com.planetory.backend.domain.auth.service.AuthSessionService.lastActivity";
    private static final Duration IDLE = Duration.ofMinutes(30);
    private final SessionRepository<S> delegate;
    private final ReentrantLock lock = new ReentrantLock(true);

    public RedisSessions(SessionRepository<S> delegate) { this.delegate = delegate; }

    // ponytail: 단일 앱의 저장 작업만 직렬화한다. 다중 앱 전환 시 Redis 원자 연산으로 교체한다.
    @Override public S createSession() { return locked(delegate::createSession); }
    @Override public S findById(String id) { return locked(() -> delegate.findById(id)); }
    @Override public void deleteById(String id) { locked(() -> { delegate.deleteById(id); return null; }); }

    @Override public void save(S session) { locked(() -> { saveCurrent(session); return null; }); }

    private void saveCurrent(S session) {
        S current = delegate.findById(session.getId());
        Instant activity = session.getAttribute(LAST_ACTIVITY);
        if (current != null) {
            Instant latest = current.getAttribute(LAST_ACTIVITY);
            if (latest != null && (activity == null || latest.isAfter(activity))) {
                activity = latest;
                session.setAttribute(LAST_ACTIVITY, latest);
            }
            if (current.getLastAccessedTime().isAfter(session.getLastAccessedTime())) {
                session.setLastAccessedTime(current.getLastAccessedTime());
            }
        }
        // CSRF·정적 요청의 기본 lastAccessedTime 갱신이 인증 idle TTL을 연장하지 않는다.
        if (activity != null) session.setLastAccessedTime(activity);
        try {
            delegate.save(session);
        } catch (IllegalStateException ex) {
            // RedisSessionRepository는 이미 삭제/ID 교체된 사본의 저장을 거부한다.
            // 같은 잠금 안에서 delete와 save가 실행되므로 존재 확인 후 재생성 경합도 없다.
            if (!"Session was invalidated".equals(ex.getMessage())) throw ex;
        }
    }

    public boolean active(String id, Instant receivedAt, boolean touch) {
        return locked(() -> updateActivity(id, receivedAt, touch));
    }
    private boolean updateActivity(String id, Instant receivedAt, boolean touch) {
        S session = delegate.findById(id);
        if (session == null) return false;
        Instant last = session.getAttribute(LAST_ACTIVITY);
        if (last == null || !receivedAt.isBefore(last.plus(IDLE))) return false;
        if (touch && receivedAt.isAfter(last)) {
            session.setAttribute(LAST_ACTIVITY, receivedAt);
            session.setLastAccessedTime(receivedAt);
            delegate.save(session);
        }
        return true;
    }

    private <T> T locked(Supplier<T> operation) {
        try {
            if (!lock.tryLock(2, TimeUnit.SECONDS)) throw new CannotAcquireLockException("Session store is busy");
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new CannotAcquireLockException("Session store wait was interrupted", ex);
        }
        try { return operation.get(); }
        finally { lock.unlock(); }
    }
}
