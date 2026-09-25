package com.planetory.backend;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
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
     * 읽기 전용 명령은 <b>기동 단계까지</b> 아무것도 바꾸지 않아야 한다. Flyway는 컨텍스트가 뜨는 중에
     * DDL을 실행하고 배포 compose가 마이그레이션 계정까지 넘기므로, 끄지 않으면 "영향만 세어 보는"
     * 실행이 미적용 migration을 적용한다. 메서드의 readOnly=true는 그보다 한참 뒤다 [154 리뷰].
     */
    @Test
    void 읽기_전용_명령은_기동할_때_마이그레이션을_실행하지_않는다() {
        String guard = "--spring.flyway.enabled=false";

        // 운영자가 옵션을 빼먹어도 붙는다. 명령줄 인자라 설정 파일보다 우선한다.
        assertTrue(List.of(PlanetoryApplication.withFlywayDisabledGuards(
                new String[]{"--planetory.command=candidate-correction-precheck"})).contains(guard));
        assertTrue(List.of(PlanetoryApplication.withFlywayDisabledGuards(new String[]{
                "--planetory.command=candidate-correction-precheck",
                "--planetory.correction.kind=merge"})).contains(guard), "다른 인자와 함께 줘도 붙는다");

        // 쓰기 명령과 평소 기동은 건드리지 않는다. 챌린지 명령은 마이그레이션이 필요할 수 있다.
        assertFalse(List.of(PlanetoryApplication.withFlywayDisabledGuards(
                new String[]{"--planetory.command=challenge-unlock"})).contains(guard));
        assertEquals(0, PlanetoryApplication.withFlywayDisabledGuards(new String[]{}).length);
        // 통계 잡 역할에는 DDL 권한을 주지 않는다. 통계 명령도 기동 migration을 강제로 막는다.
        assertTrue(List.of(PlanetoryApplication.withFlywayDisabledGuards(
                new String[]{"--planetory.command=statistics", "--planetory.statistics.mode=refresh"})).contains(guard));
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
        // 런처는 인자 파일을 시스템 기본 인코딩으로 읽는다. UTF-8로 쓰면 한글 경로가 깨진다.
        Path argFile = dir.resolve("classpath.args");
        Files.writeString(argFile, "-cp \"" + System.getProperty("java.class.path").replace('\\', '/') + "\"",
                Charset.forName(System.getProperty("native.encoding")));
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
