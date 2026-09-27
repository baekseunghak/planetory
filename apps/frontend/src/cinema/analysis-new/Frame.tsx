import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  type ReactNode,
} from "react";
import type {
  AnalysisContext,
  CurveData,
} from "../../features/analysis/analysis-data";
import { useCurveStepSession } from "../../features/analysis/AnalysisSession";
import { remainingSeconds, stepName } from "../../features/analysis/curve-step";
import { MAX_FOLD_ZOOM } from "../../features/analysis/folded-curve";
import { useModalDialog } from "../../features/analysis/use-modal-dialog";
import { CinemaDataDetails } from "../analysis/results/DataDetails";

/**
 * One live region for the guidance line, owned by the route element, so the
 * line is announced even when the panel body remounts (loading -> ready).
 */
export const AnnounceContext = createContext<(text: string) => void>(
  () => undefined,
);

/** The panel layout: head (meta, guidance, tools), notices, three areas. */
export function PanelFrame({
  meta,
  guide,
  tools,
  notices,
  period,
  window,
  judge,
  busy = false,
}: {
  meta: ReactNode;
  guide: string;
  tools?: ReactNode;
  notices?: ReactNode;
  period: ReactNode;
  window: ReactNode;
  judge: ReactNode;
  busy?: boolean;
}) {
  const announce = useContext(AnnounceContext);
  useEffect(() => announce(guide), [announce, guide]);
  return (
    <div className="cx-frame" aria-busy={busy || undefined}>
      <header className="cx-head">
        <p className="cx-meta">{meta}</p>
        <p className="cx-guide" data-testid="cx-guide">
          {guide}
        </p>
        <div className="cx-head-tools">{tools}</div>
      </header>
      {notices && <div className="cx-notices">{notices}</div>}
      <div className="cx-grid">
        {period}
        {window}
        {judge}
      </div>
    </div>
  );
}

/**
 * The same three areas before there is anything to choose (loading, or a
 * periodogram that cannot be shown), so the panel keeps its height.
 */
export function SkeletonFrame({
  meta = <b>관측</b>,
  guide,
  tools,
  notices,
  strip,
  period,
  periodAction,
  busy = true,
}: {
  meta?: ReactNode;
  guide: string;
  tools?: ReactNode;
  notices?: ReactNode;
  strip?: ReactNode;
  period?: ReactNode;
  periodAction?: ReactNode;
  busy?: boolean;
}) {
  return (
    <PanelFrame
      busy={busy}
      meta={meta}
      guide={guide}
      tools={tools}
      notices={notices}
      period={
        <section
          className="cx-area"
          data-area="period"
          data-state="active"
          aria-label="반복 주기"
        >
          {strip ?? (
            <div className="cx-strip">
              <div className="cx-row">
                <span className="cx-sublabel">밝기 변화</span>
              </div>
              <div
                className="cx-strip-plot cx-waiting"
                data-loading={busy || undefined}
              />
            </div>
          )}
          <div className="cx-row">
            <h2 className="cx-label">주기</h2>
          </div>
          <div
            className="cx-plot cx-period-plot cx-waiting"
            data-loading={busy || undefined}
          >
            {period}
          </div>
          {periodAction}
        </section>
      }
      window={
        <section
          className="cx-area"
          data-area="window"
          data-state="idle"
          aria-label="구간"
        >
          <div className="cx-row">
            <h2 className="cx-label">구간</h2>
          </div>
          <div className="cx-plot cx-fold-plot cx-waiting">
            <p className="cx-empty">주기를 고르면 여기서 곡선이 접힙니다</p>
          </div>
        </section>
      }
      judge={
        <section
          className="cx-area"
          data-area="judge"
          data-state="idle"
          aria-label="판단과 제출"
        >
          <div className="cx-row">
            <h2 className="cx-label">판단</h2>
          </div>
          <p className="cx-note">주기와 구간을 고르면 판단할 수 있습니다.</p>
        </section>
      }
    />
  );
}

/** "관측 · 섹터 14 · 원본 곡선", the classic step row in one line. */
export function Meta({
  context,
  viewing,
}: {
  context: AnalysisContext;
  viewing: AnalysisContext["curveContext"];
}) {
  return (
    <>
      <b>관측</b>
      <span>
        섹터 <span className="cx-num">{context.sectors.join("·")}</span>
      </span>
      <span>{stepName(viewing)}</span>
      <span>
        {context.hasConfirmedCandidate
          ? "확정 행성 보유"
          : "확정 행성 정보 없음"}
      </span>
    </>
  );
}

