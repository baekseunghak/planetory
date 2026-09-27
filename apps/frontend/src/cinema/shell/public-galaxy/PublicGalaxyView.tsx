// Another explorer's galaxy, drawn in the one scene (stage `public`).
// Read only: the owner's name stays on screen, stars open a panel with the
// owner's planets, there is no analysis action and one step back home.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Link,
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api, ApiError } from "../../../api";
import { useSession } from "../../../auth/SessionProvider";
import { SkyDataStore } from "../../../features/sky-data/store";
import {
  publicTiles,
  readPublicMeta,
  readPublicSystem,
} from "../../../features/public-sky/contracts";
import {
  readFollowing,
  type FollowTarget,
} from "../../../features/follow/contracts";
import { FollowButton } from "../../../features/follow/Follow";
import { readProfile } from "../../../features/profile/contracts";
import type { OwnedSystem } from "../../../features/sky-renderer/model";
import type { Star } from "../../../features/sky-data/contracts";
import {
  sceneSystemFrom,
  useScene,
  useSceneState,
  type SceneController,
} from "../../scene";
import { usePanelCover } from "../../ui/usePanelSize";
import { useShell } from "../context";
import { HoverLabel, PlanetLabels } from "../ScreenLabels";
import { useCinemaSky } from "../sky";
import { progressLabel } from "../StarPanel";
import { fullSkyView } from "../stage";
import "./public-galaxy.css";

const TIC = /^\d{1,19}$/;
const number = (value: number) => value.toLocaleString("ko-KR");
const profilePath = (memberId: string) =>
  `/members/${encodeURIComponent(memberId)}`;
const galaxyPath = (memberId: string) => `${profilePath(memberId)}/sky`;
const emptySnapshot = new SkyDataStore(async () => undefined, "").getSnapshot();
const noSubscribe = () => () => {};

export function PublicGalaxyView() {
  const { memberId = "" } = useParams();
  const { member } = useSession();
  if (!member) return null;
  if (memberId === member.memberId) return <Navigate to="/sky" replace />;
  return <PublicGalaxy key={memberId} memberId={memberId} />;
}

/** The owner's sky store: meta, then every star at the coarsest level. */
function usePublicSky(memberId: string) {
  const [loaded, setLoaded] = useState<{
    store: SkyDataStore;
    nickname: string;
  } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // The owner's name when the galaxy itself cannot be shown (private).
  const [profileName, setProfileName] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const path = `/v1/members/${encodeURIComponent(memberId)}`;
    let store: SkyDataStore | null = null;
    setError(null);
    setLoaded(null);
    setProfileName(null);
    void (async () => {
      try {
        const meta = readPublicMeta(
          await api(`${path}/sky`, { signal: controller.signal }),
          memberId,
        );
        if (controller.signal.aborted) return;
        let first = true;
        store = new SkyDataStore(async (request, options) => {
          if (request === "/v1/me/sky" && first) {
            first = false;
            return meta;
          }
          const value = await api(request.replace("/v1/me", path), options);
          return request.includes("/sky/tiles")
            ? publicTiles(value)
            : readPublicMeta(value, memberId);
        }, `public:${memberId}`);
        setLoaded({ store, nickname: meta.owner.nickname });
        void store.setView(fullSkyView(meta));
        void store.refresh();
      } catch (reason) {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason : new Error(String(reason)));
        try {
          const profile = readProfile(
            await api(path, { signal: controller.signal }),
            memberId,
            false,
          );
          if (!controller.signal.aborted) setProfileName(profile.nickname);
        } catch {
          /* no name either: the card says 탐사자 */
        }
      }
    })();
    return () => {
      controller.abort();
      store?.dispose();
    };
  }, [memberId, attempt]);
  const data = useSyncExternalStore(
    loaded?.store.subscribe ?? noSubscribe,
    loaded?.store.getSnapshot ?? (() => emptySnapshot),
  );
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return {
    store: loaded?.store ?? null,
    nickname: loaded?.nickname ?? profileName,
    data,
    error: error ?? (loaded ? data.error : null),
    retry,
  };
}

