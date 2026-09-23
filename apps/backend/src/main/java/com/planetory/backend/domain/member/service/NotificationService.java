package com.planetory.backend.domain.member.service;

import com.planetory.backend.domain.StarBoardVisibility;
import com.planetory.backend.domain.comment.service.CommentCursor;
import com.planetory.backend.domain.exploration.service.TutorialRepository;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

/** 알림 전용 수신 의도·발행·알림함. 소스 트랜잭션에서 다른 수신자 행을 잠그지 않는다. */
@Service
@RequiredArgsConstructor
public class NotificationService {
    public static final Set<String> KINDS = Set.of("ACHIEVEMENT", "REOPEN", "CHALLENGE", "FOLLOW", "COMMENT", "RELABEL");
    private static final String DEFAULTS = "{\"achievement\":true,\"reopen\":true,\"challenge\":true,\"follow\":true,\"comment\":true,\"relabel\":true}";
    private final JdbcClient jdbc;
    private final JsonMapper json;
    private final TutorialRepository members;
    private final NotificationTokens tokens;
    private final Clock clock;

    public record Preferences(Map<String, Boolean> preferences) {}
    public record Notice(String notificationId, String kind, Instant createdAt, boolean read,
                         boolean available, String title, String body) {}
    public record Page(List<Notice> items, String nextCursor, boolean hasNext, String readBoundary) {}
    public record Target(String notificationId, boolean available, Map<String, Object> target) {}
    public record Count(long unreadCount) {}
    public record Read(String notificationId, boolean read) {}
    private record Row(long id, String type, String payload, Instant publishedAt, boolean read) {}
    private record Intent(long id, String key, String type, String payload, long epoch, Long follow, Long source, Long followEpoch) {}

