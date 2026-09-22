import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../auth/SessionProvider";
import { ErrorState, LoadingState } from "../../components/RequestState";
import { SkyDataStore } from "../sky-data/store";
import type { SkySceneProps } from "../sky-data/SkyDataPage";
import { GalaxyScene, type SceneControl } from "../sky-renderer/GalaxyScene";
import type { GalaxyCamera, OwnedSystem } from "../sky-renderer/model";
import { PersonalSceneControls } from "../sky-renderer/PersonalSceneControls";
import { INITIAL_SYSTEM, signalSeed } from "../sky-renderer/personal-system";
import { readPublicMeta, readPublicSystem, publicTiles, publicStarLabel } from "./contracts";
import "../sky-renderer/detail-presentation.css";
import "./public-sky.css";
const empty = new SkyDataStore(async () => undefined, "").getSnapshot();
const noSubscribe = () => () => {};
const getEmpty = () => empty;
export function PublicSkyPage() {
  const { memberId = "" } = useParams(),
    { member } = useSession();
  return memberId === member?.memberId ? (
    <Navigate to="/sky" replace />
  ) : member ? (
    <PublicSky key={member.memberId + ":" + memberId} memberId={memberId} />
  ) : null;
}
function PublicSky({ memberId }: { memberId: string }) {
  const [resource, setResource] = useState<{
      store: SkyDataStore;
      nickname: string;
    } | null>(null),
    [error, setError] = useState<Error | null>(null),
    [attempt, setAttempt] = useState(0);
  const active = useRef<SkyDataStore | null>(null),
    epoch = useRef(0);
  const revoke = useCallback((e: Error) => {
    ++epoch.current;
    active.current?.dispose();
    active.current = null;
    setResource(null);
    setError(e);
  }, []);
  useEffect(() => {
    let stopped = false,
      controller: AbortController | null = null;
    const clear = () => {
      ++epoch.current;
      controller?.abort();
      active.current?.dispose();
      active.current = null;
      setResource(null);
    };
    const load = async () => {
      clear();
      setError(null);
      if (stopped || document.hidden) return;
      const generation = epoch.current;
      controller = new AbortController();
      try {
        const meta = readPublicMeta(
          await api(`/v1/members/${encodeURIComponent(memberId)}/sky`, {
            signal: controller.signal,
          }),
          memberId,
        );
        if (stopped || generation !== epoch.current) return;
        let initial = true;
        const store = new SkyDataStore(async (path, options) => {
          try {
            if (path === "/v1/me/sky" && initial) {
              initial = false;
              return meta;
            }
            const value = await api(
              path.replace(
                "/v1/me",
                `/v1/members/${encodeURIComponent(memberId)}`,
              ),
              options,
            );
            return path.includes("/sky/tiles")
              ? publicTiles(value)
              : readPublicMeta(value, memberId);
          } catch (e) {
            if (!options.signal.aborted && generation === epoch.current)
              revoke(e as Error);
            throw e;
          }
        }, memberId);
        active.current = store;
        setResource({ store, nickname: meta.owner.nickname });
        void store.refresh();
      } catch (e) {
        if (
          !stopped &&
          generation === epoch.current &&
          !controller.signal.aborted
        )
          setError(e as Error);
      }
    };
    const hide = () => {
      if (document.hidden) clear();
    };
    let queued = false;
    const refresh = () => {
      if (queued || document.hidden) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (!stopped) void load();
      });
    };
    const visibility = () => (document.hidden ? hide() : refresh());
    window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visibility);
    const timer = window.setInterval(refresh, 60000);
    void load();
    return () => {
      stopped = true;
      clear();
      window.clearInterval(timer);
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [memberId, attempt, revoke]);
  const data = useSyncExternalStore(
    resource?.store.subscribe ?? noSubscribe,
    resource?.store.getSnapshot ?? getEmpty,
  );
  return (
    <section className="sky-page public-sky">
      <header className="public-sky-heading">
        <Link to={"/members/" + encodeURIComponent(memberId)}>← 프로필</Link>
        <h1>{resource?.nickname ?? "탐사자"}의 은하</h1>
        {data.meta && (
          <span>
            발견한 별 {data.meta.starCount.toLocaleString()}개 · 읽기 전용
          </span>
        )}
        <Link to="/sky">내 별지도</Link>
      </header>
      {data.meta?.starCount === 0 && <p className="public-empty">아직 공개할 보유 별이 없습니다.</p>}
      {error ? (
        <div className="public-sky-error">
          <p>
            현재 이 은하를 볼 수 없습니다. 공개 범위가 바뀌었거나 연결이 끊겼을
            수 있습니다.
          </p>
          <ErrorState error={error} retry={() => setAttempt((n) => n + 1)} />
        </div>
      ) : !resource || !data.meta ? (
        <LoadingState />
      ) : (
        <PublicScene
          key={resource.store.memberId + ":" + attempt + ":" + epoch.current}
          data={data}
          store={resource.store}
          memberId={memberId}
          revoke={revoke}
        />
      )}
    </section>
  );
}
function PublicScene({
  data,
  store,
  memberId,
  revoke,
}: SkySceneProps & { memberId: string; revoke(e: Error): void }) {
  const control = useRef<SceneControl | null>(null),
    saved = useRef<GalaxyCamera | null>(null),
    [system, setSystem] = useState<OwnedSystem | null>(null),
    [view, setView] = useState({ ...INITIAL_SYSTEM }),
    [list, setList] = useState(false),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(0);
  const ticId = data.selectedTicId,
    meta = data.meta!;
  const close = useCallback(() => {
    store.select(null);
    setSystem(null);
    if (saved.current) control.current?.setCamera(saved.current);
    saved.current = null;
  }, [store]);
  useEffect(() => {
    setSystem(null);
    setView({ ...INITIAL_SYSTEM });
    if (!ticId) return;
    const controller = new AbortController();
    if (!saved.current) saved.current = control.current?.getCamera() ?? null;
    void api(
      `/v1/members/${encodeURIComponent(memberId)}/stars/${encodeURIComponent(ticId)}`,
      { signal: controller.signal },
    )
      .then((v) => {
        if (controller.signal.aborted) return;
        const next = readPublicSystem(
          v,
          meta,
          ticId,
          memberId,
          data.stars.find((s) => s.ticId === ticId),
        );
        setSystem(next);
        control.current?.focusStar(next.position);
      })
      .catch((e) => {
        if (!controller.signal.aborted) revoke(e);
      });
    return () => controller.abort();
  }, [ticId, meta, memberId, revoke]);
  const onReady = useCallback((next: SceneControl | null) => {
    control.current = next;
  }, []);
  const onGraphics = useCallback(
    (available: boolean, message: string | null) => {
      if (!available && message) setList(true);
    },
    [],
  );
  useEffect(() => {
    if (list)
      void store.setView({
        level: meta.zoomLevels[0].level,
        box: {
          x: meta.bounds.minX,
          y: meta.bounds.minY,
          w: Math.max(1, meta.bounds.maxX - meta.bounds.minX + 1),
          h: Math.max(1, meta.bounds.maxY - meta.bounds.minY + 1),
        },
      });
  }, [list, store, meta]);
  const all = data.stars
      .filter((s) => s.ticId.includes(query))
      .sort((a, b) => a.layoutOrdinal - b.layoutOrdinal),
    rows = all.slice(page * 30, (page + 1) * 30),
    planet = system?.items.find((p) => p.candidateId === view.body);
  return (
    <div
      className={
        "personal-galaxy public-galaxy" +
        (ticId ? " has-detail" : "") +
        (list ? " shows-list" : "")
      }
    >
      <GalaxyScene canvasLabel="이 탐사자가 공개한 별의 3D 은하 지도"
        starLabel={publicStarLabel}
        data={data}
        store={store}
        onReady={onReady}
        onGraphics={onGraphics}
        suspended={list}
        personalSystem={system}
        systemView={system && !list ? view : null}
        onDeselect={close}
      />
      {!ticId && (
        <button
          className="public-list-switch"
          onClick={() => {
            setList((v) => !v);
            setQuery("");
            setPage(0);
            void store.setView({
              level: meta.zoomLevels[0].level,
              box: {
                x: meta.bounds.minX,
                y: meta.bounds.minY,
                w: Math.max(1, meta.bounds.maxX - meta.bounds.minX + 1),
                h: Math.max(1, meta.bounds.maxY - meta.bounds.minY + 1),
              },
            });
          }}
        >
          {list ? "은하 보기" : "별 목록 보기"}
        </button>
      )}
      {list && !ticId && (
        <div className="public-star-list">
          <h2>공개한 별</h2>
          <p>
            적재 {data.loadedCount.toLocaleString()} / 전체{" "}
            {meta.starCount.toLocaleString()}개
          </p>
          <label>
            TIC 검색
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <ul>
            {rows.map((s) => (
              <li key={s.ticId}>
                <button onClick={() => store.select(s.ticId)}>
                  {publicStarLabel(s)}
                </button>
              </li>
            ))}
          </ul>
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            이전 별
          </button>
          <button
            disabled={(page + 1) * 30 >= all.length}
            onClick={() => setPage((p) => p + 1)}
          >
            다음 별
          </button>
          {data.pending > 0 && (
            <p role="status">주변 별을 불러오고 있습니다.</p>
          )}
        </div>
      )}
      {system && !list && (
        <PersonalSceneControls
          planets={system.items.map((p, i) => ({
            id: p.candidateId,
            label: "행성 " + (i + 1),
            candidate: p.kind === "unconfirmed",
            period: p.periodDays ?? 1,
            seed: signalSeed(p.candidateId),
          }))}
          view={view}
          onView={setView}
          onClose={close}
          renderer={control}
        />
      )}
      {ticId && (
        <aside
          className={"star-detail" + (!list ? " prototype-detail" : "") + (system ? " detail-ready" : "")}
          aria-label="공개 별 상세"
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
        >
          <div className="focus-heading">
            <button onClick={close}>← {list ? "별 목록" : "별지도"}</button>
            <p className="eyebrow">EXPLORER DISCOVERY</p>
            <h2>TIC {ticId}</h2>
          </div>
          <div className="focus-information">
            {!system ? (
              <LoadingState />
            ) : (
              <>
                <h3>공개 행성 {system.items.length}개</h3>
                <button onClick={() => setView({ ...INITIAL_SYSTEM })}>
                  항성계
                </button>
                <button
                  onClick={() =>
                    setView((v) => ({ ...v, body: "star", zoom: 1 }))
                  }
                >
                  항성
                </button>
                <ul className="planet-list">
                  {system.items.map((p, i) => (
                    <li key={p.candidateId}>
                      <button
                        aria-pressed={view.body === p.candidateId}
                        onClick={() =>
                          setView((v) => ({
                            ...v,
                            body: p.candidateId,
                            zoom: 1,
                          }))
                        }
                      >
                        행성 {i + 1}
                      </button>
                    </li>
                  ))}
                </ul>
                {!system.items.length && <p>현재 공개할 행성이 없습니다. 개인 탐사 결과와 다를 수 있습니다.</p>}
                {planet && (
                  <dl>
                    <dt>신호</dt>
                    <dd>{planet.candidateId}</dd>
                    <dt>분류</dt>
                    <dd>
                      {planet.kind === "confirmed"
                        ? "확인된 행성"
                        : "미확인 후보"}
                    </dd>
                    <dt>반복 주기</dt>
                    <dd>
                      {planet.periodDays === null
                        ? "정보 없음"
                        : planet.periodDays + "일"}
                    </dd>
                    <dt>감광 깊이</dt>
                    <dd>
                      {planet.depthPpm === null
                        ? "정보 없음"
                        : planet.depthPpm + " ppm"}
                    </dd>
                  </dl>
                )}
                <p className="detail-muted">
                  표면과 궤도는 이해를 돕기 위한 시각화입니다.
                </p>
              </>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}


