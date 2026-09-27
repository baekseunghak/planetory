// "데이터 상세" / "자료" in the cinema: what was observed, in plain words.
// The data version, the bundle id, BTJD start times and scatter are kept
// under 기술 정보. Used by the classic analysis (through the cinema copy) and
// by the new variant's 자료 dialog.
import type {
  AnalysisContext,
  CurveData,
} from "../../../features/analysis/analysis-data";
import * as f from "../format";
import { Row } from "./AcceptedResult";
import "./results.css";

type Ready = Extract<CurveData, { kind: "ready" }>;

export function CinemaDataDetails({
  context,
  viewedBundleId,
  curve,
  stepLabel,
}: {
  context: AnalysisContext;
  viewedBundleId: string;
  curve: Ready;
  /** The curve on screen, in the analysis screen's words (stepName). */
  stepLabel: string;
}) {
  const segments = curve.segments;
  const total = segments.reduce((sum, segment) => sum + segment.nPoints, 0);
  const missing = segments.reduce(
    (sum, segment) =>
      sum + segment.flux.filter((point) => point === null).length,
    0,
  );
  const origin = segments[0]?.startBtjd ?? 0;
  const unit = f.fluxUnit(curve.fluxUnit);
  const gaps = segments.slice(1).map((segment, i) => {
    const previous = segments[i];
    const days =
      segment.startBtjd +
      segment.binMinutes / 2880 -
      (previous.startBtjd +
        ((previous.nPoints - 0.5) * previous.binMinutes) / 1440);
    return {
      key: segment.segmentId,
      from: previous.sector,
      to: segment.sector,
      days,
    };
  });
  return (
    <div className="pc-data-details">
      <p>
        관측 구간 {f.count(segments.length)}개 · 관측점 {f.count(total)}개 (값
        있음 {f.count(total - missing)}개 · 비어 있음 {f.count(missing)}개)
      </p>
      <dl className="cx-facts pc-data-facts">
        <div>
          <dt>보고 있는 곡선</dt>
          <dd>{stepLabel}</dd>
        </div>
        <div>
          <dt>관측</dt>
          <dd>{f.sectors([...new Set(segments.map((s) => s.sector))])}</dd>
        </div>
        <div>
          <dt>확정 행성</dt>
          <dd>{context.hasConfirmedCandidate ? "있음" : "알려진 것 없음"}</dd>
        </div>
        <div>
          <dt>밝기</dt>
          <dd>{unit || "중앙값을 1로 맞춘 상대 밝기"}</dd>
        </div>
      </dl>
      <table className="cx-table">
        <caption>관측 구간</caption>
        <thead>
          <tr>
            <th scope="col">섹터</th>
            <th scope="col">관측 시작</th>
            <th scope="col">간격</th>
            <th scope="col">관측점</th>
          </tr>
        </thead>
        <tbody>
          {segments.map((segment) => (
            <tr key={segment.segmentId}>
              <th scope="row">{segment.sector}</th>
              <td>
                {segment.startBtjd === origin
                  ? "첫 관측"
                  : `첫 관측 뒤 ${f.days(segment.startBtjd - origin)}`}
              </td>
              <td>{f.count(segment.binMinutes)}분</td>
              <td>{f.count(segment.nPoints)}개</td>
            </tr>
          ))}
        </tbody>
      </table>
      {gaps.length > 0 && (
        <>
          <h3>섹터 사이 실제 시간 간격</h3>
          <ul>
            {gaps.map((gap) => (
              <li key={gap.key}>
                {f.sector(gap.from)} → {gap.to}:{" "}
                {gap.days >= 0 ? f.days(gap.days) : "관측 시간 범위 겹침"}
              </li>
            ))}
          </ul>
        </>
      )}
      <details className="pc-result-tech">
        <summary>기술 정보</summary>
        <dl>
          <Row term="자료 판">{viewedBundleId}</Row>
          <Row term="데이터 버전">{context.bundleVersion}</Row>
          <Row term="기준 시각">
            {f.referenceTime(context.foldReferenceTimeBtjd)}
          </Row>
          <Row term="밝기 단위">{curve.fluxUnit}</Row>
          {segments.map((segment) => (
            <Row
              key={segment.segmentId}
              term={`${f.sector(segment.sector)} 시작`}
            >
              {f.referenceTime(segment.startBtjd)} · 흩어짐{" "}
              {segment.fluxScatter.toPrecision(3)}
            </Row>
          ))}
        </dl>
      </details>
    </div>
  );
}
