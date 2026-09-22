package com.planetory.backend.global.security;

import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.session.MapSession;
import org.springframework.session.SessionRepository;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class SessionDependencyFilterTest {
    @Test void unrelatedDatabaseFailureIsNotRelabeledAsSessionFailure() {
        var failure = new DataAccessResourceFailureException("database probe");
        var filter = new SessionDependencyFilter(mock(SecurityErrorWriter.class));
        assertSame(failure, assertThrows(DataAccessResourceFailureException.class, () ->
                filter.doFilter(new MockHttpServletRequest(), new MockHttpServletResponse(),
                        (request, response) -> { throw failure; })));
    }

    @Test void saveFailureOfAnExistingSessionIsNotSilentlyIgnored() {
        @SuppressWarnings("unchecked")
        SessionRepository<MapSession> delegate = mock(SessionRepository.class);
        var session = new MapSession();
        var failure = new IllegalStateException("unexpected storage failure");
        when(delegate.findById(session.getId())).thenReturn(session);
        doThrow(failure).when(delegate).save(session);
        assertSame(failure, assertThrows(IllegalStateException.class, () -> new RedisSessions<>(delegate).save(session)));
    }
}
