package com.planetory.backend;

import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.context.ConfigurableApplicationContext;

import com.planetory.backend.domain.exploration.command.CandidateCorrectionPrecheckCommand;
import com.planetory.backend.domain.exploration.command.ChallengeUnlockCommand;

@SpringBootApplication
@ConfigurationPropertiesScan
public class PlanetoryApplication {

	/** 운영 명령 이름을 받는 속성. 예: {@code --planetory.command=challenge-unlock} */
	public static final String COMMAND_PROPERTY = "planetory.command";

	/** 실행할 수 있는 운영 명령. 명령을 추가하면 여기에 등록한다. */
	static final Set<String> COMMANDS = Set.of(ChallengeUnlockCommand.NAME,
			CandidateCorrectionPrecheckCommand.NAME);

	/** 실행할 수 없는 명령 인자. sysexits의 사용법 오류(EX_USAGE)와 같은 값이다. */
	static final int INVALID_COMMAND_EXIT_CODE = 64;

	private static final String COMMAND_ARGUMENT = "--" + COMMAND_PROPERTY + "=";

	public static void main(String[] args) {
		Optional<String> invalid = invalidCommand(args);
		if (invalid.isPresent()) {
			// 없는 명령은 실행할 빈이 없어 아무것도 하지 않고 0으로 끝난다. 자동화가 실패를 성공으로 보지 않도록
			// 스프링을 띄우기 전에 멈춘다. DB 접속·마이그레이션도 일어나지 않는다 [S15P21C206-139].
			System.err.println(invalid.get());
			System.exit(INVALID_COMMAND_EXIT_CODE);
			return;
		}
		ConfigurableApplicationContext context = application(args).run(args);
		if (isCommand(args)) {
			// 명령은 한 번 실행하고 끝난다. 종료 코드는 명령이 정한다.
			System.exit(SpringApplication.exit(context));
		}
	}

	/** 운영 명령이면 웹 서버를 띄우지 않는다. 서버가 떠 있는 호스트에서 실행해도 포트가 겹치지 않는다. */
	static SpringApplication application(String[] args) {
		SpringApplication application = new SpringApplication(PlanetoryApplication.class);
		if (isCommand(args)) {
			application.setWebApplicationType(WebApplicationType.NONE);
		}
		return application;
	}

	static boolean isCommand(String[] args) {
		return !commandValues(args).isEmpty();
	}

	/**
	 * 명령 인자를 실행할 수 없으면 그 이유. 명령 인자가 없거나 지원하는 명령 하나면 빈 값이다.
	 *
	 * <p>같은 인자를 두 번 주면 스프링이 두 값을 쉼표로 이어 붙여 어느 명령과도 맞지 않는다. 그래서
	 * 이것도 거절한다.
	 */
	static Optional<String> invalidCommand(String[] args) {
		List<String> values = commandValues(args);
		if (values.size() > 1) {
			return Optional.of("운영 명령은 하나만 줄 수 있습니다: " + values);
		}
		if (values.size() == 1 && !COMMANDS.contains(values.get(0))) {
			return Optional.of("알 수 없는 운영 명령입니다: '" + values.get(0) + "'. 사용할 수 있는 명령: "
					+ String.join(", ", new TreeSet<>(COMMANDS)));
		}
		return Optional.empty();
	}

	private static List<String> commandValues(String[] args) {
		return Arrays.stream(args)
				.filter(arg -> arg.startsWith(COMMAND_ARGUMENT))
				.map(arg -> arg.substring(COMMAND_ARGUMENT.length()))
				.toList();
	}

}
