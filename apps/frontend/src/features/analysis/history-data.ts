import { readCurveContext, type CurveContext } from "./analysis-data.ts";
import {
  matchStatuses,
  readProgress,
  submissionKinds,
  type MatchStatus,
  type SubmissionKind,
  type SubmissionProgress,
} from "./submission-data.ts";
import {
  readResultExplanation,
  storedPublicationStates,
  type ResultExplanation,
} from "./submission-result.ts";

// 탐사 API 8.2절 `GET /api/v1/histories/{historyId}`를 읽는다. 본문은 6.4절
// `submissionResult` 전체에 보관 정보를 더한 것이라, 해설은 #188의 파서를
// 그대로 쓰고 여기서는 더해진 것만 읽는다. 왜 이렇게 가르는지는
// docs/analysis-history.md.

export const historyPath = (historyId: string) =>
  `/v1/histories/${encodeURIComponent(historyId)}`;

/**
 * 이 기록을 만든 처리 버전. **`preprocess`·`pipeline`은 null일 수 있다** —
 * 143이 따로 보존하지 않은 값이라, 현재 처리 버전으로 꾸며 채우지 않는다.
 */
export type HistoryVersions = {
  data: string | null;
  preprocess: string | null;
  pipeline: string | null;
  rule: string | null;
  residualModel: string | null;
  periodogramConfig: string | null;
  /** 저장 스냅샷의 계산 버전. 구기록에는 없다. 없다고 최신으로 추정하지 않는다. */
  snapshot: string | null;
};

/** 제출 당시 보던 화면. 그래프를 이미지가 아니라 이 값으로 되살린다. */
export type HistorySnapshotParams = {
  periodogramViewport: { minDays: number; maxDays: number } | null;
  foldedXZoomRatio: number | null;
  /** 제출 당시 기준 시각. 현재 판의 기준 시각과 다를 수 있다. */
  foldReferenceTimeBtjd: number | null;
  centroidDataStatus: string | null;
};

/** 외부 라벨이 바뀌었다는 표시(GRD-06). 당시 판정·성과는 바뀌지 않는다. */
export type HistoryRelabel = { relabeledAt: string; newDisposition: string };

export type HistoryDetail = {
  historyId: string;
  submissionId: string;
  ticId: string;
  submittedAt: string;
  submissionKind: SubmissionKind;
  matchStatus: MatchStatus;
  curveContext: CurveContext;
  /** **조회 시점** 값이다. 당시 진행이 아니다. */
  progress: SubmissionProgress;
  explanation: ResultExplanation;
  versions: HistoryVersions;
  snapshotParams: HistorySnapshotParams;
  /** 저장 판이 현재 판이 아닌가. 현재 판이 없으면 서버가 참으로 준다. */
  isPreviousBundle: boolean;
  relabel: HistoryRelabel | null;
  createdAt: string;
};

function invalid(field: string): never {
  throw new Error(`기록 응답을 읽을 수 없습니다: ${field}`);
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) invalid(field);
  return value;
}
function instant(value: unknown, field: string): string {
  const raw = text(value, field);
  if (!/Z$/.test(raw) || Number.isNaN(Date.parse(raw))) invalid(field);
  return raw;
}
function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field);
  return value;
}
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  const raw = text(value, field);
  if (!(allowed as readonly string[]).includes(raw)) invalid(field);
  return raw as T;
}
const nullableText = (value: unknown, field: string) =>
  value === null || value === undefined ? null : text(value, field);
const nullableNumber = (value: unknown, field: string) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
  return value;
};

function readVersions(value: unknown): HistoryVersions {
  const row = record(value, "versions");
  return {
    data: nullableText(row.data, "versions.data"),
    preprocess: nullableText(row.preprocess, "versions.preprocess"),
    pipeline: nullableText(row.pipeline, "versions.pipeline"),
    rule: nullableText(row.rule, "versions.rule"),
    residualModel: nullableText(row.residualModel, "versions.residualModel"),
    periodogramConfig: nullableText(
      row.periodogramConfig,
      "versions.periodogramConfig",
    ),
    snapshot: nullableText(row.snapshotVersion, "versions.snapshotVersion"),
  };
}

