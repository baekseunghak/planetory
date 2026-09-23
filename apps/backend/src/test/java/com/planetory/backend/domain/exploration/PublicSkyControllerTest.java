package com.planetory.backend.domain.exploration;

import com.planetory.backend.domain.exploration.controller.PublicSkyController;
import com.planetory.backend.domain.exploration.service.PublicSkyService;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;
import com.planetory.backend.global.security.MemberPrincipal;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class PublicSkyControllerTest {
    @Test
    void 요청_숫자만_검증오류로_바꾸고_서비스_숫자오류는_전파한다() {
        var service = mock(PublicSkyService.class);
        var controller = new PublicSkyController(service);
        var principal = new MemberPrincipal(1);
        String[] valid = {"2", "0", "0", "512", "512", "1000"};
        for (int index = 0; index < valid.length; index++) {
            String[] args = valid.clone();
            args[index] = "invalid";
            var error = assertThrows(BusinessException.class, () -> controller.tiles(principal, "u-2",
                    args[0], args[1], args[2], args[3], args[4], "v1", args[5], null));
            assertEquals(ErrorCode.VALIDATION_FAILED, error.getErrorCode());
        }
        verifyNoInteractions(service);
        var internalError = new NumberFormatException("internal parsing");
        when(service.tiles(1, 2, 2, 0, 0, 512, 512, "v1", 1000, null)).thenThrow(internalError);
        assertSame(internalError, assertThrows(NumberFormatException.class,
                () -> controller.tiles(principal, "u-2", "2", "0", "0", "512", "512", "v1", "1000", null)));
    }
}
