// /sky: my galaxy (no star) or a star's system (?star=). The scene draws;
// this file only adds the HUD, markers, labels and the star panel.
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../auth/SessionProvider";
import {
  OnboardingLookContext,
  useOnboardingOpen,
} from "../../features/onboarding/Onboarding";
import { QuestPanel } from "../../features/quests/QuestPanel";
import { QuestProvider } from "../../features/quests/QuestProvider";
import { DiscoveredStars } from "../../features/sky-renderer/DiscoveredStars";
import { StarSearch } from "../../features/sky-renderer/StarSearch";
import { GalaxyArtwork } from "../../components/GalaxyArtwork";
import type { Star } from "../../features/sky-data/contracts";
import {
  POWER_SLOW_MESSAGE,
  SCENE_TIMING,
  forgetPower,
  useScene,
  useSceneState,
} from "../scene";
import { useShell } from "./context";
import { writeSceneEffects } from "./preferences";

const POWER_ORDER = ["full", "reduced", "low"] as const;
import {
  HoverLabel,
  MarkerLayer,
  NewStarMarks,
  PlanetLabels,
} from "./ScreenLabels";
import { markedNewStars, nextNewStar } from "./new-stars";
import { StarPanel } from "./StarPanel";
import { useCinemaSky } from "./sky";
import { useTutorialGuide } from "./TutorialGuide";
import { browserStorage, firstVisitFlown } from "./tutorial-guide";

