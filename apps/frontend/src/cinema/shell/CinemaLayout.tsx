// Signed-in layout. Every authenticated route renders here over the one
// scene: the galaxy and a star's system are camera moves, analysis is a panel
// over the system, other pages float over the dimmed galaxy.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../auth/SessionProvider";
import { PublicationUnlockSink } from "../../features/publication/unlock-sink";
import {
  OnboardingLookContext,
  OnboardingProvider,
  OnboardingTip,
  type OnboardingLook,
} from "../../features/onboarding/Onboarding";
import { browserStorage, takeFirstVisitFlight } from "./tutorial-guide";
import {
  MARKER_FRAME_MARGIN,
  STORY_LEAVE_MS,
  markStorySeen,
  storyWanted,
} from "./first-story";
import { FirstStory } from "./FirstStory";
import {
  addNewStars,
  newStarsOf,
  openNewStar,
  pruneNewStars,
  type NewStarList,
} from "./new-stars";
import "../../components/service-presentation.css";
import { SCENE_TIMING, sceneSystemFrom, useScene } from "../scene";
import { ShellContext, type PanelSide, type Shell } from "./context";
import { SequenceDirector, planetLabel } from "./sequences";
import { SequenceLayer } from "./SequenceLayer";
import { SkyProvider, useCinemaSky, waitForStar } from "./sky";
import { galaxySearch, legacyMainClass, readStage, starSearch } from "./stage";
import { useStarDetail } from "./star-detail";
import { TopBar } from "./TopBar";
import { useStageDirector } from "./useStageDirector";
import { ANALYSIS_STAGE_CLASS, analysisPanelCover } from "./AnalysisStage";

export const TOP_BAR = 56;
const TRANSIT_COVER = 190;
const CARD_COVER = 300;

export function CinemaLayout({
  skyOverride = false,
  publicGalaxy = false,
}: {
  /** A page slot replaces the galaxy on /sky (dev inspectors only). */
  skyOverride?: boolean;
  /**
   * /members/:memberId/sky is the cinema public galaxy (stage `public`,
   * shell/public-galaxy) instead of a page over the backdrop.
   */
  publicGalaxy?: boolean;
}) {
  const location = useLocation();
  const target = useMemo(
    () =>
      readStage(location.pathname, location.search, {
        skyOverride,
        publicGalaxy,
      }),
    [location.pathname, location.search, skyOverride, publicGalaxy],
  );
  return (
    <OnboardingProvider>
      <SkyProvider
        selectedTicId={target.stage === "system" ? target.ticId : null}
        stage={target.stage}
      >
        <ShellBody skyOverride={skyOverride} publicGalaxy={publicGalaxy} />
      </SkyProvider>
    </OnboardingProvider>
  );
}

/** Where the result of the analysis on stage lives, for keyboard focus. */
function focusAnalysisResult() {
  const stage = document.querySelector(`.${ANALYSIS_STAGE_CLASS}`);
  // The classic result is a modal dialog; the new one an inline region.
  const result =
    stage?.querySelector<HTMLElement>("dialog[open]") ??
    stage?.querySelector<HTMLElement>("[data-analysis-result]") ??
    null;
  if (!result) return;
  // "이번 제출 결과" means the full result in both variants: the classic
  // dialog is it; the new variant opens its own detail view.
  const details = result.matches("[data-analysis-result]")
    ? result.querySelector<HTMLButtonElement>(
        "[data-result-details]:not(:disabled)",
      )
    : null;
  if (details) {
    details.click();
    return;
  }
  result.scrollIntoView({ block: "nearest" });
  const inner = result.querySelector<HTMLElement>(
    '[tabindex="-1"], button:not(:disabled), a[href]',
  );
  (inner ?? (result.hasAttribute("tabindex") ? result : null))?.focus({
    preventScroll: true,
  });
}

