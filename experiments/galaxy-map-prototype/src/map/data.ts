import type { MapNode } from "../../shared/types";
import { ApiError } from "../api/client";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): value is number =>
  finite(value) && Number.isInteger(value) && value >= 0;

function isMapNode(value: unknown): value is MapNode {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    !finite(value.x) ||
    !finite(value.y) ||
    !count(value.count) ||
    value.count < 1
  )
    return false;
  const { bounds, counts, star } = value;
  if (
    !object(bounds) ||
    !finite(bounds.x) ||
    !finite(bounds.y) ||
    !finite(bounds.w) ||
    !finite(bounds.h) ||
    bounds.w < 0 ||
    bounds.h < 0 ||
    !object(counts) ||
    !count(counts.planet) ||
    !count(counts.done) ||
    !count(counts.new)
  )
    return false;
  if (value.count > 1) return star === undefined;
  return (
    object(star) &&
    typeof star.id === "string" &&
    typeof star.name === "string" &&
    finite(star.x) &&
    finite(star.y) &&
    count(star.planetCount) &&
    ["unexplored", "in_progress", "complete"].includes(String(star.status)) &&
    (star.tutorial === null || count(star.tutorial)) &&
    typeof star.challenge === "boolean"
  );
}

export function readMapNodes(response: unknown): MapNode[] {
  if (
    !object(response) ||
    !Array.isArray(response.nodes) ||
    !response.nodes.every(isMapNode)
  )
    throw new ApiError(
      200,
      "INVALID_MAP_RESPONSE",
      "지도 데이터를 읽을 수 없습니다. 다시 시도해 주세요.",
    );
  return response.nodes;
}
