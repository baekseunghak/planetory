// The one sky store of the signed-in app. useSkyData() makes a store per
// mount, so it is called once here, in the protected layout, above every
// route: the persistent galaxy keeps its data across screens.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSkyData } from "../../features/sky-data/useSkyData";
import {
  SkyContractError,
  type SkyMeta,
  type Star,
} from "../../features/sky-data/contracts";
import type { SkyDataStore, SkySnapshot } from "../../features/sky-data/store";
import { useScene } from "../scene";
import { fullSkyView, type ShellStage } from "./stage";

export type CinemaSky = {
  store: SkyDataStore | null;
  data: SkySnapshot;
  /**
   * A just-changed sky answered with its previous version (read lag after a
   * submission): the shell asks again a few times before it says anything.
   */
  retrying?: boolean;
};

/** The sky answered with an older version than the one just announced. */
export const isVersionLag = (error: Error | null) =>
  error instanceof SkyContractError && /지도 버전/.test(error.message);
const LAG_RETRIES_MS = [700, 1500, 3000];
/** Re-read the sky on window focus at most this often, and on this interval. */
const FOCUS_REFRESH_MS = 30000;
const INTERVAL_REFRESH_MS = 60000;
const SkyContext = createContext<CinemaSky | null>(null);

export function useCinemaSky(): CinemaSky {
  const value = useContext(SkyContext);
  if (!value) throw new Error("SkyProvider 안에서 사용해 주세요.");
  return value;
}

export function SkyProvider({
  selectedTicId,
  stage,
  children,
}: {
  /** Star selected by the route (`/sky?star=`), or null. */
  selectedTicId: string | null;
  /** Stage on screen; coming back to the galaxy re-reads the sky. */
  stage?: ShellStage;
  children: ReactNode;
}) {
  const sky = useSkyData();
  const { store, data } = sky;
  const scene = useScene();
  const lastMeta = useRef<SkyMeta | null>(null);

  // One store lives for the whole session, so it is re-read where the old
  // map re-read by remounting: on coming back to the galaxy from another
  // screen, on window focus and once a minute. A submission accepted after
  // the member left (or in another tab) then still reaches the galaxy.
  const loaded = useRef(false);
  loaded.current = !!store && !!data.meta;
  const lastRead = useRef(0);
  useEffect(() => {
    if (data.meta) lastRead.current = Date.now();
  }, [data.meta]);
  const lastStage = useRef(stage);
  useEffect(() => {
    const previous = lastStage.current;
    lastStage.current = stage;
    if (
      stage === "galaxy" &&
      previous !== undefined &&
      previous !== "galaxy" &&
      previous !== "system" &&
      loaded.current
    ) {
      lastRead.current = Date.now();
      void store?.refresh();
    }
  }, [stage, store]);
  useEffect(() => {
    if (!store) return;
    const quiet = () =>
      document.visibilityState === "visible" && loaded.current;
    const onFocus = () => {
      if (!quiet() || Date.now() - lastRead.current < FOCUS_REFRESH_MS) return;
      lastRead.current = Date.now();
      void store.refresh();
    };
    const timer = window.setInterval(() => {
      if (!quiet() || Date.now() - lastRead.current < INTERVAL_REFRESH_MS)
        return;
      lastRead.current = Date.now();
      void store.refresh();
    }, INTERVAL_REFRESH_MS / 2);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [store]);

  // Read lag: ask again with backoff before the alert shows.
  const [lagTries, setLagTries] = useState(0);
  const lag = isVersionLag(data.error);
  // Start over only once the sky is healthy again, not while a retry loads.
  useEffect(() => {
    if (data.phase === "ready" && !data.error) setLagTries(0);
  }, [data.phase, data.error]);
  useEffect(() => {
    if (!lag || !store || lagTries >= LAG_RETRIES_MS.length) return;
    const timer = window.setTimeout(() => {
      setLagTries((n) => n + 1);
      void store.retry();
    }, LAG_RETRIES_MS[lagTries]);
    return () => window.clearTimeout(timer);
  }, [lag, lagTries, store]);
  const retrying = lag && lagTries < LAG_RETRIES_MS.length;

  // Load every stored star once per sky version (same view is a no-op).
  useEffect(() => {
    if (store && data.meta) void store.setView(fullSkyView(data.meta));
  }, [store, data.meta]);

  useEffect(() => {
    store?.select(selectedTicId);
  }, [store, selectedTicId]);

  // Feed the scene. A new controller (the engine registering) gets the data
  // too. On another member's galaxy (`public`) the public view feeds it;
  // leaving there feeds my stars again.
  const ownsScene = stage !== "public";
  useEffect(() => {
    if (!data.meta || !ownsScene) return;
    lastMeta.current = data.meta;
    try {
      scene.setStars(data.stars, data.meta);
    } catch (error) {
      console.error("scene setStars failed", error);
    }
  }, [scene, data.stars, data.meta, ownsScene]);

  // Signing out or switching members: the next person never sees these stars.
  useEffect(
    () => () => {
      const meta = lastMeta.current;
      try {
        scene.setSystem(null);
        scene.setAnalysisHint(null);
        if (meta) scene.setStars([], { ...meta, starCount: 0 });
      } catch (error) {
        console.error("scene reset failed", error);
      }
    },
    [scene],
  );

  const value = useMemo(
    () => ({ store, data, retrying }),
    [store, data, retrying],
  );
  return <SkyContext.Provider value={value}>{children}</SkyContext.Provider>;
}

/** Resolves with the star once the store has it, or null after `timeoutMs`. */
export function waitForStar(
  store: SkyDataStore,
  ticId: string,
  timeoutMs = 10000,
): Promise<Star | null> {
  const find = () =>
    store.getSnapshot().stars.find((star) => star.ticId === ticId) ?? null;
  const now = find();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    let off = () => {};
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, timeoutMs);
    off = store.subscribe(() => {
      const star = find();
      if (!star) return;
      clearTimeout(timer);
      off();
      resolve(star);
    });
  });
}
