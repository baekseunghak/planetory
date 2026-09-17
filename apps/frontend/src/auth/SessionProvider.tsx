import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, http } from "../api";
import { readMember, type Member } from "./member";
import {
  activateDraftOwner,
  clearSessionDrafts,
} from "./session-draft-storage";

type SessionState =
  | { status: "loading"; member: null; error: null }
  | { status: "anonymous"; member: null; error: null }
  | { status: "error"; member: null; error: Error }
  | { status: "authenticated"; member: Member; error: null };
type Session = SessionState & {
  refresh: () => Promise<void>;
  clear: () => void;
  revision: number;
};
const Context = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({
    status: "loading",
    member: null,
    error: null,
  });
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const clear = useCallback(() => {
    clearSessionDrafts();
    ++generation.current;
    pending.current?.abort();
    http.cancelPending();
    setRevision((v) => v + 1);
    setState({ status: "anonymous", member: null, error: null });
  }, []);
  const refresh = useCallback(async () => {
    const id = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setState({ status: "loading", member: null, error: null });
    try {
      const member = readMember(
        await http.request<unknown>("/v1/me", { signal: controller.signal }),
      );
      if (id === generation.current && !controller.signal.aborted) {
        activateDraftOwner(member.memberId);
        setRevision((v) => v + 1);
        setState({ status: "authenticated", member, error: null });
      }
    } catch (error) {
      if (id !== generation.current || controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) clear();
      else
        setState({
          status: "error",
          member: null,
          error:
            error instanceof Error
              ? error
              : new Error("회원 정보를 확인할 수 없습니다."),
        });
    }
  }, [clear]);
  useEffect(() => {
    const unsubscribe = http.onUnauthorized(clear);
    void refresh();
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) void refresh();
    };
    window.addEventListener("pageshow", restored);
    return () => {
      ++generation.current;
      pending.current?.abort();
      unsubscribe();
      http.cancelPending();
      window.removeEventListener("pageshow", restored);
    };
  }, [clear, refresh]);
  return (
    <Context.Provider value={{ ...state, refresh, clear, revision }}>
      {children}
    </Context.Provider>
  );
}

export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error("SessionProvider 안에서 사용해 주세요.");
  return value;
}
