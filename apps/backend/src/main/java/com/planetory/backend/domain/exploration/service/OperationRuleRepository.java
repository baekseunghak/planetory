package com.planetory.backend.domain.exploration.service;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.PropertyNamingStrategies;
import tools.jackson.databind.json.JsonMapper;

/**
 * 운영 규칙 읽기 [S15P21C206-151].
 *
 * <p>앱은 읽기만 한다(V5 권한). 새 버전은 운영자가 런북 절차대로 SQL로 넣고, 잘못된 값은 DB가 저장
 * 순간 거절한다(V9). 그래서 여기서 값의 범위를 다시 검사하지 않는다. 다만 이 앱이 모르는 형식의 행을
 * 조용히 잘못 해석하지 않도록 형식 번호는 확인한다.
 */
@Repository
@RequiredArgsConstructor
public class OperationRuleRepository {

    /** 이 앱이 해석할 수 있는 {@code values} 형식. */
    static final int FORMAT_VERSION = 1;

    /** DB JSON 전용 매퍼. HTTP 직렬화 설정이 바뀌어도 규칙 해석이 흔들리면 안 된다. */
    private static final JsonMapper JSON = JsonMapper.builder()
            .propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
            .build();

    private final JdbcClient jdbc;

    /**
     * 현재 규칙: 지금 이전에 적용된 버전 중 {@code applied_at}이 가장 늦은 것.
     *
     * <p>적용 시각을 미래로 넣은 버전은 그 시각이 되기 전까지 현재가 아니다. 같은 적용 시각은 DB가
     * 막는다(V9 {@code uq_operation_settings_applied_at}).
     */
    public Optional<OperationRule> findCurrent() {
        return jdbc.sql("""
                        SELECT rule_version, "values", applied_at
                          FROM operation_settings
                         WHERE applied_at <= now()
                         ORDER BY applied_at DESC
                         LIMIT 1
                        """)
                .query(this::toRule)
                .optional();
    }

    /** 이 버전의 규칙. 제출이 저장한 버전으로 과거 판정을 되살릴 때 쓴다. */
    public Optional<OperationRule> find(String ruleVersion) {
        return jdbc.sql("""
                        SELECT rule_version, "values", applied_at
                          FROM operation_settings
                         WHERE rule_version = ?
                        """)
                .param(ruleVersion)
                .query(this::toRule)
                .optional();
    }

    private OperationRule toRule(ResultSet rs, int rowNum) throws SQLException {
        String ruleVersion = rs.getString("rule_version");
        JsonNode values = JSON.readTree(rs.getString("values"));
        JsonNode format = values.get("format_version");
        if (format == null || !format.isInt() || format.intValue() != FORMAT_VERSION) {
            throw new IllegalStateException("운영 규칙 " + ruleVersion + "의 형식(" + format
                    + ")을 이 앱은 읽을 수 없습니다. 읽을 수 있는 형식은 " + FORMAT_VERSION + "입니다.");
        }
        return new OperationRule(ruleVersion, rs.getObject("applied_at", OffsetDateTime.class),
                section(values, "selection", OperationRule.Selection.class),
                section(values, "matching", OperationRule.Matching.class),
                section(values, "peaks", OperationRule.Peaks.class),
                section(values, "discovery", OperationRule.Discovery.class),
                section(values, "tutorial", OperationRule.Tutorial.class),
                section(values, "ai", OperationRule.Ai.class));
    }

    private static <T> T section(JsonNode values, String name, Class<T> type) {
        return JSON.treeToValue(values.get(name), type);
    }
}