function ShellBody({
  skyOverride,
  publicGalaxy,
}: {
  skyOverride: boolean;
  publicGalaxy: boolean;
}) {
  const session = useSession();
  const memberId = session.member?.memberId ?? "";
  const location = useLocation();
  const navigate = useNavigate();
  const scene = useScene();
  const sky = useCinemaSky();
  const target = useMemo(
    () =>
      readStage(location.pathname, location.search, {
        skyOverride,
        publicGalaxy,
      }),
    [location.pathname, location.search, skyOverride, publicGalaxy],
  );
  const focusTic =
    target.stage === "system" || target.stage === "analysis"
      ? target.ticId
      : null;
  const focus = useStarDetail(sky, focusTic);

  // ---- toast
  const [toastMessage, setToastMessage] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toast = useCallback((message: string) => {
    clearTimeout(toastTimer.current);
    setToastMessage(message);
    toastTimer.current = setTimeout(() => setToastMessage(""), 2800);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // ---- sequences (bridge -> scene)
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const analysisTic = useRef<string | null>(null);
  analysisTic.current = target.stage === "analysis" ? target.ticId : null;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const unlockRef = useRef<
    (ticIds: readonly string[], ignites: boolean) => void
  >(() => undefined);
  const [director] = useState(
    () =>
      new SequenceDirector({
        scene: () => sceneRef.current,
        memberId,
        analysisTic: () => analysisTic.current,
        planetLabel: (outcome) =>
          outcome.planet
            ? planetLabel(
                focusRef.current.ticId === outcome.ticId
                  ? focusRef.current.detail?.system.items
                  : null,
                outcome.planet.candidateId,
              )
            : null,
        onUnlock: (ticIds, ignites) => unlockRef.current(ticIds, ignites),
      }),
  );
  useEffect(() => director.start(), [director]);
  useEffect(() => director.reapply(), [director, scene]);
  // Publishing an analysis (공개 검토) can grant the achievement and open
  // stars there: they ignite like a discovery's once the galaxy is back.
  const publicationUnlocks = useCallback(
    (ticIds: readonly string[]) => director.unlockElsewhere(ticIds),
    [director],
  );
  useEffect(() => {
    if (target.stage !== "analysis") return;
    director.enterAnalysis();
    return () => director.leaveAnalysis();
  }, [director, target.stage, target.ticId]);
  const sequence = useSyncExternalStore(director.subscribe, director.getState);

  // ---- new stars: unlocked and not opened yet (new-stars.ts), kept per
  // member on this browser. The galaxy rings them (NewStarMarks) and the
  // "새 별 N개" chip walks through them; a star waiting for its ignition
  // (`unlit`) joins them once it has ignited.
  const [newStarList, setNewStarList] = useState<NewStarList>(() =>
    newStarsOf(browserStorage(), memberId),
  );
  const [unlit, setUnlit] = useState<ReadonlySet<string>>(() => new Set());
  const lightUp = useCallback((ticIds: readonly string[]) => {
    setUnlit((previous) =>
      ticIds.some((id) => previous.has(id))
        ? new Set([...previous].filter((id) => !ticIds.includes(id)))
        : previous,
    );
  }, []);
  unlockRef.current = (ticIds, ignites) => {
    setNewStarList(addNewStars(browserStorage(), memberId, ticIds));
    if (ignites) setUnlit((previous) => new Set([...previous, ...ticIds]));
  };
  const newStars = useMemo(
    () =>
      unlit.size ? newStarList.filter((id) => !unlit.has(id)) : newStarList,
    [newStarList, unlit],
  );
  // Opened (its panel or its analysis): not new any more.
  useEffect(() => {
    if (focusTic)
      setNewStarList(openNewStar(browserStorage(), memberId, focusTic));
  }, [focusTic, memberId]);

  // ---- unlocked stars ignite once the galaxy is on screen again, one after
  // another, then one toast says how many opened.
  const [newStar, setNewStar] = useState<string | null>(null);
  const clearNewStar = useCallback(() => setNewStar(null), []);
  const store = sky.store;
  const storeRef = useRef(store);
  storeRef.current = store;
  const onGalaxy = useCallback(() => {
    const ids = director.takeIgnitions();
    const current = storeRef.current;
    if (!ids.length || !current) {
      // Held stars that will not ignite after all are shown plainly.
      if (ids.length) {
        director.holdStars(null);
        lightUp(ids);
      }
      director.releaseStars();
      return;
    }
    void (async () => {
      for (const id of ids) {
        const star = await waitForStar(current, id);
        const controller = sceneRef.current;
        try {
          await Promise.race([
            controller.ignite(star ?? id),
            new Promise((resolve) =>
              setTimeout(resolve, SCENE_TIMING.igniteMs + 11000),
            ),
          ]);
        } catch (error) {
          console.error("scene ignite failed", error);
        }
        lightUp([id]);
        setNewStar(id);
      }
      toast(
        ids.length > 1
          ? `새 별 ${ids.length}개가 열렸습니다`
          : "새 별이 열렸습니다",
      );
      // Now the star count moves (see TallyHold).
      director.releaseStars();
    })();
  }, [director, toast, lightUp]);
  // The mark belongs to the galaxy: any other screen ends it.
  useEffect(() => {
    if (target.stage !== "galaxy") setNewStar(null);
  }, [target.stage]);

  // ---- camera
  const starLoaded = useMemo(
    () => !!focusTic && sky.data.stars.some((star) => star.ticId === focusTic),
    [focusTic, sky.data.stars],
  );
  // A TIC the fully loaded sky does not have (locked, unknown): no flight
  // to it. Latched per TIC so a sky refresh does not start one either.
  const complete =
    !!sky.data.meta &&
    sky.data.phase === "ready" &&
    sky.data.loadedCount === sky.data.meta.starCount;
  const missing = useRef<{ ticId: string; missing: boolean } | null>(null);
  if (!focusTic) missing.current = null;
  else if (starLoaded) missing.current = { ticId: focusTic, missing: false };
  else if (complete) missing.current = { ticId: focusTic, missing: true };
  else if (missing.current?.ticId !== focusTic) missing.current = null;
  const starMissing = !!missing.current?.missing;

  // The fully loaded sky has the last word on what is still new (explored
  // or gone is not); a star unlocked a moment ago waits for its refresh.
  useEffect(() => {
    setNewStarList(
      pruneNewStars(browserStorage(), memberId, {
        stars: sky.data.stars,
        complete,
      }),
    );
  }, [memberId, sky.data.stars, complete]);

  // ---- first-login story: a newcomer's galaxy waits far away while four
  // lines say what this place is for; 시작하기 (or 건너뛰기) starts the
  // fly-in, then the first-visit flight to tutorial 1. Once per member on
  // this browser (first-story.ts), never for members who have onboarded.
  const firstVisit = session.member?.onboardingDone === false;
  const [storyPhase, setStoryPhase] = useState<"ready" | "leaving" | "done">(
    "ready",
  );
  const story =
    storyPhase === "ready" &&
    storyWanted(browserStorage(), {
      firstVisit,
      memberId,
      onGalaxy: target.stage === "galaxy",
    });
  const endStory = useCallback(() => {
    markStorySeen(browserStorage(), memberId);
    setStoryPhase("leaving");
  }, [memberId]);
  useEffect(() => {
    if (storyPhase !== "leaving") return;
    const timer = setTimeout(
      () => setStoryPhase("done"),
      scene.getState().reducedMotion ? 0 : STORY_LEAVE_MS,
    );
    return () => clearTimeout(timer);
  }, [storyPhase, scene]);

  const [intro, setIntro] = useState(false);
  useStageDirector(scene, target, starLoaded, onGalaxy, {
    starMissing,
    onIntro: setIntro,
    holdIntro: story,
  });

  // The tutorial markers stay inside the resting galaxy's frame (the end
  // of the fly-in, 전체 보기): the scene pans, then moves back, only as far
  // as they need. Another member's galaxy is not mine to frame.
  const frameTics = useMemo(
    () =>
      sky.data.stars
        .filter(
          (star) =>
            star.marker?.type === "tutorial" &&
            star.progressStage !== "completed",
        )
        .map((star) => star.ticId)
        .join(" "),
    [sky.data.stars],
  );
  const ownFrame = target.stage !== "public";
  useEffect(() => {
    scene.setHomeFrame?.(
      ownFrame && frameTics
        ? { ticIds: frameTics.split(" "), margin: MARKER_FRAME_MARGIN }
        : null,
    );
  }, [scene, frameTics, ownFrame]);
  useEffect(() => () => scene.setHomeFrame?.(null), [scene]);

  // The focused star's own planets. While a transit runs, the reveal owns the
  // new planet; the refreshed system lands after it.
  const lastFocus = useRef<string | null>(null);
  useEffect(() => {
    if (focusTic && lastFocus.current && lastFocus.current !== focusTic)
      scene.setSystem(null);
    lastFocus.current = focusTic ?? lastFocus.current;
  }, [scene, focusTic]);
  useEffect(() => {
    if (sequence.phase === "transit") return;
    const detail = focus.detail;
    if (detail && detail.system.ticId === focusTic)
      scene.setSystem(sceneSystemFrom(detail.system));
  }, [scene, focus.detail, focusTic, sequence.phase]);

  // ---- insets: panels cover part of the canvas, the star stays in the rest
  const [panels, setPanels] = useState({ right: 0, bottom: 0 });
  const reportPanel = useCallback((side: PanelSide, px: number) => {
    setPanels((previous) =>
      previous[side] === px ? previous : { ...previous, [side]: px },
    );
  }, []);
  // In analysis the variant reports its own panel; the shell only replaces
  // that inset while the panel is away, then restores the measured one. The
  // top bar is always over the scene.
  useEffect(() => {
    if (target.stage === "analysis") {
      const bottom =
        sequence.phase === "transit"
          ? TRANSIT_COVER
          : sequence.phase === "card"
            ? CARD_COVER
            : analysisPanelCover(
                document.querySelector(`.${ANALYSIS_STAGE_CLASS}`),
              );
      scene.setViewInset({ top: TOP_BAR, right: 0, bottom, left: 0 });
      return;
    }
    scene.setViewInset(
      target.stage === "system" || target.stage === "public"
        ? { top: TOP_BAR, right: panels.right, bottom: 0, left: 0 }
        : { top: 0, right: 0, bottom: 0, left: 0 },
    );
  }, [scene, target.stage, target.ticId, panels.right, sequence.phase]);

  // ---- navigation helpers
  const search = useRef(location.search);
  search.current = location.search;
  const selectStar = useCallback(
    (ticId: string) => {
      const current = new URLSearchParams(search.current);
      if (location.pathname === "/sky" && current.get("star") === ticId) return;
      navigate({
        pathname: "/sky",
        search: starSearch(
          location.pathname === "/sky" ? search.current : "",
          ticId,
        ),
      });
    },
    [navigate, location.pathname],
  );
  const closeStar = useCallback(() => {
    navigate(
      {
        pathname: "/sky",
        search: galaxySearch(
          location.pathname === "/sky" ? search.current : "",
        ),
      },
      { replace: true },
    );
  }, [navigate, location.pathname]);

  // ---- first visit (onboarding not done): fly to tutorial star 1 once per
  // member, kept in the browser, so "← 나의 은하" and a reload stay put.
  const markFirstVisitFlown = useCallback(
    () => takeFirstVisitFlight(browserStorage(), memberId),
    [memberId],
  );

  // ---- guide lines: "안내 숨기기" hides that line for this visit only
  // (it does not complete onboarding; the first tutorial submission does).
  const [hiddenLines, setHiddenLines] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const look = useMemo<OnboardingLook>(
    () => ({
      hidden: false,
      isDismissed: (key) => hiddenLines.has(key),
      dismiss: (key) =>
        setHiddenLines((previous) => new Set(previous).add(key)),
    }),
    [hiddenLines],
  );

  const shell: Shell = {
    target,
    focus,
    director,
    sequence,
    reportPanel,
    selectStar,
    closeStar,
    toast,
    firstVisit,
    markFirstVisitFlown,
    story,
    newStars,
    newStar,
    clearNewStar,
  };
  const overlay = target.stage === "backdrop";
  return (
    <ShellContext.Provider value={shell}>
      <OnboardingLookContext.Provider value={look}>
        <div
          className={`cinema-shell${overlay ? " service-presentation cinema-backdrop" : ""}`}
          data-stage={target.stage}
          // HUD out of the way: the fly-in, and the story fading out before it.
          data-intro={intro || storyPhase === "leaving" ? "true" : "false"}
          data-story={story ? "true" : "false"}
        >
          <a className="skip-link" href="#main-content">
            본문으로 이동
          </a>
          <TopBar />
          <main
            id="main-content"
            className={
              overlay
                ? `cinema-page ${legacyMainClass(location.pathname)}`
                : "cinema-main"
            }
            tabIndex={-1}
          >
            <PublicationUnlockSink.Provider value={publicationUnlocks}>
              <Outlet />
            </PublicationUnlockSink.Provider>
            {/* The galaxy shows its own first-visit line (GalaxyView). A page
              that fills the sky slot (dev inspectors) keeps the old tip. */}
            {skyOverride && location.pathname === "/sky" && (
              <OnboardingTip step={0} />
            )}
          </main>
          {target.stage === "analysis" && (
            <SequenceLayer
              onGalaxy={() => {
                director.dismiss();
                navigate("/sky");
              }}
              onDetails={() => {
                director.dismiss();
                // The transit hands the camera back in system mode. The panel
                // is back, so the analysis framing (and ghost orbit) is too.
                const now = scene.getState();
                if (
                  target.ticId &&
                  now.focusedTicId === target.ticId &&
                  now.mode === "system"
                )
                  scene.setMode("analysis");
                // Back to the variant's own result view, as it was left (the
                // classic dialog reopens once the panel is back).
                requestAnimationFrame(focusAnalysisResult);
              }}
            />
          )}
          {(story || storyPhase === "leaving") && (
            <FirstStory leaving={!story} onStart={endStory} />
          )}
          <div
            className="cinema-toast"
            role="status"
            aria-live="polite"
            data-empty={!toastMessage}
          >
            {toastMessage}
          </div>
        </div>
      </OnboardingLookContext.Provider>
    </ShellContext.Provider>
  );
}
