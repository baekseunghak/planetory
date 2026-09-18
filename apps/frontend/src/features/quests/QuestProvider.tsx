import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../../api";
import type { SkySceneProps } from "../sky-data/SkyDataPage";
import { subscribeSkyChange } from "../sky-data/events";
import { subscribeQuestChange } from "./events";
import {
  readQuests,
  readCurrentChallenge,
  tutorialMarkers,
  type Quests,
  type CurrentChallenge,
} from "./contracts";
import type { TutorialMarkers } from "../sky-renderer/interaction";

type Resource<T> = { value?: T; error?: Error };
type Context = {
  memberId: string;
  quests?: Quests;
  current?: CurrentChallenge;
  error?: Error;
  currentError?: Error;
  markers: TutorialMarkers | null;
  refresh(): void;
};
const QuestContext = createContext<Context | null>(null);
export const useQuests = () => {
  const value = useContext(QuestContext);
  if (!value) throw new Error("QuestProvider가 필요합니다.");
  return value;
};
export function QuestProvider({
  data,
  store,
  children,
}: SkySceneProps & { children: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    scope: typeof data.meta;
    quests: Resource<Quests>;
    current: Resource<CurrentChallenge>;
  } | null>(null);
  const activeRead = useRef<AbortController | null>(null);
  const retired = useRef(new Set<string>());
  const refresh = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    const off = subscribeQuestChange(store.memberId, refresh);
    const offSky = subscribeSkyChange(store.memberId, refresh);
    let last = 0;
    const visibleRefresh = () => {
      if (!document.hidden && !activeRead.current && Date.now() - last > 1000) {
        last = Date.now();
        refresh();
      }
    };
    window.addEventListener("focus", visibleRefresh);
    document.addEventListener("visibilitychange", visibleRefresh);
    const timer = window.setInterval(visibleRefresh, 60000);
    return () => {
      off();
      offSky();
      clearInterval(timer);
      window.removeEventListener("focus", visibleRefresh);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, [store, refresh]);
  useEffect(() => {
    const controller = new AbortController(),
      scope = data.meta;
    setResult(null);
    if (data.needsRefresh) return;
    activeRead.current = controller;
    const load = async <T,>(
      path: string,
      decode: (value: unknown) => T,
      key: "quests" | "current",
    ) => {
      let resource: Resource<T>;
      try {
        resource = {
          value: decode(
            await api<unknown>(path, { signal: controller.signal }),
          ),
        };
      } catch (error) {
        resource = {
          error:
            error instanceof Error
              ? error
              : new Error("탐사 안내를 불러오지 못했습니다."),
        };
      }
      if (!controller.signal.aborted)
        setResult((previous) => ({
          scope,
          quests: previous?.scope === scope ? previous.quests : {},
          current: previous?.scope === scope ? previous.current : {},
          [key]: resource,
        }));
    };
    void Promise.all([
      load("/v1/me/quests", readQuests, "quests"),
      load("/v1/challenges/current", readCurrentChallenge, "current"),
    ]).finally(() => {
      if (activeRead.current === controller) activeRead.current = null;
    });
    return () => {
      controller.abort();
      if (activeRead.current === controller) activeRead.current = null;
    };
  }, [store, data.meta, data.needsRefresh, attempt]);
  const valid =
    result?.scope === data.meta && !data.needsRefresh ? result : null;
  const quests = valid?.quests.value;
  const markers = useMemo(
    () => (quests ? tutorialMarkers(quests, retired.current) : null),
    [quests],
  );
  return (
    <QuestContext.Provider
      value={{
        memberId: store.memberId,
        quests,
        current: valid?.current.value,
        error: valid?.quests.error,
        currentError: valid?.current.error,
        markers,
        refresh,
      }}
    >
      {children}
    </QuestContext.Provider>
  );
}
