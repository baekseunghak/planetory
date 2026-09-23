import { useEffect, useState, type ReactNode } from "react";
import { ApiError } from "../../api/client";
import { ErrorState } from "../../components/RequestState";
import { useSession } from "../../auth/SessionProvider";
import { sessionDraftKey } from "../../auth/session-draft-storage";
import { readSavedDraft, type SavedAnalysisDraft } from "./session-draft";
import { RetryPreparationError, type AnalysisEntry } from "./load-analysis";

export function AnalysisEntryError({
  error,
  retry,
}: {
  error: Error;
  retry: () => void;
}) {
  const deadline = error instanceof RetryPreparationError ? error.retryAt : 0;
  const retryable =
    error instanceof RetryPreparationError
      ? error.retryable
      : !(error instanceof ApiError && error.details.retryable === false);
  const [now, setNow] = useState(Date.now);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  useEffect(() => {
    if (!deadline || deadline <= Date.now()) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= deadline) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [deadline]);
  return (
    <>
      <ErrorState error={error} />
      {retryable && (
        <button type="button" disabled={seconds > 0} onClick={retry}>
          {seconds ? `${seconds}초 후 다시 불러오기` : "다시 불러오기"}
        </button>
      )}
    </>
  );
}

/** Decide before mounting the editor: a different curve must not erase an existing draft. */
export function AnalysisEntryGate({
  ticId,
  retryId,
  children,
}: {
  ticId: string;
  retryId: string | null;
  children: (entry: AnalysisEntry | undefined) => ReactNode;
}) {
  const { member } = useSession();
  const [saved] = useState<SavedAnalysisDraft | null>(() => {
    if (!member) return null;
    try {
      const raw = sessionStorage.getItem(
        sessionDraftKey(member.memberId, ticId),
      );
      if (!raw) return null;
      const value = JSON.parse(raw);
      return readSavedDraft(raw, value.identity);
    } catch {
      return null;
    }
  });
  const [choice, setChoice] = useState<"resume" | "retry" | null>(
    retryId && saved ? null : retryId ? "retry" : "resume",
  );
  const [entry, setEntry] = useState<AnalysisEntry | undefined>(() =>
    retryId && !saved
      ? { retryOfSubmissionId: retryId, retryAttemptId: crypto.randomUUID() }
      : !retryId && saved
        ? {
            retryOfSubmissionId: saved.retryOfSubmissionId ?? undefined,
            retryAttemptId: saved?.retryAttemptId,
            resume: true,
            savedContext: saved.curveContext,
          }
        : undefined,
  );
  if (choice === null)
    return (
      <section aria-label="재도전 초안 선택">
        <h2>작성 중인 초안이 있습니다</h2>
        <p>
          기존 초안을 이어가거나, 이전 제출의 주기·구간으로 다시 시작할 수
          있습니다. 다시 시작하면 판단·근거·메모를 새로 작성합니다.
        </p>
        <button
          type="button"
          onClick={() => {
            setEntry({
              retryOfSubmissionId: saved?.retryOfSubmissionId ?? undefined,
              retryAttemptId: saved?.retryAttemptId,
              resume: true,
              autoRestore: true,
              savedContext: saved?.curveContext,
            });
            setChoice("resume");
          }}
        >
          기존 초안 이어가기
        </button>
        <button
          type="button"
          onClick={() => {
            setEntry({
              retryOfSubmissionId: retryId!,
              retryAttemptId: crypto.randomUUID(),
            });
            setChoice("retry");
          }}
        >
          초안 대신 재도전 시작
        </button>
      </section>
    );
  return children(entry);
}
