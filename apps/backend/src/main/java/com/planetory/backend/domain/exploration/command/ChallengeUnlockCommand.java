package com.planetory.backend.domain.exploration.command;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.ExitCodeGenerator;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import com.planetory.backend.PlanetoryApplication;
import com.planetory.backend.domain.exploration.service.TutorialProgressService;

/**
 * 챌린지 회차 별 일괄 발견 명령 (탐사 API 9.4절) [S15P21C206-139].
 *
 * <p>운영자가 회차를 DB에서 active로 바꾼 뒤 실행한다(OPS-07). 앱은 DB 직접 변경을 알 수 없어
 * 주기 실행 대신 전용 명령으로 둔다. 여러 번 실행해도 회원마다 한 번만 열린다. 실행 절차는
 * docs/operations/challenge-round-runbook.md를 따른다.
 *
 * <p>종료 코드: 0 처리 완료, 2 진행 회차 없음, 1 처리 중 오류. 명령 이름이 틀리면 이 빈이 뜨지 않으므로
 * {@link PlanetoryApplication}이 스프링을 띄우기 전에 64로 끝낸다.
 */
@Slf4j
@Component
@ConditionalOnProperty(name = PlanetoryApplication.COMMAND_PROPERTY, havingValue = ChallengeUnlockCommand.NAME)
@RequiredArgsConstructor
public class ChallengeUnlockCommand implements ApplicationRunner, ExitCodeGenerator {

    public static final String NAME = "challenge-unlock";

    /** 회차를 active로 바꾸지 않고 실행한 경우다. 아무것도 바꾸지 않는다. */
    public static final int NO_ACTIVE_ROUND = 2;

    private final TutorialProgressService tutorials;

    /** 끝까지 실행하기 전에는 실패로 둔다. 예외로 멈추면 기동 실패로 종료 코드 1이 된다. */
    private volatile int exitCode = 1;

    @Override
    public void run(ApplicationArguments args) {
        var result = tutorials.unlockActiveChallenge();
        if (result.isEmpty()) {
            log.error("진행 중인 챌린지 회차가 없어 아무 별도 열지 않았습니다. 회차를 active로 바꾼 뒤 다시 실행하세요.");
            exitCode = NO_ACTIVE_ROUND;
            return;
        }
        var done = result.get();
        log.info("챌린지 회차 {}(id {}) 대상 별 {}: 새로 연 회원 {}명, 건너뛴 회원 {}명",
                done.round().roundNo(), done.round().id(), done.round().targetTicIds(),
                done.opened(), done.skipped());
        exitCode = 0;
    }

    @Override
    public int getExitCode() {
        return exitCode;
    }
}
