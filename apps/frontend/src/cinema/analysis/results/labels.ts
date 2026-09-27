// "행성 N" / "신호 N" for the signals of a star, from what the member's own
// star detail says (GET /v1/me/stars/:tic, the star panel's list) and, right
// after a submission, from the outcome the scene played (HOME-05).
import { useContext, useEffect, useState } from "react";
import { api } from "../../../api";
import {
  readPlanetExplanations,
  type StarDetail,
} from "../../../features/sky-renderer/detail";
import { lastAnalysis } from "../bridge";
import { ShellContext } from "../../shell/context";
import { knownPlanetName, orderOf, signalName, withPeriod } from "../format";

type Signal = {
  candidateId: string;
  disposition: string;
  external?: { source: string; externalId: string; disposition: string }[];
  bls?: { periodDays: number } | null;
};

/**
 * Candidate ids of the member's planets on `ticId`, when the shell holds that
 * star's detail (the analysis on stage). null when unknown.
 */
export function useStagePlanetIds(ticId: string): string[] | null {
  const shell = useContext(ShellContext);
  const detail = shell?.focus.detail;
  if (!detail || detail.system.ticId !== ticId) return null;
  return detail.system.items.map((item) => item.candidateId);
}

/**
 * Is the matched signal one of the member's planets? The outcome the scene
 * played for this submission says so exactly (revealsPlanet); otherwise the
 * star detail, and a confirmed planet always is (HOME-05).
 */
export function isMemberPlanet(
  signal: Signal,
  submissionId: string | null,
  planetIds: readonly string[] | null,
): boolean {
  const outcome = lastAnalysis("outcome");
  if (
    submissionId &&
    outcome?.submissionId === submissionId &&
    outcome.planet?.candidateId === signal.candidateId
  )
    return outcome.revealsPlanet;
  if (planetIds?.includes(signal.candidateId)) return true;
  return signal.disposition === "CONFIRMED";
}

/**
 * "행성 1 · WASP-62 b (주기 4.41일)" or "신호 2 (주기 3.98일)". Other signals
 * are numbered among the star's matched signals that are not planets.
 */
export function matchedSignalLabel({
  signal,
  planet,
  planetIds,
  matchedIds,
  withPeriodDays = true,
}: {
  signal: Signal;
  planet: boolean;
  planetIds: readonly string[] | null;
  matchedIds: readonly string[];
  withPeriodDays?: boolean;
}): string {
  const planets = new Set(planetIds ?? []);
  const others = [
    ...new Set([
      ...matchedIds.filter((id) => !planets.has(id)),
      signal.candidateId,
    ]),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const name = signalName({
    planet,
    order: planet
      ? orderOf(planetIds ?? [], signal.candidateId)
      : others.indexOf(signal.candidateId) + 1,
    name: planet ? knownPlanetName(signal.external) : null,
  });
  return withPeriodDays ? withPeriod(name, signal.bls?.periodDays) : name;
}

/**
 * Published names of the member's confirmed planets on a star (NASA planet
 * explanations, the star panel's source). Empty until read, and on failure:
 * a missing name only shortens the label.
 */
export function useKnownPlanetNames(
  detail: StarDetail | null,
): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const ticId = detail?.system.ticId ?? null;
  const version = detail?.system.version ?? null;
  const confirmed =
    detail?.system.items.some((item) => item.kind === "confirmed") ?? false;
  useEffect(() => {
    setNames(new Map());
    if (!detail || !confirmed) return;
    const controller = new AbortController();
    void api<unknown>(
      `/v1/me/stars/${encodeURIComponent(detail.system.ticId)}/planet-explanations`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        const found = new Map<string, string>();
        for (const row of readPlanetExplanations(value, detail)) {
          const name = row.facts?.planetName ?? row.content?.name ?? null;
          if (row.kind === "confirmed" && name)
            found.set(row.candidateId, name);
        }
        setNames(found);
      })
      .catch(() => undefined);
    return () => controller.abort();
    // The detail object changes on every read; its star and version do not.
  }, [ticId, version, confirmed]);
  return names;
}
