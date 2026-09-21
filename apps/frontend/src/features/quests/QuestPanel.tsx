import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { pagePath } from "../../app/paths";
import { useQuests } from "./QuestProvider";
import {
  intentLabels,
  currentChallengeMismatch,
  needsChallengeNotice,
  recordChallengeShown,
  type CurrentChallenge,
} from "./contracts";
import "./quests.css";

const statusLabel = {
  locked: "잠김",
  unlocked: "시작 가능",
  in_progress: "탐색 중",
  completed: "완료",
};
function NewRoundNotice({
  current,
  memberId,
  open,
}: {
  current: CurrentChallenge;
  memberId: string;
  open(): void;
}) {
  const [show, setShow] = useState(() => {
    try {
      return needsChallengeNotice(localStorage, memberId, current);
    } catch {
      return current.eligible && current.round?.status === "active";
    }
  });
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = element.current;
    if (!show || !node || !current.round) return;
    let first = 0,
      second = 0,
      recorded = false;
    const record = () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      if (document.hidden || recorded) return;
      first = requestAnimationFrame(() => {
        second = requestAnimationFrame(() => {
          const rect = node.getBoundingClientRect();
          if (
            !node.isConnected ||
            document.hidden ||
            rect.height <= 0 ||
            rect.bottom <= 0 ||
            rect.top >= innerHeight
          )
            return;
          try {
            recordChallengeShown(
              localStorage,
              memberId,
              current.round!.roundId,
            );
          } catch {
            /* Access itself may be denied. */
          }
          recorded = true;
        });
      });
    };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) record();
    });
    observer.observe(node);
    document.addEventListener("visibilitychange", record);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      document.removeEventListener("visibilitychange", record);
    };
  }, [show, memberId, current.round]);
  if (!show || !current.round) return null;
  return (
    <div className="quest-round-notice" ref={element}>
      <p role="status">새 챌린지가 열렸어요 · {current.round.roundNo}회차</p>
      <button onClick={open}>챌린지 보기</button>
      <button aria-label="새 챌린지 안내 닫기" onClick={() => setShow(false)}>
        닫기
      </button>
    </div>
  );
}
export function QuestPanel({
  select,
  listMode,
}: {
  select(ticId: string): void;
  listMode: boolean;
}) {
  const { memberId, quests, error, current, currentError, refresh } =
    useQuests();
  const challengeRef = useRef<HTMLDetailsElement>(null);
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target)
      )
        setExpanded(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [expanded]);
  const choose = (ticId: string) => {
    // A closed panel cannot receive focus when returning from star detail.
    trigger.current?.focus({ preventScroll: true });
    setExpanded(false);
    select(ticId);
  };
  const challenge = quests?.challenge;
  const currentMismatch = currentChallengeMismatch(current, challenge);
  const returnTo = (ticId: string) =>
    `/sky?${new URLSearchParams({ star: ticId, ...(listMode ? { view: "list" } : {}) })}`;
  return (
    <section
      ref={panel}
      className="quest-layer"
      aria-label="탐사 퀘스트"
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.stopPropagation();
          setExpanded(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className="quest-toggle"
        aria-expanded={expanded}
        aria-controls="quest-panel-content"
        onClick={() => setExpanded(!expanded)}
      >
        <span aria-hidden="true">✧</span> 퀘스트{" "}
        <span aria-hidden="true">{expanded ? "−" : "+"}</span>
      </button>
      {current?.eligible && current.round?.status === "active" && (
        <NewRoundNotice
          key={memberId + current.round.roundId}
          current={current}
          memberId={memberId}
          open={() => {
            setExpanded(true);
            if (challengeRef.current) {
              challengeRef.current.open = true;
              requestAnimationFrame(() =>
                challengeRef.current?.querySelector("summary")?.focus(),
              );
            }
          }}
        />
      )}
      <div className="quest-panel" id="quest-panel-content" hidden={!expanded}>
        <div className="quest-panel-heading">
          <h2>탐사 퀘스트</h2>
          <button
            aria-label="퀘스트 닫기"
            onClick={() => {
              setExpanded(false);
              trigger.current?.focus();
            }}
          >
            닫기
          </button>
        </div>
        <div className="quest-sections">
          <details className="quest-tutorial">
            <summary>
              튜토리얼{" "}
              <span>
                {quests ? `${quests.tutorial.completedCount} / 5` : ""}
              </span>
            </summary>
            {error ? (
              <div role="alert">
                <p>튜토리얼을 불러오지 못했습니다.</p>
                <button onClick={refresh}>퀘스트 다시 불러오기</button>
              </div>
            ) : !quests ? (
              <p role="status">튜토리얼을 불러오고 있습니다.</p>
            ) : (
              <>
                <p className="quest-caption">
                  다섯 별을 차례로 탐사하며 밝기 곡선 읽는 법을 익혀 보세요.
                </p>
                <ol className="quest-steps">
                  {quests.tutorial.items.map((item) => (
                    <li key={item.seq}>
                      <button
                        disabled={!item.ticId}
                        onClick={() => item.ticId && choose(item.ticId)}
                      >
                        <span className="quest-seq">{item.seq}</span>
                        <span>
                          <strong>
                            튜토리얼 {item.seq} ·{" "}
                            {item.completionReason === "skipped"
                              ? "건너뛰기 완료"
                              : statusLabel[item.status]}
                          </strong>
                          <small>{intentLabels[item.intent]}</small>
                        </span>
                        <span aria-hidden="true">
                          {item.status === "completed"
                            ? "✓"
                            : item.status === "locked"
                              ? "—"
                              : "↗"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
                {quests.tutorial.completedCount === 5 && (
                  <p>
                    기본 탐사를 모두 마쳤어요. 열린 별과 챌린지를 자유롭게
                    탐사해 보세요.
                  </p>
                )}
              </>
            )}
          </details>
          <details className="quest-challenge" ref={challengeRef}>
            <summary>
              챌린지{" "}
              <span>
                {challenge?.round ? `${challenge.round.roundNo}회차` : ""}
              </span>
            </summary>
            {error ? (
              <div role="alert">
                <p>챌린지를 불러오지 못했습니다.</p>
                <button onClick={refresh}>퀘스트 다시 불러오기</button>
              </div>
            ) : !challenge ? (
              <p role="status">챌린지를 불러오고 있습니다.</p>
            ) : !challenge.round ? (
              <p>현재 진행 중인 챌린지가 없습니다.</p>
            ) : (
              <>
                <p className="quest-caption">
                  <time dateTime={challenge.round.startsOn}>
                    {challenge.round.startsOn}
                  </time>{" "}
                  ~{" "}
                  <time dateTime={challenge.round.endsOn}>
                    {challenge.round.endsOn}
                  </time>
                </p>
                <p>{challenge.round.description}</p>
                <p>
                  공개 분석 참여자{" "}
                  <strong>
                    {challenge.participantCount?.toLocaleString()}명
                  </strong>
                </p>
                {!challenge.eligible ? (
                  <p>튜토리얼 다섯 별을 마치면 참여할 수 있어요.</p>
                ) : !challenge.unlocked ? (
                  <p>
                    참여 자격을 확인했습니다. 대상 별이 열리기를 기다리고
                    있어요.
                  </p>
                ) : currentMismatch ? (
                  <p role="status">
                    회차가 변경되었습니다. 최신 챌린지를 다시 확인해 주세요.
                  </p>
                ) : (
                  <>
                    <p>
                      TIC {challenge.ticId} · 별{" "}
                      {
                        statusLabel[
                          challenge.progressStage === "unexplored"
                            ? "unlocked"
                            : challenge.progressStage!
                        ]
                      }
                    </p>
                    <div className="quest-actions">
                      <button onClick={() => choose(challenge.ticId!)}>
                        지도에서 선택
                      </button>
                      <Link
                        to={pagePath(
                          "analysis",
                          { ticId: challenge.ticId! },
                          { returnTo: returnTo(challenge.ticId!) },
                        )}
                      >
                        챌린지 별 분석하기
                      </Link>
                    </div>
                  </>
                )}
              </>
            )}
            {(currentError || currentMismatch) && (
              <div className="quest-caption" role="status">
                <p>
                  {currentError
                    ? "새 회차 안내를 확인하지 못했습니다. 탐사 진행 상태에는 영향을 주지 않습니다."
                    : "회차 정보가 갱신 중입니다."}
                </p>
                <button onClick={refresh}>회차 다시 확인</button>
              </div>
            )}
          </details>
        </div>
        {quests && quests.reopened.length > 0 && (
          <details className="quest-reopened">
            <summary>
              다시 열린 별 <span>{quests.reopened.length}개</span>
            </summary>
            <p className="quest-caption">
              새 자료가 도착한 별에서 탐사를 이어가 보세요.
            </p>
            <ul>
              {quests.reopened.map((star) => (
                <li key={star.ticId}>
                  <button onClick={() => choose(star.ticId)}>
                    <strong>TIC {star.ticId}</strong>
                    <span>
                      {star.newDiscoverableCount === null
                        ? "새 자료 확인하기"
                        : `새 탐색 신호 ${star.newDiscoverableCount}개`}
                    </span>
                    <time dateTime={star.reopenedAt}>
                      {new Date(star.reopenedAt).toLocaleDateString("ko-KR")}
                    </time>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
