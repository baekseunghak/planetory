package com.planetory.backend.domain.statistics.command;

import com.planetory.backend.PlanetoryApplication;
import com.planetory.backend.domain.statistics.service.StatisticsAggregationService;
import java.time.LocalDate;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.ExitCodeGenerator;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/** 외부 스케줄러가 전용 DB 역할로 실행한다. 웹 앱에 스케줄을 활성화하지 않는다. */
@Slf4j
@Component
@RequiredArgsConstructor
@ConditionalOnProperty(name = PlanetoryApplication.COMMAND_PROPERTY, havingValue = StatisticsCommand.NAME)
public class StatisticsCommand implements ApplicationRunner, ExitCodeGenerator {
    public static final String NAME = "statistics";
    private final StatisticsAggregationService aggregation;
    private final Environment environment;
    private int exitCode = 1;

    @Override
    public void run(ApplicationArguments arguments) {
        String mode = environment.getProperty("planetory.statistics.mode", "");
        String cutoff = environment.getProperty("planetory.statistics.cutoff");
        StatisticsAggregationService.Result result;
        if ("refresh".equals(mode) && cutoff == null) {
            result = aggregation.refresh();
        } else if ("snapshot".equals(mode)) {
            result = aggregation.snapshot(cutoff == null ? null : LocalDate.parse(cutoff));
        } else {
            throw new IllegalArgumentException("statistics mode는 refresh 또는 snapshot이며 cutoff는 snapshot에만 허용됩니다");
        }
        exitCode = switch (result) {
            case CREATED, ALREADY_EXISTS -> 0;
            case BUSY -> 2;
            case HISTORICAL_SOURCE_UNAVAILABLE, FUTURE_CUTOFF_NOT_ALLOWED -> 3;
        };
        log.info("통계 작업 {}: {}", mode, result);
    }

    @Override
    public int getExitCode() {
        return exitCode;
    }
}
