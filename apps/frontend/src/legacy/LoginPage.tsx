// develop's src/auth/LoginPage.tsx before the cinema shell (fbc7da7b~1),
// for VITE_CINEMA=false. Only import paths changed; its stylesheet is the
// restored ./auth-presentation.css.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { useSession } from "../auth/SessionProvider";
import { authSettings } from "../auth/settings";
import {
  callbackProblem,
  loginDestination,
  nicknameProblem,
  normalizedNickname,
  oauthDestination,
  returnStorageKey,
} from "../auth/flow";
import "../auth/auth.css";
import { GalaxyArtwork } from "../components/GalaxyArtwork";
import "./auth-presentation.css";

function savedReturn() {
  try {
    return sessionStorage.getItem(returnStorageKey);
  } catch {
    return null;
  }
}
export function LogoutStatus() {
  const session = useSession();
  const { phase, error } = session.logoutState;
  return (
    <main className="page auth-message">
      <span className="brand">PLANETORY</span>
      <h1>
        {phase === "pending"
          ? "로그아웃하고 있습니다"
          : phase === "uncertain"
            ? "로그아웃 여부를 확인해 주세요"
            : "로그아웃하지 못했습니다"}
      </h1>
      {phase === "pending" ? (
        <p role="status">로그인을 종료하는 동안 잠시 기다려 주세요.</p>
      ) : (
        <>
          <p role="alert">{error?.message}</p>
          {phase === "uncertain" ? (
            <button
              disabled={session.status === "loading"}
              onClick={() => void session.verifyLogout()}
            >
              로그인 상태 확인
            </button>
          ) : (
            <>
              <button onClick={() => void session.logout()}>
                다시 로그아웃
              </button>
              <button onClick={session.dismissLogoutError}>
                서비스로 돌아가기
              </button>
            </>
          )}
        </>
      )}
    </main>
  );
}
export function LoginPage() {
  const session = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const destination = useRef(loginDestination(location.search, savedReturn()));
  const callback = useRef(location.pathname === "/oauth/callback");
  const [problem, setProblem] = useState(() =>
    callback.current ? callbackProblem(location.search) : null,
  );
  const [nickname, setNickname] = useState("");
  const [formError, setFormError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const saving = useRef(false);
  const writeController = useRef<AbortController | null>(null);
  useEffect(() => () => writeController.current?.abort(), []);
  useEffect(() => {
    if (callback.current) {
      // Only a post-authentication UI landing page; never exchange OAuth codes here.
      navigate(
        {
          pathname: "/oauth/callback",
          search: `?${new URLSearchParams({ returnTo: destination.current })}`,
        },
        { replace: true },
      );
    }
  }, [navigate]);
  useEffect(() => {
    const restored = () => setStarting(false);
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);
  useEffect(() => {
    if (session.status === "authenticated" && !problem) {
      try {
        sessionStorage.removeItem(returnStorageKey);
      } catch {
        /* navigation still succeeds */
      }
    }
  }, [session.status, problem]);
  function start(provider: "ssafy" | "google") {
    const url = oauthDestination(
      authSettings[provider],
      window.location.origin,
    );
    if (!url || starting) return;
    try {
      sessionStorage.setItem(returnStorageKey, destination.current);
      setStarting(true);
      window.location.assign(url);
    } catch {
      setStarting(false);
      setFormError(
        new Error(
          "로그인을 시작하지 못했습니다. 브라우저 설정을 확인하고 다시 시도해 주세요.",
        ),
      );
    }
  }
  async function saveNickname(event: FormEvent) {
    event.preventDefault();
    if (saving.current) return;
    const invalid = nicknameProblem(nickname);
    if (invalid) {
      setFormError(new Error(invalid));
      return;
    }
    const path = authSettings.initialNicknamePath;
    if (!path || !path.startsWith("/v1/")) {
      setFormError(
        new Error(
          "닉네임 등록 연결을 준비하고 있습니다. 잠시 후 다시 시도해 주세요.",
        ),
      );
      return;
    }
    saving.current = true;
    setBusy(true);
    setFormError(null);
    writeController.current = new AbortController();
    try {
      await api(path, {
        method: "PATCH",
        json: { nickname: normalizedNickname(nickname) },
        signal: writeController.current.signal,
      });
      // A successful write alone never grants access: confirm the server's /me state.
      await session.refresh();
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error
          : new Error("닉네임을 저장하지 못했습니다."),
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  if (session.logoutState.phase !== "idle") return <LogoutStatus />;
  if (session.status === "authenticated" && !problem)
    return <Navigate replace to={destination.current} />;
  const profile = session.status === "profile-required" && !problem;
  const uncertain = formError instanceof ApiError && formError.outcomeUnknown;
  const fieldReason =
    formError instanceof ApiError
      ? formError.fieldErrors.find((error) => error.field === "nickname")
          ?.reason
      : null;
  const providerButtons = (
    <div className="auth-providers">
      {(["ssafy", "google"] as const).map((provider) => (
        <button
          key={provider}
          className={`auth-provider ${provider}`}
          disabled={
            starting ||
            !oauthDestination(authSettings[provider], window.location.origin)
          }
          onClick={() => start(provider)}
        >
          <span aria-hidden="true">{provider === "ssafy" ? "S" : "G"}</span>
          {provider === "ssafy" ? "SSAFY" : "Google"} 계정으로 로그인
          <span aria-hidden="true">↗</span>
        </button>
      ))}
      {(!authSettings.ssafy || !authSettings.google) && (
        <p className="auth-note">일부 로그인 연결을 준비하고 있습니다.</p>
      )}
    </div>
  );
  return (
    <main className="auth-page auth-presentation">
      <section className="auth-universe" aria-label="Planetory 소개">
        <Link className="brand" to="/login">
          PLANETORY
        </Link>
        <div className="auth-galaxy">
          <GalaxyArtwork decorative />
        </div>
        <div className="auth-intro">
          <p className="eyebrow">A UNIVERSE OF YOUR OWN</p>
          <h1>
            나의 발견으로
            <br />
            채워지는 밤하늘
          </h1>
          <p>
            별빛의 변화를 살펴 행성의 흔적을 찾고,
            <br />
            발견을 나의 은하에 모으세요.
          </p>
        </div>
        <span className="auth-caption">
          별빛을 읽고, 새로운 세계를 발견하다
        </span>
      </section>
      <section className="auth-content" aria-labelledby="auth-title">
        <p className="eyebrow">
          {profile ? "FIRST CONTACT" : "WELCOME, EXPLORER"}
        </p>
        <h2 id="auth-title">
          {profile
            ? "어떤 이름으로 탐사할까요?"
            : problem === "cancelled"
              ? "로그인이 취소되었습니다"
              : problem === "unavailable"
                ? "로그인 서비스를 잠시 이용할 수 없습니다"
                : problem === "failed"
                  ? "로그인을 완료하지 못했습니다"
                  : session.status === "error"
                    ? "회원 정보를 확인하지 못했습니다"
                    : callback.current && session.status === "anonymous"
                      ? "로그인을 확인하지 못했습니다"
                      : "로그인이 필요합니다"}
        </h2>
        {session.notice === "expired" && (
          <p role="status">로그인이 만료되었습니다. 다시 로그인해 주세요.</p>
        )}
        {session.notice === "logout" && (
          <p role="status">로그아웃되었습니다.</p>
        )}
        {problem ? (
          <>
            <p role="alert">
              {problem === "cancelled"
                ? "준비되면 다시 로그인해 주세요."
                : problem === "unavailable"
                  ? "서버에 일시적인 문제가 생겼습니다. 잠시 후 다시 시도해 주세요."
                  : "로그인 과정에 문제가 생겼습니다. 다시 시도해 주세요."}
            </p>
            <button
              onClick={() => {
                setProblem(null);
                callback.current = false;
                navigate(
                  `/login?${new URLSearchParams({ returnTo: destination.current })}`,
                  { replace: true },
                );
              }}
            >
              로그인 화면으로
            </button>
          </>
        ) : session.status === "loading" ? (
          <p role="status">로그인 정보를 확인하고 있습니다.</p>
        ) : profile ? (
          <form onSubmit={(event) => void saveNickname(event)}>
            <label htmlFor="initial-nickname">닉네임</label>
            <input
              id="initial-nickname"
              value={nickname}
              onChange={(event) => {
                setNickname(event.target.value);
                if (!uncertain) setFormError(null);
              }}
              disabled={busy || uncertain}
              autoComplete="nickname"
              aria-describedby="nickname-help nickname-error"
              aria-invalid={Boolean(formError)}
            />
            <p id="nickname-help" className="auth-note">
              2~20자 · 한글, 영문, 숫자, 밑줄 사용 가능
            </p>
            <p id="nickname-error" role={formError ? "alert" : undefined}>
              {fieldReason || formError?.message}
            </p>
            {uncertain ? (
              <>
                <p>
                  저장되었을 수 있습니다. 다시 제출하기 전에 등록 여부를 확인해
                  주세요.
                </p>
                <button
                  type="button"
                  onClick={() =>
                    void session.refresh().then((result) => {
                      if (result === "profile-required") setFormError(null);
                    })
                  }
                >
                  저장 여부 확인
                </button>
              </>
            ) : (
              <button className="auth-submit" disabled={busy} type="submit">
                {busy ? "저장하고 있습니다" : "이 이름으로 시작하기"}
              </button>
            )}
            <button
              className="auth-text-action"
              type="button"
              disabled={busy}
              onClick={() => void session.logout()}
            >
              다른 계정으로 로그인
            </button>
          </form>
        ) : (
          <>
            {session.status === "error" ? (
              <p role="alert">{session.error.message}</p>
            ) : (
              <p>계정으로 로그인하고 탐사를 이어가세요.</p>
            )}
            {providerButtons}
            {starting && (
              <p role="status">로그인 페이지로 이동하고 있습니다.</p>
            )}
            {formError && <p role="alert">{formError.message}</p>}
            <button
              className="auth-text-action"
              onClick={() => void session.refresh()}
            >
              로그인 상태 다시 확인
            </button>
          </>
        )}
        <p className="auth-footnote">
          서로 다른 제공자의 계정은 각각의 탐사 기록을 가집니다.
        </p>
      </section>
    </main>
  );
}