export function GalaxyView() {
  const { store, data } = useCinemaSky();
  const shell = useShell();
  const { target, focus, selectStar, closeStar } = shell;
  const scene = useScene();
  const sceneState = useSceneState();
  const ticId = target.stage === "system" ? target.ticId : null;
  const [planet, setPlanet] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [markerHover, setMarkerHover] = useState<string | null>(null);
  const failed = sceneState.failed;
  // Markers wait for the galaxy to be at rest (see MarkerLayer `held`).
  const markersHeld =
    sceneState.ready && (sceneState.busy || sceneState.mode !== "galaxy");
  useEffect(() => {
    if (ticId || markersHeld) setMarkerHover(null);
  }, [ticId, markersHeld]);

  // Flying to a new star: the panel waits for the last part of the move, so
  // the flight has the whole screen and the arrival has something to show.
  const [arriving, setArriving] = useState(false);
  const arrivalFor = useRef<string | null>(null);
  useEffect(() => {
    if (!ticId) {
      arrivalFor.current = null;
      setArriving(false);
      return;
    }
    if (arrivalFor.current === ticId) return;
    arrivalFor.current = ticId;
    const now = scene.getState();
    // Child effects run before the stage director's: the scene still shows
    // where the camera comes from. Already there (back from analysis): no wait.
    const flies =
      now.ready &&
      !now.reducedMotion &&
      !now.failed &&
      now.focusedTicId !== ticId;
    setArriving(flies);
    if (!flies) return;
    const timer = setTimeout(
      () => setArriving(false),
      Math.round(SCENE_TIMING.toStarMs * 0.68),
    );
    return () => clearTimeout(timer);
  }, [scene, ticId]);

  // Planet focus belongs to one star.
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
  useEffect(
    () => scene.onStarClick((pointer) => selectStar(pointer.ticId)),
    [scene, selectStar],
  );
  // The member's effects choice is applied once at the root (CinemaRoot).
  // Weak graphics step the scene down while it runs: say so once per step.
  // The engine's first level (software renderer detected, a ?power= pin or
  // a level kept from earlier) is not a step down: only a runtime step says
  // "slow". Before the engine attaches the state has no power at all.
  const reported = sceneState.power;
  const power = reported ?? "full";
  const lastPower = useRef(reported);
  const { toast } = shell;
  useEffect(() => {
    const before = lastPower.current;
    lastPower.current = reported;
    if (
      before !== undefined &&
      reported !== undefined &&
      POWER_ORDER.indexOf(reported) > POWER_ORDER.indexOf(before)
    )
      toast("화면이 느려 그래픽을 낮췄습니다");
  }, [reported, toast]);

  // HUD panels (내 별 찾기, quests, 별 목록): one at a time. Esc or a press
  // on the sky closes them; opening one closes the others.
  useEffect(() => {
    if (ticId) return;
    const hudDetails = () => [
      ...document.querySelectorAll<HTMLDetailsElement>(
        ".cinema-tools details[open]",
      ),
    ];
    const closeAll = (except?: HTMLDetailsElement) => {
      for (const node of hudDetails())
        if (node !== except && !node.contains(except ?? null))
          node.open = false;
    };
    const onToggle = (event: Event) => {
      const node = event.target;
      if (
        node instanceof HTMLDetailsElement &&
        node.open &&
        node.closest(".cinema-tools")
      ) {
        closeAll(node);
        setListOpen(false);
      }
    };
    // The quest panel keeps its own open state (QuestPanel): its toggle.
    const closeQuests = () =>
      document
        .querySelector<HTMLButtonElement>(
          '.cinema-tools .quest-toggle[aria-expanded="true"]',
        )
        ?.click();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("dialog[open]")) return;
      closeAll();
      closeQuests();
      setListOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      const node = event.target instanceof Element ? event.target : null;
      if (!node) return;
      if (node.closest(".scene-canvas")) {
        closeAll();
        closeQuests();
        setListOpen(false);
      } else if (node.closest(".cinema-quests")) {
        for (const open of hudDetails())
          if (!open.closest(".cinema-quests")) open.open = false;
        setListOpen(false);
      } else if (node.closest(".cinema-search")) setListOpen(false);
    };
    document.addEventListener("toggle", onToggle, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("toggle", onToggle, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [ticId]);

  // Esc on the system returns to the galaxy, unless a field or popup has it.
  useEffect(() => {
    if (!ticId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const node = event.target instanceof Element ? event.target : null;
      if (
        node?.closest(
          "input, select, textarea, dialog, details[open], .quest-layer",
        )
      )
        return;
      closeStar();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ticId, closeStar]);

  // First visit: fly to tutorial star 1, instead of the old tip box. Only
  // once the login fly-in has landed (the galaxy at rest), so the flight to
  // the star never cuts the intro short, and once per member (the shell
  // keeps it), so "← 나의 은하" and a reload stay in the galaxy.
  const tutorialOne = useMemo(
    () =>
      data.stars.find(
        (star) =>
          star.marker?.type === "tutorial" &&
          star.marker.seq === 1 &&
          star.progressStage !== "completed",
      ) ?? null,
    [data.stars],
  );
  const tutorialOneTic = tutorialOne?.ticId ?? null;
  const [sceneLate, setSceneLate] = useState(false);
  useEffect(() => {
    if (sceneState.ready) return;
    // No drawing scene after a while (slow engine chunk): do not wait forever.
    const timer = setTimeout(() => setSceneLate(true), 8000);
    return () => clearTimeout(timer);
  }, [sceneState.ready]);
  const galaxyAtRest =
    !!failed ||
    (sceneState.ready
      ? sceneState.mode === "galaxy" && !sceneState.busy
      : sceneLate);
  // The first-login story (FirstStory) comes before all of this.
  const { firstVisit, markFirstVisitFlown, story } = shell;
  useEffect(() => {
    if (!firstVisit || story || ticId || !tutorialOneTic || !galaxyAtRest)
      return;
    // A moment on the landed galaxy before the camera moves on.
    const timer = setTimeout(
      () => {
        if (markFirstVisitFlown()) selectStar(tutorialOneTic);
      },
      failed || sceneState.reducedMotion ? 0 : 900,
    );
    return () => clearTimeout(timer);
  }, [
    firstVisit,
    story,
    markFirstVisitFlown,
    ticId,
    tutorialOneTic,
    galaxyAtRest,
    failed,
    sceneState.reducedMotion,
    selectStar,
  ]);

  // New stars (not opened yet): rings on the most recent ones, and a chip
  // that takes the member to them one by one, the most recent first.
  const { newStars } = shell;
  const markedStars = useMemo(() => markedNewStars(newStars), [newStars]);

  const detail = ticId && focus.ticId === ticId ? focus.detail : null;
  const showList = listOpen || !!failed;
  return (
    <div
      className="cinema-galaxy"
      data-stage={ticId ? "system" : "galaxy"}
      data-scene-ready={sceneState.ready ? "true" : "false"}
    >
      <h1 className="cinema-sr-only">
        {ticId ? `TIC ${ticId} 항성계` : "나의 은하"}
      </h1>
      {!sceneState.ready && !failed && data.stars.length > 0 && (
        <StillGalaxy stars={data.stars} />
      )}
      <SkyStatus />
      {/* Before the markers: a tutorial number or "!" stays on top. */}
      {!ticId && (
        <NewStarMarks
          stars={data.stars}
          ticIds={markedStars}
          recent={shell.newStar}
          onRecentDone={shell.clearNewStar}
          onSelect={selectStar}
          held={markersHeld}
          onHover={setMarkerHover}
        />
      )}
      {store && data.meta && (
        <QuestProvider key={store.memberId} store={store} data={data}>
          {!ticId && (
            <MarkerLayer
              stars={data.stars}
              onSelect={selectStar}
              held={markersHeld}
              onHover={setMarkerHover}
            />
          )}
          <HoverLabel
            stars={data.stars}
            forced={!ticId && !markersHeld ? markerHover : null}
          />
          <div className="cinema-tools" data-hidden={ticId ? "true" : "false"}>
            <div className="cinema-tool cinema-search">
              {/* Holds the pill's place; the details element floats over it. */}
              <span
                className="cinema-pill cinema-search-sizer"
                aria-hidden="true"
              >
                내 별 찾기
              </span>
              <StarSearch
                store={store}
                data={data}
                onLocate={(location) => selectStar(location.ticId)}
              />
            </div>
            <div className="cinema-tool cinema-quests">
              <QuestPanel listMode={false} select={selectStar} />
            </div>
            <button
              type="button"
              className="cinema-pill"
              aria-pressed={showList}
              disabled={!!failed}
              onClick={() => {
                if (!listOpen)
                  document
                    .querySelectorAll<HTMLDetailsElement>(
                      ".cinema-tools details[open]",
                    )
                    .forEach((node) => (node.open = false));
                setListOpen((open) => !open);
              }}
            >
              별 목록
            </button>
            {newStars.length > 0 && (
              <button
                type="button"
                className="cinema-pill cinema-new-star-chip"
                data-testid="new-star-chip"
                onClick={() => {
                  // Opening it ends its mark, so the next press goes on.
                  const next = nextNewStar(newStars);
                  if (next) selectStar(next);
                }}
              >
                <span className="cinema-new-star-dot" aria-hidden="true" />
                <span>{`새 별 ${newStars.length.toLocaleString("ko-KR")}개`}</span>
                <span className="cinema-sr-only"> 중 다음 별로 이동</span>
              </button>
            )}
          </div>
        </QuestProvider>
      )}
      {detail && (
        <PlanetLabels planets={detail.system.items} selected={planet} />
      )}
      <div className="cinema-corner">
        <button
          type="button"
          className="cinema-pill"
          onClick={() => (ticId ? closeStar() : void scene.showOverview())}
        >
          전체 보기
        </button>
        <button
          type="button"
          className="cinema-pill"
          aria-pressed={sceneState.effects}
          disabled={!!failed}
          onClick={() => {
            const next = !sceneState.effects;
            writeSceneEffects(next);
            scene.setEffects(next);
            // Off by default on weak graphics: on is the member's call.
            if (next && power !== "full")
              toast("이 컴퓨터에서는 빛 효과가 느릴 수 있습니다");
          }}
        >
          빛 효과 {sceneState.effects ? "켬" : "끔"}
        </button>
      </div>
      {store && data.meta && showList && (
        <aside className="cinema-list-panel" aria-label="발견한 별 목록 보기">
          {failed === POWER_SLOW_MESSAGE ? (
            <div className="cinema-notice-row">
              <p role="status" className="cinema-notice">
                {failed}
              </p>
              <button
                type="button"
                className="cinema-mini"
                onClick={() => {
                  // Forget the kept level (and a ?power= pin) and start over.
                  forgetPower();
                  const url = new URL(window.location.href);
                  url.searchParams.delete("power");
                  window.location.replace(url.toString());
                }}
              >
                3D 다시 시도
              </button>
            </div>
          ) : failed ? (
            <p role="status" className="cinema-notice">
              이 브라우저에서는 3D 은하를 그릴 수 없어 목록으로 보여 드립니다.
            </p>
          ) : (
            <button
              type="button"
              className="cinema-mini cinema-list-close"
              onClick={() => setListOpen(false)}
            >
              목록 닫기
            </button>
          )}
          <DiscoveredStars
            store={store}
            data={data}
            active
            select={(id) => selectStar(id)}
          />
        </aside>
      )}
      {ticId && (
        <StarPanel
          ticId={ticId}
          planet={planet}
          onPlanet={setPlanet}
          arriving={arriving}
        />
      )}
      <FirstVisitCaption ticId={ticId} tutorialTicId={tutorialOneTic} />
    </div>
  );
}

/** Sky loading, paging and version states in one quiet line. */
function SkyStatus() {
  const { store, data, retrying } = useCinemaSky();
  if (data.error && retrying)
    return (
      <p className="cinema-sky-status" role="status" data-empty="false">
        최신 은하를 확인하고 있습니다.
      </p>
    );
  if (data.error)
    return (
      <div className="cinema-sky-status" role="alert">
        <p>{data.error.message}</p>
        <button
          type="button"
          className="cinema-mini"
          onClick={() => void store?.retry()}
        >
          다시 불러오기
        </button>
      </div>
    );
  if (data.failures.length)
    return (
      <div className="cinema-sky-status" role="alert">
        <p>
          {data.failures.length}개 영역을 불러오지 못했습니다. 불러온 별은
          그대로 둡니다.
        </p>
        <button
          type="button"
          className="cinema-mini"
          onClick={() => void store?.retry()}
        >
          실패 영역 다시 불러오기
        </button>
      </div>
    );
  const message =
    !store || !data.meta
      ? "은하를 불러오고 있습니다."
      : data.needsRefresh
        ? "최신 은하를 확인하고 있습니다."
        : data.pending > 0
          ? `별을 불러오고 있습니다 · ${data.loadedCount.toLocaleString("ko-KR")} / ${data.meta.starCount.toLocaleString("ko-KR")}`
          : data.phase === "ready" && data.meta.starCount === 0
            ? "아직 열린 별이 없습니다."
            : "";
  return (
    <p className="cinema-sky-status" role="status" data-empty={!message}>
      {message}
    </p>
  );
}

/** No scene drawing yet (or none at all): a still map of my real stars. */
function StillGalaxy({ stars }: { stars: readonly Star[] }) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), 700);
    return () => clearTimeout(timer);
  }, []);
  if (!late) return null;
  return (
    <div className="cinema-still" aria-hidden="true">
      <GalaxyArtwork stars={stars} />
    </div>
  );
}

