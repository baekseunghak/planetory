package com.planetory.backend.domain.auth;

import com.planetory.backend.domain.auth.service.AuthSessionService;
import com.planetory.backend.global.security.RedisSessions;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.web.server.autoconfigure.ServerProperties;
import org.springframework.core.ResolvableType;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.mock.web.MockHttpSession;
import static org.junit.jupiter.api.Assertions.*;

class AuthSessionTimeoutTest {
    @Test void unitlessAndExplicitTimeoutsMatchBootSecondsAndExpiryBoundary() {
        for (String value : new String[]{"1800", "30m", "PT30M"}) {
            var env = new MockEnvironment().withProperty("server.servlet.session.timeout", value);
            var bootTimeout = Binder.get(env).bind("server", Bindable.of(ServerProperties.class))
                    .get().getServlet().getSession().getTimeout();
            assertEquals(Duration.ofMinutes(30), bootTimeout, value);
            var sessions = new AuthSessionService(Clock.systemUTC(), new DefaultListableBeanFactory()
                    .getBeanProvider(ResolvableType.forClass(RedisSessions.class)), env);
            var session = new MockHttpSession();
            var last = Instant.parse("2026-09-22T00:00:00Z");
            session.setAttribute(RedisSessions.LAST_ACTIVITY, last);
            assertFalse(sessions.isExpired(session, last.plus(bootTimeout).minusNanos(1)), value);
            assertTrue(sessions.isExpired(session, last.plus(bootTimeout)), value);
        }
    }
}
