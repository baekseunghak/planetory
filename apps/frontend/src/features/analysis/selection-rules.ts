export type SelectionRules = Readonly<{
  version: string;
  minWindowDays: number;
  phaseWidthMax: number;
  maxDurationMultipleOfSuggested: number;
  allowEmptyPhaseSpan: boolean;
}>;

export type SelectionIssue = Readonly<{
  field: string;
  code: string;
  message: string;
}>;

export class SelectionInputError extends Error {
  constructor(readonly issue: SelectionIssue) {
    super(issue.message);
  }
}

export type SelectionContract =
  | {
      kind: "ready";
      rules: SelectionRules;
      observationBounds: readonly [number, number];
    }
  | { kind: "unavailable"; issues: readonly SelectionIssue[] };

export function selectionError(
  field: string,
  code: string,
  message: string,
): never {
  throw new SelectionInputError({ field, code, message });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    selectionError(
      "selectionRules",
      "RULES_UNAVAILABLE",
      "구간 선택 규칙을 불러오지 못했습니다.",
    );
  return value as Record<string, unknown>;
}

function positive(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    selectionError(
      field,
      "INVALID_RULE",
      "구간 선택 규칙의 유한한 양수 값을 확인해 주세요.",
    );
  return value;
}

/** Missing selection metadata must not hide the already usable curves/periodogram. */
export function readSelectionContract(
  rulesValue: unknown,
  boundsValue: unknown,
): SelectionContract {
  try {
    const raw = record(rulesValue);
    if (typeof raw.version !== "string" || !raw.version.trim())
      selectionError(
        "selectionRules.version",
        "INVALID_RULE",
        "구간 선택 규칙 버전이 없습니다.",
      );
    const phaseWidthMax = positive(
      raw.phaseWidthMax,
      "selectionRules.phaseWidthMax",
    );
    if (phaseWidthMax > 1)
      selectionError(
        "selectionRules.phaseWidthMax",
        "INVALID_RULE",
        "최대 위상 폭은 1 이하여야 합니다.",
      );
    if (typeof raw.allowEmptyPhaseSpan !== "boolean")
      selectionError(
        "selectionRules.allowEmptyPhaseSpan",
        "INVALID_RULE",
        "빈 위상 구간의 허용 규칙이 없습니다.",
      );
    const rules: SelectionRules = {
      version: raw.version,
      minWindowDays: positive(
        raw.minWindowDays,
        "selectionRules.minWindowDays",
      ),
      phaseWidthMax,
      maxDurationMultipleOfSuggested: positive(
        raw.maxDurationMultipleOfSuggested,
        "selectionRules.maxDurationMultipleOfSuggested",
      ),
      allowEmptyPhaseSpan: raw.allowEmptyPhaseSpan,
    };
    if (
      !Array.isArray(boundsValue) ||
      boundsValue.length !== 2 ||
      boundsValue.some(
        (value) => typeof value !== "number" || !Number.isFinite(value),
      ) ||
      boundsValue[0] > boundsValue[1]
    )
      selectionError(
        "bundle.observationBounds",
        "INVALID_OBSERVATION_BOUNDS",
        "관측 시각의 범위를 확인해 주세요.",
      );
    return {
      kind: "ready",
      rules,
      observationBounds: [boundsValue[0], boundsValue[1]],
    };
  } catch (error) {
    if (error instanceof SelectionInputError)
      return { kind: "unavailable", issues: [error.issue] };
    throw error;
  }
}
