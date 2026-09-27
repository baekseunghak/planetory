// Demo scenario switch for the dev:cinema review server only.
//
// Mounted by CinemaRoot (above the routes, so it also works on /login) when
// `import.meta.env.DEV && import.meta.env.VITE_CINEMA_DEMO === "true"`; a
// build never contains it (scripts/check-production.mjs fails on the string
// "dev-cinema"). Endpoints and scenarios: dev/cinema-scenarios.ts.
//
// A faint "DEMO" tab at the top centre (or Alt+Shift+D) opens the panel:
// switch account (a full page load of /api/dev-cinema/session?as=..., which
// builds a fresh world), start from the login page, jump to another
// explorer's galaxy, or rebuild the current world. When the endpoint does
// not answer (not the fixture server) nothing is shown.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  DemoScenarioId,
  DemoScenarioList,
} from "../../../../dev/cinema-scenarios";
import "./demo.css";

const BASE = "/api/dev-cinema";
const number = (value: number) => value.toLocaleString("ko-KR");

/** Drafts belong to the world they were written in. */
function forgetDrafts() {
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith("planetory:analysis-draft:"))
        sessionStorage.removeItem(key);
  } catch {
    /* storage blocked: the switch page clears them too */
  }
}

export default function DemoSwitch() {
  const [list, setList] = useState<DemoScenarioList | null>(null);
  const [open, setOpen] = useState(false);
  const [fromLogin, setFromLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const root = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${BASE}/scenarios`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(String(response.status));
      setList((await response.json()) as DemoScenarioList);
    } catch {
      setList(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.shiftKey && event.code === "KeyD") {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, []);

  if (!list) return null;
  const current = list.current;
  const anonymous = current.session === "anonymous";
  const scenarioLabel =
    list.scenarios.find((item) => item.id === current.scenario)?.label ??
    current.scenario;

  const go = (as: DemoScenarioId | "anonymous", stars?: number) => {
    setBusy(true);
    forgetDrafts();
    const query = new URLSearchParams({ as });
    if (stars) query.set("stars", String(stars));
    if (fromLogin && as !== "anonymous") query.set("start", "login");
    window.location.assign(`${BASE}/session?${query}`);
  };
  const rebuild = async () => {
    setBusy(true);
    try {
      await fetch(`${BASE}/reset`, { method: "POST" });
    } finally {
      forgetDrafts();
      window.location.assign(anonymous ? "/login" : "/sky");
    }
  };

  return (
    <div
      ref={root}
      className="dev-demo"
      data-dev-cinema-demo=""
      data-open={open ? "true" : "false"}
    >
      <button
        type="button"
        className="dev-demo-tab"
        // Not a Tab stop on stage; Alt+Shift+D opens it.
        tabIndex={open ? 0 : -1}
        aria-expanded={open}
        aria-controls="dev-demo-panel"
        title="데모 계정 전환 (Alt+Shift+D)"
        onClick={() => setOpen((value) => !value)}
      >
        DEMO
        <span>{anonymous ? "로그아웃" : scenarioLabel}</span>
      </button>
      {open && (
        <div
          id="dev-demo-panel"
          className="dev-demo-panel"
          role="dialog"
          aria-label="데모 계정 전환"
        >
          <p className="dev-demo-title">
            데모 계정 <small>개발 서버 전용 · Alt+Shift+D</small>
          </p>
          <ul className="dev-demo-scenarios">
            {list.scenarios.map((scenario) => (
              <li key={scenario.id}>
                {scenario.id === "veteran" ? (
                  <div className="dev-demo-row">
                    <span className="dev-demo-name">
                      {scenario.label}
                      {current.scenario === scenario.id && !anonymous && (
                        <em>지금</em>
                      )}
                    </span>
                    <span className="dev-demo-sizes">
                      {list.veteranStarOptions.map((stars) => (
                        <button
                          key={stars}
                          type="button"
                          disabled={busy}
                          onClick={() => go("veteran", stars)}
                        >
                          별 {number(stars)}
                        </button>
                      ))}
                    </span>
                    <small>{scenario.description}</small>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="dev-demo-row"
                    disabled={busy}
                    onClick={() => go(scenario.id)}
                  >
                    <span className="dev-demo-name">
                      {scenario.label}
                      {current.scenario === scenario.id && !anonymous && (
                        <em>지금</em>
                      )}
                    </span>
                    <small>{scenario.description}</small>
                  </button>
                )}
              </li>
            ))}
          </ul>
          <label className="dev-demo-check">
            <input
              type="checkbox"
              checked={fromLogin}
              onChange={(event) => setFromLogin(event.target.checked)}
            />
            로그인 화면에서 시작
          </label>
          {!anonymous && (
            <>
              <p className="dev-demo-subtitle">다른 탐사자의 은하</p>
              <ul className="dev-demo-members">
                {list.members.map((member) => (
                  <li key={member.memberId}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        navigate(
                          `/members/${encodeURIComponent(member.memberId)}/sky`,
                        );
                      }}
                    >
                      <span>{member.nickname}</span>
                      <small>
                        {member.visibility === "PUBLIC"
                          ? `별 ${number(member.starCount)}`
                          : "비공개"}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="dev-demo-footer">
            <button
              type="button"
              disabled={busy}
              onClick={() => void rebuild()}
            >
              지금 세계 처음으로
            </button>
            <button
              type="button"
              disabled={busy || anonymous}
              onClick={() => go("anonymous")}
            >
              로그아웃 상태로
            </button>
          </div>
          <p className="dev-demo-status">
            {scenarioLabel} · 발견한 별 {number(current.starCount)} ·{" "}
            {current.realSample.loaded
              ? `실제 TESS 별 ${current.realSample.stars}개`
              : "합성 자료만"}
          </p>
        </div>
      )}
    </div>
  );
}
