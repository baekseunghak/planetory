package com.planetory.backend.domain.gold;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.planetory.backend.domain.gold.GoldCatalogViews.Bundle;
import com.planetory.backend.domain.gold.GoldCatalogViews.LightCurveSegment;
import com.planetory.backend.domain.gold.GoldCatalogViews.Periodogram;
import java.time.Duration;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

/** 운영자가 고른 별의 Gold 배열을 cache Redis에 보관한다. PostgreSQL이 정본이다. */
@Component
@ConditionalOnProperty(name = "planetory.gold.cache.enabled", havingValue = "true")
public class GoldReadCache {
    private static final Logger log = LoggerFactory.getLogger(GoldReadCache.class);
    private static final Duration TTL = Duration.ofDays(1);
    private static final long RETRY_NANOS = TimeUnit.SECONDS.toNanos(2);
    private final StringRedisTemplate redis;
    private final ObjectMapper json = new ObjectMapper();
    private final Set<Long> selectedTics;
    private volatile long retryAt;

    public GoldReadCache(@Qualifier("goldCacheRedisTemplate") StringRedisTemplate redis,
                         @Value("${planetory.gold.cache.tic-ids:}") String ticIds) {
        this.redis = redis;
        this.selectedTics = ticIds.isBlank() ? Set.of() : List.of(ticIds.split(",")).stream()
                .map(String::trim).map(Long::parseLong).collect(Collectors.toUnmodifiableSet());
        if (selectedTics.stream().anyMatch(id -> id <= 0)) {
            throw new IllegalArgumentException("GOLD_CACHE_TIC_IDS에는 양의 TIC ID만 지정합니다");
        }
    }

    public Set<Long> selectedTics() {
        return selectedTics;
    }

    public boolean selected(long ticId) {
        return selectedTics.contains(ticId);
    }

    public boolean available() {
        return retryAt == 0 || System.nanoTime() - retryAt >= 0;
    }

    public void warm(Bundle bundle, List<LightCurveSegment> segments, Periodogram periodogram) {
        if (!selected(bundle.ticId())) return;
        put(segmentKey(bundle.manifest().segmentIds()), segments);
        put(periodogramKey(bundle.id()), periodogram);
        log.info("Gold Redis 사전 적재 시도: TIC {}, 판 {}, 곡선 {}개", bundle.ticId(), bundle.id(), segments.size());
    }

    public List<LightCurveSegment> segments(Collection<Long> ids) {
        String value = get(segmentKey(ids));
        if (value == null) return null;
        try {
            return json.readValue(value, json.getTypeFactory().constructCollectionType(List.class, LightCurveSegment.class));
        } catch (JsonProcessingException ex) {
            log.warn("Gold 곡선 캐시 해석 실패", ex);
            return null;
        }
    }

    public Periodogram periodogram(long bundleId) {
        String value = get(periodogramKey(bundleId));
        if (value == null) return null;
        try {
            return json.readValue(value, Periodogram.class);
        } catch (JsonProcessingException ex) {
            log.warn("Gold 주기도 캐시 해석 실패", ex);
            return null;
        }
    }

    public void refillSegments(Collection<Long> ids, List<LightCurveSegment> segments) {
        if (!segments.isEmpty() && segments.size() == ids.size()
                && selected(segments.getFirst().ticId())
                && segments.stream().allMatch(segment -> segment.ticId() == segments.getFirst().ticId())) {
            put(segmentKey(ids), segments);
        }
    }

    public void refillPeriodogram(long bundleId, Periodogram periodogram) {
        put(periodogramKey(bundleId), periodogram);
    }

    private String get(String key) {
        if (!available()) return null;
        try {
            return redis.opsForValue().get(key);
        } catch (DataAccessException ex) {
            retryAt = System.nanoTime() + RETRY_NANOS;
            log.warn("Gold Redis 조회 실패, PostgreSQL로 조회합니다", ex);
            return null;
        }
    }

    private void put(String key, Object value) {
        if (!available()) return;
        try {
            redis.opsForValue().set(key, json.writeValueAsString(value), TTL);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Gold Redis 직렬화 실패", ex);
        } catch (DataAccessException ex) {
            retryAt = System.nanoTime() + RETRY_NANOS;
            log.warn("Gold Redis 적재 실패, PostgreSQL 조회를 유지합니다", ex);
        }
    }

    static String segmentKey(Collection<Long> ids) {
        return "planetory:gold:v1:segments:" + ids.stream().sorted()
                .map(String::valueOf).collect(Collectors.joining("-"));
    }

    static String periodogramKey(long bundleId) {
        return "planetory:gold:v1:bundle" + bundleId + ":periodogram";
    }
}
