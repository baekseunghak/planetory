package com.planetory.backend;

import java.util.Arrays;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;
import org.springframework.context.ConfigurableApplicationContext;

@SpringBootApplication
@ConfigurationPropertiesScan
public class PlanetoryApplication {

	/** 운영 명령 이름을 받는 속성. 예: {@code --planetory.command=challenge-unlock} */
	public static final String COMMAND_PROPERTY = "planetory.command";

	public static void main(String[] args) {
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
		return Arrays.stream(args).anyMatch(arg -> arg.startsWith("--" + COMMAND_PROPERTY + "="));
	}

}