/** Seconds left before a refused residual job may be asked again. */
function useWait(refusedAt: number | null, retryAfterSeconds: number) {
  const [left, setLeft] = useState(() =>
    refusedAt === null
      ? 0
      : remainingSeconds(refusedAt, retryAfterSeconds, Date.now()),
  );
  useEffect(() => {
    if (refusedAt === null) return;
    const tick = () =>
      setLeft(remainingSeconds(refusedAt, retryAfterSeconds, Date.now()));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [refusedAt, retryAfterSeconds]);
  return refusedAt === null ? 0 : left;
}

const RESIDUAL_STATE: Record<string, string> = {
  QUEUED: "대기",
  RESIDUAL_CALCULATING: "잔차 계산",
  RESIDUAL_READY: "잔차 준비",
  PERIODOGRAM_CALCULATING: "주기도 계산",
  COMPLETED: "완료",
  FAILED: "실패",
};
const RESIDUAL_ORDER = [
  "QUEUED",
  "RESIDUAL_CALCULATING",
  "RESIDUAL_READY",
  "PERIODOGRAM_CALCULATING",
  "COMPLETED",
] as const;

/** Curve step moves (classic CurveStepBar), only the ones that exist. */
export function CurveSteps({ context }: { context: AnalysisContext }) {
  const step = useCurveStepSession();
  if (!step) return null;
  const { viewing, transition, moves } = step;
  const busy = transition.phase === "running";
  return (
    <div className="cx-steps" role="group" aria-label="곡선 단계">
      <span className="cx-ro">
        찾은 신호 <b>{context.matchedCandidateIds.length}</b> ·{" "}
        {stepName(viewing)}
      </span>
      {moves.previous && (
        <button
          type="button"
          className="cx-link"
          disabled={busy}
          onClick={() => step.previous()}
        >
          이전 단계
        </button>
      )}
      {moves.original && (
        <button
          type="button"
          className="cx-link"
          disabled={busy}
          onClick={() => step.original()}
        >
          원본 곡선
        </button>
      )}
      {moves.next && (
        <button
          type="button"
          className="cx-link"
          disabled={busy}
          onClick={() => step.next()}
        >
          다음 곡선 단계로
        </button>
      )}
    </div>
  );
}

/** Progress and refusals of a curve step move, in the classic's words. */
export function CurveStepStatus() {
  const step = useCurveStepSession();
  const queued =
    step?.transition.phase === "queue-full" ? step.transition : null;
  const wait = useWait(
    queued?.refusedAt ?? null,
    queued?.retryAfterSeconds ?? 0,
  );
  if (!step || step.transition.phase === "idle") return null;
  const { transition } = step;
  if (transition.phase === "running") {
    const at = transition.progress
      ? RESIDUAL_ORDER.indexOf(transition.progress.status as never)
      : -1;
    return (
      <div className="cx-notice" data-testid="cx-residual-progress">
        <ol className="cx-flow" aria-hidden="true">
          {RESIDUAL_ORDER.map((state, index) => (
            <li
              key={state}
              data-state={
                index < at ? "done" : index === at ? "now" : "waiting"
              }
            >
              {RESIDUAL_STATE[state]}
            </li>
          ))}
        </ol>
        <p role="status">
          {stepName(transition.target)}을 준비하고 있습니다 ·{" "}
          {transition.progress
            ? RESIDUAL_STATE[transition.progress.status]
            : "요청 중"}
          {transition.progress?.queuePosition
            ? ` · 대기 ${transition.progress.queuePosition}번째`
            : ""}
        </p>
      </div>
    );
  }
  if (transition.phase === "failed")
    return (
      <div className="cx-notice" data-tone="bad">
        <p role="alert">{transition.message} 보고 있던 곡선은 그대로입니다.</p>
        {transition.retryable && (
          <button
            type="button"
            className="cx-link"
            onClick={() => step.retry()}
          >
            다시 시도
          </button>
        )}
      </div>
    );
  if (transition.phase === "unavailable")
    return (
      <div className="cx-notice">
        <p role="status">{transition.message} 보고 있던 곡선은 그대로입니다.</p>
      </div>
    );
  if (transition.phase === "queue-full")
    return (
      <div className="cx-notice" data-tone="warn">
        <p role="alert">
          {transition.activeJobId
            ? "다른 곡선을 이미 계산하고 있습니다. 그것이 끝난 뒤에 다시 시도해 주세요."
            : `계산 대기가 가득 찼습니다. ${transition.retryAfterSeconds}초 뒤에 다시 시도해 주세요.`}
        </p>
        <button
          type="button"
          className="cx-link"
          onClick={() => step.retry()}
          disabled={wait > 0}
        >
          {wait > 0 ? `다시 시도 (${wait}초)` : "다시 시도"}
        </button>
      </div>
    );
  return (
    <div className="cx-notice">
      <p role="status">
        새 데이터 판이 공개되어 최신 자료를 다시 불러오고 있습니다.
      </p>
    </div>
  );
}

/** A small text button that opens a dialog over the scene. */
function DialogButton({
  label,
  title,
  children,
  testId,
}: {
  label: string;
  title: string;
  children: ReactNode;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const ref = useModalDialog({ open, onClose: () => setOpen(false) });
  return (
    <>
      <button type="button" className="cx-link" onClick={() => setOpen(true)}>
        {label}
      </button>
      <dialog
        ref={ref}
        className="cx-dialog"
        aria-labelledby={headingId}
        data-testid={testId}
      >
        {open && (
          <>
            <header className="cx-dialog-head">
              <h2 id={headingId}>{title}</h2>
              <button
                type="button"
                className="cx-link"
                onClick={() => setOpen(false)}
              >
                닫기
              </button>
            </header>
            {children}
          </>
        )}
      </dialog>
    </>
  );
}

/** The classic "데이터 상세", with "최신 자료 확인". */
export function DataButton({
  context,
  viewedBundleId,
  curve,
  reload,
}: {
  context: AnalysisContext;
  viewedBundleId: string;
  curve: Extract<CurveData, { kind: "ready" }>;
  reload: () => void;
}) {
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
    <DialogButton label="자료" title="분석 데이터" testId="cx-data-dialog">
      <DataDetails
        context={context}
        viewedBundleId={viewedBundleId}
        curve={curve}
        total={total}
        missing={missing}
      />
      <p>
        <button type="button" className="cx-secondary" onClick={reload}>
          최신 자료 확인
        </button>
      </p>
    </DialogButton>
  );
}

export function DataDetails({
  context,
  viewedBundleId,
  curve,
}: {
  context: AnalysisContext;
  viewedBundleId: string;
  curve: Extract<CurveData, { kind: "ready" }>;
  total?: number;
  missing?: number;
}) {
  // The cinema's data details (plain words; ids and BTJD under 기술 정보),
  // the same body as the classic "데이터 상세".
  return (
    <CinemaDataDetails
      context={context}
      viewedBundleId={viewedBundleId}
      curve={curve}
      stepLabel={stepName(context.curveContext)}
    />
  );
}

/** How to drive the panel with a pointer or the keyboard. */
export function HelpButton() {
  return (
    <DialogButton label="도움말" title="조작 도움말" testId="cx-help-dialog">
      <dl className="cx-help">
        <div>
          <dt>주기</dt>
          <dd>
            추천 봉우리 버튼으로 주기를 고릅니다. 그래프를 누르면 그 주기를 직접
            고릅니다. 그래프에 포커스한 뒤 ←/→로 봉우리 주기를 미세 조정하고,
            Shift나 Page 키는 격자 한 칸, Home/End는 허용 범위 끝입니다. 직접
            고를 때는 ←/→로 옮긴 뒤 Enter를 누릅니다. +/−로 확대·축소하고 0으로
            전체 보기를 합니다. 음영은 관측 기간 절반을 넘는 주기, 보라 점선은
            이미 찾은 신호의 주기입니다.
          </dd>
        </div>
        <div>
          <dt>구간</dt>
          <dd>
            접힌 곡선에서 드래그하면 구간을 고르고, Shift+드래그하면 보기를
            옮깁니다. 휠이나 +/−로 최대 {MAX_FOLD_ZOOM}배까지 확대하고, 0이나
            더블클릭으로 전체 보기를 합니다. 양 끝 핸들은 방향키로 보기 폭의
            1/1000씩, Shift를 누르면 10배씩 움직입니다. 키보드로 시작하려면
            ‘구간 선택 시작’을 누르세요.
          </dd>
        </div>
        <div>
          <dt>판단과 제출</dt>
          <dd>
            판단을 고르면 지금 구간으로 확정합니다. 근거와 메모는 선택입니다.
            제출하면 요청 번호 하나로 접수를 추적하므로 응답을 받지 못해도 두 번
            접수되지 않습니다. 주기·구간·판단은 이 탭에 임시 저장되고
            로그아웃하면 지워집니다.
          </dd>
        </div>
      </dl>
      <p className="cx-note">
        판별 도구(홀짝·2차 식·V/U형)는 연결 준비 중입니다.
      </p>
    </DialogButton>
  );
}
