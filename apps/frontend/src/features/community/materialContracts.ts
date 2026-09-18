import { ApiError } from "../../api/client";

export type Source = { type: "PUBLIC_ANALYSIS" | "SIGNAL_THREAD"; id: string };
export type Materials = { historyIds?: string[]; sourceLinks?: Source[] };
export const emptyMaterials = (): Required<Materials> => ({
  historyIds: [],
  sourceLinks: [],
});
const sameIdentities = (a: string[], b: string[]) => {
  const left = new Set(a),
    right = new Set(b);
  return (
    a.length === b.length &&
    left.size === a.length &&
    right.size === b.length &&
    a.every((id) => right.has(id))
  );
};
// Attachments are identified by ID (sources also by type), not response order.
export const sameMaterials = (a: Materials, b: Materials) =>
  sameIdentities(a.historyIds ?? [], b.historyIds ?? []) &&
  sameIdentities(
    (a.sourceLinks ?? []).map((s) => JSON.stringify([s.type, s.id])),
    (b.sourceLinks ?? []).map((s) => JSON.stringify([s.type, s.id])),
  );
export function materialError(value: Materials, ticId: string | null) {
  const histories = value.historyIds ?? [],
    sources = value.sourceLinks ?? [];
  if (!ticId && (histories.length || sources.length))
    return "자료를 첨부하려면 별을 먼저 선택해 주세요.";
  if (histories.length > 3 || sources.length > 3)
    return "분석 기록과 공개 출처는 각각 최대 3개입니다.";
  if (
    new Set(histories).size !== histories.length ||
    new Set(sources.map((s) => s.type + ":" + s.id)).size !== sources.length
  )
    return "같은 자료를 두 번 첨부할 수 없습니다.";
  return "";
}
export const invalidMaterial = (): never => {
  throw new ApiError(0, "INVALID_RESPONSE", "자료 응답을 확인할 수 없습니다.");
};
export function materialObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalidMaterial();
  return value as Record<string, unknown>;
}
export function materialText(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return invalidMaterial();
  return value;
}
export function readMaterials(
  raw: Record<string, unknown>,
): Required<Materials> {
  // Older read-only fixtures may omit arrays; when present they must be valid.
  const attachments = raw.attachments ?? [],
    sources = raw.sourceLinks ?? [];
  if (!Array.isArray(attachments) || !Array.isArray(sources))
    return invalidMaterial();
  const result = {
    historyIds: attachments.map((v) =>
      materialText(materialObject(v).historyId),
    ),
    sourceLinks: sources
      .filter((v) => materialObject(v).available !== false)
      .map((v) => {
        const s = materialObject(v);
        if (s.type !== "PUBLIC_ANALYSIS" && s.type !== "SIGNAL_THREAD")
          return invalidMaterial();
        return { type: s.type, id: materialText(s.id) } as Source;
      }),
  };
  if (materialError(result, "selected")) return invalidMaterial();
  return result;
}
export function readSource(raw: unknown, expected: Source, ticId: string) {
  const row = materialObject(raw);
  if (row.available === false)
    throw new ApiError(
      404,
      "SOURCE_UNAVAILABLE",
      "공개 취소되었거나 볼 수 없는 출처입니다.",
    );
  if (
    row.available !== true ||
    row.type !== expected.type ||
    row.id !== expected.id ||
    row.ticId !== ticId
  )
    return invalidMaterial();
  return row;
}
