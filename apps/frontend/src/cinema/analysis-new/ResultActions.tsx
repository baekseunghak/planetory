import { Link } from "react-router-dom";
import { pagePath } from "../../app/paths";
import { usePageContext } from "../../app/usePageContext";
import type { SubmissionReceipt } from "../../features/analysis/submission-data";
import type { AnalysisOutcome } from "../analysis/bridge";

/** 은하 이동은 왼쪽, 허용된 공개 검토와 다음 곡선은 오른쪽. 둘 다 없으면 제출 결과를 우선한다. */
export function ResultActions({
  receipt,
  kind,
  nextCurve,
  onDetails,
  onAgain,
}: {
  receipt: SubmissionReceipt;
  kind: AnalysisOutcome["kind"];
  nextCurve?: () => void;
  onDetails(): void;
  onAgain(step: 1 | 2): void;
}) {
  const { currentPath } = usePageContext();
  const publish = receipt.nextActions.includes("PUBLISH_ANALYSIS");
  const publishUrl = pagePath("publicationBatch", {}, { ticId: receipt.ticId, returnTo: currentPath });
  const details = (className: string) => (
    <button
      type="button"
      className={className}
      // The discovery card's "이번 제출 결과" opens this same view.
      data-result-details=""
      onClick={onDetails}
    >
      이번 제출 결과
    </button>
  );
  const next =
    receipt.nextActions.includes("NEXT_CURVE") &&
    nextCurve &&
    receipt.progress.stage !== "completed" ? (
      <button type="button" className="cx-primary" onClick={nextCurve}>
        다음 곡선 단계로
      </button>
    ) : null;
  const missed = kind === "numericMismatch";
  const ambiguous = kind === "ambiguous";
  return (
    <>
      {next && <p className="cx-note">분석 기록은 나중에 모아서 공개할 수 있습니다.</p>}
      <div className="cx-actions cx-result-flow" data-testid="cx-result-actions">
        <Link className="cx-secondary cx-result-home" to="/sky">나의 은하로</Link>
        {missed ? (
          <>
            <button
              type="button"
              className="cx-primary"
              onClick={() => onAgain(2)}
            >
              구간 다시 잡기
            </button>
            <button
              type="button"
              className="cx-secondary"
              onClick={() => onAgain(1)}
            >
              주기 다시 고르기
            </button>
          </>
        ) : ambiguous ? (
          <button
            type="button"
            className="cx-primary"
            onClick={() => onAgain(1)}
          >
            주기 다시 고르기
          </button>
        ) : (
          <>
            {publish && <Link className={next ? "cx-secondary" : "cx-primary"} to={publishUrl}>{next ? "공개 검토" : "이 별의 분석 공개 검토"}</Link>}
            {next}
            {!publish && !next && details("cx-primary")}
          </>
        )}
      </div>
      <p className="cx-next">
        {(missed || ambiguous || publish || next) && details("cx-link")}
      </p>
    </>
  );
}

