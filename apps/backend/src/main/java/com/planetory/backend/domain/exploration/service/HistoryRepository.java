package com.planetory.backend.domain.exploration.service;

import com.planetory.backend.domain.PublicAnalysisVisibility;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@Repository
@RequiredArgsConstructor
public class HistoryRepository {
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private final JdbcClient jdbc;
    record Row(long id, long member, long tic, long bundle, OffsetDateTime createdAt, JsonNode submission,
               JsonNode params, JsonNode versions, Long currentBundle, HistoryViews.Publication publication,
               boolean granted, boolean snapshotAvailable, boolean detailAvailable, AchievementViews.Relabel relabel) {
        String historyId() { return "h-"+id; }
        long submissionId() { return submission.path("id").asLong(); }
        OffsetDateTime submittedAt() { return OffsetDateTime.parse(submission.path("created_at").asText()); }
        boolean previous() { return currentBundle == null || currentBundle != bundle; }
    }
    private static final String FROM = """
            FROM analysis_histories h JOIN submissions s ON s.id=h.submission_id
            LEFT JOIN publication_bundles b ON b.tic_id=h.tic_id AND b.status='current'
            LEFT JOIN user_candidate_achievements a ON a.user_id=h.user_id AND a.candidate_id=s.matched_candidate_id
            LEFT JOIN published_analyses pa ON pa.history_id=h.id
            LEFT JOIN posts p ON p.id=pa.post_id
            """;
    private static String select(boolean detail) {
        return """
            SELECT h.id,h.user_id,h.tic_id,s.bundle_id,h.created_at,
            %s AS submission,h.snapshot_params::text,h.versions::text,b.id AS current_bundle,
            pa.id AS public_analysis, COALESCE(%s,false) AS is_public,
            COALESCE(pa.hidden_at IS NOT NULL OR p.status='hidden',false) AS is_hidden,
            a.id IS NOT NULL AS granted,a.relabeled_at,a.relabel_disposition,
            EXISTS(SELECT 1 FROM analysis_snapshots sn WHERE sn.history_id=h.id) AS snapshot_available,
            s.response_snapshot IS NOT NULL AS detail_available
            """.formatted(detail ? "(to_jsonb(s)-'request_hash')::text" : "(to_jsonb(s)-'request_hash'-'response_snapshot')::text",
                    PublicAnalysisVisibility.VISIBLE) + FROM;
    }
    List<Row> list(HistoryQuery q) {
        // submissions(user_id,tic_id,created_at) 인덱스도 사용할 수 있도록 양쪽 소유자를 제한한다.
        StringBuilder sql = new StringBuilder(select(false)).append(" WHERE h.user_id=:member AND s.user_id=:member");
        var params = new java.util.HashMap<String,Object>();
        params.put("member",q.member()); params.put("limit",q.size()+1);
        if (q.tic()!=null) { sql.append(" AND h.tic_id=:tic AND s.tic_id=:tic"); params.put("tic",q.tic()); }
        if (q.candidate()!=null) { sql.append(" AND s.matched_candidate_id=:candidate"); params.put("candidate",q.candidate()); }
        if (q.result().equals("matched")) sql.append(" AND s.match_result IN ('matched','matched_harmonic','duplicate')");
        else if (!q.result().isEmpty()) { sql.append(" AND s.match_result=:result"); params.put("result",q.result()); }
        if (q.from()!=null) { sql.append(" AND s.created_at>=:from"); params.put("from",q.from()); }
        if (q.to()!=null) { sql.append(" AND s.created_at<:to"); params.put("to",q.to()); }
        if (q.afterId()!=null) { sql.append(" AND (s.created_at,s.id)<(:at,:id)"); params.put("at",q.afterAt()); params.put("id",q.afterId()); }
        return jdbc.sql(sql.append(" ORDER BY s.created_at DESC,s.id DESC LIMIT :limit").toString())
                .params(params).query(this::row).list();
    }
    Optional<Row> find(long id) { return jdbc.sql(select(true)+" WHERE h.id=?").param(id).query(this::row).optional(); }
    Optional<HistoryViews.Snapshot> snapshot(long id) {
        return jdbc.sql("SELECT bins,folded_flux,folded_err FROM analysis_snapshots WHERE history_id=?").param(id)
                .query((r,n)->new HistoryViews.Snapshot(r.getInt(1),(Float[])r.getArray(2).getArray(),(Float[])r.getArray(3).getArray())).optional();
    }
    /** 그래프 구성 뒤 새 DB 스냅샷에서 판 전환을 확인한다. */
    boolean stillCurrent(long tic, long bundle) {
        return jdbc.sql("SELECT EXISTS(SELECT 1 FROM publication_bundles WHERE id=? AND tic_id=? AND status='current')")
                .params(bundle,tic).query(Boolean.class).single();
    }
    private Row row(ResultSet r, int n) throws SQLException {
        Long publicId = r.getObject("public_analysis",Long.class);
        OffsetDateTime relabeled = r.getObject("relabeled_at",OffsetDateTime.class);
        return new Row(r.getLong("id"),r.getLong("user_id"),r.getLong("tic_id"),r.getLong("bundle_id"),
                r.getObject("created_at",OffsetDateTime.class),JSON.readTree(r.getString("submission")),
                JSON.readTree(r.getString("snapshot_params")),JSON.readTree(r.getString("versions")),
                r.getObject("current_bundle",Long.class),new HistoryViews.Publication(publicId==null?null:ExplorationIds.publicAnalysis(publicId),
                r.getBoolean("is_public"),r.getBoolean("is_hidden")),r.getBoolean("granted"),r.getBoolean("snapshot_available"),r.getBoolean("detail_available"),
                relabeled==null?null:new AchievementViews.Relabel(relabeled,AchievementRepository.apiDisposition(r.getString("relabel_disposition"))));
    }
}