function readSnapshotParams(value: unknown): HistorySnapshotParams {
  const row = record(value, "snapshotParams");
  const viewport =
    row.periodogramViewport === null || row.periodogramViewport === undefined
      ? null
      : record(row.periodogramViewport, "snapshotParams.periodogramViewport");
  const fold =
    row.foldSettings === null || row.foldSettings === undefined
      ? null
      : record(row.foldSettings, "snapshotParams.foldSettings");
  const minDays = viewport
    ? nullableNumber(viewport.minDays, "snapshotParams.minDays")
    : null;
  const maxDays = viewport
    ? nullableNumber(viewport.maxDays, "snapshotParams.maxDays")
    : null;
  // 창은 두 값이 함께 있어야 창이다. 한쪽만 오면 어디를 보던 것인지 모른다.
  if ((minDays === null) !== (maxDays === null))
    invalid("snapshotParams.periodogramViewport");
  if (minDays !== null && maxDays !== null && !(minDays < maxDays))
    invalid("snapshotParams.periodogramViewport");
  return {
    periodogramViewport:
      minDays !== null && maxDays !== null ? { minDays, maxDays } : null,
    foldedXZoomRatio: nullableNumber(
      row.foldedXZoomRatio,
      "snapshotParams.foldedXZoomRatio",
    ),
    foldReferenceTimeBtjd: fold
      ? nullableNumber(
          fold.referenceTimeBtjd,
          "snapshotParams.foldSettings.referenceTimeBtjd",
        )
      : null,
    centroidDataStatus: nullableText(
      row.centroidDataStatus,
      "snapshotParams.centroidDataStatus",
    ),
  };
}

/**
 * 8.2절 기록 상세. **당시 값과 조회 시점 값을 섞지 않는다.**
 *
 * `submission`은 6.4절 본문 전체라 #188의 해설 파서를 그대로 태운다. 접수
 * 경로의 `decodeSubmissionReceipt`를 쓰지 않는 이유는 그쪽이 요청 ID 대조와
 * 201/200 구분을 하기 때문이다. 기록 조회에는 둘 다 없다.
 *
 * @param expected 주소의 기록 번호. 응답이 다른 기록이면 잘못 읽은 것이다.
 */
export function readHistoryDetail(
  value: unknown,
  expected: { historyId: string },
): HistoryDetail {
  const data = record(value, "history");
  const historyId = text(data.historyId, "historyId");
  if (historyId !== expected.historyId) invalid("historyId");

  const submission = record(data.submission, "submission");
  const submissionKind = oneOf(
    submission.submissionKind,
    submissionKinds,
    "submission.submissionKind",
  );
  const matchStatus = oneOf(
    record(submission.match, "submission.match").status,
    matchStatuses,
    "submission.match.status",
  );
  const curveContext = readCurveContext(submission.curveContext);
  if (
    text(submission.bundleId, "submission.bundleId") !== curveContext.bundleId
  )
    invalid("submission.bundleId/curveContext");

  const relabel =
    data.relabel === null || data.relabel === undefined
      ? null
      : (() => {
          const row = record(data.relabel, "relabel");
          return {
            relabeledAt: instant(row.relabeledAt, "relabel.relabeledAt"),
            newDisposition: text(row.newDisposition, "relabel.newDisposition"),
          };
        })();

  return {
    historyId,
    submissionId: text(submission.submissionId, "submission.submissionId"),
    ticId: text(submission.ticId, "submission.ticId"),
    submittedAt: instant(submission.submittedAt, "submission.submittedAt"),
    submissionKind,
    matchStatus,
    curveContext,
    progress: readProgress(submission.progress),
    // 8.2절은 시간이 지난 뒤의 기록이라 `PUBLISHED`·`HIDDEN`이 더 온다.
    // 6.4절 집합으로 읽으면 공개한 기록을 열지 못한다.
    explanation: readResultExplanation(
      submission,
      matchStatus,
      storedPublicationStates,
    ),
    versions: readVersions(data.versions),
    snapshotParams: readSnapshotParams(data.snapshotParams),
    isPreviousBundle: flag(data.isPreviousBundle, "isPreviousBundle"),
    relabel,
    createdAt: instant(data.createdAt, "createdAt"),
  };
}
