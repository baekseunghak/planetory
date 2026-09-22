package com.planetory.backend.domain.auth;

import java.io.InputStreamReader;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.Properties;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ForwardedHeadersConfigurationTest {
    private static final String KEY = "server.forward-headers-strategy";

    @Test void commonConfigurationHasOneFrameworkStrategy() throws Exception {
        var properties = checkedProperties();
        try (var stream = getClass().getResourceAsStream("/application.properties")) {
            assertNotNull(stream);
            properties.load(new InputStreamReader(stream, StandardCharsets.UTF_8));
        }
        assertEquals("framework", properties.getProperty(KEY));
    }

    @Test void checkedPropertiesRejectsDuplicateStrategyRegardlessOfOrderOrValue() {
        for (String values : new String[]{"framework,none", "none,framework", "none,none", "framework,framework"}) {
            var pair = values.split(",");
            assertThrows(IllegalArgumentException.class, () -> checkedProperties().load(
                    new StringReader(KEY + "=" + pair[0] + "\n" + KEY + ": " + pair[1])));
        }
    }

    private static Properties checkedProperties() {
        return new Properties() {
            @Override public synchronized Object put(Object key, Object value) {
                if (KEY.equals(key) && containsKey(key)) {
                    throw new IllegalArgumentException("Duplicate " + KEY);
                }
                return super.put(key, value);
            }
        };
    }
}
