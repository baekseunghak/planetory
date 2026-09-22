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

	/**
	 * 아무것도 바꾸지 않는 명령. <b>기동 단계까지 읽기 전용이어야 한다.</b>
	 *
	 * <p>Flyway는 컨텍스트가 뜨는 중에 DDL을 실행하고, 배포 compose는 마이그레이션(소유자) 계정까지
	 * 넘긴다. 그래서 끄지 않으면 "영향만 세어 보는" 실행이 미적용 migration을 적용해 버린다.
	 * 메서드의 {@code readOnly = true}는 그보다 한참 뒤에야 걸린다 [S15P21C206-154 리뷰].
	 */
	static final Set<String> READ_ONLY_COMMANDS = Set.of(CandidateCorrectionPrecheckCommand.NAME);

	/** 실행할 수 없는 명령 인자. sysexits의 사용법 오류(EX_USAGE)와 같은 값이다. */
	static final int INVALID_COMMAND_EXIT_CODE = 64;

	/** 기동 중 마이그레이션 실행 여부를 정하는 속성. 읽기 전용 명령은 이것을 false로 강제한다. */
	static final String FLYWAY_ENABLED = "spring.flyway.enabled";

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
		String[] effective = withReadOnlyGuards(args);
		ConfigurableApplicationContext context = application(effective).run(effective);
		if (isCommand(effective)) {
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

	/**
	 * 읽기 전용 명령에 Flyway 비활성화를 <b>명령줄 인자로</b> 덧붙인다.
	 *
	 * <p>기본 속성(setDefaultProperties)은 우선순위가 가장 낮아 설정 파일 한 줄로 뒤집힌다. 명령줄
	 * 인자는 가장 높으므로 운영자가 옵션을 빼먹어도, 설정이 켜 두어도 마이그레이션이 돌지 않는다.
	 * 같은 키를 명시적으로 주면 스프링이 두 값을 이어 붙여 Boolean 바인딩이 실패하므로, 조용히
	 * 켜지는 경로가 없다 [S15P21C206-154 리뷰].
	 */
	static String[] withReadOnlyGuards(String[] args) {
		if (commandValues(args).stream().noneMatch(READ_ONLY_COMMANDS::contains)) {
			return args;
		}
		String[] guarded = Arrays.copyOf(args, args.length + 1);
		guarded[args.length] = "--" + FLYWAY_ENABLED + "=false";
		return guarded;
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
