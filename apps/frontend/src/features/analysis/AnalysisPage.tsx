import { AnalysisReturnLink } from "./AnalysisReturnLink";
import { FoldViewControls } from "./FoldViewControls";
import { AnalysisSteps } from "./AnalysisJudgment";
import { sameContext, stepName } from "./curve-step";
import { CurveStepBar } from "./CurveStepBar";
import { useCurveStep } from "./use-curve-step";
import { useMemo, type ReactNode } from "react";
import "./analysis-screen.css";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { AnalysisEntryGate, AnalysisEntryError } from "./AnalysisEntry";
import type { AnalysisEntry } from "./load-analysis";
import type { RetryDraft } from "./retry-draft";
import { usePageContext } from "../../app/usePageContext";
import { LoadingState } from "../../components/RequestState";
import { useAnalysisData } from "./useAnalysisData";
import { TimeCurveChart } from "./TimeCurveChart";
import {
  contextKey,
  type AnalysisContext,
  type CurveData,
} from "./analysis-data";
import { PeriodogramPanel } from "./PeriodogramPanel";
import { AnalysisSession } from "./AnalysisSession";

const isObservation = (ticId?: string) =>
  import.meta.env.DEV &&
  import.meta.env.VITE_OBSERVATIONS === "true" &&
  ["259377017", "307210830", "199574208"].includes(ticId ?? "");

function AnalysisData({
  ticId,
  entry,
}: {
  ticId: string;
  entry?: AnalysisEntry;
}) {
  const {
    context,
    curve,
    loading,
    error,
    retry,
    bundleChanged,
    recoverBundle,
    retryDraft,
  } = useAnalysisData(ticId, entry);
  if (error)
    return (
      <AnalysisEntryError key={String(error)} error={error} retry={retry} />
    );
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
      {retryDraft && (
        <p role="status">
          이전 제출을 바탕으로 현재 데이터에서 다시 풉니다. 새 판단은 제출할
          때만 기록됩니다.
        </p>
      )}
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
  // 여기부터는 문맥·곡선이 확실하다. 단계 이동 상태를 여기서 만들어야
  // 보고 있는 곡선을 차트·주기도·제출이 함께 따라간다.
  return (
    <AnalysisReady
      ticId={ticId}
      context={context}
      entryCurve={curve}
      retry={retry}
      recoverBundle={recoverBundle}
      notice={notice}
      retryDraft={retryDraft}
      resume={entry?.resume ?? false}
      autoRestore={entry?.autoRestore ?? false}
      retryAttemptId={entry?.retryAttemptId}
    />
  );
}

