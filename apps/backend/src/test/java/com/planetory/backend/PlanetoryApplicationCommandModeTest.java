package com.planetory.backend;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.WebApplicationType;

import static org.junit.jupiter.api.Assertions.*;

/** 운영 명령 인자에 따른 실행 방식 [S15P21C206-139]. 컨텍스트를 띄우지 않는다. */
class PlanetoryApplicationCommandModeTest {

    @Test
    void 운영_명령_인자가_있으면_웹_서버_없이_뜬다() {
        String[] args = {"--spring.profiles.active=prod", "--planetory.command=challenge-unlock"};

        assertTrue(PlanetoryApplication.isCommand(args));
        assertTrue(PlanetoryApplication.invalidCommand(args).isEmpty());
        assertEquals(WebApplicationType.NONE, PlanetoryApplication.application(args).getWebApplicationType());
    }

    /** 평소 기동은 그대로 서블릿 서버다. 비슷한 이름의 속성을 명령으로 오인하지 않는다. */
    @Test
    void 명령_인자가_없으면_서버로_뜬다() {
        String[] args = {"--planetory.sky.tile-size=512", "--planetory.commands=x"};

        assertFalse(PlanetoryApplication.isCommand(args));
        assertTrue(PlanetoryApplication.invalidCommand(args).isEmpty());
        assertEquals(WebApplicationType.SERVLET, PlanetoryApplication.application(args).getWebApplicationType());
    }

    /**
     * 오타·빈 값은 실행할 명령 빈이 없고, 같은 인자를 두 번 주면 스프링이 값을 이어 붙여 어느 명령과도
     * 맞지 않는다. 셋 다 아무것도 하지 않고 0으로 끝났으므로 실행 전에 거절한다(MR !65 리뷰).
     */
    @Test
    void 실행할_수_없는_명령_인자는_이유와_함께_거절한다() {
        String typo = PlanetoryApplication.invalidCommand(
                new String[]{"--planetory.command=challenge-unlok"}).orElseThrow();
        assertTrue(typo.contains("'challenge-unlok'") && typo.contains("challenge-unlock"), typo);

        assertTrue(PlanetoryApplication.invalidCommand(new String[]{"--planetory.command="}).isPresent());
        assertTrue(PlanetoryApplication.invalidCommand(
                new String[]{"--planetory.command=x", "--planetory.command=challenge-unlock"}).isPresent());
        assertTrue(PlanetoryApplication.invalidCommand(
                new String[]{"--planetory.command=challenge-unlock", "--planetory.command=challenge-unlock"}).isPresent());
    }

    /**
     * 실제 main을 별도 JVM으로 실행해 종료 코드를 본다. 운영 자동화는 이 값으로 성공을 판단한다.
     *
     * <p>검증이 빠지면 스프링이 뜬다. 닿을 수 없는 DB 주소를 줘 로컬 DB를 건드리지 않고 다른 종료 코드로
     * 실패하게 하고, 작업 디렉터리를 비워 개인 OAuth 설정도 읽지 않게 한다.
     */
    @Test
    void 알_수_없는_명령은_스프링을_띄우지_않고_64로_끝난다(@TempDir Path dir) throws Exception {
        // 윈도우 명령줄 길이 제한을 피하려고 클래스패스를 인자 파일로 넘긴다.
        Path argFile = dir.resolve("classpath.args");
        Files.writeString(argFile,
                "-cp \"" + System.getProperty("java.class.path").replace('\\', '/') + "\"", StandardCharsets.UTF_8);
        Path output = dir.resolve("output.log");
        Process process = new ProcessBuilder(
                Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8",
                "-DOAUTH_LOCAL_CONFIG=optional:classpath:/oauth-test-no-local.properties",
                "@" + argFile,
                PlanetoryApplication.class.getName(),
                "--planetory.command=challenge-unlok",
                "--spring.datasource.url=jdbc:postgresql://127.0.0.1:1/unreachable")
                .directory(dir.toFile())
                .redirectErrorStream(true)
                .redirectOutput(output.toFile())
                .start();

        assertTrue(process.waitFor(60, TimeUnit.SECONDS), "명령이 끝나지 않았다");
        String log = Files.readString(output, StandardCharsets.UTF_8);
        assertEquals(PlanetoryApplication.INVALID_COMMAND_EXIT_CODE, process.exitValue(), log);
        assertTrue(log.contains("'challenge-unlok'"), log);
        assertFalse(log.contains("Starting PlanetoryApplication"), "스프링을 띄우면 안 된다: " + log);
    }
}
