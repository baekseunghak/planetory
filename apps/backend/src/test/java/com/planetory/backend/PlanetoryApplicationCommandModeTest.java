package com.planetory.backend;

import org.junit.jupiter.api.Test;
import org.springframework.boot.WebApplicationType;

import static org.junit.jupiter.api.Assertions.*;

/** 운영 명령 인자에 따른 실행 방식 [S15P21C206-139]. 컨텍스트를 띄우지 않는다. */
class PlanetoryApplicationCommandModeTest {

    @Test
    void 운영_명령_인자가_있으면_웹_서버_없이_뜬다() {
        String[] args = {"--spring.profiles.active=prod", "--planetory.command=challenge-unlock"};

        assertTrue(PlanetoryApplication.isCommand(args));
        assertEquals(WebApplicationType.NONE, PlanetoryApplication.application(args).getWebApplicationType());
    }

    /** 평소 기동은 그대로 서블릿 서버다. 비슷한 이름의 속성을 명령으로 오인하지 않는다. */
    @Test
    void 명령_인자가_없으면_서버로_뜬다() {
        String[] args = {"--planetory.sky.tile-size=512", "--planetory.commands=x"};

        assertFalse(PlanetoryApplication.isCommand(args));
        assertEquals(WebApplicationType.SERVLET, PlanetoryApplication.application(args).getWebApplicationType());
    }
}
