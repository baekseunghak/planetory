// Transit caption with the live light curve, then the discovery card.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
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

/** The transit can be skipped this long after it starts. */
const SKIP_AFTER_MS = 1000;

/**
 * The caption is on from the start of the transit (the approach flight
 * included); the live light curve waits for the planet to start its pass
 * (the first light-curve sample). After a second, "건너뛰기" (or Escape)
 * jumps to the discovery card.
 */
function TransitView({ depth }: { depth: number }) {
  const { director } = useShell();
  const passing = useSyncExternalStore(
    director.subscribeFlux,
    () => director.getFlux().length > 0,
  );
  const layer = useRef<HTMLDivElement>(null);
  const [skippable, setSkippable] = useState(false);
  // The panel (and any dialog it held) stepped aside: keep keyboard focus
  // on the scene's layer, not on a control nobody can see.
  useEffect(() => {
    layer.current?.focus({ preventScroll: true });
    const timer = setTimeout(() => setSkippable(true), SKIP_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!skippable) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      director.skip();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [skippable, director]);
  return (
    <>
      {/* Outside the caption box (its transform would pin a fixed child). */}
      {skippable && (
        <button
          type="button"
          className="cinema-transit-skip"
          aria-keyshortcuts="Escape"
          onClick={() => director.skip()}
        >
          건너뛰기
        </button>
      )}
      <div
        ref={layer}
        className="cinema-transit"
        data-passing={passing ? "true" : "false"}
        aria-live="polite"
        tabIndex={-1}
      >
        <p className="cinema-transit-caption">
          당신이 본 밝기 감소는 바로 이 순간입니다
        </p>
        {passing && (
          <>
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
    </>
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
  const more = card.remaining > 0;
  const galaxyButton = (
    <button
      ref={more ? undefined : primary}
      type="button"
      className={more ? "cinema-secondary" : "cinema-primary"}
      onClick={onGalaxy}
    >
      은하로 돌아가기
    </button>
  );
  const detailsButton = (
    <button
      ref={more ? primary : undefined}
      type="button"
      className={more ? "cinema-primary" : "cinema-secondary"}
      onClick={onDetails}
    >
      결과 자세히 보기
    </button>
  );
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
      {more && (
        <p className="cinema-discovery-more">
          이 별에 찾을 수 있는 신호가 {card.remaining}개 더 남아 있습니다.
        </p>
      )}
      {/* While the star still has signals to find, the result (where the
          next one starts) leads; the galaxy leads once it is done. */}
      <div className="cinema-discovery-actions">
        {more ? (
          <>
            {detailsButton}
            {galaxyButton}
          </>
        ) : (
          <>
            {galaxyButton}
            {detailsButton}
          </>
        )}
      </div>
    </dialog>
  );
}
