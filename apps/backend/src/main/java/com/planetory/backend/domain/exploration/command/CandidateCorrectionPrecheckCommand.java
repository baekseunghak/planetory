package com.planetory.backend.domain.exploration.command;

import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.ExitCodeGenerator;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import com.planetory.backend.PlanetoryApplication;
import com.planetory.backend.domain.exploration.command.CorrectionViews.CandidateImpact;
import com.planetory.backend.domain.exploration.command.CorrectionViews.Kind;
import com.planetory.backend.domain.exploration.command.CorrectionViews.Precheck;

/**
 * 후보 정정 영향 사전검사 명령 [S15P21C206-154].
 *
 * <p>계약(docs/architecture/candidate-correction-contract.md) 5.2절의 dry-run이며 <b>아무것도
 * 바꾸지 않는다.</b> 계약 4장의 미확정 항목(C18-Q1~Q6)이 승인되기 전에는 적용·복구 경로를 만들지
 * 않는다는 티켓 차단 조건에 따라, C19에서 지금 쓸 수 있는 것은 이 명령뿐이다.
 *
 * <p>읽기만 하므로 앱 역할의 권한을 넓히지 않는다. Gold 변경 이력 쓰기는 배치·운영 역할이 맡는다.
 *
 * <p>실행 예: {@code --planetory.command=candidate-correction-precheck
 * --planetory.correction.kind=merge --planetory.correction.candidates=101,102
 * --planetory.correction.keep=101}
 *
 * <p>기동 단계도 읽기 전용이다. {@link PlanetoryApplication}이 이 명령에 한해 Flyway를 꺼서
 * 미적용 migration이 검사 도중 적용되는 일을 막는다. 그 대신 스키마가 최신이 아니면 무엇이 없는지
 * 알리고 69로 끝낸다.
 *
 * <p>종료 코드: 0 회원 영향 없음, 2 사전 거절, 3 회원 영향 있어 Gold 쪽만 적용 가능,
 * 64 인자 오류, 69 스키마 미비, 1 처리 중 오류.
 * 절차는 docs/operations/candidate-correction-runbook.md를 따른다.
 */
@Slf4j
@Component
@ConditionalOnProperty(name = PlanetoryApplication.COMMAND_PROPERTY,
        havingValue = CandidateCorrectionPrecheckCommand.NAME)
@RequiredArgsConstructor
public class CandidateCorrectionPrecheckCommand implements ApplicationRunner, ExitCodeGenerator {

    public static final String NAME = "candidate-correction-precheck";

    /** 계약 3.4의 사전 거절이다. 실행하지 않는다. */
    public static final int REJECTED = 2;

    /** 회원 데이터가 걸려 있다. 계약 3.2의 기본값인 보존으로만 진행할 수 있다. */
    public static final int NEEDS_MEMBER_APPROVAL = 3;

    /** 인자를 읽을 수 없다. sysexits의 사용법 오류와 같은 값이다. */
    public static final int INVALID_ARGUMENTS = 64;

    /** 조회에 필요한 테이블이 없다. Flyway를 끄고 뜨므로 이 명령이 스키마를 만들지 않는다. */
    public static final int SCHEMA_NOT_READY = 69;

    static final String KIND = "planetory.correction.kind";
    static final String CANDIDATES = "planetory.correction.candidates";
    static final String KEEP = "planetory.correction.keep";

    private final CandidateCorrectionPrecheck precheck;

    /** 끝까지 실행하기 전에는 실패로 둔다. 예외로 멈추면 기동 실패로 종료 코드 1이 된다. */
    private volatile int exitCode = 1;

    @Override
    public void run(ApplicationArguments args) {
        Request request;
        try {
            request = Request.parse(args);
        } catch (IllegalArgumentException invalid) {
            log.error("{}", invalid.getMessage());
            exitCode = INVALID_ARGUMENTS;
            return;
        }

        List<String> missing = precheck.missingTables();
        if (!missing.isEmpty()) {
            log.error("조회에 필요한 테이블이 없습니다: {}. 이 명령은 스키마를 만들지 않습니다. "
                    + "마이그레이션을 따로 적용한 뒤 다시 실행하세요.", missing);
            exitCode = SCHEMA_NOT_READY;
            return;
        }

        Precheck result = precheck.check(request.kind(), request.candidateIds(), request.keepId());
        report(result);

        if (result.rejected()) {
            exitCode = REJECTED;
        } else if (result.needsMemberApproval()) {
            exitCode = NEEDS_MEMBER_APPROVAL;
        } else {
            exitCode = 0;
        }
    }

