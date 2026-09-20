package com.planetory.backend.domain.exploration.service;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.OptionalLong;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import com.planetory.backend.domain.exploration.service.AchievementViews.AchievementItem;
import com.planetory.backend.domain.exploration.service.AchievementViews.AchievementList;
import com.planetory.backend.domain.exploration.service.StarDiscoveryService.AchievementTrigger;
import com.planetory.backend.domain.exploration.service.StarDiscoveryService.DiscoveredStar;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

/**
 * 신호별 성과 인정·등급·새 별 발견 (탐사 API 9.1·9.2절) [S15P21C206-144].
 *
 * <p>성과 인정은 HTTP가 아니라 서비스 계층 함수다. 제출(6.3절)과 서비스 API의 공개 등록·일괄 공개가
 * 같은 함수를 호출자 트랜잭션 안에서 부른다. 그래서 여러 신호를 한꺼번에 공개해도 순서대로 하나씩
 * 인정한 것과 결과가 같다(COM-19, AT-107).
 */
@Service
@RequiredArgsConstructor
public class AchievementService {

    /** 이 앱이 따르는 시드 정책. 운영 규칙 {@code discovery.seed_policy}와 같아야 한다. */
    static final String SEED_POLICY = "hash-user-achievement-seq-v1";

    /** 목록 기본 크기와 상한(9.1절). 상한은 4.4절 목록과 같다. */
    static final int DEFAULT_LIST_SIZE = 50;
    static final int MAX_LIST_SIZE = 100;

    private final AchievementRepository achievements;
    private final StarRepository stars;
    private final OperationRuleRepository rules;
    private final StarDiscoveryService discovery;
    private final ExplorationSummaryService summaries;
    private final SkyService sky;

    /** 성과 유형. {@code user_candidate_achievements.achievement_type} 값이다. 등급에는 유형 구분이 없다. */
    public enum AchievementType {
        CONFIRMED("confirmed"),
        UNCONFIRMED("unconfirmed"),
        FP("fp");

        private final String column;

        AchievementType(String column) {
            this.column = column;
        }
    }

    /**
     * 성과 인정 결과(9.2절 반환값).
     *
     * @param star            이 별의 처리 후 누적 성과. 4.2절 별 상세와 같은 계산이다(6.4절 {@code achievement.star})
     * @param unlockedStars   이번에 새로 연 별. 성과 순번 순서다
     * @param unlockShortfall 못 찾은 별이 모자라 열지 못한 수(D-11). 성과 인정은 그대로다
     * @param skyVersion      처리 후 지도 버전. 새로 연 별이 없으면 바뀌지 않는다
     */
    public record Recognition(boolean newlyRecognized, long achievementId, long ticId, StarViews.Achievement star,
                              List<DiscoveredStar> unlockedStars, int unlockShortfall, String skyVersion) {

        public int ticAchievementCount() {
            return star.count();
        }

        public String grade() {
            return star.grade();
        }
    }