    @Transactional(propagation = Propagation.MANDATORY)
    public void record(long member, String kind, String key, Map<String, Object> payload, Long source) {
        capture("SELECT id, NULL::bigint AS follow_id FROM users WHERE id=:member AND status='active'",
                member, kind, key, payload, source, 0, 0);
        if (source != null && "reopen".equals(kind)) {
            // 본인 재개 사유는 구독과 독립이다. 이미 제공한 구독 알림은 그대로 유지한다.
            jdbc.sql("""
                    UPDATE notification_outbox o SET payload=CAST(:payload AS jsonb),source_notification_id=:source,
                      follow_id=NULL,follow_epoch=NULL,preference_epoch=coalesce((s.notification_epochs->>'reopen')::bigint,0),
                      state=CASE WHEN coalesce((s.notification_prefs->>'reopen')::boolean,true) THEN 'pending' ELSE 'excluded' END
                    FROM users u LEFT JOIN user_settings s ON s.user_id=u.id
                    WHERE o.user_id=:member AND u.id=o.user_id AND o.event_key=:key AND o.state<>'delivered'
                      AND o.source_notification_id IS NULL AND o.follow_id IS NOT NULL
                    """).param("payload",json.writeValueAsString(payload)).param("source",source).param("member",member).param("key",key).update();
        }
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void postCreated(long actor, long post, Long tic, boolean thread) {
        if (tic == null) return;
        capture("SELECT u.id,f.id AS follow_id FROM follows f JOIN users u ON u.id=f.user_id "
                        + "WHERE f.target_type='star' AND f.target_id=:tic AND u.status='active' AND u.id<>:actor",
                0, "follow", "post:" + post,
                Map.of("actorId", actor, "postId", post, "targetKind", thread ? "THREAD" : "POST"), null, actor, tic);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void commentCreated(long actor, long owner, long post, long comment) {
        if (actor == owner) return;
        record(owner, "comment", "comment:" + comment,
                Map.of("actorId", actor, "postId", post, "commentId", comment, "targetKind", "POST"), null);
    }

    private void capture(String recipients, long member, String type, String key, Map<String, Object> payload,
                         Long source, long actor, long tic) {
        if (!KINDS.contains(type.toUpperCase(Locale.ROOT))) throw new IllegalArgumentException("알림 종류");
        jdbc.sql("""
                INSERT INTO notification_outbox(event_key,user_id,type,payload,preference_epoch,follow_id,source_notification_id,state)
                SELECT :key,r.id,:type,CAST(:payload AS jsonb),coalesce((s.notification_epochs->>:type)::bigint,0),
                       r.follow_id,:source,CASE WHEN coalesce((s.notification_prefs->>:type)::boolean,true)
                       THEN 'pending' ELSE 'excluded' END
                  FROM (%s) r LEFT JOIN user_settings s ON s.user_id=r.id
                ON CONFLICT(user_id,event_key) DO NOTHING
                """.formatted(recipients)).param("key", key).param("type", type)
                .param("payload", json.writeValueAsString(payload)).param("source", source)
                .param("member", member).param("actor", actor).param("tic", tic).update();
    }

    @Transactional
    public Preferences preferences(long member) {
        lock(member);
        return savedPreferences(member);
    }

    @Transactional
    public Preferences changePreferences(long member, Map<String, Object> request) {
        if (request == null || !request.keySet().equals(Set.of("preferences"))
                || !(request.get("preferences") instanceof Map<?, ?> patch) || patch.isEmpty()) throw invalid();
        var values = new LinkedHashMap<String, Boolean>();
        for (var entry : patch.entrySet()) {
            if (!(entry.getKey() instanceof String key) || !KINDS.contains(key)
                    || !(entry.getValue() instanceof Boolean value)) throw invalid();
            values.put(key.toLowerCase(Locale.ROOT), value);
        }
        lock(member);
        for (var entry : values.entrySet()) {
            String kind = entry.getKey();
            // 세대는 아직 커밋되지 않은 수신 의도에도 적용된다. 보이는 pending만 바꾸면 누락된다.
            jdbc.sql("""
                    UPDATE user_settings SET notification_epochs = CASE
                      WHEN :enabled=false AND (notification_prefs->>:kind)::boolean
                      THEN notification_epochs || jsonb_build_object(CAST(:kind AS text),coalesce((notification_epochs->>:kind)::bigint,0)+1)
                      ELSE notification_epochs END,
                      notification_prefs=notification_prefs || jsonb_build_object(CAST(:kind AS text),CAST(:enabled AS boolean))
                    WHERE user_id=:member
                    """).param("kind", kind).param("enabled", entry.getValue()).param("member", member).update();
            if (!entry.getValue()) jdbc.sql("UPDATE notification_outbox SET state='excluded' "
                            + "WHERE user_id=? AND type=? AND state='pending'").params(member, kind).update();
        }
        return savedPreferences(member);
    }

    private Preferences savedPreferences(long member) {
        var node = json.readTree(jdbc.sql("SELECT notification_prefs::text FROM user_settings WHERE user_id=?")
                .param(member).query(String.class).single());
        var result = new LinkedHashMap<String, Boolean>();
        for (String kind : KINDS) {
            var value = node.get(kind.toLowerCase(Locale.ROOT));
            if (value == null || !value.isBoolean()) throw new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE);
            result.put(kind, value.booleanValue());
        }
        return new Preferences(result);
    }

    private void lock(long member) {
        if (!members.lockActiveMember(member)) throw new BusinessException(ErrorCode.AUTH_REQUIRED);
        jdbc.sql("INSERT INTO user_settings(user_id) VALUES (?) ON CONFLICT DO NOTHING").param(member).update();
        jdbc.sql("UPDATE user_settings SET notification_prefs=CAST(? AS jsonb)||notification_prefs WHERE user_id=?")
                .params(DEFAULTS, member).update();
    }

    /** 실패하면 해당 회원의 발행만 롤백한다. 다음 벨·목록 조회가 같은 pending을 재처리한다. */
    @Transactional
    public void dispatch(long member) {
        if (!members.lockActiveMember(member)) {
            jdbc.sql("UPDATE notification_outbox SET state='excluded' WHERE user_id=? AND state='pending'")
                    .param(member).update();
            return;
        }
        lock(member);
        dispatchLocked(member);
    }

    // ponytail: 회원 pending을 한 트랜잭션으로 처리한다. 적체가 조회를 지연시키면 제한 배치로 나눈다.
    private void dispatchLocked(long member) {
        var pending = jdbc.sql("SELECT id,event_key,type,payload::text,preference_epoch,follow_id,source_notification_id,follow_epoch "
                        + "FROM notification_outbox WHERE user_id=? AND state='pending' ORDER BY id FOR UPDATE")
                .param(member).query((r, n) -> new Intent(r.getLong(1), r.getString(2), r.getString(3), r.getString(4),
                        r.getLong(5), (Long) r.getObject(6), (Long) r.getObject(7), (Long) r.getObject(8))).list();
        for (Intent event : pending) {
            boolean eligible = jdbc.sql("SELECT (notification_prefs->>?)::boolean AND "
                            + "coalesce((notification_epochs->>?)::bigint,0)=? FROM user_settings WHERE user_id=?")
                    .params(event.type(), event.type(), event.epoch(), member).query(Boolean.class).single();
            if (event.follow() != null) eligible &= jdbc.sql("SELECT EXISTS(SELECT 1 FROM follows WHERE id=? AND user_id=?)")
                    .params(event.follow(), member).query(Boolean.class).single();
            if (event.followEpoch() != null) eligible &= jdbc.sql("SELECT (notification_prefs->>'follow')::boolean AND coalesce((notification_epochs->>'follow')::bigint,0)=? FROM user_settings WHERE user_id=?")
                    .params(event.followEpoch(),member).query(Boolean.class).single();
            eligible &= destination(member, event.payload()) != null;
            if (eligible) {
                long sequence = nextSequence(member);
                var now = OffsetDateTime.ofInstant(clock.instant(), ZoneOffset.UTC);
                if (event.source() == null) {
                    jdbc.sql("INSERT INTO notifications(user_id,type,payload,event_key,published_at,publication_seq) "
                                    + "VALUES (?,?,CAST(? AS jsonb),?,?,?) ON CONFLICT(user_id,event_key) DO NOTHING")
                            .params(member, event.type(), event.payload(), event.key(), now, sequence).update();
                } else {
                    int changed = jdbc.sql("UPDATE notifications SET event_key=?,published_at=?,publication_seq=? "
                                    + "WHERE id=? AND user_id=? AND type=? AND event_key IS NULL")
                            .params(event.key(), now, sequence, event.source(), member, event.type()).update();
                    if (changed == 0 && !jdbc.sql("SELECT EXISTS(SELECT 1 FROM notifications WHERE id=? AND user_id=? AND type=? AND event_key=?)")
                            .params(event.source(), member, event.type(), event.key()).query(Boolean.class).single())
                        throw new IllegalStateException("재개 원본과 알림 수신 의도가 일치하지 않습니다");
                }
            }
            jdbc.sql("UPDATE notification_outbox SET state=? WHERE id=?")
                    .params(eligible ? "delivered" : "excluded", event.id()).update();
        }
    }

    private long nextSequence(long member) {
        return jdbc.sql("SELECT coalesce(max(publication_seq),0)+1 FROM notifications WHERE user_id=?")
                .param(member).query(Long.class).single();
    }
    private OffsetDateTime cutoff() { return OffsetDateTime.ofInstant(clock.instant().minusSeconds(90L * 86400), ZoneOffset.UTC); }
    private List<Row> rows(long member, String extra, Map<String, Object> params) {
        var query = jdbc.sql("SELECT id,type,payload::text,published_at,read_at IS NOT NULL FROM notifications "
                + "WHERE user_id=:member AND published_at>:cutoff " + extra).params(params)
                .param("member", member).param("cutoff", cutoff());
        return query.query((r,n) -> new Row(r.getLong(1),r.getString(2),r.getString(3),
                r.getObject(4,OffsetDateTime.class).toInstant(),r.getBoolean(5))).list();
    }

    @Transactional
    public Page list(long member, int size, boolean unread, String cursor) {
        lock(member);
        dispatchLocked(member);
        String purpose = "page:" + size + ":" + unread;
        String after = "";
        var params = new LinkedHashMap<String, Object>();
        params.put("limit", size + 1);
        if (cursor != null) {
            try {
                String[] parts = tokens.verify(member, purpose, cursor).split("\\|", -1);
                if (parts.length != 2) throw invalid();
                params.put("at", OffsetDateTime.parse(parts[0]));
                params.put("id", Long.parseLong(parts[1]));
                after = " AND (published_at,id)<(:at,:id)";
            } catch (IllegalArgumentException | java.time.DateTimeException e) { throw invalid(); }
        }
        var found = rows(member, (unread ? " AND read_at IS NULL" : "") + after
                + " ORDER BY published_at DESC,id DESC LIMIT :limit", params);
        boolean more = found.size() > size;
        var shown = more ? found.subList(0, size) : found;
        Row last = shown.isEmpty() ? null : shown.getLast();
        String next = more ? tokens.sign(member, purpose, last.publishedAt() + "|" + last.id()) : null;
        return new Page(shown.stream().map(r -> notice(member, r)).toList(), next, more,
                tokens.sign(member, "read", Long.toString(nextSequence(member) - 1)));
    }
    private Notice notice(long member, Row row) {
        boolean available = destination(member, row.payload()) != null;
        String title = switch (row.type()) {
            case "achievement" -> "이 별의 탐사 등급이 올랐습니다";
            case "reopen" -> "STAR_BOARD".equals(json.readTree(row.payload()).path("targetKind").asText())
                    ? "팔로우한 별에 새 탐사 소식이 있습니다" : "이 별에 새로 찾을 수 있는 신호가 생겼습니다";
            case "comment" -> "내 글에 새 댓글이 달렸습니다";
            case "follow" -> "팔로우한 별에 새 글이 올라왔습니다";
            case "challenge" -> "새 챌린지가 시작되었습니다";
            case "relabel" -> "찾은 신호의 상태가 갱신되었습니다";
            default -> throw new IllegalStateException("저장된 알림 종류");
        };
        return new Notice("n-"+row.id(),row.type().toUpperCase(Locale.ROOT),row.publishedAt(),row.read(),available,
                available ? title : "", "");
    }
    @Transactional
    public Count count(long member) { lock(member); dispatchLocked(member); return unread(member); }
    private Count unread(long member) {
        return new Count(jdbc.sql("SELECT count(*) FROM notifications WHERE user_id=? AND published_at>? AND read_at IS NULL")
                .params(member,cutoff()).query(Long.class).single());
    }
    @Transactional
    public Read read(long member, long id) {
        lock(member);
        owned(member,id);
        jdbc.sql("UPDATE notifications SET read_at=coalesce(read_at,clock_timestamp()) WHERE id=? AND user_id=?")
                .params(id,member).update();
        return new Read("n-"+id,true);
    }
    @Transactional
    public Count readThrough(long member, String boundary) {
        long through;
        try { through=Long.parseLong(tokens.verify(member,"read",boundary)); }
        catch (NumberFormatException e) { throw invalid(); }
        if (through<0) throw invalid();
        lock(member);
        jdbc.sql("UPDATE notifications SET read_at=coalesce(read_at,clock_timestamp()) "
                        + "WHERE user_id=? AND published_at>? AND publication_seq<=?")
                .params(member,cutoff(),through).update();
        return unread(member);
    }
    @Transactional
    public Target target(long member,long id) {
        lock(member);
        var target=destination(member,owned(member,id).payload());
        return new Target("n-"+id,target!=null,target);
    }
    private Row owned(long member,long id) {
        return rows(member," AND id=:id",Map.of("id",id)).stream().findFirst()
                .orElseThrow(() -> new BusinessException(ErrorCode.RESOURCE_NOT_FOUND));
    }

    private Map<String,Object> destination(long member,String payload) {
        var p=json.readTree(payload);
        if (p.has("roundId")) {
            long round=p.get("roundId").asLong();
            if (!members.isTutorialCompleted(member) || !jdbc.sql("SELECT EXISTS(SELECT 1 FROM challenge_rounds WHERE id=? AND status IN ('active','closed'))")
                    .param(round).query(Boolean.class).single()) return null;
            return Map.of("kind","CHALLENGE","roundId","cr-"+round);
        }
        if (p.has("actorId") && !jdbc.sql("SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')")
                .param(p.get("actorId").asLong()).query(Boolean.class).single()) return null;
        if (p.has("postId")) {
            long post=p.get("postId").asLong();
            String kind=p.path("targetKind").asText();
            if (!Set.of("POST","THREAD").contains(kind)) return null;
            boolean visible=jdbc.sql("SELECT EXISTS(SELECT 1 FROM posts p LEFT JOIN users u ON u.id=p.user_id "
                            + "WHERE p.id=? AND p.status='visible' AND p.kind=? AND (p.user_id IS NULL OR u.status='active') "
                            + "AND (p.tic_id IS NULL OR " + StarBoardVisibility.OPEN.formatted("p.tic_id") + "))")
                    .params(post,kind.equals("POST")?"user":"system_thread").query(Boolean.class).single();
            if (!visible) return null;
            var target=new LinkedHashMap<String,Object>();
            target.put("kind",kind);
            target.put(kind.equals("POST")?"postId":"threadId",(kind.equals("POST")?"p-":"st-")+post);
            if (p.has("commentId")) {
                long comment=p.get("commentId").asLong();
                if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM comments c JOIN users u ON u.id=c.user_id "
                                + "WHERE c.id=? AND c.post_id=? AND c.status='visible' AND u.status='active')")
                        .params(comment,post).query(Boolean.class).single()) return null;
                target.put("commentId","c-"+comment);
                var preceding=jdbc.sql("SELECT c.id,c.created_at FROM comments c JOIN comments t ON t.id=? "
                                + "WHERE c.post_id=? AND c.status='visible' AND (c.created_at,c.id)>(t.created_at,t.id) "
                                + "ORDER BY c.created_at,c.id LIMIT 1").params(comment,post)
                        .query((r,n)->CommentCursor.after(kind.equals("POST")?"POST":"SIGNAL_THREAD",post,20,
                                r.getObject(2,OffsetDateTime.class).toInstant(),r.getLong(1)).encode()).optional();
                preceding.ifPresent(value->target.put("discussionCursor",value));
            }
            return target;
        }
        if (p.has("ticId")) {
            long tic=p.get("ticId").asLong();
            if ("STAR_BOARD".equals(p.path("targetKind").asText())) {
                if (!jdbc.sql("SELECT " + StarBoardVisibility.OPEN.formatted("?"))
                        .param(tic).query(Boolean.class).single()) return null;
                return Map.of("kind","STAR_BOARD","ticId",Long.toString(tic));
            }
            if (!jdbc.sql("SELECT EXISTS(SELECT 1 FROM star_unlocks WHERE user_id=? AND tic_id=?)")
                    .params(member,tic).query(Boolean.class).single()) return null;
            return Map.of("kind","STAR","ticId",Long.toString(tic));
        }
        return null;
    }
    private static BusinessException invalid() { return new BusinessException(ErrorCode.VALIDATION_FAILED); }
}
