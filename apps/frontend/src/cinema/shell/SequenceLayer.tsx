// Transit caption with the live light curve, then the discovery card.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { LightCurve } from "../ui/LightCurve";
import { useShell } from "./context";

export function SequenceLayer({
  onGalaxy,
  onDetails,
}: {
  onGalaxy(): void;
  onDetails(): void;
}) {
  const { sequence } = useShell();
  if (sequence.phase === "transit" && sequence.outcome?.planet)
    return <TransitView depth={sequence.outcome.planet.depthPpm / 1e6} />;
  if (sequence.phase === "card" && sequence.card)
    return <DiscoveryCardView onGalaxy={onGalaxy} onDetails={onDetails} />;
  return null;
}

/**
 * The caption belongs to the edge-on view: it waits for the camera to land
 * and the planet to start its pass (the first light-curve sample), then
 * fades in. The live region is there from the start so the caption is read.
 */
function TransitView({ depth }: { depth: number }) {
  const { director } = useShell();
  const passing = useSyncExternalStore(
    director.subscribeFlux,
    () => director.getFlux().length > 0,
  );
  const layer = useRef<HTMLDivElement>(null);
  // The panel (and any dialog it held) stepped aside: keep keyboard focus
  // on the scene's layer, not on a control nobody can see.
  useEffect(() => {
    layer.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={layer}
      className="cinema-transit"
      data-passing={passing ? "true" : "false"}
      aria-live="polite"
      tabIndex={-1}
    >
      {passing && (
        <>
          <p className="cinema-transit-caption">
            당신이 본 밝기 감소는 바로 이 순간입니다
          </p>
          <LightCurve
            subscribe={director.subscribeFlux}
            getSamples={director.getFlux}
            depth={depth}
            label="행성이 별 앞을 지나는 동안의 밝기"
          />
          <p className="cinema-transit-note">
            밝기 감소와 행성 크기는 잘 보이도록 과장했습니다
          </p>
        </>
      )}
    </div>
  );
}

function DiscoveryCardView({
  onGalaxy,
  onDetails,
}: {
  onGalaxy(): void;
  onDetails(): void;
}) {
  const { sequence } = useShell();
  const card = sequence.card!;
  const dialog = useRef<HTMLDialogElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const details = useRef(onDetails);
  details.current = onDetails;
  // A modal dialog in the top layer, above the scene. The analysis panel's
  // own dialogs are held closed while the card is up (AnalysisStage), and
  // closing the card brings back the result view as it was.
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    try {
      if (!node.open) node.showModal();
    } catch {
      node.setAttribute("open", "");
    }
    primary.current?.focus({ preventScroll: true });
    const cancel = (event: Event) => {
      event.preventDefault();
      details.current();
    };
    node.addEventListener("cancel", cancel);
    return () => {
      node.removeEventListener("cancel", cancel);
      if (node.open) node.close();
    };
  }, [card]);
  return (
    <dialog
      ref={dialog}
      className="cinema-discovery"
      aria-labelledby="cinema-discovery-title"
      data-kind={card.kind}
    >
      <p className="cinema-eyebrow">{card.eyebrow}</p>
      <h2 id="cinema-discovery-title">{card.title}</h2>
      {card.facts && <p className="cinema-discovery-facts">{card.facts}</p>}
      {card.chips.length > 0 && (
        <ul className="cinema-chips" aria-label="결과 요약">
          {card.chips.map((chip) => (
            <li key={chip.label} className="cinema-chip" data-tone={chip.tone}>
              {chip.label}
            </li>
          ))}
        </ul>
      )}
      {card.note && <p className="cinema-discovery-note">{card.note}</p>}
      <div className="cinema-discovery-actions">
        <button
          ref={primary}
          type="button"
          className="cinema-primary"
          onClick={onGalaxy}
        >
          은하로 돌아가기
        </button>
        <button type="button" className="cinema-secondary" onClick={onDetails}>
          결과 자세히 보기
        </button>
      </div>
    </dialog>
  );
}
