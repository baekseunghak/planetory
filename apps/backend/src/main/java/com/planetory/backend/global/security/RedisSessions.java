package com.planetory.backend.global.security;

import java.time.Instant;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.core.ScanOptions;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.session.Session;
import org.springframework.session.SessionRepository;

/** 단일 앱의 Redis 저장 경계. 세션 내용은 Redis에만 보관한다. */
public final class RedisSessions<S extends Session> implements SessionRepository<S> {
    public static final String LAST_ACTIVITY = "com.planetory.backend.domain.auth.service.AuthSessionService.lastActivity";
    private final SessionRepository<S> delegate;
    private final RedisTemplate<String, Object> redis;
    private final ReentrantLock lock = new ReentrantLock(true);

    public RedisSessions(SessionRepository<S> delegate) { this(delegate, null); }
    public RedisSessions(SessionRepository<S> delegate, RedisTemplate<String, Object> redis) {
        this.delegate = delegate;
        this.redis = redis;
    }

    public void invalidateMember(long memberId) {
        if (redis == null) return;
        locked(() -> {
            // ponytail: 탈퇴는 드물어 세션 키를 SCAN한다. 세션 수가 커지면 회원별 인덱스로 교체한다.
            try (var keys = redis.scan(ScanOptions.scanOptions()
                    .match("planetory:session:sessions:*").count(100).build())) {
                while (keys.hasNext()) {
                    String key = keys.next();
                    String id = key.substring("planetory:session:sessions:".length());
                    S session = delegate.findById(id);
                    if (session == null) continue;
                    Object context = session.getAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY);
                    if (context instanceof SecurityContext security && security.getAuthentication() != null
                            && security.getAuthentication().getPrincipal() instanceof MemberPrincipal principal
                            && principal.memberId() == memberId) delegate.deleteById(id);
                }
            }
            return null;
        });
    }

    // ponytail: 단일 앱의 저장 작업만 직렬화한다. 다중 앱 전환 시 Redis 원자 연산으로 교체한다.
    @Override public S createSession() { return access(delegate::createSession); }
    @Override public S findById(String id) { return access(() -> delegate.findById(id)); }
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
            // 익명 세션도 역순 저장이 최신 접근 시각을 되돌리지 않도록 한다.
            if (activity == null && current.getLastAccessedTime().isAfter(session.getLastAccessedTime())) {
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
            if (delegate.findById(session.getId()) != null) throw ex;
        }
    }

    public boolean active(String id, Instant receivedAt, boolean touch) {
        return touch ? locked(() -> updateActivity(id, receivedAt, true))
                : access(() -> updateActivity(id, receivedAt, false));
    }
    private boolean updateActivity(String id, Instant receivedAt, boolean touch) {
        S session = delegate.findById(id);
        if (session == null) return false;
        Instant last = session.getAttribute(LAST_ACTIVITY);
        if (last == null || !receivedAt.isBefore(last.plus(session.getMaxInactiveInterval()))) return false;
        if (touch && receivedAt.isAfter(last)) {
            session.setAttribute(LAST_ACTIVITY, receivedAt);
            session.setLastAccessedTime(receivedAt);
            delegate.save(session);
        }
        return true;
    }

    /** 저장소에서 나온 장애만 외부 필터가 503으로 변환한다. */
    public static final class StoreUnavailableException extends DataAccessException {
        StoreUnavailableException(String message) { super(message); }
        StoreUnavailableException(String message, Throwable cause) { super(message, cause); }
    }

    private <T> T access(Supplier<T> operation) {
        try { return operation.get(); }
        catch (DataAccessException ex) { throw new StoreUnavailableException("Session store unavailable", ex); }
    }

    private <T> T locked(Supplier<T> operation) {
        try {
            if (!lock.tryLock(2, TimeUnit.SECONDS)) throw new StoreUnavailableException("Session store is busy");
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new StoreUnavailableException("Session store wait was interrupted", ex);
        }
        try { return access(operation); }
        finally { lock.unlock(); }
    }
}
