package com.planetory.backend.domain.gold;

import com.planetory.backend.global.security.RedisSessionConfig;
import org.junit.jupiter.api.Test;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.jdbc.core.simple.JdbcClient;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

class GoldReadCacheConfigurationTest {
    @Test
    void commandModeSkipsGoldCacheEvenWhenEnabled() {
        new ApplicationContextRunner()
                .withUserConfiguration(RedisSessionConfig.class, GoldReadCache.class,
                        GoldCatalogRepository.class)
                .withBean(JdbcClient.class, () -> mock(JdbcClient.class))
                .withPropertyValues("planetory.gold.cache.enabled=true")
                .run(context -> {
                    assertTrue(context.getStartupFailure() == null);
                    assertFalse(context.containsBean("goldReadCache"));
                    assertTrue(context.containsBean("goldCatalogRepository"));
                    assertDoesNotThrow(() -> context.getBean(GoldCatalogRepository.class)
                            .run(new DefaultApplicationArguments(new String[0])));
                });
    }

    @Test
    void webModeWithoutSessionRedisSkipsGoldCache() {
        new WebApplicationContextRunner()
                .withUserConfiguration(RedisSessionConfig.class, GoldReadCache.class)
                .withPropertyValues("planetory.gold.cache.enabled=true",
                        "planetory.session.redis.enabled=false")
                .run(context -> {
                    assertTrue(context.getStartupFailure() == null);
                    assertFalse(context.containsBean("goldReadCache"));
                });
    }
}
