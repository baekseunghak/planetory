import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { http } from "../../api";
import { readMember } from "../../auth/member";
import { useSession } from "../../auth/SessionProvider";
import { publishQuestChange } from "../quests/events";
import "./onboarding.css";

const steps = [
  [
    "별 선택",
    "별지도에서 열려 있는 별을 고른 뒤 분석 시작을 누르세요. 별을 고르는 것만으로 안내나 탐사가 완료되지는 않습니다.",
  ],
  [
    "봉우리 선택",
    "주기도의 봉우리를 선택하고 접힌 곡선을 살펴보세요. 주기를 정하면 ‘이 주기로 구간 선택’으로 이동합니다.",
  ],
  [
    "구간 선택",
    "접힌 곡선에서 밝기가 줄어든 구간을 드래그해 선택하세요. Shift와 드래그로 그래프를 좌우로 이동할 수 있습니다.",
  ],
  [
    "판단과 근거",
    "행성 같음·아닌 것 같음·모르겠음 중 판단을 고르고 관측 근거와 메모를 남기세요.",
  ],
  [
    "검토 후 제출",
    "주기·구간·판단·근거를 확인한 뒤 제출하세요. 안내를 닫는 것은 제출이나 성과 획득이 아닙니다.",
  ],
] as const;
type Guide = {
  done: boolean;
  pending: boolean;
  error: boolean;
  close(): void;
  observeSubmission(): void;
};
const Context = createContext<Guide | null>(null);
export function useOnboardingSubmission(submissionId: string | null) {
  const observe = useContext(Context)?.observeSubmission;
  useEffect(() => {
    if (submissionId) observe?.();
  }, [submissionId, observe]);
}

// ProtectedRoutes already keys this subtree by authenticated member and revision.
// Do not refresh SessionProvider here: that would unmount the analysis editor.
export function OnboardingProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const member = session.member;
  const location = useLocation();
  const [done, setDone] = useState(member?.onboardingDone ?? true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const observeSubmission = useCallback(
    () => setRevision((value) => value + 1),
    [],
  );
  const write = useRef<AbortController | null>(null);
  const completed = useRef(done);
  useEffect(() => () => write.current?.abort(), []);
  useEffect(() => {
    if (!member || completed.current) return;
    const controller = new AbortController();
    // A successful first tutorial submission can complete onboarding on the server.
    void http
      .request("/v1/me", { signal: controller.signal })
      .then((value) => {
        const fresh = readMember(value);
        if (
          !controller.signal.aborted &&
          fresh.memberId === member.memberId &&
          fresh.onboardingDone
        ) {
          completed.current = true;
          setDone(true);
        }
      })
      .catch(() => {
        /* A failed read never invents completion or erases input. */
      });
    return () => controller.abort();
  }, [location.key, member?.memberId, revision]);
  async function close() {
    if (!member || completed.current || write.current) return;
    const controller = new AbortController();
    write.current = controller;
    const focusWasGuide =
      !!document.activeElement?.closest(".first-visit-guide");
    setPending(true);
    setError(false);
    try {
      const response = await http.request<unknown>("/v1/me/onboarding", {
        method: "PATCH",
        json: { onboardingDone: true },
        signal: controller.signal,
      });
      if (
        !response ||
        typeof response !== "object" ||
        !("onboardingDone" in response) ||
        response.onboardingDone !== true
      )
        throw new Error("Invalid onboarding receipt");
      if (controller.signal.aborted) return;
      completed.current = true;
      setDone(true);
      publishQuestChange(member.memberId, { reason: "guide-closed" });
      // Only move focus if it is still on the disappearing guide.
      if (
        document.activeElement?.closest(".first-visit-guide") ||
        (focusWasGuide && document.activeElement === document.body)
      ) {
        const target = document.getElementById("main-content");
        target?.focus({ preventScroll: true });
      }
    } catch {
      if (!controller.signal.aborted && !completed.current) setError(true);
    } finally {
      if (!controller.signal.aborted) {
        write.current = null;
        setPending(false);
      }
    }
  }
  return (
    <Context.Provider
      value={{ done, pending, error, close, observeSubmission }}
    >
      {children}
    </Context.Provider>
  );
}

export function OnboardingTip({ step }: { step: 0 | 1 | 2 | 3 | 4 }) {
  const guide = useContext(Context);
  if (!guide || guide.done) return null;
  return (
    <aside className="first-visit-guide" aria-label="첫 방문 분석 안내">
      <p aria-live="polite" aria-atomic="true">
        <strong>
          {step + 1}/5 · {steps[step][0]}
        </strong>
      </p>
      <p>{steps[step][1]}</p>
      <span className="onboarding-status" role="status">
        {guide.pending ? "안내 완료 저장 중" : ""}
      </span>
      {guide.error && (
        <p role="alert">
          안내 완료를 저장하지 못했습니다. 다음 방문에 다시 표시될 수 있습니다.
          작성 중인 분석은 유지됩니다.
        </p>
      )}
      <button
        type="button"
        disabled={guide.pending}
        onClick={() => void guide.close()}
      >
        {guide.pending
          ? "안내 완료 저장 중"
          : guide.error
            ? "안내 완료 다시 저장"
            : "안내 닫기"}
      </button>
    </aside>
  );
}
