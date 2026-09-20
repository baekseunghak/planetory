import { useMemo } from "react";
import type { HistoryGraphProps } from "../history/HistoryGraph.tsx";
import {
  extendHistoryGraph,
  historySeries,
  type GraphSeries,
  type HistoryGraphView,
} from "./history-graph.ts";
import "./history-curve.css";

// #190 읽기 전용 접힌 곡선. 분석 화면의 차트는 조작·워커·뷰 상태를 함께
// 들고 있어 기록 화면에 맞지 않는다. 여기서는 **읽기만** 한다.
//
// 두 모드가 같은 좌표계로 들어온다(`historySeries`). 그래서 한 컴포넌트가
// 당시 배열과 현재 곡선을 모두 그린다. 왜 이렇게 모으는지는
// docs/analysis-history.md.

const WIDTH = 720;
const HEIGHT = 260;
const PAD = { left: 52, right: 12, top: 12, bottom: 28 };

const EMPTY: Record<NonNullable<GraphSeries["emptyReason"]>, string> = {
  "no-period": "고른 주기가 없는 제출이라 접을 수 없습니다.",
  "no-curve": "이 단계의 곡선이 아직 계산되지 않았습니다.",
  "no-reference": "곡선은 왔지만 접기 기준 시각이 없어 그릴 수 없습니다.",
  "no-snapshot": "맞는 신호를 찾지 못한 제출이라 당시 배열이 없습니다.",
};

function fluxDomain(values: number[]): [number, number] {
  if (!values.length) return [0, 1];
  let low = values[0];
  let high = values[0];
  for (const value of values) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  // 완전히 평평한 곡선도 선 하나로 보여야 한다.
  if (low === high) return [low - 0.001, high + 0.001];
  const margin = (high - low) * 0.08;
  return [low - margin, high + margin];
}

/**
 * 읽기 전용 접힌 곡선.
 *
 * @param windows 당시 또는 현재의 선택 창. **경계를 넘는 창은 이미 나뉘어
 * 들어온다**(`wrapPhaseWindow`). 여기서 잇지 않는다.
 */
export function HistoryCurveChart({
  view,
  windows = [],
  caption,
}: {
  view: HistoryGraphView;
  windows?: { from: number; to: number }[];
  caption?: string;
}) {
  const series = useMemo(() => historySeries(view), [view]);
  const [low, high] = useMemo(
    () => fluxDomain(series.points.map((point) => point.flux)),
    [series],
  );

  if (series.emptyReason)
    return (
      <p className="history-curve-empty" role="status">
        {EMPTY[series.emptyReason]}
      </p>
    );

  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (phase: number) => PAD.left + (phase + 0.5) * plotWidth;
  const y = (flux: number) =>
    PAD.top + ((high - flux) / (high - low)) * plotHeight;

  const label =
    caption ??
    (view.mode === "SUBMITTED"
      ? "제출 당시 접힌 곡선"
      : "현재 판으로 다시 접은 곡선");

  return (
    <figure className="history-curve">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${label}. 위상 -0.5부터 0.5까지, 관측점 ${series.points.length}개.`}
      >
        {/* 선택 창. 나뉘어 들어온 두 조각을 잇지 않는다. */}
        {windows.map((window) => (
          <rect
            key={`${window.from}:${window.to}`}
            className="history-curve-window"
            x={x(window.from)}
            y={PAD.top}
            width={Math.max(1, x(window.to) - x(window.from))}
            height={plotHeight}
          />
        ))}
        <line
          className="history-curve-axis"
          x1={PAD.left}
          y1={PAD.top + plotHeight}
          x2={PAD.left + plotWidth}
          y2={PAD.top + plotHeight}
        />
        {[-0.5, -0.25, 0, 0.25, 0.5].map((tick) => (
          <text
            key={tick}
            className="history-curve-tick"
            x={x(tick)}
            y={HEIGHT - 8}
            textAnchor="middle"
          >
            {tick}
          </text>
        ))}
        {[high, low].map((value, index) => (
          <text
            key={value}
            className="history-curve-tick"
            x={PAD.left - 8}
            y={index === 0 ? PAD.top + 4 : PAD.top + plotHeight}
            textAnchor="end"
          >
            {value.toFixed(4)}
          </text>
        ))}
        {/* 당시 배열에는 오차가 함께 온다. 없으면 막대를 그리지 않는다. */}
        {series.kind === "bins" &&
          series.points.map(
            (point) =>
              point.error !== null && (
                <line
                  key={`e${point.phase}`}
                  className="history-curve-error"
                  x1={x(point.phase)}
                  y1={y(point.flux - point.error)}
                  x2={x(point.phase)}
                  y2={y(point.flux + point.error)}
                />
              ),
          )}
        {series.points.map((point) => (
          <circle
            key={`p${point.phase}`}
            className="history-curve-point"
            cx={x(point.phase)}
            cy={y(point.flux)}
            r={series.kind === "bins" ? 1.8 : 1.1}
          />
        ))}
      </svg>
      <figcaption>
        {label} · 위상 · 관측점 {series.points.length.toLocaleString("ko-KR")}개
        {view.alignmentUnknown && (
          <span className="history-curve-warning">
            {" "}
            스냅샷 버전 정보가 없어 선택 영역과의 정렬을 보장할 수 없습니다.
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/**
 * 공용 슬롯에 꽂는 어댑터. 213이 이미 읽은 DTO를 받으므로 파서를 **다시
 * 태우지 않는다.** 남의 화면(게시글 첨부)에는 선택 창을 주지 않는다 — 그
 * 값은 개인 상세나 공개 내용에서 오고 이 props에는 없다.
 */
export function SharedHistoryCurve({ graph, mode }: HistoryGraphProps) {
  const view = useMemo(() => extendHistoryGraph(graph, mode), [graph, mode]);
  return <HistoryCurveChart view={view} />;
}