function PublicGalaxy({ memberId }: { memberId: string }) {
  const scene = useScene();
  const sceneState = useSceneState();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requested = params.get("star");
  const ticId = requested && TIC.test(requested) ? requested : null;
  const sky = usePublicSky(memberId);
  const { data } = sky;
  const meta = data.meta;
  const complete = !!meta && data.loadedCount === meta.starCount;
  const planets = useMemo(
    () =>
      complete
        ? data.stars.reduce((sum, star) => sum + star.planetCount, 0)
        : null,
    [complete, data.stars],
  );

  // The login fly-in (a fresh load) owns the camera until it starts, and the
  // stage director moves it in the same commit as this view (when the engine
  // registers, say). So this view moves the camera only after the intro has
  // started, and one task later than the director.
  const intro = sceneState.mode === "intro";
  const selected = useRef(ticId);
  selected.current = ticId;

  // ---- feed the scene with the owner's stars, frame them once per engine
  useEffect(() => {
    if (!meta || (!data.stars.length && data.phase !== "ready")) return;
    try {
      scene.setStars(data.stars, meta);
    } catch (error) {
      console.error("scene setStars failed", error);
    }
  }, [scene, meta, data.stars, data.phase]);
  const framed = useRef<SceneController | null>(null);
  const hasStars = data.stars.length > 0;
  useEffect(() => {
    if (intro || !hasStars || framed.current === scene) return;
    const timer = window.setTimeout(() => {
      framed.current = scene;
      if (!selected.current) void scene.showOverview();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [scene, intro, hasStars]);

  // Leaving: my galaxy is fed back by SkyProvider; frame it once the next
  // stage has had its turn (a star flight or a page keeps its own camera).
  useEffect(
    () => () => {
      try {
        scene.setSystem(null);
      } catch (error) {
        console.error("scene reset failed", error);
      }
      window.setTimeout(() => {
        const state = scene.getState();
        if (state.mode === "galaxy" && !state.focusedTicId)
          void scene.showOverview();
      }, 160);
    },
    [scene],
  );

  // ---- selection (?star=), flights and the owner's system
  const select = useCallback(
    (tic: string) => {
      const next = new URLSearchParams(params);
      if (next.get("star") === tic) return;
      next.set("star", tic);
      setParams(next);
    },
    [params, setParams],
  );
  const close = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete("star");
    setParams(next, { replace: true });
  }, [params, setParams]);
  useEffect(
    () => scene.onStarClick((pointer) => select(pointer.ticId)),
    [scene, select],
  );
  const shown = useRef<string | null>(null);
  const systemRef = useRef<OwnedSystem | null>(null);
  useEffect(() => {
    if (intro) return;
    const previous = shown.current;
    shown.current = ticId;
    const timer = window.setTimeout(() => {
      if (ticId)
        // The director may clear the system when its own move is superseded;
        // the arrival puts the owner's planets back.
        void scene.focusStar(ticId).then(() => {
          const system = systemRef.current;
          if (shown.current === ticId && system?.ticId === ticId)
            scene.setSystem(sceneSystemFrom(system));
        });
      else if (previous)
        void scene.returnToGalaxy().then(() => {
          if (!shown.current) scene.setSystem(null);
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [scene, ticId, intro]);

  const [system, setSystem] = useState<OwnedSystem | null>(null);
  systemRef.current = system;
  const [systemError, setSystemError] = useState<Error | null>(null);
  const [systemAttempt, setSystemAttempt] = useState(0);
  const latest = useRef(data);
  latest.current = data;
  useEffect(() => {
    setSystem(null);
    setSystemError(null);
    const current = latest.current.meta;
    if (!ticId || !current) return;
    const controller = new AbortController();
    void api(
      `/v1/members/${encodeURIComponent(memberId)}/stars/${encodeURIComponent(ticId)}`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setSystem(
          readPublicSystem(
            value,
            current,
            ticId,
            memberId,
            latest.current.stars.find((star) => star.ticId === ticId),
          ),
        );
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setSystemError(
            reason instanceof Error ? reason : new Error(String(reason)),
          );
      });
    return () => controller.abort();
  }, [memberId, ticId, meta?.version, systemAttempt]);
  useEffect(() => {
    if (system && system.ticId === ticId)
      scene.setSystem(sceneSystemFrom(system));
  }, [scene, system, ticId]);

  const [planet, setPlanet] = useState<string | null>(null);
  useEffect(() => setPlanet(null), [ticId]);
  useEffect(() => {
    scene.focusPlanet(ticId ? planet : null);
  }, [scene, ticId, planet]);
  useEffect(
    () =>
      scene.onPlanetClick((pointer) => {
        if (ticId) setPlanet(pointer.candidateId);
      }),
    [scene, ticId],
  );

  // Esc on a star returns to the owner's galaxy.
  useEffect(() => {
    if (!ticId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const node = event.target instanceof Element ? event.target : null;
      if (node?.closest("input, select, textarea, dialog, details[open]"))
        return;
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ticId, close]);

  const goHome = useCallback(() => navigate("/sky"), [navigate]);
  const nickname = sky.nickname;
  const unavailable =
    sky.error instanceof ApiError &&
    (sky.error.code === "PUBLIC_SKY_NOT_AVAILABLE" || sky.error.status === 404);
  const detailItems = system && system.ticId === ticId ? system.items : null;

  return (
    <div
      className="cinema-galaxy cinema-public"
      data-stage={ticId ? "system" : "galaxy"}
      data-scene-ready={sceneState.ready ? "true" : "false"}
      data-owner={memberId}
      data-public-loaded={complete ? "true" : "false"}
    >
      <h1 className="cinema-sr-only">
        {nickname ? `${nickname}의 은하` : "다른 탐사자의 은하"}
        {ticId ? ` · TIC ${ticId}` : ""}
      </h1>
      <section className="cinema-public-owner" aria-label="은하 주인">
        <p className="cinema-eyebrow">다른 탐사자의 은하 · 읽기 전용</p>
        <p className="cinema-public-name">
          {nickname ?? (sky.error ? "탐사자" : "불러오는 중")}
        </p>
        {meta && (
          <p className="cinema-public-counts">
            <span>
              공개한 별 <b>{number(meta.starCount)}</b>
            </span>
            {planets !== null && (
              <span>
                찾은 행성 <b>{number(planets)}</b>
              </span>
            )}
          </p>
        )}
        {meta && !complete && !sky.error && (
          <p className="cinema-public-status" role="status">
            별을 불러오고 있습니다 · {number(data.loadedCount)} /{" "}
            {number(meta.starCount)}
          </p>
        )}
        <div className="cinema-public-actions">
          <button type="button" className="cinema-primary" onClick={goHome}>
            ← 나의 은하로
          </button>
          <Link className="cinema-secondary" to={profilePath(memberId)}>
            프로필
          </Link>
          {nickname && (
            <span className="cinema-public-follow">
              <FollowButton
                target={{ kind: "MEMBER", id: memberId, label: nickname }}
              />
            </span>
          )}
        </div>
      </section>

      {sky.error && (
        <div className="cinema-public-error" role="alert">
          <p>
            {unavailable
              ? "이 탐사자의 은하는 공개되어 있지 않습니다. 공개 범위가 바뀌었거나 없는 탐사자일 수 있습니다."
              : "은하를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요."}
          </p>
          <div>
            {!unavailable && (
              <button type="button" className="cinema-pill" onClick={sky.retry}>
                다시 불러오기
              </button>
            )}
            <button type="button" className="cinema-pill" onClick={goHome}>
              나의 은하로 돌아가기
            </button>
          </div>
        </div>
      )}

      {meta && <HoverLabel stars={data.stars} />}
      {detailItems && <PlanetLabels planets={detailItems} selected={planet} />}

      <div className="cinema-tools" data-hidden={ticId ? "true" : "false"}>
        <ExplorerList current={memberId} />
      </div>
      <div className="cinema-corner">
        <button
          type="button"
          className="cinema-pill"
          onClick={() => (ticId ? close() : void scene.showOverview())}
        >
          전체 보기
        </button>
      </div>

      {sceneState.failed && meta && !ticId && (
        <FallbackList stars={data.stars} onSelect={select} />
      )}

      {ticId && (
        <PublicStarPanel
          ticId={ticId}
          nickname={nickname ?? "탐사자"}
          star={data.stars.find((star) => star.ticId === ticId) ?? null}
          system={detailItems ? system : null}
          error={systemError}
          retry={() => setSystemAttempt((n) => n + 1)}
          planet={planet}
          onPlanet={setPlanet}
          onClose={close}
        />
      )}
    </div>
  );
}

function PublicStarPanel({
  ticId,
  nickname,
  star,
  system,
  error,
  retry,
  planet,
  onPlanet,
  onClose,
}: {
  ticId: string;
  nickname: string;
  star: Star | null;
  system: OwnedSystem | null;
  error: Error | null;
  retry(): void;
  planet: string | null;
  onPlanet(candidateId: string | null): void;
  onClose(): void;
}) {
  const { reportPanel } = useShell();
  const mine = useCinemaSky().data.stars.some((item) => item.ticId === ticId);
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  usePanelCover(panel, "right", (px) => reportPanel("right", px));
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [ticId]);
  const items = system?.items ?? [];
  const selected = items.find((item) => item.candidateId === planet) ?? null;
  return (
    <aside
      ref={panel}
      className={`cinema-star-panel cinema-public-panel${system ? " is-ready" : ""}`}
      aria-label={`${nickname}의 별`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="cinema-star-head">
        <button type="button" className="cinema-back" onClick={onClose}>
          ← {nickname}의 은하
        </button>
        <p className="cinema-eyebrow">{nickname}의 별</p>
        <h2 ref={heading} tabIndex={-1}>
          TIC {ticId}
        </h2>
        {star && (
          <p className="cinema-star-status">
            <span data-stage={star.progressStage}>
              {progressLabel[star.progressStage]}
            </span>
          </p>
        )}
      </div>
      {!system && !error && (
        <p role="status" className="cinema-muted">
          이 탐사자가 찾은 행성을 불러오고 있습니다.
        </p>
      )}
      {error && (
        <div role="alert" className="cinema-alert">
          <p>
            {error instanceof ApiError && error.status === 404
              ? "이 별은 지금 공개되어 있지 않습니다."
              : "별 정보를 불러오지 못했습니다."}
          </p>
          <button type="button" className="cinema-pill" onClick={retry}>
            다시 불러오기
          </button>
        </div>
      )}
      {system && (
        <section
          className="cinema-planets"
          aria-labelledby="cinema-public-planets"
        >
          <div className="cinema-planets-head">
            <h3 id="cinema-public-planets">
              {nickname}님이 찾은 행성{" "}
              <b className="cinema-num">{items.length}</b>개
            </h3>
            <button
              type="button"
              className="cinema-mini"
              aria-pressed={planet === null}
              onClick={() => onPlanet(null)}
            >
              항성계
            </button>
          </div>
          {!items.length ? (
            <p className="cinema-muted">
              아직 공개한 행성이 없습니다. 이 별의 실제 행성 유무와는 다를 수
              있습니다.
            </p>
          ) : (
            <ul className="cinema-planet-list" aria-label="공개 행성 목록">
              {items.map((item, index) => (
                <li key={item.candidateId}>
                  <button
                    type="button"
                    aria-pressed={selected?.candidateId === item.candidateId}
                    onClick={() => onPlanet(item.candidateId)}
                  >
                    <i
                      className="cinema-orbit-glyph"
                      data-kind={item.kind}
                      aria-hidden="true"
                    />
                    <span>행성 {index + 1}</span>
                    <small>
                      {item.kind === "confirmed" ? "확인된 행성" : "후보"}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {selected && (
            <div className="cinema-planet-info" aria-live="polite">
              <h3>행성 {items.indexOf(selected) + 1}</h3>
              <dl className="cinema-facts">
                <dt>분류</dt>
                <dd>
                  {selected.kind === "confirmed"
                    ? "확인된 행성"
                    : "아직 확인되지 않은 후보"}
                </dd>
                <dt>반복 주기</dt>
                <dd>
                  {selected.periodDays === null ? (
                    "정보 없음"
                  ) : (
                    <>
                      <span className="cinema-num">{selected.periodDays}</span>
                      일
                    </>
                  )}
                </dd>
                <dt>어두워진 정도</dt>
                <dd>
                  {selected.depthPpm === null ? (
                    "정보 없음"
                  ) : (
                    <span className="cinema-num">{selected.depthPpm} ppm</span>
                  )}
                </dd>
              </dl>
            </div>
          )}
          <p className="cinema-caption">
            표면과 궤도는 이해를 돕기 위한 시각화입니다.
          </p>
        </section>
      )}
      <div className="cinema-public-note">
        <p className="cinema-muted">
          다른 탐사자의 별은 볼 수만 있습니다. 분석은 내 은하의 별에서 합니다.
        </p>
        {mine && (
          <Link
            className="cinema-link"
            to={`/sky?star=${encodeURIComponent(ticId)}`}
          >
            내 은하에서 이 별 보기 →
          </Link>
        )}
      </div>
    </aside>
  );
}

/** Explorers I follow and who follow me: a short hop between galaxies. */
function ExplorerList({ current }: { current: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FollowTarget[] | null>(null);
  const [failed, setFailed] = useState(false);
  const { member } = useSession();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    const read = (path: string) =>
      api(path, { signal: controller.signal }).then(
        (value) => readFollowing(value).items,
      );
    void Promise.all([
      read("/v1/me/following/members?size=20"),
      read("/v1/me/followers?size=20").catch(() => [] as FollowTarget[]),
    ])
      .then(([following, followers]) => {
        if (controller.signal.aborted) return;
        const seen = new Set<string>();
        setItems(
          [...following, ...followers].filter(
            (target) =>
              target.kind === "MEMBER" &&
              target.id !== member?.memberId &&
              !seen.has(target.id) &&
              seen.add(target.id),
          ),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [member?.memberId]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="cinema-tool cinema-explorers" ref={panel}>
      <button
        type="button"
        className="cinema-pill"
        aria-expanded={open}
        aria-controls="cinema-explorer-list"
        onClick={() => setOpen((value) => !value)}
      >
        다른 탐사자
        {items && items.length > 0 && (
          <span className="cinema-num">{items.length}</span>
        )}
      </button>
      {open && (
        <div id="cinema-explorer-list" className="cinema-explorer-panel">
          <p className="cinema-explorer-title">팔로우한 탐사자</p>
          {failed ? (
            <p className="cinema-muted">목록을 불러오지 못했습니다.</p>
          ) : !items ? (
            <p className="cinema-muted" role="status">
              불러오는 중입니다.
            </p>
          ) : !items.length ? (
            <p className="cinema-muted">
              아직 팔로우한 탐사자가 없습니다.{" "}
              <Link to="/community">커뮤니티에서 찾기</Link>
            </p>
          ) : (
            <ul>
              {items.map((target) => (
                <li key={target.id}>
                  <Link
                    to={galaxyPath(target.id)}
                    aria-current={target.id === current ? "page" : undefined}
                    onClick={() => setOpen(false)}
                  >
                    <span className="cinema-explorer-avatar" aria-hidden="true">
                      {target.label.slice(0, 1)}
                    </span>
                    <span>{target.label}</span>
                    <small>
                      {target.id === current ? "보는 중" : "은하 보기"}
                    </small>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** No WebGL: the owner's stars as a short list (the first 60 by ordinal). */
function FallbackList({
  stars,
  onSelect,
}: {
  stars: readonly Star[];
  onSelect(ticId: string): void;
}) {
  const rows = [...stars]
    .sort((a, b) => a.layoutOrdinal - b.layoutOrdinal)
    .slice(0, 60);
  return (
    <aside className="cinema-list-panel" aria-label="공개한 별 목록">
      <p role="status" className="cinema-notice">
        이 브라우저에서는 3D 은하를 그릴 수 없어 목록으로 보여 드립니다.
      </p>
      <ul className="cinema-public-fallback">
        {rows.map((star) => (
          <li key={star.ticId}>
            <button type="button" onClick={() => onSelect(star.ticId)}>
              <span className="cinema-num">TIC {star.ticId}</span>
              <small>
                {progressLabel[star.progressStage]}
                {star.planetCount ? ` · 행성 ${star.planetCount}` : ""}
              </small>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
