package com.planetory.backend.domain.exploration.service;

import java.time.Clock;
import java.time.OffsetDateTime;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Isolation;
import org.springframework.transaction.annotation.Transactional;

import com.planetory.backend.domain.exploration.service.QuestViews.Challenge;
import com.planetory.backend.domain.exploration.service.QuestViews.Quests;
import com.planetory.backend.domain.exploration.service.QuestViews.Round;
import com.planetory.backend.domain.exploration.service.QuestViews.Tutorial;
import com.planetory.backend.domain.exploration.service.TutorialRepository.ChallengeRound;

/** 퀘스트 패널 (탐사 API 4.3) [S15P21C206-139]. */
@Service
@RequiredArgsConstructor
public class QuestService {

    private final QuestRepository quests;
    private final TutorialRepository tutorials;
    private final Clock clock;

    /**
     * 튜토리얼·챌린지·다시 열린 별을 <b>한 스냅샷</b>에서 읽는다. 따로 읽으면 방금 끝낸 튜토리얼이
     * 완료 수에는 들어가고 챌린지 자격에는 빠진 채로 나갈 수 있다.
     *
     * <p>조회만 한다. 자격이 있는데 챌린지 별이 열리지 않았어도 여기서 열지 않는다. 열기는 튜토리얼
     * 완료와 회차 전환 명령이 맡는다(9.4절).
     */
    @Transactional(readOnly = true, isolation = Isolation.REPEATABLE_READ)
    public Quests quests(long memberId) {
        Tutorial tutorial = new Tutorial(tutorials.countCompleted(memberId), quests.findTutorialItems(memberId));
        Challenge challenge = tutorials.findActiveRound()
                .map(round -> challenge(memberId, round))
                .orElse(Challenge.NONE);
        return new Quests(OffsetDateTime.now(clock), tutorial, challenge, quests.findReopened(memberId));
    }

    private Challenge challenge(long memberId, ChallengeRound round) {
        Optional<String> stage = quests.findUnlockedStage(memberId, round.targetTicId());
        return new Challenge(
                new Round("cr-" + round.id(), round.roundNo(), round.startsOn(), round.endsOn(),
                        round.description()),
                tutorials.isTutorialCompleted(memberId),
                stage.map(ignored -> String.valueOf(round.targetTicId())).orElse(null),
                stage.isPresent(),
                stage.orElse(null),
                quests.countChallengeParticipants(round.targetTicId()));
    }
}
