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
import { authSettings } from "./settings";

type SessionState =
  | {
      status: "loading" | "anonymous" | "profile-required";
      member: null;
      error: null;
    }
  | { status: "error"; member: null; error: Error }
  | { status: "authenticated"; member: Member; error: null };
type RefreshResult = SessionState["status"] | "superseded";
type LogoutState = {
  phase: "idle" | "pending" | "uncertain" | "failed";
  error: Error | null;
};
type Notice = "expired" | "logout" | null;
type Session = SessionState & {
  refresh: () => Promise<RefreshResult>;
  clear: (notice?: Notice) => void;
  revision: number;
  notice: Notice;
  logoutState: LogoutState;
  logout: () => Promise<void>;
  verifyLogout: () => Promise<void>;
  dismissLogoutError: () => void;
};
const Context = createContext<Session | null>(null);
const idle: LogoutState = { phase: "idle", error: null };
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({
    status: "loading",
    member: null,
    error: null,
  });
  const [notice, setNotice] = useState<Notice>(null);
  const [revision, setRevision] = useState(0);
  const [logoutState, setLogoutState] = useState<LogoutState>(idle);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const authenticatedBefore = useRef(false);
  const loggingOut = useRef(false);
  const clear = useCallback((nextNotice?: Notice) => {
    ++generation.current;
    pending.current?.abort();
    http.cancelPending();
    setNotice(
      nextNotice === undefined
        ? authenticatedBefore.current
          ? "expired"
          : null
        : nextNotice,
    );
    authenticatedBefore.current = false;
    setLogoutState(idle);
    setRevision((v) => v + 1);
    setState({ status: "anonymous", member: null, error: null });
  }, []);
  const refresh = useCallback(async (): Promise<RefreshResult> => {
    const id = ++generation.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setState({ status: "loading", member: null, error: null });
    try {
      const member = readMember(
        await http.request<unknown>("/v1/me", { signal: controller.signal }),
      );
      if (id !== generation.current || controller.signal.aborted)
        return "superseded";
      authenticatedBefore.current = true;
      setNotice(null);
      setRevision((v) => v + 1);
      setState({ status: "authenticated", member, error: null });
      return "authenticated";
    } catch (error) {
      // The shared 401 listener clears private state and cancels pending reads.
      if (error instanceof ApiError && error.status === 401) return "anonymous";
      if (id !== generation.current || controller.signal.aborted)
        return "superseded";
      if (
        error instanceof ApiError &&
        [403, 409].includes(error.status) &&
        authSettings.nicknameRequiredCode &&
        error.code === authSettings.nicknameRequiredCode
      ) {
        setState({ status: "profile-required", member: null, error: null });
        return "profile-required";
      }
      setState({
        status: "error",
        member: null,
        error:
          error instanceof Error
            ? error
            : new Error("회원 정보를 확인할 수 없습니다."),
      });
      return "error";
    }
  }, []);
  const logout = useCallback(async () => {
    if (loggingOut.current) return;
    loggingOut.current = true;
    // Hide private consumers and cancel their reads as soon as logout begins.
    http.cancelPending();
    setLogoutState({ phase: "pending", error: null });
    try {
      await http.request("/v1/auth/logout", { method: "POST" });
      clear("logout");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) clear("logout");
      else
        setLogoutState({
          phase:
            error instanceof ApiError && error.outcomeUnknown
              ? "uncertain"
              : "failed",
          error:
            error instanceof Error
              ? error
              : new Error("로그아웃을 처리하지 못했습니다."),
        });
    } finally {
      loggingOut.current = false;
    }
  }, [clear]);
  const verifyLogout = useCallback(async () => {
    const result = await refresh();
    if (result === "anonymous") clear("logout");
    else if (result === "authenticated" || result === "profile-required")
      setLogoutState({
        phase: "failed",
        error: new Error("로그인이 유지되고 있습니다. 다시 로그아웃해 주세요."),
      });
    // If the read also fails, keep the uncertain state and hide private pages.
  }, [clear, refresh]);
  const dismissLogoutError = useCallback(
    () =>
      setLogoutState((current) =>
        current.phase === "failed" ? idle : current,
      ),
    [],
  );
  useEffect(() => {
    const unsubscribe = http.onUnauthorized(() => clear());
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
    <Context.Provider
      value={{
        ...state,
        refresh,
        clear,
        revision,
        notice,
        logoutState,
        logout,
        verifyLogout,
        dismissLogoutError,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useSession() {
  const value = useContext(Context);
  if (!value) throw new Error("SessionProvider 안에서 사용해 주세요.");
  return value;
}
