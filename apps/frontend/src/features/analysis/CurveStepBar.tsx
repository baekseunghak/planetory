import { useEffect, useState } from "react";
import { remainingSeconds, stepName } from "./curve-step";
import type { AnalysisContext } from "./analysis-data";
import { useCurveStepSession } from "./AnalysisSession";

/** 2.4절 상태의 화면 이름. 와이어프레임 SC-03이 이렇게 부른다. */
const STATE: Record<string, string> = {
  QUEUED: "대기",
  RESIDUAL_CALCULATING: "잔차 계산",
  RESIDUAL_READY: "잔차 준비",
  PERIODOGRAM_CALCULATING: "주기도 계산",
  COMPLETED: "완료",
  FAILED: "실패",
};
const ORDER = [
  "QUEUED",
  "RESIDUAL_CALCULATING",
  "RESIDUAL_READY",
  "PERIODOGRAM_CALCULATING",
  "COMPLETED",
] as const;

/**
 * 곡선 단계 이동(#189). 와이어프레임 SC-03의 「← 이전 단계」와 「이 별에서
 * 찾은 신호 N · 곡선 단계 M」 자리다.
 *
 * **계산이 끝나기 전에는 곡선이 바뀌지 않는다.** 여기서는 어디까지 왔는지만
 * 알린다. 실패해도 보고 있던 곡선은 그대로다.
 */
/** 대기열 거절 뒤 남은 초를 센다. 0이면 다시 누를 수 있다. */
function useWait(refusedAt: number | null, retryAfterSeconds: number) {
  const [left, setLeft] = useState(() =>
    refusedAt === null
      ? 0
      : remainingSeconds(refusedAt, retryAfterSeconds, Date.now()),
  );
  useEffect(() => {
    if (refusedAt === null) return;
    const tick = () =>
      setLeft(remainingSeconds(refusedAt, retryAfterSeconds, Date.now()));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [refusedAt, retryAfterSeconds]);
  return refusedAt === null ? 0 : left;
}

export function CurveStepBar({ context }: { context: AnalysisContext }) {
  const step = useCurveStepSession();
  const queued =
    step?.transition.phase === "queue-full" ? step.transition : null;
  const wait = useWait(
    queued?.refusedAt ?? null,
    queued?.retryAfterSeconds ?? 0,
  );
  if (!step) return null;
  const { viewing, transition, moves } = step;
  const busy = transition.phase === "running";
  return (
    <section className="curve-step-bar" aria-label="곡선 단계">
      <p className="curve-step-where">
        이 별에서 찾은 신호 {context.matchedCandidateIds.length} ·{" "}
        {stepName(viewing)}
      </p>
      <p className="curve-step-moves">
        <button
          type="button"
          onClick={() => step.previous()}
          disabled={!moves.previous || busy}
        >
          ← 이전 단계
        </button>
        <button
          type="button"
          onClick={() => step.original()}
          disabled={!moves.original || busy}
        >
          원본 곡선
        </button>
        <button
          type="button"
          onClick={() => step.next()}
          disabled={!moves.next || busy}
        >
          다음 곡선 단계로
        </button>
      </p>

      {transition.phase === "running" && (
        <div data-testid="residual-progress">
          {/* 순서를 끝까지 보여 준다. 어디까지 왔는지 모르면 기다림이 더 길다. */}
          <ol className="curve-step-flow">
            {ORDER.map((state) => {
              const at = transition.progress
                ? ORDER.indexOf(transition.progress.status as never)
                : -1;
              const index = ORDER.indexOf(state);
              return (
                <li
                  key={state}
                  data-state={
                    index < at ? "done" : index === at ? "now" : "waiting"
                  }
                >
                  {STATE[state]}
                </li>
              );
            })}
          </ol>
          <p role="status">
            {stepName(transition.target)}을 준비하고 있습니다 ·{" "}
            {transition.progress
              ? STATE[transition.progress.status]
              : "요청 중"}
            {/* 빗나간 예상은 기다림을 더 나쁘게 만든다. 순번만 알린다. */}
            {transition.progress?.queuePosition
              ? ` · 대기 ${transition.progress.queuePosition}번째`
              : ""}
          </p>
        </div>
      )}

      {transition.phase === "failed" && (
        <p role="alert">
          {transition.message} 보고 있던 곡선은 그대로입니다.
          {/* 눌러도 같은 결과인 버튼은 「내가 뭘 잘못했나」를 묻게 만든다. */}
          {transition.retryable && (
            <>
              {" "}
              <button type="button" onClick={() => step.retry()}>
                다시 시도
              </button>
            </>
          )}
        </p>
      )}

      {/* 실패가 아니라 준비되지 않은 것이다. 다시 시도를 권하지 않는다. */}
      {transition.phase === "unavailable" && (
        <p role="status">{transition.message} 보고 있던 곡선은 그대로입니다.</p>
      )}

      {transition.phase === "queue-full" && (
        <p role="alert">
          {/* 내가 이미 돌리고 있는 작업이면 기다리라고 하면 안 된다(D-4). */}
          {transition.activeJobId
            ? "다른 곡선을 이미 계산하고 있습니다. 그것이 끝난 뒤에 다시 시도해 주세요."
            : `계산 대기가 가득 찼습니다. ${transition.retryAfterSeconds}초 뒤에 다시 시도해 주세요.`}{" "}
          {/* 말과 버튼이 다르면 곧바로 눌러 대기열을 한 번 더 두드린다. */}
          <button
            type="button"
            onClick={() => step.retry()}
            disabled={wait > 0}
          >
            {wait > 0 ? `다시 시도 (${wait}초)` : "다시 시도"}
          </button>
        </p>
      )}

      {/* 이제 스스로 다시 읽는다. 눌러 달라고 하지 않는다. */}
      {transition.phase === "bundle-changed" && (
        <p role="status">
          새 데이터 판이 공개되어 최신 자료를 다시 불러오고 있습니다.
        </p>
      )}
    </section>
  );
}
