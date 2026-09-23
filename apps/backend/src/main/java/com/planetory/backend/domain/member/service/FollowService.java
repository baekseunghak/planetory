package com.planetory.backend.domain.member.service;

import com.planetory.backend.domain.StarBoardVisibility;
import com.planetory.backend.domain.exploration.service.StarService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.time.OffsetDateTime;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
public class FollowService {
    private final JdbcClient jdbc;
    private final MemberService members;
    private final StarService stars;
    private final FollowTokens tokens;

    private static final String OPEN_STAR = StarBoardVisibility.OPEN.formatted("f.target_id");
    private static final String ACTIVE_TARGET = "EXISTS (SELECT 1 FROM users u WHERE u.id=f.target_id AND u.status='active')";
    public record Relation(String kind, String id, boolean following) {}
    public record Target(String kind, String id, String label) {}
    public record Summary(String memberId, long followers, long followingMembers, long followingStars) {}
    public record Management(String relationId, boolean canUnfollow) {}
    public record ManagedRelation(String relationId, boolean following) {}
    public record Page<T>(List<T> items, String nextCursor, boolean hasNext) {}
    private record Row<T>(T item, OffsetDateTime at, long id) {}

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Relation relation(long member, String kind, long target) {
        members.requireActive(member);
        target(kind, target);
        return new Relation(kind, id(kind, target), !(kind.equals("MEMBER") && member == target) && exists(member, kind, target));
    }