    /**
     * 신호 하나의 성과를 인정하고 별을 연다(9.2절).
     *
     * <p>잠금 순서는 {@code users → user_star_progress → user_candidate_achievements → star_unlocks}다.
     * 회원 행을 먼저 잡으므로 같은 회원의 제출·공개·다른 발견 경로가 이 함수 안에서 줄을 선다.
     *
     * <p><b>호출자는 제출·공개 기록 저장과 진행 행 갱신 전에, 같은 트랜잭션에서 회원 행을 먼저 잠근다</b>
     * ({@code SELECT … FROM users WHERE id = ? FOR UPDATE}, 서비스 API 9.1절과 같은 원칙). 회원을 참조하는 행을
     * 먼저 쓰면 외래 키 검사가 회원 행에 KEY SHARE 잠금을 남긴다. 같은 회원의 두 트랜잭션이 그 상태로 이 함수의
     * {@code FOR UPDATE}에 오면 서로의 KEY SHARE를 기다리다 교착한다. 함수 안의 잠금만으로는 호출자 전체의 잠금
     * 순서가 보장되지 않는다.
     *
     * <p>이미 인정된 신호면 아무것도 바꾸지 않고 {@code newlyRecognized=false}를 돌려준다. 응답을 잃고
     * 다시 불러도, 같은 신호를 동시에 공개해도 성과와 별이 늘지 않는다(SUB-06, AT-12).
     *
     * <p>별 저장이 실패하면 예외가 호출자 트랜잭션을 되돌려 성과도 남지 않는다. 성과만 남기고 별을
     * 잃는 경우는 못 찾은 별이 모자랄 때뿐이며 그 수를 {@code unlockShortfall}로 알린다.
     *
     * @param analysisId 미확정 성과의 인정 근거 공개 분석. 확정·FP는 null
     * @throws IllegalArgumentException 인정 근거가 이 회원·신호의 것이 아니거나 유형과 맞지 않을 때
     * @throws IllegalStateException    회원이 신호의 별을 발견하지 않았을 때
     * @throws BusinessException        현재 운영 규칙이 없으면 {@code DEPENDENCY_UNAVAILABLE}
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public Recognition recognize(long memberId, long candidateId, AchievementType type, long submissionId,
                                 Long analysisId) {
        achievements.lockMember(memberId);
        long ticId = achievements.findCandidateTic(candidateId)
                .orElseThrow(() -> new IllegalArgumentException("없는 신호: " + candidateId));
        verifyBasis(memberId, candidateId, type, submissionId, analysisId);
        if (!achievements.lockProgress(memberId, ticId)) {
            throw new IllegalStateException("회원 " + memberId + "이 발견하지 않은 별 " + ticId + "의 성과입니다.");
        }

        OptionalLong inserted = achievements.insertAchievement(memberId, candidateId, type.column, submissionId,
                analysisId);
        if (inserted.isEmpty()) {
            return new Recognition(false, achievements.findAchievementId(memberId, candidateId), ticId,
                    star(memberId, ticId), List.of(), 0, sky.version(memberId));
        }
        long achievementId = inserted.getAsLong();
        achievements.countAchievement(memberId, ticId, type == AchievementType.FP);

        int wanted = currentDiscoveryRule().starsPerAchievement();
        List<DiscoveredStar> unlocked = new ArrayList<>(wanted);
        for (int seq = 0; seq < wanted; seq++) {
            Optional<DiscoveredStar> star = unlockOne(memberId, new AchievementTrigger(ticId, achievementId, seq));
            if (star.isEmpty()) {
                break;
            }
            unlocked.add(star.get());
        }
        String skyVersion = unlocked.isEmpty() ? sky.version(memberId) : unlocked.getLast().skyVersion();
        return new Recognition(true, achievementId, ticId, star(memberId, ticId), List.copyOf(unlocked),
                wanted - unlocked.size(), skyVersion);
    }

    /**
     * 공개 재전송은 현재 성과를 읽기만 한다. 취소·숨김된 공개를 다시 인정하지 않는다.
     * 공개와 성과는 원자적으로 저장되며 공개 취소·숨김도 성과를 회수하지 않는다(서비스 API 9.3절).
     * 기존 공개의 성과 누락은 정상적인 미보유가 아닌 데이터 불일치이므로 false로 숨기지 않는다.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public Recognition existingRecognition(long memberId, long candidateId) {
        long ticId = achievements.findCandidateTic(candidateId)
                .orElseThrow(() -> new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE));
        return new Recognition(false, achievements.findAchievementId(memberId, candidateId), ticId,
                star(memberId, ticId), List.of(), 0, sky.version(memberId));
    }

    /** 공개 응답 유실 복구용이며 성과·별을 추가 지급하지 않는다. */
    @Transactional(propagation = Propagation.MANDATORY)
    public List<SubmissionViews.UnlockedStar> publicationStars(long memberId, long analysisId) {
        return achievements.findPublicationStars(memberId, analysisId);
    }

    /**
     * 성과 조회(9.1절). 요약과 목록을 한 스냅샷에서 읽는다.
     *
     * @param requestedTicId 목록 필터. 요약에는 적용하지 않는다
     * @throws BusinessException ticId·size·cursor가 계약 밖이면 {@code VALIDATION_FAILED}
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public AchievementList list(long memberId, String requestedTicId, String requestedSize, String cursor) {
        Long ticId = validateTic(requestedTicId);
        int size = validateSize(requestedSize);

        AchievementCursor request = new AchievementCursor(memberId, ticId == null ? 0 : ticId, size, 0, 0);
        AchievementCursor position = cursor == null ? null
                : AchievementCursor.decode(cursor, request)
                        .orElseThrow(() -> new BusinessException(ErrorCode.VALIDATION_FAILED));

        List<AchievementItem> page = achievements.findPage(memberId, ticId,
                position == null ? null : position.afterRecognizedAt(),
                position == null ? null : position.afterAchievementId(),
                size + 1);
        boolean hasNext = page.size() > size;
        List<AchievementItem> items = hasNext ? page.subList(0, size) : page;
        String nextCursor = null;
        if (hasNext) {
            AchievementItem last = items.getLast();
            long lastId = ExplorationIds.parse(last.achievementId(), ExplorationIds.ACHIEVEMENT).orElseThrow();
            nextCursor = AchievementCursor.after(memberId, request.ticId(), size, last.recognizedAt(), lastId)
                    .encode();
        }
        return new AchievementList(summaries.achievementSummary(memberId), List.copyOf(items), nextCursor, hasNext);
    }

    /** 필터가 없으면 null. 없는 별·발견하지 않은 별도 거절하지 않는다. 내 성과 목록이 비어 나갈 뿐이다. */
    private static Long validateTic(String requested) {
        if (requested == null) {
            return null;
        }
        return ExplorationIds.parseTic(requested).stream().boxed().findFirst()
                .orElseThrow(() -> new BusinessException(ErrorCode.VALIDATION_FAILED));
    }

