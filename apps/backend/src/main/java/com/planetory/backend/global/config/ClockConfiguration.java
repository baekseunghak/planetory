package com.planetory.backend.global.config;

import java.time.Clock;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 시간을 주입 가능한 협력자로 둔다.
 * 세션 만료·챌린지 회차처럼 시간에 의존하는 로직은 테스트에서 {@code Clock.fixed(...)}로 대체해 검증한다.
 */
@Configuration
public class ClockConfiguration {

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }
}
