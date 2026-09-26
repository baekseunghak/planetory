// /sky: my galaxy (no star) or a star's system (?star=). The scene draws;
// this file only adds the HUD, markers, labels and the star panel.
import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../auth/SessionProvider";
import { OnboardingTip } from "../../features/onboarding/Onboarding";
import { QuestPanel } from "../../features/quests/QuestPanel";
import { QuestProvider } from "../../features/quests/QuestProvider";
import { DiscoveredStars } from "../../features/sky-renderer/DiscoveredStars";
import { StarSearch } from "../../features/sky-renderer/StarSearch";
import { GalaxyArtwork } from "../../components/GalaxyArtwork";
import type { Star } from "../../features/sky-data/contracts";
import { SCENE_TIMING, useScene, useSceneState } from "../scene";
import { useShell } from "./context";
import { readSceneEffects, writeSceneEffects } from "./preferences";
import {
  HoverLabel,
  MarkerLayer,
  NewStarReticle,
  PlanetLabels,
} from "./ScreenLabels";
import { StarPanel } from "./StarPanel";
import { useCinemaSky } from "./sky";

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
  // Keep the member's display choice when the engine (re)registers.
  useEffect(() => {
    scene.setEffects(readSceneEffects());
  }, [scene]);

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

  // First visit: fly to tutorial star 1 once, instead of the old tip box.
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
  useEffect(() => {
    if (!shell.firstVisit || ticId || !tutorialOne) return;
    if (shell.markFirstVisitFlown()) selectStar(tutorialOne.ticId);
  }, [shell, ticId, tutorialOne, selectStar]);

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
              onClick={() => setListOpen((open) => !open)}
            >
              별 목록
            </button>
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
          onClick={() => {
            const next = !sceneState.effects;
            writeSceneEffects(next);
            scene.setEffects(next);
          }}
        >
          빛 효과 {sceneState.effects ? "켬" : "끔"}
        </button>
      </div>
      {store && data.meta && showList && (
        <aside className="cinema-list-panel" aria-label="발견한 별 목록 보기">
          {failed ? (
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
      {!ticId && shell.newStar && (
        <NewStarReticle
          key={shell.newStar}
          ticId={shell.newStar}
          onDone={shell.clearNewStar}
        />
      )}
      <FirstVisitCaption
        active={shell.firstVisit}
        ticId={ticId}
        tutorialTicId={tutorialOne?.ticId ?? null}
      />
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
 * One line instead of the old tip box. The onboarding tip keeps its own
 * completion logic (close = PATCH /v1/me/onboarding); only its look changes,
 * and the line disappears with it once onboarding is done.
 */
function FirstVisitCaption({
  active,
  ticId,
  tutorialTicId,
}: {
  active: boolean;
  ticId: string | null;
  tutorialTicId: string | null;
}) {
  const { member } = useSession();
  if (!active || !member) return null;
  const line = ticId
    ? ticId === tutorialTicId
      ? "첫 번째 별입니다. 분석 시작을 누르면 밝기 곡선이 열립니다."
      : "분석 시작을 누르면 이 별의 밝기 곡선이 열립니다."
    : tutorialTicId
      ? "첫 번째 별로 안내합니다."
      : "파란 번호가 붙은 별부터 탐사해 보세요.";
  return (
    <div className="cinema-first-visit">
      <p className="cinema-first-visit-line">{line}</p>
      <OnboardingTip step={0} />
    </div>
  );
}
