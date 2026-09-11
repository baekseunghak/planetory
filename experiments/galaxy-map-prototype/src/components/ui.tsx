import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from "react";
import { Link } from "react-router-dom";
import { X, ArrowLeft, RefreshCw } from "lucide-react";
import type {
  Distribution,
  History,
  Signal,
  StarNode,
  Page,
} from "../../shared/types";
import { JUDGMENTS, TYPES, STATUSES } from "../../shared/types";
export const date = (s: string) =>
  new Date(s).toLocaleString("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  });
export const number = (v: number | null | undefined, unit = "") =>
  v === null || v === undefined
    ? "데이터 없음"
    : new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(v) +
      unit;
export function PageTitle({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-title">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      <div className="actions">{actions}</div>
    </header>
  );
}
export function Empty({
  title = "아직 기록이 없습니다.",
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-orbit" aria-hidden="true">
        ✧
      </span>
      <h3>{title}</h3>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}
export function RequestState({
  state,
}: {
  state: { loading: boolean; error: Error | null; reload: () => void };
}) {
  return state.error ? (
    <div role="alert" className="error-box">
      <h3>자료를 불러오지 못했습니다</h3>
      <p>{state.error.message}</p>
      <button type="button" onClick={state.reload}>
        <RefreshCw size={14} />
        다시 시도
      </button>
    </div>
  ) : state.loading ? (
    <div role="status" className="loading">
      <span />
      자료를 불러오는 중입니다…
    </div>
  ) : null;
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    const before = document.activeElement as HTMLElement;
    d.showModal();
    return () => {
      d.close();
      before?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "wide" : ""}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="닫기" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function useAction() {
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run, clear: () => setError("") };
}
export function ActionError({ message }: { message: string }) {
  return message ? (
    <p className="inline-error" role="alert">
      {message}
    </p>
  ) : null;
}
export function Pager({
  data,
  onPage,
}: {
  data: Page<unknown>;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return (
    <nav aria-label="페이지 이동" className="pager">
      <span>총 {data.total.toLocaleString()}개</span>
      <button
        type="button"
        disabled={data.page <= 1}
        onClick={() => onPage(data.page - 1)}
      >
        이전
      </button>
      <span>
        {data.page} / {pages}
      </span>
      <button
        type="button"
        disabled={data.page >= pages}
        onClick={() => onPage(data.page + 1)}
      >
        다음
      </button>
    </nav>
  );
}
export function Grade({
  star,
}: {
  star: Pick<StarNode, "grade" | "achievementCount" | "typeCounts">;
}) {
  return (
    <div className="grade-info">
      <span className={"grade g" + star.grade}>
        {star.grade === "—" ? "성과 없음" : star.grade}
      </span>
      <span>
        인정된 성과 <strong>{star.achievementCount}건</strong>
        <small>
          확인된 행성 {star.typeCounts.confirmed} · 미확정{" "}
          {star.typeCounts.unconfirmed} · 행성 아님 {star.typeCounts.fp}
        </small>
      </span>
    </div>
  );
}
export function Status({
  star,
}: {
  star: Pick<StarNode, "status" | "completionReason">;
}) {
  return (
    <span className={"status " + star.status}>
      {star.completionReason === "skipped"
        ? "건너뛰어 완료"
        : STATUSES[star.status]}
      {star.completionReason === "undiscoverable_only" ? " · 새 관측 대기" : ""}
    </span>
  );
}
export function AI({ signal }: { signal: Signal }) {
  return (
    <div className="ai-box">
      <strong>AI 참고 정보</strong>
      <p>
        {signal.ai.status === "evaluated"
          ? number(
              signal.ai.score === null ? null : signal.ai.score * 100,
              "점",
            ) +
            " · " +
            { approved: "승인 구간", review: "검토 구간", below: "기준 미만" }[
              signal.ai.band || "below"
            ]
          : (
              {
                insufficient_data: "입력 데이터 부족",
                error: "계산 오류",
                not_evaluated: "아직 평가되지 않음",
              } as Record<string, string>
            )[signal.ai.status]}
      </p>
      <small>모델 {signal.ai.version} · 성과 인정에 사용하지 않습니다.</small>
    </div>
  );
}
export function DistributionView({ data }: { data: Distribution | null }) {
  if (!data) return null;
  if (data.kind === "scored")
    return (
      <div className="distribution">
        <p>
          {data.total
            ? "이 신호를 찾은 사람 중 기록과 일치 " +
              number(data.percent, "%") +
              " · " +
              data.total +
              "명"
            : "아직 이 신호의 매칭 기록이 없습니다."}
        </p>
        <small>회원별 첫 매칭 제출 기준 · {date(data.asOf)}</small>
      </div>
    );
  return (
    <div className="distribution">
      <h3>
        {data.aggregate
          ? "신호별 공개 판단 " + data.total + "건"
          : "공개 분석의 판단 · 참여자 " + data.total + "명"}
      </h3>
      {!data.total ? (
        <p className="muted">아직 공개된 분석이 없습니다</p>
      ) : (
        <>
          {Object.entries(data.counts).map(([key, count]) => (
            <div className="distribution-row" key={key}>
              <span>{JUDGMENTS[key as keyof typeof JUDGMENTS]}</span>
              <div className="meter">
                <i style={{ width: (count / data.total) * 100 + "%" }} />
              </div>
              <span>
                {count}
                {data.aggregate ? "건" : "명"} ·{" "}
                {number((count / data.total) * 100, "%")}
              </span>
            </div>
          ))}
          <small>
            공개 중인 회원별 최신 제출 1건 · 행성일 확률이 아닙니다.
            <br />
            {date(data.asOf)} 기준
          </small>
        </>
      )}
    </div>
  );
}
export function Curve({
  points,
  label = "주기로 겹친 곡선",
  band,
  zoom = 1,
}: {
  points: number[][];
  label?: string;
  band?: [number, number] | null;
  zoom?: number;
}) {
  const clipId = useId();
  // Stored phases remain continuous (e.g. .95..1.05). Only the drawing
  // wraps into the displayed 0..1 cycle; zoom clipping still applies below.
  const bands: [number, number][] = !band
    ? []
    : band[1] > 1
      ? [
          [band[0], 1],
          [0, band[1] - 1],
        ]
      : [band];
  const slice = points.filter(
    (p) => p[0] >= 0.5 - 0.5 / zoom && p[0] <= 0.5 + 0.5 / zoom,
  );
  const low = Math.min(...points.map((p) => p[1])) - 0.001,
    high = Math.max(...points.map((p) => p[1])) + 0.001;
  const x = (v: number) => 50 + (v - (0.5 - 0.5 / zoom)) * zoom * 650;
  const y = (v: number) =>
    175 - ((v - low) / Math.max(0.001, high - low)) * 130;
  return (
    <figure className="curve">
      <svg viewBox="0 0 760 220" role="img" aria-label={label}>
        <g stroke="#202631">
          {[50, 90, 130, 170].map((y) => (
            <path key={y} d={"M50 " + y + "H705"} />
          ))}
          {[50, 180, 310, 440, 570, 700].map((x) => (
            <path key={x} d={"M" + x + " 30V175"} />
          ))}
        </g>
        <defs>
          <clipPath id={clipId}>
            <rect x="50" y="20" width="650" height="160" />
          </clipPath>
        </defs>
        <g clipPath={"url(#" + clipId + ")"}>
          {bands.map(([start, end], i) => (
            <rect
              key={i}
              x={x(start)}
              y="25"
              width={Math.max(0, x(end) - x(start))}
              height="150"
              fill="#1c67e322"
            />
          ))}
          {slice.map((p, i) => (
            <circle key={i} cx={x(p[0])} cy={y(p[1])} r="1.8" fill="#b4ceff" />
          ))}
        </g>
        <text x="50" y="206" fill="#8c98aa" fontSize="11">
          {zoom === 1 ? "주기 시작" : "위상 " + (0.5 - 0.5 / zoom)}
        </text>
        <text x="620" y="206" fill="#8c98aa" fontSize="11">
          {zoom === 1 ? "다음 주기" : "위상 " + (0.5 + 0.5 / zoom)}
        </text>
        <text
          x="14"
          y="115"
          fill="#8c98aa"
          fontSize="10"
          transform="rotate(-90 14 115)"
        >
          정규화 밝기
        </text>
      </svg>
      <figcaption>{label}</figcaption>
    </figure>
  );
}
export function HistorySummary({
  h,
}: {
  h: Omit<History, "answerViewed" | "retryOf" | "viewport">;
}) {
  return (
    <>
      <div className="inline-info">
        <span>
          {h.signalId
            ? "신호 찾음"
            : h.outcome === "skipped"
              ? "건너뛰기"
              : "신호 미일치"}
        </span>
        <span>{h.judgment ? JUDGMENTS[h.judgment] : "판단 없음"}</span>
        <span>
          {
            {
              recognized: "최초 성과 인정",
              already_recognized: "기존 성과 유지 · 추가 인정 없음",
              judgment_mismatch: "판단 불일치 · 이번 성과 없음",
              judgment_unsure: "판단 보류 · 이번 성과 없음",
              unpublished: "미게시 분석 · 성과 미인정",
              no_match: "이번 성과 없음",
              skipped: "성과 없는 건너뛰기",
            }[h.achievementResult]
          }
        </span>
      </div>
      {h.bundleId !== h.currentBundleId && (
        <p className="notice">이전 데이터 판에서 제출됨</p>
      )}
      {h.relabeled && (
        <p className="notice">기록이 갱신됨 · 기존 성과는 유지됩니다.</p>
      )}
    </>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Back({
  to,
  label = "돌아가기",
}: {
  to: string;
  label?: string;
}) {
  return (
    <Link className="back-link" to={to}>
      <ArrowLeft size={14} />
      {label}
    </Link>
  );
}