    /**
     * 계약 5.2절이 요구한 "변경 전후 목록"이다. 회원 쪽은 v1에서 바뀌지 않으므로 전후가 같고,
     * 그 사실을 적는 것이 이 보고의 핵심이다.
     */
    private void report(Precheck result) {
        log.info("후보 정정 사전검사: {} 대상 {} 대표 {}", result.kind(), result.candidateIds(), result.keepId());
        for (CandidateImpact impact : result.impacts()) {
            log.info("  후보 {} (TIC {}, {}): 성과 {}건, 성과로 연 별 기록 {}건, 공개 분석 {}건(유효 {}), "
                            + "공식 스레드 {}개, 매칭 제출 {}건",
                    impact.candidateId(), impact.ticId(), impact.status(), impact.achievements(),
                    impact.unlockedStars(), impact.publishedAnalyses(), impact.activePublishedAnalyses(),
                    impact.officialThreads(), impact.submissions());
        }
        if (result.kind() == Kind.MERGE) {
            log.info("  병합 대상 둘 이상에 성과를 가진 회원: {}명", result.conflictingMembers());
        }

        log.info("  별 기록 건수는 회원별 기록 수이며 고유 TIC 수가 아닙니다.");
        result.rejections().forEach(reason -> log.error("  거절: {}", reason));
        result.approvals().forEach(reason -> log.warn("  승인 필요: {}", reason));

        if (result.rejected()) {
            log.error("사전 거절입니다. 적용하지 않습니다.");
            return;
        }
        // 어느 쪽으로 끝나든 회원 데이터는 그대로다. 계약 6장의 "아직 할 수 없는 것" 1번이다.
        log.info("적용하면 바뀌는 것: 대상 후보의 status와 candidate_status_history 기록.");
        log.info("바뀌지 않는 것: 성과, 성과로 연 별, 공개 분석, 공식 스레드, 히스토리, 제출, 통계 스냅샷.");
        log.info("아직 실행하지 않는 것: 별칭·외부 참조·disposition 이동과 분리 산물 추가"
                + "(복구 절차 미확정, 계약 5.4).");
        if (result.needsMemberApproval()) {
            log.warn("회원 데이터가 걸려 있어 Gold 쪽만 적용할 수 있습니다. "
                    + "회원 쪽 정정은 계약 4장 승인 뒤에만 가능하며 v1에는 경로가 없습니다.");
        }
    }

    @Override
    public int getExitCode() {
        return exitCode;
    }

    /**
     * 명령 인자. 후보 id를 숫자로만 받고 중복과 빈 값을 거절한다. 대상을 잘못 주면 세는 대상이
     * 조용히 달라지므로 실행 전에 막는다.
     */
    record Request(Kind kind, List<Long> candidateIds, Long keepId) {

        static Request parse(ApplicationArguments args) {
            Kind kind = Kind.of(single(args, KIND).orElseThrow(
                    () -> new IllegalArgumentException("--" + KIND + "=merge|split 가 필요합니다.")));
            if (kind == null) {
                throw new IllegalArgumentException("--" + KIND + " 는 merge 또는 split 입니다.");
            }
            List<Long> candidates = ids(single(args, CANDIDATES).orElseThrow(
                    () -> new IllegalArgumentException("--" + CANDIDATES + "=<id>,<id> 가 필요합니다.")));
            Long keep = single(args, KEEP).map(Request::singleId).orElse(null);
            return new Request(kind, candidates, keep);
        }

        /** 같은 인자를 두 번 주면 스프링이 값을 이어 붙여 조용히 다른 대상이 된다. 그래서 거절한다. */
        private static Optional<String> single(ApplicationArguments args, String name) {
            List<String> values = args.getOptionValues(name);
            if (values == null || values.isEmpty()) {
                return Optional.empty();
            }
            if (values.size() > 1) {
                throw new IllegalArgumentException("--" + name + " 는 하나만 줄 수 있습니다: " + values);
            }
            return Optional.of(values.get(0));
        }

        /** 대표 후보는 정확히 하나다. 둘을 주면 앞의 것을 조용히 고르지 않고 거절한다. */
        private static Long singleId(String value) {
            List<Long> parsed = ids(value);
            if (parsed.size() != 1) {
                throw new IllegalArgumentException("--" + KEEP + " 는 후보 id 하나여야 합니다: " + parsed);
            }
            return parsed.get(0);
        }

        private static List<Long> ids(String value) {
            List<Long> parsed = java.util.Arrays.stream(value.split(","))
                    .map(String::strip)
                    .filter(part -> !part.isEmpty())
                    .map(part -> {
                        try {
                            return Long.parseLong(part);
                        } catch (NumberFormatException notANumber) {
                            throw new IllegalArgumentException("후보 id가 숫자가 아닙니다: '" + part + "'");
                        }
                    })
                    .toList();
            if (parsed.isEmpty()) {
                throw new IllegalArgumentException("후보 id가 비어 있습니다: '" + value + "'");
            }
            if (parsed.stream().distinct().count() != parsed.size()) {
                throw new IllegalArgumentException("후보 id가 중복됩니다: " + parsed);
            }
            return parsed;
        }
    }
}
