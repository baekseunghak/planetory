package com.planetory.backend.domain.gold;

import java.util.LinkedHashSet;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.ApplicationArguments;
import org.springframework.jdbc.core.simple.JdbcClient;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.mockito.Mockito.*;

class GoldCatalogRepositoryStartupTest {
    @Test
    @SuppressWarnings("unchecked")
    void failedPreloadDoesNotStopStartupOrOtherSelectedStars() {
        GoldReadCache cache = mock(GoldReadCache.class);
        when(cache.selectedTics()).thenReturn(new LinkedHashSet<>(List.of(1L, 2L)));
        when(cache.available()).thenReturn(true);
        ObjectProvider<GoldReadCache> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(cache);
        GoldCatalogRepository repository = spy(new GoldCatalogRepository(mock(JdbcClient.class), provider));
        doThrow(new IllegalStateException("invalid Gold fixture")).when(repository).preloadSelectedTic(1L);
        doNothing().when(repository).preloadSelectedTic(2L);

        assertDoesNotThrow(() -> repository.run(mock(ApplicationArguments.class)));
        verify(repository).preloadSelectedTic(2L);
    }
}