function AnalysisReady({
  ticId,
  context,
  entryCurve,
  retry,
  recoverBundle,
  notice,
  retryDraft,
  resume,
  autoRestore,
  retryAttemptId,
}: {
  ticId: string;
  context: AnalysisContext;
  entryCurve: Extract<CurveData, { kind: "ready" }>;
  retry: () => void;
  recoverBundle: () => boolean;
  notice: ReactNode;
  retryDraft: RetryDraft | null;
  resume: boolean;
  autoRestore: boolean;
  retryAttemptId?: string;
}) {
  // 계산이 도는 동안 판이 바뀌면 곡선 조회와 똑같이 자동으로 다시 읽는다.
  const step = useCurveStep(context, entryCurve, recoverBundle);
  // 보고 있는 곡선. 전환이 끝나야 바뀌므로 그 전에는 진입 곡선 그대로다.
  const curve = step.curve.kind === "ready" ? step.curve : entryCurve;
  /**
   * 아래로 내려보내는 문맥은 **보고 있는 단계**의 것이다. 주기도 조회와
   * 제출이 모두 이 문맥을 쓰므로, 진입 문맥을 그대로 내려보내면 표시만
   * 바뀌고 실제로 읽고 보내는 곳은 이전 단계가 된다.
   */
  const viewed = useMemo(
    () =>
      sameContext(step.viewing, context.curveContext)
        ? context
        : { ...context, curveContext: step.viewing },
    [context, step.viewing],
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
  const details = (
    <>
      <button onClick={retry}>최신 자료 확인</button>
      <section aria-label="분석 데이터 요약">
        <h2>분석 데이터</h2>
        <dl>
          <dt>Bundle ID</dt>
          <dd>{viewed.curveContext.bundleId}</dd>
          <dt>데이터 버전</dt>
          <dd>{context.bundleVersion}</dd>
          <dt>곡선 단계</dt>
          <dd>{stepName(step.viewing)}</dd>
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
      <h3>Sector 경계의 실제 시간 간격</h3>
      <ul>
        {curve.segments.slice(1).map((segment, i) => {
          const previous = curve.segments[i];
          const days =
            segment.startBtjd +
            segment.binMinutes / 2880 -
            (previous.startBtjd +
              ((previous.nPoints - 0.5) * previous.binMinutes) / 1440);
          return (
            <li key={segment.segmentId}>
              Sector {previous.sector} → {segment.sector}:{" "}
              {days >= 0 ? `${days.toFixed(5)}일` : "관측 시간 범위 겹침"}
            </li>
          );
        })}
      </ul>
    </>
  );
  return (
    <>
      {notice}
      {curve.segments.length === 0 || total === missing ? (
        <>
          <p role="status">표시할 유효 관측 데이터가 없습니다.</p>
          {details}
        </>
      ) : (
        <AnalysisSession
          key={contextKey(curve.context)}
          context={viewed}
          step={step}
          curve={curve}
          recoverBundle={recoverBundle}
          retryDraft={retryDraft}
          resume={resume}
          autoRestore={autoRestore}
          retryAttemptId={retryAttemptId}
        >
          <div className="analysis-screen-grid">
            <div className="analysis-step-row">
              <AnalysisSteps />
              <span>
                {isObservation(ticId)
                  ? "행성 정보 미연결"
                  : context.hasConfirmedCandidate
                    ? "확정 행성 보유"
                    : "확정 행성 정보 없음"}{" "}
                · 데이터 {context.bundleVersion}
              </span>
              <CurveStepBar context={context} />
            </div>
            <TimeCurveChart
              key={contextKey(curve.context)}
              segments={curve.segments}
              fluxUnit={curve.fluxUnit}
            />
            <PeriodogramPanel
              key={`periodogram-${contextKey(curve.context)}`}
              context={viewed}
              curve={curve}
              reloadAnalysis={retry}
              recoverBundle={recoverBundle}
            />
            <div className="analysis-secondary">
              <details>
                <summary>판별 도구 열기 ›</summary>
                <p>홀짝·2차 식·V/U형 판별 도구는 연결 준비 중입니다.</p>
              </details>
              <div className="analysis-secondary-links">
                <details>
                  <summary>데이터 상세 ›</summary>
                  <p>
                    관측 구간 {curve.segments.length}개 · 전체 {total}점 · 유효{" "}
                    {total - missing}점 · 결측 {missing}점
                  </p>
                  {details}
                </details>
                <details>
                  <summary>조작 도움말 ›</summary>
                  <FoldViewControls />
                  <p>
                    그래프에 포커스한 뒤 +/−로 확대·축소, ←/→로 이동, 0/Home으로
                    전체 보기를 합니다. 접힌 곡선은 최대 32배이며 미세 조정 중
                    위치를 유지합니다.
                  </p>
                  <p>
                    주기도의 봉우리 버튼에 Tab으로 이동해 주기와 power를
                    확인하고 Enter로 선택합니다. 빈 위치를 클릭하거나 ↑/↓로 조회
                    후 Enter를 누르면 직접 선택합니다.
                  </p>
                  <p>
                    구간 선택 단계에서 드래그로 새 구간, Shift+드래그로 가로
                    이동합니다. 키보드는 접힌 곡선 아래 ‘키보드 구간 선택’에서
                    시작하며 핸들 방향키 간격은 보기 폭의 1/1000, Shift는
                    10배입니다.
                  </p>
                </details>
              </div>
            </div>
          </div>
        </AnalysisSession>
      )}
    </>
  );
}

export function AnalysisPage() {
  const { ticId, returnTo } = usePageContext();
  const [params] = useSearchParams();
  const location = useLocation();
  const retryId = params.get("retryOfSubmissionId");

  return (
    <section className="analysis-screen">
      <header className="analysis-screen-header">
        <Link to="/sky">PLANETORY</Link>
        <h1>
          <span className="analysis-sr-only">분석 · </span>TIC {ticId}
        </h1>
        <AnalysisReturnLink ticId={ticId ?? ""} to={returnTo}>
          ← 이전 화면
        </AnalysisReturnLink>
      </header>
      {import.meta.env.DEV && import.meta.env.VITE_FIXTURE === "true" && (
        <details className="analysis-fixture-details">
          <summary>합성 샘플 · 상세 안내</summary>
          {import.meta.env.DEV &&
            import.meta.env.VITE_OBSERVATIONS === "true" && (
              <nav aria-label="관측 데이터 항성 선택">
                <Link to="/analysis/259377017?returnTo=%2Fsky">TOI-270</Link>
                {" · "}
                <Link to="/analysis/307210830?returnTo=%2Fsky">L 98-59</Link>
                {" · "}
                <Link to="/analysis/199574208?returnTo=%2Fsky">
                  CM Draconis
                </Link>
              </nav>
            )}
          {import.meta.env.DEV && import.meta.env.VITE_FIXTURE === "true" && (
            <nav className="fixture-links" aria-label="주기도 개발 샘플">
              <Link to="/analysis/259377024?returnTo=%2Fsky">
                주기도 정상 샘플
              </Link>
              <Link to="/analysis/259377027?returnTo=%2Fsky">
                빈 봉우리 샘플
              </Link>
              <Link to="/analysis/259377028?returnTo=%2Fsky">
                주기도 오류 샘플
              </Link>
            </nav>
          )}
          {import.meta.env.DEV && import.meta.env.VITE_FIXTURE === "true" && (
            <p className="fixture-note">
              {isObservation(ticId)
                ? "프로토타입 관측 데이터입니다. 기존 정제값을 10분 평균으로 묶었습니다. 로그인·진행·판 정보는 로컬 확인용입니다."
                : "개발용 합성 응답입니다. 실제 관측 데이터가 아닙니다."}
            </p>
          )}
          {import.meta.env.DEV &&
            import.meta.env.VITE_FIXTURE === "true" &&
            ticId === "259377024" && (
              <p className="fixture-note">
                접기 확인용 합성 샘플: 120일 동안 1위 봉우리 주기로 밝기가
                반복해서 떨어집니다. 1위 봉우리를 선택하면 하락 구간이 겹치고,
                미세 조정 슬라이더를 끝으로 옮기면 퍼집니다. 주기도는 BLS 계산
                결과가 아닌 조작 확인용 예제입니다.
              </p>
            )}
        </details>
      )}
      {ticId ? (
        <AnalysisEntryGate
          key={`${ticId}:${location.key}`}
          ticId={ticId}
          retryId={retryId}
        >
          {(entry) => <AnalysisData ticId={ticId} entry={entry} />}
        </AnalysisEntryGate>
      ) : (
        <p role="alert">분석할 별을 선택해 주세요.</p>
      )}
    </section>
  );
}
