import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../auth/SessionProvider";
import { UsageGuide } from "./UsageGuide";
import { NicknameEditor } from "./NicknameEditor";
import { readVisibility, type Visibility } from "./settings";
import "./settings.css";
import { NotificationPreferences } from "../notifications/NotificationPreferences";
import { p1Enabled } from "../p1";
import { useCinemaWording } from "../../shared/cinema-wording";

export function SettingsPage() {
  const session = useSession();
  const memberId = session.member?.memberId;
  const [saved, setSaved] = useState<Visibility | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Cinema app: no "설정 다시 확인" unless a read is needed
  // (src/shared/cinema-wording); develop keeps its button as it is.
  const cinema = useCinemaWording();
  const request = useRef<AbortController | null>(null);
  const locked = useRef(false);

  async function read(signal: AbortSignal) {
    return readVisibility(await api<unknown>("/v1/me", { signal }), memberId);
  }
  async function load() {
    if (locked.current || !memberId) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setSaved(null);
    try {
      const value = await read(controller.signal);
      if (controller.signal.aborted) return;
      setSaved(value);
    } catch {
      if (!controller.signal.aborted)
        setError("설정을 불러오지 못했습니다. 다시 확인해 주세요.");
    } finally {
      if (!controller.signal.aborted) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    locked.current = false;
    void load();
    return () => {
      request.current?.abort();
      locked.current = false;
    };
  }, [memberId]);

  async function save(desired: Visibility) {
    if (locked.current || saved === null || saved === desired) return;
    const controller = new AbortController();
    request.current = controller;
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = readVisibility(
        await api<unknown>("/v1/me/settings", {
          method: "PATCH",
          json: { starListVisibility: desired },
          signal: controller.signal,
        }),
      );
      if (controller.signal.aborted) return;
      if (value !== desired) throw new Error("Unexpected saved value");
      setSaved(value);
      setNotice("공개 설정을 저장했습니다.");
    } catch {
      if (controller.signal.aborted) return;
      // A failed/lost write is never replayed. Read the authoritative value once.
      setSaved(null);
      try {
        const value = await read(controller.signal);
        if (controller.signal.aborted) return;
        setSaved(value);
        if (value === desired)
          setNotice(
            "저장 응답은 확인하지 못했지만, 현재 설정이 선택한 값과 일치합니다.",
          );
        else
          setError(
            "선택한 값으로 저장되지 않았습니다. 현재 설정을 확인하고 다시 저장해 주세요.",
          );
      } catch {
        if (!controller.signal.aborted)
          setError(
            cinema
              ? "저장되었는지 확인하지 못했습니다. '다시 불러오기'를 눌러 주세요."
              : "저장 여부를 확인할 수 없습니다. 설정 다시 확인을 눌러 주세요.",
          );
      }
    } finally {
      if (!controller.signal.aborted) {
        locked.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section className="explorer-settings" aria-labelledby="settings-title">
      <header>
        <h1 id="settings-title">설정</h1>
      </header>
      <section className="settings-row">
        <h2>프로필</h2>
        <div>
          {session.member && (
            <NicknameEditor
              memberId={session.member.memberId}
              nickname={session.member.nickname}
              active={!busy}
            />
          )}
        </div>
      </section>
      <section className="settings-row" aria-labelledby="guide-settings-title">
        <h2 id="guide-settings-title">탐사 안내</h2>
        <div>
          <h3>탐사의 다섯 단계</h3>
          <p>별 선택부터 제출까지, 그림과 함께 다시 살펴보세요.</p>
          <UsageGuide />
        </div>
      </section>
      <section className="settings-row" aria-labelledby="visibility-title">
        <h2 id="visibility-title">공개 범위</h2>
        <div aria-busy={busy}>
          <div className="settings-switchline">
            <span>내 은하·별 목록 공개</span>
            {saved !== null && (
              <button
                type="button"
                className="settings-switch"
                role="switch"
                aria-label="내 은하·별 목록 공개"
                aria-checked={saved === "PUBLIC"}
                aria-describedby="visibility-help"
                disabled={busy}
                onClick={() =>
                  void save(saved === "PUBLIC" ? "PRIVATE" : "PUBLIC")
                }
              >
                <span />
              </button>
            )}
          </div>
          <p id="visibility-help">
            다른 탐사자에게 전체 보유 별의 은하와 별 목록을 보여줍니다. 개인
            분석 기록은 공개하지 않습니다.
          </p>
          <small>
            공개한 글과 판단 분포, 성과 요약의 공개 여부는 바뀌지 않습니다.
          </small>
          <p className="settings-current">
            현재 설정:{" "}
            {saved === null
              ? busy
                ? "확인 중"
                : "확인 필요"
              : saved === "PUBLIC"
                ? "공개"
                : "비공개"}
          </p>
          {cinema ? (
            (saved === null || error) && (
              <div className="settings-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void load()}
                >
                  {busy ? "불러오는 중…" : "다시 불러오기"}
                </button>
              </div>
            )
          ) : (
            <div className="settings-actions">
              <button type="button" disabled={busy} onClick={() => void load()}>
                {busy ? "설정 확인 중…" : "설정 다시 확인"}
              </button>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          <p role="status">{notice}</p>
        </div>
      </section>
      {p1Enabled && <NotificationPreferences />}
      <section className="settings-row">
        <h2>계정</h2>
        <div>
          {p1Enabled && (
            <p>
              <Link to="/settings/withdrawal">계정 탈퇴 안내</Link>
            </p>
          )}
          <button type="button" onClick={() => void session.logout()}>
            로그아웃
          </button>
        </div>
      </section>
    </section>
  );
}
