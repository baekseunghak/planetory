// A signal by the name the star panel gives it, for shared screens that only
// hold its id (publication review): "행성 2 (주기 11.73일)" when it is one of
// the member's planets on that star, otherwise "신호 (주기 11.73일)".
import { useCinemaSky } from "../../shell/sky";
import { useStarDetail } from "../../shell/star-detail";
import { orderOf, signalName, withPeriod } from "../format";

export function CinemaSignalName({
  ticId,
  candidateId,
  periodDays,
}: {
  ticId: string;
  candidateId: string;
  /** The signal's period when the caller knows it. */
  periodDays?: number | null;
}) {
  const focus = useStarDetail(useCinemaSky(), ticId);
  const items = focus.ticId === ticId ? focus.detail?.system.items : null;
  const planet = items?.find((item) => item.candidateId === candidateId);
  const name =
    items && planet
      ? signalName({
          planet: true,
          order: orderOf(
            items.map((item) => item.candidateId),
            candidateId,
          ),
        })
      : "신호";
  return <>{withPeriod(name, periodDays ?? planet?.periodDays ?? null)}</>;
}
