import { Link } from "react-router-dom";
import { usePageContext } from "../../app/usePageContext";
import { ErrorState, LoadingState } from "../../components/RequestState";
import { useAnalysisData } from "./useAnalysisData";
import { TimeCurveChart } from "./TimeCurveChart";
import { contextKey } from "./analysis-data";

const isObservation = (ticId?: string) =>
  import.meta.env.DEV &&
  import.meta.env.VITE_OBSERVATIONS === "true" &&
  ["259377017", "307210830", "199574208"].includes(ticId ?? "");

function AnalysisData({ ticId }: { ticId: string }) {
  const { context, curve, loading, error, retry, bundleChanged } =
    useAnalysisData(ticId);
  if (error) return <ErrorState error={error} retry={retry} />;
  if (loading || !context || !curve)
    return bundleChanged ? (
      <p role="status">
        새 데이터 판이 확인되어 분석 자료를 다시 불러오고 있습니다.
      </p>
    ) : (
      <LoadingState />
    );
  const notice = (
    <>
      {bundleChanged && (
        <p role="status">
          새 데이터 판으로 갱신했습니다. 현재 진행 단계의 자료를 다시
          불러왔습니다.
        </p>
      )}
      {context.notice === "STEP_NOT_RESTORABLE" && (
        <p role="status">
          이전 제거 조합을 복원할 수 없어 현재 진행 단계의 자료를 불러왔습니다.
        </p>
      )}
    </>
  );
  if (curve.kind === "not-ready")
    return (
      <section role="status">
        {notice}
        <h2>곡선이 아직 준비되지 않았습니다</h2>
        <p>
          {curve.status === null
            ? "이 단계의 계산 결과가 없습니다."
            : curve.status === "FAILED"
              ? "곡선 계산에 실패했습니다."
              : "곡선을 준비하고 있습니다."}
        </p>
        <button onClick={retry}>다시 불러오기</button>
      </section>
    );
  const total = curve.segments.reduce(
    (sum, segment) => sum + segment.nPoints,
    0,
  );
  const missing = curve.segments.reduce(
    (sum, segment) =>
      sum + segment.flux.filter((point) => point === null).length,
    0,
  );
  return (
    <>
      {notice}
      <button onClick={retry}>최신 자료 확인</button>
      <section aria-label="분석 데이터 요약">
        <h2>분석 데이터</h2>
        <dl>
          <dt>Bundle ID</dt>
          <dd>{context.curveContext.bundleId}</dd>
          <dt>데이터 버전</dt>
          <dd>{context.bundleVersion}</dd>
          <dt>곡선 단계</dt>
          <dd>
            {context.curveContext.curveStep === 0
              ? "원본"
              : `잔차 ${context.curveContext.curveStep}단계`}
          </dd>
          <dt>확정 행성 보유 여부</dt>
          <dd>
            {isObservation(ticId)
              ? "미연결"
              : context.hasConfirmedCandidate
                ? "있음"
                : "없음"}
          </dd>
          <dt>밝기 단위</dt>
          <dd>{curve.fluxUnit}</dd>
          <dt>기준 시각 (BTJD)</dt>
          <dd>{context.foldReferenceTimeBtjd}</dd>
        </dl>
      </section>
      {curve.segments.length === 0 || total === missing ? (
        <p role="status">표시할 유효 관측 데이터가 없습니다.</p>
      ) : (
        <>
          <p role="status">
            관측 구간 {curve.segments.length}개 · 전체 {total}점 · 유효{" "}
            {total - missing}점 · 결측 {missing}점
          </p>
          <TimeCurveChart
            key={contextKey(curve.context)}
            segments={curve.segments}
            fluxUnit={curve.fluxUnit}
          />
          <table>
            <caption>관측 세그먼트</caption>
            <thead>
              <tr>
                <th scope="col">Sector</th>
                <th scope="col">시작 시각 (BTJD)</th>
                <th scope="col">간격 (분)</th>
                <th scope="col">전체 점 수</th>
                <th scope="col">세그먼트 산포</th>
              </tr>
            </thead>
            <tbody>
              {curve.segments.map((segment) => (
                <tr key={segment.segmentId}>
                  <th scope="row">{segment.sector}</th>
                  <td>{segment.startBtjd}</td>
                  <td>{segment.binMinutes}</td>
                  <td>{segment.nPoints}</td>
                  <td>{segment.fluxScatter}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

export function AnalysisPage() {
  const { ticId, returnTo } = usePageContext();

  return (
    <section>
      <h1>분석</h1>
      <p>TIC {ticId}</p>
      {import.meta.env.DEV && import.meta.env.VITE_OBSERVATIONS === "true" && (
        <nav aria-label="관측 데이터 항성 선택">
          <Link to="/analysis/259377017?returnTo=%2Fsky">TOI-270</Link>
          {" · "}
          <Link to="/analysis/307210830?returnTo=%2Fsky">L 98-59</Link>
          {" · "}
          <Link to="/analysis/199574208?returnTo=%2Fsky">CM Draconis</Link>
        </nav>
      )}
      {import.meta.env.DEV && import.meta.env.VITE_FIXTURE === "true" && (
        <p className="fixture-note">
          {isObservation(ticId)
            ? "프로토타입 관측 데이터입니다. 기존 정제값을 10분 평균으로 묶었습니다. 로그인·진행·판 정보는 로컬 확인용입니다."
            : "개발용 합성 응답입니다. 실제 관측 데이터가 아닙니다."}
        </p>
      )}
      {ticId ? (
        <AnalysisData key={ticId} ticId={ticId} />
      ) : (
        <p role="alert">분석할 별을 선택해 주세요.</p>
      )}
      <Link className="text-link" to={returnTo}>
        이전 화면으로
      </Link>
    </section>
  );
}