/**
 * One line instead of the old tip box, while onboarding is open (it closes
 * with the first tutorial submission, on the server). "안내 숨기기" hides
 * this line for the visit and completes nothing. One guide at a time: on a
 * star whose tutorial line is in the panel, the caption steps back.
 */
function FirstVisitCaption({
  ticId,
  tutorialTicId,
}: {
  ticId: string | null;
  tutorialTicId: string | null;
}) {
  const { member } = useSession();
  const { firstVisit } = useShell();
  const open = useOnboardingOpen();
  const look = useContext(OnboardingLookContext);
  const panelGuide = useTutorialGuide(ticId, "star");
  const key = ticId ? "first-visit:star" : "first-visit:galaxy";
  if (!open || !member || panelGuide || look?.isDismissed(key)) return null;
  // The shell is about to fly there by itself (GalaxyView, once per member).
  const flying =
    firstVisit &&
    !!tutorialTicId &&
    !firstVisitFlown(browserStorage(), member.memberId);
  const line = ticId
    ? ticId === tutorialTicId
      ? "첫 번째 별입니다. '분석 시작'을 누르면 밝기 곡선이 열립니다."
      : "'분석 시작'을 누르면 이 별의 밝기 곡선이 열립니다."
    : flying
      ? "첫 번째 별로 안내합니다."
      : tutorialTicId
        ? "파란 1번 별을 눌러 시작하세요."
        : "파란 번호가 붙은 별부터 탐사해 보세요.";
  return (
    <div className="cinema-first-visit">
      <p className="cinema-first-visit-line" role="status">
        {line}
      </p>
      <button
        type="button"
        className="cinema-first-visit-close"
        aria-label="첫 방문 안내 숨기기"
        onClick={() => look?.dismiss(key)}
      >
        안내 숨기기
      </button>
    </div>
  );
}