    /**
     * 파라미터를 문자열로 받아 여기서 판별한다. 숫자로 받으면 변환 실패가 전역 처리기에서 400이 아니라
     * 500이 된다({@link ExplorationIds#parseTic} 참조).
     */
    private static int validateSize(String requested) {
        if (requested == null) {
            return DEFAULT_LIST_SIZE;
        }
        int size;
        try {
            size = Integer.parseInt(requested);
        } catch (NumberFormatException malformed) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        if (size < 1 || size > MAX_LIST_SIZE) {
            throw new BusinessException(ErrorCode.VALIDATION_FAILED);
        }
        return size;
    }

    /**
     * 시드 정책 {@code hash-user-achievement-seq-v1}의 시드(9.2절 4단계).
     *
     * <p>문자열 {@code "<memberId>:<achievementId>:<seq>"}(십진수, UTF-8)의 SHA-256 앞 8바이트를 부호 없는
     * 빅엔디언 정수로 읽는다. 같은 회원·성과·순번은 언제나 같은 시드를 낸다.
     */
    static BigInteger seed(long memberId, long achievementId, int seq) {
        byte[] digest;
        try {
            digest = MessageDigest.getInstance("SHA-256")
                    .digest((memberId + ":" + achievementId + ":" + seq).getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256을 쓸 수 없습니다.", e);
        }
        return new BigInteger(1, Arrays.copyOf(digest, Long.BYTES));
    }

    /**
     * 순번 하나에 별 하나를 연다.
     *
     * <p>고른 별이 저장 직전에 다른 경로로 열렸으면(회원 잠금 없이 넣은 운영자 수동 입력 등) 그 별은 이제
     * 후보가 아니므로 같은 시드로 다시 고른다. 고를 때마다 후보가 하나씩 줄어 반드시 끝난다.
     *
     * @return 못 찾은 별이 남아 있지 않으면 빈 값
     */
    private Optional<DiscoveredStar> unlockOne(long memberId, AchievementTrigger trigger) {
        BigInteger seed = seed(memberId, trigger.achievementId(), trigger.seq());
        while (true) {
            OptionalLong picked = achievements.pickUndiscoveredStar(memberId, seed);
            if (picked.isEmpty()) {
                return Optional.empty();
            }
            Optional<DiscoveredStar> star = discovery.discoverByAchievement(memberId, picked.getAsLong(), trigger);
            if (star.isPresent()) {
                return star;
            }
        }
    }

    private OperationRule.Discovery currentDiscoveryRule() {
        OperationRule rule = rules.findCurrent()
                .orElseThrow(() -> new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE));
        if (!SEED_POLICY.equals(rule.discovery().seedPolicy())) {
            throw new IllegalStateException("운영 규칙 " + rule.ruleVersion() + "의 시드 정책("
                    + rule.discovery().seedPolicy() + ")을 이 앱은 따를 수 없습니다.");
        }
        return rule.discovery();
    }

    /** 이 별의 처리 후 누적 성과. 등급은 성과 수에서 만든다(GRD-01). */
    private StarViews.Achievement star(long memberId, long ticId) {
        StarViews.Achievement counted = stars.countAchievements(memberId, ticId);
        return new StarViews.Achievement(counted.count(), StarService.grade(counted.count()), counted.byType());
    }

    /**
     * 인정 근거가 이 회원·신호의 것인지 본다.
     *
     * <p>성과 행은 앱이 지울 수 없다(V5 권한). 호출자가 근거를 잘못 넘기면 되돌릴 수 없는 성과가 남으므로
     * 넣기 전에 막는다. 확정·FP는 매칭한 제출이, 미확정은 그 제출과 같은 신호의 공개 분석이 근거다.
     */
    private void verifyBasis(long memberId, long candidateId, AchievementType type, long submissionId,
                             Long analysisId) {
        AchievementRepository.SubmissionBasis submission = achievements.findSubmissionBasis(submissionId)
                .orElseThrow(() -> new IllegalArgumentException("없는 제출: " + submissionId));
        if (submission.memberId() != memberId || !Objects.equals(submission.matchedCandidateId(), candidateId)) {
            throw new IllegalArgumentException("제출 " + submissionId + "은 회원 " + memberId + "이 신호 "
                    + candidateId + "를 매칭한 제출이 아닙니다.");
        }
        if (type != AchievementType.UNCONFIRMED) {
            if (analysisId != null) {
                throw new IllegalArgumentException(type.column + " 성과에는 공개 분석 근거가 없습니다.");
            }
            return;
        }
        if (analysisId == null) {
            throw new IllegalArgumentException("미확정 성과에는 공개 분석 근거가 필요합니다.");
        }
        AchievementRepository.AnalysisBasis analysis = achievements.findAnalysisBasis(analysisId)
                .orElseThrow(() -> new IllegalArgumentException("없는 공개 분석: " + analysisId));
        if (analysis.memberId() != memberId || analysis.candidateId() != candidateId) {
            throw new IllegalArgumentException("공개 분석 " + analysisId + "은 회원 " + memberId + "의 신호 "
                    + candidateId + " 공개가 아닙니다.");
        }
    }
}
