package com.planetory.backend.domain.exploration.service;

import java.util.List;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

import com.planetory.backend.domain.exploration.service.StarDiscoveryService.DiscoveredStar;
import com.planetory.backend.domain.exploration.service.StarDiscoveryService.Reason;
import com.planetory.backend.domain.exploration.service.TutorialRepository.ChallengeRound;
import com.planetory.backend.global.error.BusinessException;
import com.planetory.backend.global.error.ErrorCode;

/**
 * 튜토리얼 순차 발견·챌린지 발견 (탐사 API 9.4절) [S15P21C206-139].
 *
 * <p>튜토리얼 n을 끝내면 n+1을, 다섯 개를 끝내면 진행 회차 별을 연다. 새 회차가 시작되면 이미
 * 다섯 개를 끝낸 회원 전원에게 그 회차 별을 연다. 회차가 끝나도 연 별은 닫지 않는다(AT-61).
 * 모든 발견은 {@link StarDiscoveryService}를 지나므로 같은 사건을 다시 실행해도 한 번만 열린다.
 */
@Service
@RequiredArgsConstructor
public class TutorialProgressService {

    /** 회원 목록을 읽는 묶음 크기. 회원마다 트랜잭션을 나누므로 묶음은 조회 비용만 정한다. */
    static final int UNLOCK_BATCH_SIZE = 500;

    private final TutorialRepository tutorials;
    private final StarDiscoveryService discovery;
    private final PlatformTransactionManager transactionManager;

    /**
     * 챌린지 일괄 발견 결과.
     *
     * @param opened  이번 실행에서 별을 새로 받은 회원 수
     * @param skipped 목록에 있었지만 처리 시점에 이미 받았거나 자격이 없어진 회원 수
     */
    public record ChallengeUnlockResult(ChallengeRound round, int opened, int skipped) {
    }

    /**
     * 튜토리얼 완료 후처리. 제출 트랜잭션이 진행 단계를 완료로 바꾼 뒤 같은 트랜잭션에서 부른다
     * (6.3절 9단계, S15P21C206-143).
     *
     * <p>완료 사유는 가리지 않는다. {@code skipped}로 끝나도 다음 순번을 열고, 추가 성과는 주지
     * 않는다(SUB-12, AT-88). 호출 시점에 완료가 아니거나 튜토리얼 별이 아니면 아무것도 하지 않는다.
     *
     * @return 새로 연 별. 다음 튜토리얼 하나이거나 진행 회차 대상 별 전부 중 새로 연 것이다. 이미 열려 있었거나
     *         열 별이 없으면 빈 목록
     * @throws BusinessException 다음 순번 튜토리얼이 설정되지 않았으면 {@code DEPENDENCY_UNAVAILABLE}.
     *                           가입 초기화와 같은 처리다. 운영 설정 누락을 조용히 넘기면 회원이
     *                           다음 튜토리얼 없이 멈춘다.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public List<DiscoveredStar> onTutorialCompleted(long memberId, long ticId) {
        // 발견 함수도 잠그지만 완료 판정부터 회원 잠금 안에서 본다.
        if (!tutorials.lockActiveMember(memberId)) {
            return List.of();
        }
        Optional<Integer> seq = tutorials.findActiveSeq(ticId);
        if (seq.isEmpty() || !tutorials.isCompleted(memberId, ticId)) {
            return List.of();
        }
        if (seq.get() < TutorialRepository.TUTORIAL_STAR_COUNT) {
            long next = tutorials.findActiveTicId(seq.get() + 1)
                    .orElseThrow(() -> new BusinessException(ErrorCode.DEPENDENCY_UNAVAILABLE));
            return discovery.discover(memberId, next, Reason.TUTORIAL).stream().toList();
        }
        // 회차 진행 중에 다섯 번째를 끝내면 그 시점에 연다(서비스 F17-Q2).
        if (!tutorials.isTutorialCompleted(memberId)) {
            return List.of();
        }
        return tutorials.findActiveRound().map(round -> openTargets(memberId, round)).orElse(List.of());
    }

    /** 회차 대상 별을 대표 대상부터 차례로 연다. 이미 받은 별은 건너뛴다. */
    private List<DiscoveredStar> openTargets(long memberId, ChallengeRound round) {
        return round.targetTicIds().stream()
                .flatMap(target -> discovery.discover(memberId, target, Reason.CHALLENGE).stream())
                .toList();
    }

    /**
     * 진행 회차 별을 튜토리얼을 끝낸 회원 전원에게 연다. 운영자가 회차를 active로 바꾼 뒤 전용
     * 명령으로 실행한다(OPS-07). 앱은 DB 직접 변경을 알 수 없다.
     *
     * <p>회원마다 트랜잭션을 나눈다. 한 회원의 실패가 앞서 처리한 회원을 되돌리지 않고, 회원 잠금을
     * 오래 쥐지 않는다. 실패로 멈추면 같은 명령을 다시 실행하면 된다. 이미 받은 회원은 목록에서 빠진다.
     *
     * <p>호출자 트랜잭션 밖에서 불러야 한다. 안에서 부르면 회원별 트랜잭션이 하나로 합쳐진다.
     *
     * @return 진행 회차가 없으면 빈 값
     * @throws IllegalStateException 처리 도중 회차가 진행 상태에서 벗어난 경우. 끝난 회차의 별을
     *                               계속 열지 않는다
     */
    public Optional<ChallengeUnlockResult> unlockActiveChallenge() {
        Optional<ChallengeRound> active = tutorials.findActiveRound();
        if (active.isEmpty()) {
            return Optional.empty();
        }
        ChallengeRound round = active.get();
        TransactionTemplate perMember = new TransactionTemplate(transactionManager);

        int opened = 0;
        int skipped = 0;
        long after = 0;
        List<Long> batch;
        while (!(batch = tutorials.findMembersToUnlock(round.id(), after, UNLOCK_BATCH_SIZE)).isEmpty()) {
            for (long memberId : batch) {
                if (Boolean.TRUE.equals(perMember.execute(status -> unlockChallengeFor(memberId, round)))) {
                    opened++;
                } else {
                    skipped++;
                }
            }
            after = batch.get(batch.size() - 1);
        }
        return Optional.of(new ChallengeUnlockResult(round, opened, skipped));
    }

    private boolean unlockChallengeFor(long memberId, ChallengeRound round) {
        if (!tutorials.lockActiveMember(memberId)) {
            return false;
        }
        if (!tutorials.isActiveRound(round.id())) {
            throw new IllegalStateException("챌린지 회차 " + round.roundNo() + "(id " + round.id()
                    + ")가 처리 도중 진행 상태에서 벗어났습니다");
        }
        if (!tutorials.isTutorialCompleted(memberId)) {
            return false;
        }
        return !openTargets(memberId, round).isEmpty();
    }
}