    @Transactional
    public Relation change(long member, String kind, long target, boolean following) {
        if (kind.equals("MEMBER") && member != target) lockMembers(member, target);
        else lock(member);
        if (kind.equals("MEMBER") && member == target) {
            if (following) throw new BusinessException(ErrorCode.FOLLOW_SELF);
            return new Relation(kind, id(kind, target), false);
        }
        // 비공개 별도 본인이 보존한 관계라면 해제할 수 있다. 없는 대상의 관계를 새로 만들지는 않는다.
        if (following || !kind.equals("STAR") || !exists(member, kind, target)) target(kind, target);
        if (following) jdbc.sql("INSERT INTO follows(user_id,target_type,target_id) VALUES (?,?,?) ON CONFLICT DO NOTHING")
                .param(member).param(dbKind(kind)).param(target).update();
        else jdbc.sql("DELETE FROM follows WHERE user_id=? AND target_type=? AND target_id=?")
                .param(member).param(dbKind(kind)).param(target).update();
        return new Relation(kind, id(kind, target), following);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Summary summary(long member, long target) {
        members.requireActive(member);
        target("MEMBER", target);
        return jdbc.sql("""
                SELECT
                  (SELECT count(*) FROM follows f JOIN users u ON u.id=f.user_id AND u.status='active'
                   WHERE f.target_type='user' AND f.target_id=:member AND f.user_id<>:member) AS followers,
                  (SELECT count(*) FROM follows f WHERE f.user_id=:member AND f.target_type='user'
                   AND f.target_id<>:member AND %s) AS members,
                  (SELECT count(*) FROM follows f WHERE f.user_id=:member AND f.target_type='star' AND %s) AS stars
                """.formatted(ACTIVE_TARGET, OPEN_STAR)).param("member", target)
                .query((r, n) -> new Summary("u-" + target, r.getLong(1), r.getLong(2), r.getLong(3))).single();
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Page<Target> list(long member, String scope, FollowTokens.Page q) {
        members.requireActive(member);
        boolean followers = scope.equals("followers"), star = scope.equals("stars");
        String key = followers ? "f.user_id" : "f.target_id";
        String join = star ? "" : " JOIN users u ON u.id=" + key + " AND u.status='active'";
        String condition = followers ? "f.target_id=:member AND f.user_id<>:member AND f.target_type='user'"
                : "f.user_id=:member AND f.target_type='" + (star ? "star" : "user") + "'"
                  + (star ? " AND " + OPEN_STAR : " AND f.target_id<>:member");
        var rows = jdbc.sql("SELECT " + key + " AS target," + (star ? "NULL" : "u.nickname")
                + " AS label,f.created_at FROM follows f" + join + " WHERE " + condition
                + " AND (CAST(:at AS TIMESTAMPTZ) IS NULL OR (f.created_at," + key + ")<(:at,:id))"
                + " ORDER BY f.created_at DESC," + key + " DESC LIMIT :limit")
                .param("member", member).param("at", q.at()).param("id", q.id()).param("limit", q.size() + 1)
                .query((r, n) -> new Row<>(new Target(star ? "STAR" : "MEMBER", id(star ? "STAR" : "MEMBER", r.getLong("target")),
                        star ? "TIC " + r.getLong("target") : r.getString("label")),
                        r.getObject("created_at", OffsetDateTime.class), r.getLong("target"))).list();
        return page(rows, q);
    }

    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Page<Management> unavailable(long member, FollowTokens.Page q) {
        members.requireActive(member);
        var rows = jdbc.sql("SELECT f.id,f.created_at FROM follows f WHERE f.user_id=:member AND f.target_type='star' AND NOT "
                + OPEN_STAR + " AND (CAST(:at AS TIMESTAMPTZ) IS NULL OR (f.created_at,f.id)<(:at,:id))"
                + " ORDER BY f.created_at DESC,f.id DESC LIMIT :limit")
                .param("member", member).param("at", q.at()).param("id", q.id()).param("limit", q.size() + 1)
                .query((r, n) -> new Row<>(new Management(tokens.management(r.getLong("id")), true),
                        r.getObject("created_at", OffsetDateTime.class), r.getLong("id"))).list();
        return page(rows, q);
    }

    @Transactional(readOnly = true)
    public ManagedRelation managed(long member, String token) {
        members.requireActive(member);
        return new ManagedRelation(token, managedExists(member, tokens.relation(token)));
    }

    @Transactional
    public ManagedRelation removeManaged(long member, String token) {
        long relation = tokens.relation(token);
        lock(member);
        managedExists(member, relation);
        jdbc.sql("DELETE FROM follows WHERE id=? AND user_id=? AND target_type='star'").param(relation).param(member).update();
        return new ManagedRelation(token, false);
    }

    private boolean managedExists(long member, long relation) {
        var owned = jdbc.sql("SELECT user_id=? AND target_type='star' FROM follows WHERE id=?")
                .param(member).param(relation).query(Boolean.class).optional();
        if (owned.isPresent() && !owned.get()) throw new BusinessException(ErrorCode.RESOURCE_NOT_FOUND);
        return owned.isPresent();
    }
    private boolean exists(long member, String kind, long target) {
        return jdbc.sql("SELECT EXISTS(SELECT 1 FROM follows WHERE user_id=? AND target_type=? AND target_id=?)")
                .param(member).param(dbKind(kind)).param(target).query(Boolean.class).single();
    }
    private void target(String kind, long target) {
        try {
            if (kind.equals("MEMBER")) members.publicProfile(target);
            else stars.requireOpenStarBoard(target);
        } catch (BusinessException e) {
            if (e.getErrorCode() != ErrorCode.RESOURCE_NOT_FOUND && e.getErrorCode() != ErrorCode.STAR_NOT_PUBLISHED) throw e;
            throw new BusinessException(ErrorCode.FOLLOW_TARGET_UNAVAILABLE);
        }
    }
    private void lock(long member) {
        // ponytail: 회원별 팔로우 쓰기를 직렬화한다. 같은 회원의 쓰기 처리량이 병목일 때 관계별 잠금을 검토한다.
        var status = jdbc.sql("SELECT status FROM users WHERE id=? FOR UPDATE").param(member).query(String.class).optional();
        if (status.isEmpty() || !status.get().equals("active")) throw new BusinessException(ErrorCode.AUTH_REQUIRED);
    }
    private void lockMembers(long member, long target) {
        // 양방향 팔로우도 같은 순서로 잠그며, 대상 탈퇴의 T/C와 관계 저장을 직렬화한다.
        var active = jdbc.sql("SELECT id FROM users WHERE id IN (?,?) AND status='active' ORDER BY id FOR UPDATE")
                .params(member, target).query(Long.class).list();
        if (!active.contains(member)) throw new BusinessException(ErrorCode.AUTH_REQUIRED);
        if (!active.contains(target)) throw new BusinessException(ErrorCode.FOLLOW_TARGET_UNAVAILABLE);
    }
    private <T> Page<T> page(List<Row<T>> rows, FollowTokens.Page q) {
        boolean more = rows.size() > q.size();
        var page = rows.subList(0, Math.min(rows.size(), q.size()));
        return new Page<>(page.stream().map(Row::item).toList(),
                more ? tokens.next(q, page.getLast().at(), 0, page.getLast().id()) : null, more);
    }
    private static String dbKind(String kind) { return kind.equals("MEMBER") ? "user" : "star"; }
    private static String id(String kind, long target) { return (kind.equals("MEMBER") ? "u-" : "") + target; }
}
