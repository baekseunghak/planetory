import { useState, useEffect } from "react";
import {
  Link,
  useParams,
  useNavigate,
  useSearchParams,
  Navigate,
} from "react-router-dom";
import type {
  AnalysisContext,
  History,
  Page,
  StarDetail,
  StarNode,
  Post,
  Judgment,
  PublicationDestination,
  Publication,
} from "../../shared/types";
import { JUDGMENTS, EVIDENCE } from "../../shared/types";
import { useResource } from "../api/hooks";
import { api, mutation, query, ApiError } from "../api/client";
import { useApp } from "../App";
import {
  PageTitle,
  Back,
  RequestState,
  Empty,
  Curve,
  Field,
  useAction,
  ActionError,
  Grade,
  Status,
  HistorySummary,
  Pager,
} from "../components/ui";
import { rephase } from "../../shared/replay";
import { RecordView } from "../components/RecordView";
import { AnalysisGuide, useAnalysisGuide } from "../components/AnalysisGuide";

export function AnalysisPage() {
  const { starId } = useParams(),
    [params] = useSearchParams(),
    retryId = params.get("retry"),
    returnPost = params.get("returnPostId"),
    r = useResource<AnalysisContext>(
      query("/stars/" + starId + "/analysis", { retry: retryId || undefined }),
    ),
    { mode } = useApp(),
    navigate = useNavigate(),
    a = useAction();
  const guide = useAnalysisGuide(starId!);
  const [period, setPeriod] = useState(3.6),
    [start, setStart] = useState(0.45),
    [end, setEnd] = useState(0.55),
    [judgment, setJudgment] = useState<Judgment | "">(""),
    [evidence, setEvidence] = useState<string[]>([]),
    [memo, setMemo] = useState(""),
    [zoom, setZoom] = useState(1),
    [result, setResult] = useState<History | null>(null);
  useEffect(() => {
    if (!r.data) return;
    const h = r.data.retry;
    setPeriod(h?.originalPeriod || h?.period || 3.6);
    const phases = h ? rephase(h, r.data.referenceTime) : null;
    setStart(phases?.phaseStart ?? 0.45);
    setEnd(phases?.phaseEnd ?? 0.55);
    setZoom(h?.foldedZoom || 1);
    setJudgment("");
    setEvidence([]);
    setMemo("");
    setResult(null);
  }, [r.data]);
  const submit = (noCandidate = false) =>
    a.run(async () => {
      let viewport = { x: 0, y: 0, zoom: 1 };
      try {
        viewport =
          JSON.parse(sessionStorage.getItem("planetory-map-view") || "null") ||
          viewport;
      } catch {}
      const h = await mutation<History>("/submissions", {
        starId,
        period,
        phaseStart: start,
        phaseEnd: end,
        judgment: judgment || undefined,
        evidence,
        memo,
        foldedZoom: zoom,
        viewport,
        analysisView: r.data?.retry?.reproduction
          ? {
              periodogramViewport:
                r.data.retry.reproduction.periodogramViewport,
              folding: r.data.retry.reproduction.folding,
            }
          : {
              periodogramViewport: null,
              folding: {
                phaseOrigin: "bundle_reference",
                timeSystem: "BTJD",
                phaseOffset: 0,
              },
            },
        retryOf: retryId || undefined,
        noCandidate,
        requestId: crypto.randomUUID(),
      });
      setResult(h);
      guide.complete("submission_succeeded");
    });
  const returnLink = returnPost
    ? query("/community/posts/" + encodeURIComponent(returnPost), {
        returnStarId: starId,
        suggestHistoryId: result?.id,
      })
    : "/sky?star=" + starId;
  if (r.error instanceof ApiError && r.error.code === "STAR_LOCKED")
    return <Navigate to="/sky?entry=locked" replace />;
  return (
    <main className="page">
      <Back
        to={returnLink}
        label={returnPost ? "진입한 글로 돌아가기" : "밤하늘로 돌아가기"}
      />
      <PageTitle
        eyebrow="ANALYSIS WORKSPACE"
        title={"TIC " + starId}
        description="반복되는 빛의 변화를 살펴보고 판단을 기록하세요."
        actions={
          <Link className="button" to={"/results/" + starId}>
            별 결과
          </Link>
        }
      />
      <p className="notice">
        로컬 연결 검증 화면 · 곡선과 판정은 가상 자료입니다. 실제 분석 도구와
        BLS 계산은 분석 프론트·코어 백엔드 연결 대상입니다.
      </p>
      <RequestState state={r} />
      <ActionError message={a.error} />
      {r.data && !result && (
        <>
          <div className="inline-info">
            <Status star={r.data.star} />
            <span>
              {r.data.retry
                ? r.data.retry.restoreFallback
                  ? "현재 곡선으로 재도전"
                  : "이전 선택 복원 · 최신 관측 데이터"
                : r.data.star.curveStep
                  ? "뺀 곡선 " + r.data.star.curveStep
                  : "원본 곡선"}
            </span>
            <span>
              {r.data.hasConfirmed
                ? "확인된 행성이 알려진 별"
                : "미확정 신호를 살펴보는 별"}
            </span>
          </div>
          {r.data.readOnlyReason && (
            <p role="alert" className="error-box">
              {r.data.readOnlyReason}
            </p>
          )}
          {r.data.retry && (
            <p className="notice">
              주기·구간·확대를 복원했습니다. 판단·근거·메모는 새로 입력합니다.
              {r.data.retry.restoreFallback
                ? " 이전 제거 후보가 퇴역하여 현재 진행 단계에서 시작합니다."
                : ""}
            </p>
          )}
          <AnalysisGuide starId={starId!} />
          {mode === "local-fixture" && (
            <details
              className="panel"
              id="tutorial-peak"
              tabIndex={-1}
              open={guide.step === 1 || undefined}
            >
              <summary>튜토리얼 봉우리 선택 연결 시험</summary>
              <p>
                실제 주기도 도구 연결 전의 가상 이벤트입니다. 숫자 입력만으로
                봉우리 안내가 완료되지는 않습니다.
              </p>
              <button
                onClick={() => {
                  setPeriod(3.6);
                  setZoom(1);
                  guide.complete("peak_selected");
                }}
              >
                가상 봉우리 선택 · 3.6일
              </button>
            </details>
          )}
          <div className="analysis-layout">
            <section className="panel">
              <div className="section-title">
                <h2>주기로 겹친 곡선</h2>
                <label>
                  가로 확대{" "}
                  <select
                    aria-label="곡선 가로 확대"
                    value={zoom}
                    onChange={(e) => setZoom(+e.target.value)}
                  >
                    {[1, 2, 4, 8].map((n) => (
                      <option key={n} value={n}>
                        {n}배
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Curve points={r.data.curve} zoom={zoom} band={[start, end]} />
              <div className="two-columns">
                <Field
                  label="반복 주기 (일)"
                  hint="현재 연결 검증용 곡선에서 주기를 입력합니다."
                >
                  <input
                    type="number"
                    value={period}
                    min={r.data.periodLimits.min}
                    max={r.data.periodLimits.max}
                    step={r.data.periodLimits.step}
                    onChange={(e) => {
                      setPeriod(+e.target.value);
                    }}
                  />
                </Field>
                <Field label="가려진 시간">
                  <output>
                    {((end - start) * period * 24).toFixed(2)}시간
                  </output>
                </Field>
                <Field label="구간 시작 (위상)">
                  <input
                    id="tutorial-interval"
                    type="number"
                    min={0}
                    max={0.9999}
                    step={0.001}
                    value={start}
                    onChange={(e) => {
                      setStart(+e.target.value);
                      if (
                        +e.target.value >= 0 &&
                        +e.target.value < 1 &&
                        end > +e.target.value &&
                        end - +e.target.value < 1
                      )
                        guide.complete("interval_selected");
                    }}
                  />
                </Field>
                <Field
                  label="구간 끝 (위상)"
                  hint="주기 경계를 넘는 경우 1보다 크게 입력할 수 있습니다."
                >
                  <input
                    type="number"
                    min={start + 0.001}
                    max={start + 0.9999}
                    step={0.001}
                    value={end}
                    onChange={(e) => {
                      setEnd(+e.target.value);
                      if (
                        +e.target.value > start &&
                        +e.target.value - start < 1
                      )
                        guide.complete("interval_selected");
                    }}
                  />
                </Field>
              </div>
              <p className="muted">중심 위치: 데이터 없음</p>
            </section>
            <form
              className="panel judgment-panel"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <h2>나의 판단</h2>
              <fieldset
                id="tutorial-judgment"
                tabIndex={-1}
                disabled={!!r.data.readOnlyReason || a.pending}
              >
                <legend className="sr-only">행성 판단</legend>
                {Object.entries(JUDGMENTS).map(([k, v]) => (
                  <label
                    className={
                      "judgment-option " + (judgment === k ? "selected" : "")
                    }
                    key={k}
                  >
                    <input
                      type="radio"
                      name="judgment"
                      value={k}
                      checked={judgment === k}
                      onChange={() => {
                        setJudgment(k as Judgment);
                        guide.complete("judgment_selected");
                      }}
                      required
                    />
                    {v}
                  </label>
                ))}
                <h3>살펴본 근거</h3>
                <div className="evidence-options">
                  {EVIDENCE.map((e) => (
                    <label key={e}>
                      <input
                        type="checkbox"
                        checked={evidence.includes(e)}
                        onChange={(ev) =>
                          setEvidence(
                            ev.target.checked
                              ? [...evidence, e]
                              : evidence.filter((x) => x !== e),
                          )
                        }
                      />
                      {e}
                    </label>
                  ))}
                </div>
                <Field label="메모 (선택)">
                  <textarea
                    rows={4}
                    maxLength={4000}
                    value={memo}
                    onChange={(e) => setMemo(e.target.value)}
                    placeholder="어떤 변화를 확인했나요?"
                  />
                </Field>
                <button
                  id="tutorial-submit"
                  className="primary full"
                  disabled={
                    !judgment || end <= start || !Number.isFinite(period)
                  }
                >
                  분석 제출
                </button>
                <button
                  type="button"
                  className="text-button full"
                  onClick={() => void submit(true)}
                >
                  찾을 신호가 없는 것 같아요
                </button>
              </fieldset>
            </form>
          </div>
        </>
      )}
      {result && (
        <section className="panel result-notice">
          <p className="eyebrow">SUBMISSION SAVED</p>
          <h2>
            {result.signalId
              ? "신호를 기록했습니다"
              : result.outcome === "ambiguous_match"
                ? "여러 신호와 겹칩니다"
                : "선택한 값과 일치하는 신호를 찾지 못했습니다"}
          </h2>
          <HistorySummary h={result} />
          <p>제출 기록은 저장되었습니다. 공개는 별도로 선택할 수 있습니다.</p>
          <div className="actions">
            <Link className="button primary" to={"/history/" + result.id}>
              제출 기록 · 상세 보기
            </Link>
            <Link className="button" to={"/results/" + starId}>
              별 결과 보기
            </Link>
            {result.type === "unconfirmed" && (
              <Link
                className="button"
                to={"/publish/" + starId + "?record=" + result.id}
              >
                분석 공개 검토
              </Link>
            )}
            <button
              onClick={() => {
                setResult(null);
                if (retryId)
                  navigate(
                    "/analysis/" +
                      starId +
                      (returnPost ? "?returnPostId=" + returnPost : ""),
                    { replace: true },
                  );
                else r.reload();
              }}
            >
              분석 계속하기
            </button>
            <Link className="button" to={returnLink}>
              돌아가기
            </Link>
          </div>
        </section>
      )}
    </main>
  );
}

type ResultData = {
  star: StarDetail;
  histories: History[];
  newStars: StarNode[];
  threads: Post[];
};
export function ResultsPage() {
  const { starId } = useParams(),
    r = useResource<ResultData>("/stars/" + starId + "/results"),
    [page, setPage] = useState(1),
    hs = useResource<Page<History>>(query("/history", { starId, page }));
  return (
    <main className="page">
      <Back to={"/sky?star=" + starId} label="밤하늘" />
      <PageTitle
        eyebrow="EXPLORATION RECORD"
        title={"TIC " + starId + " · 탐사 결과"}
        actions={
          <Link className="button" to={"/community/stars/" + starId}>
            별 게시판
          </Link>
        }
      />
      <RequestState state={r} />
      {r.data && (
        <>
          <section className="panel result-overview">
            <div>
              <Status star={r.data.star} />
              <h2>표시 행성 {r.data.star.planetCount}개</h2>
              <p className="muted">
                찾은 신호 {r.data.star.matchedCount}개 ·{" "}
                {r.data.star.curveStep
                  ? "뺀 곡선 " + r.data.star.curveStep
                  : "원본 곡선"}
              </p>
              {r.data.star.completionReason === "undiscoverable_only" && (
                <p>
                  현재 찾을 수 있는 신호를 모두 살펴봤습니다. 새 관측을
                  기다립니다.
                </p>
              )}
            </div>
            <Grade star={r.data.star} />
            <div className="actions">
              <Link className="button primary" to={"/analysis/" + starId}>
                {r.data.star.status === "complete" ? "재검토" : "분석 계속하기"}
              </Link>
              {r.data.star.unpublishedCount > 0 && (
                <Link className="button" to={"/publish/" + starId}>
                  미게시 분석 {r.data.star.unpublishedCount}개 검토
                </Link>
              )}
              <Link className="button" to="/sky">
                나중에 · 밤하늘
              </Link>
            </div>
          </section>
          {r.data.newStars.length > 0 && (
            <section className="panel">
              <h2>이 별의 성과로 새로 찾은 별</h2>
              <div className="new-star-links">
                {r.data.newStars.map((s) => (
                  <Link key={s.id} to={"/sky?star=" + s.id}>
                    ✧ TIC {s.id} ↗
                  </Link>
                ))}
              </div>
            </section>
          )}
          <section>
            <h2>단계별 제출 기록</h2>
            <RequestState state={hs} />
            {hs.data && (
              <>
                {hs.data.items.map((h) => (
                  <article className="panel compact-record" key={h.id}>
                    <div className="section-title">
                      <strong>
                        {h.curveStep ? "뺀 곡선 " + h.curveStep : "원본 곡선"} ·{" "}
                        {h.period ?? "—"}일
                      </strong>
                      <Link to={"/history/" + h.id}>기록 보기 ↗</Link>
                    </div>
                    <HistorySummary h={h} />
                  </article>
                ))}
                <Pager data={hs.data} onPage={setPage} />
              </>
            )}
          </section>
          {r.data.threads.length > 0 && (
            <section className="panel">
              <h2>신호 토론</h2>
              {r.data.threads.map((p) => (
                <p key={p.id}>
                  <Link to={"/community/posts/" + p.id}>{p.title} ↗</Link>
                </p>
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}

export function PublishPage() {
  const { starId } = useParams(),
    [params] = useSearchParams();
  return <PublishReview key={starId + ":" + (params.get("record") || "")} />;
}
function PublishReview() {
  const { starId } = useParams(),
    [params] = useSearchParams(),
    record = params.get("record"),
    r = useResource<Page<History>>(
      query("/history", { starId, page: 1, pageSize: 100 }),
    ),
    destinations = useResource<{ items: PublicationDestination[] }>(
      query("/publications/destinations", { starId }),
    ),
    [all, setAll] = useState<History[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [state, setState] = useState<
      Record<
        string,
        { status: string; message?: string; publication?: Publication }
      >
    >({}),
    [expanded, setExpanded] = useState<string | null>(null),
    [loadError, setLoadError] = useState(""),
    [loaded, setLoaded] = useState(false),
    a = useAction();
  const destinationFor = (h: History) =>
    destinations.data?.items.find(
      (d) => d.signalId === h.signalId && d.starId === h.starId,
    );
  const canPublish = (h: History) =>
    !!destinationFor(h) && destinationFor(h)!.status !== "unavailable";
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setLoadError("");
    setAll([]);
    setSelected([]);
    setState({});
    setExpanded(null);
    if (!r.data || !destinations.data) return;
    const first = r.data;
    void (async () => {
      try {
        const list = [...first.items];
        for (
          let page = 2;
          page <= Math.ceil(first.total / first.pageSize);
          page++
        ) {
          const next = await api<Page<History>>(
            query("/history", { starId, page, pageSize: 100 }),
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          list.push(...next.items);
        }
        if (controller.signal.aborted) return;
        const eligible = list.filter(
          (h) =>
            h.type === "unconfirmed" &&
            h.signalId &&
            !h.publication?.active &&
            !h.publication?.hidden,
        );
        setAll(eligible);
        const latest = new Map<string, History>();
        for (const h of eligible.filter(canPublish))
          if (!latest.has(h.signalId!)) latest.set(h.signalId!, h);
        setSelected(
          record
            ? eligible
                .filter((h) => h.id === record && canPublish(h))
                .map((h) => h.id)
            : [...latest.values()].map((h) => h.id),
        );
        setState({});
        setLoaded(true);
      } catch (e) {
        if (!controller.signal.aborted) setLoadError((e as Error).message);
      }
    })();
    return () => {
      controller.abort();
    };
  }, [r.data, record, starId, destinations.data]);
  const send = (ids: string[]) =>
    a.run(async () => {
      setState((s) => ({
        ...s,
        ...Object.fromEntries(ids.map((id) => [id, { status: "publishing" }])),
      }));
      try {
        const result = await mutation<{
          items: {
            id: string;
            status: string;
            message?: string;
            publication?: Publication;
          }[];
        }>("/publications/batch", { ids });
        setState((s) => ({
          ...s,
          ...Object.fromEntries(result.items.map((item) => [item.id, item])),
        }));
        setSelected((s) =>
          s.filter(
            (id) =>
              !result.items.some(
                (i) => i.id === id && i.status === "published",
              ),
          ),
        );
      } catch (e) {
        setState((s) => ({
          ...s,
          ...Object.fromEntries(
            ids.map((id) => [
              id,
              {
                status: "failed",
                message: "통신에 실패했습니다. 다시 시도해 주세요.",
              },
            ]),
          ),
        }));
        throw e;
      }
    });
  const failed = Object.keys(state).filter(
    (id) => state[id].status === "failed",
  );
  return (
    <main className="page narrow">
      <Back to={"/results/" + starId} label="별 결과" />
      <PageTitle
        eyebrow="PUBLISH REVIEW"
        title="분석 공개 검토"
        description="공개할 기록을 직접 선택하세요. 선택한 판단·근거·메모·곡선이 신호 토론에 공개됩니다."
      />
      <p className="notice">
        같은 신호의 최신 미게시 기록을 기본으로 선택했습니다. 공개하면 최초 1회
        성과가 인정되며, 이후 공개 취소로 성과가 사라지지 않습니다.
      </p>
      <RequestState state={r} />
      <RequestState state={destinations} />
      <ActionError message={a.error || loadError} />
      {loadError && (
        <button
          onClick={() => {
            setLoadError("");
            setLoaded(false);
            r.reload();
          }}
        >
          기록 불러오기 다시 시도
        </button>
      )}
      {r.data && !loaded && !loadError && (
        <p role="status">모든 기록을 확인하는 중입니다…</p>
      )}
      {loaded && (
        <>
          {!all.length ? (
            <Empty title="공개할 미게시 분석이 없습니다" />
          ) : (
            <>
              <div className="actions">
                <button
                  disabled={a.pending}
                  onClick={() =>
                    setSelected(
                      all
                        .filter(
                          (h) =>
                            state[h.id]?.status !== "published" &&
                            canPublish(h),
                        )
                        .map((h) => h.id),
                    )
                  }
                >
                  전체 선택
                </button>
                <button disabled={a.pending} onClick={() => setSelected([])}>
                  선택 해제
                </button>
                <span>{selected.length}개 선택</span>
              </div>
              {all.map((h) => (
                <article className="panel publication-review" key={h.id}>
                  <div className="publication-destination">
                    <strong>등록될 스레드</strong>
                    {destinationFor(h) ? (
                      <>
                        <p>{destinationFor(h)!.title}</p>
                        {destinationFor(h)!.status === "new" && (
                          <small>
                            첫 공개가 성공하면 이 신호의 공통 스레드가
                            만들어집니다.
                          </small>
                        )}
                        {destinationFor(h)!.threadId && (
                          <Link
                            to={
                              "/community/posts/" + destinationFor(h)!.threadId
                            }
                          >
                            기존 스레드 확인 ↗
                          </Link>
                        )}
                        {destinationFor(h)!.status === "unavailable" && (
                          <p>
                            현재 공개할 수 없습니다. 개인 기록은 유지됩니다.
                          </p>
                        )}
                      </>
                    ) : (
                      <p>공개 목적지를 확인한 뒤 게시할 수 있습니다.</p>
                    )}
                  </div>
                  <label className="switch-row">
                    <span>
                      <strong>
                        {h.signalId} · {h.period}일
                      </strong>
                      <small>
                        {h.judgment ? JUDGMENTS[h.judgment] : ""} ·{" "}
                        {new Date(h.submittedAt).toLocaleString("ko-KR")}
                      </small>
                    </span>
                    <input
                      type="checkbox"
                      checked={selected.includes(h.id)}
                      disabled={
                        a.pending ||
                        state[h.id]?.status === "published" ||
                        !canPublish(h)
                      }
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, h.id]
                            : selected.filter((id) => id !== h.id),
                        )
                      }
                    />
                  </label>
                  <div className="actions">
                    <button
                      onClick={() =>
                        setExpanded(expanded === h.id ? null : h.id)
                      }
                    >
                      {expanded === h.id ? "내용 접기" : "공개될 내용 확인"}
                    </button>
                    <button
                      disabled={
                        a.pending ||
                        state[h.id]?.status === "published" ||
                        !canPublish(h)
                      }
                      onClick={() => void send([h.id])}
                    >
                      이 분석만 공개
                    </button>
                    {state[h.id] && (
                      <span role="status">
                        <span>
                          {
                            {
                              publishing: "공개 중…",
                              published: "공개 완료",
                              failed: "공개 실패",
                            }[state[h.id].status]
                          }
                          {state[h.id].message
                            ? " · " + state[h.id].message
                            : ""}
                        </span>
                        {state[h.id].publication && (
                          <Link
                            to={
                              "/community/posts/" +
                              state[h.id].publication!.threadId
                            }
                          >
                            등록된 스레드 보기 ↗
                          </Link>
                        )}
                      </span>
                    )}
                  </div>
                  {expanded === h.id && (
                    <RecordView history={h} actions={false} />
                  )}
                </article>
              ))}
              <div className="sticky-actions">
                <button
                  className="primary"
                  disabled={
                    a.pending ||
                    !selected.length ||
                    selected.some(
                      (id) => !all.some((h) => h.id === id && canPublish(h)),
                    )
                  }
                  onClick={() =>
                    void send(
                      selected.filter(
                        (id) => state[id]?.status !== "published",
                      ),
                    )
                  }
                >
                  선택한 {selected.length}개 공개
                </button>
                {failed.length > 0 && (
                  <button
                    disabled={a.pending}
                    onClick={() => void send(failed)}
                  >
                    실패한 {failed.length}개만 재시도
                  </button>
                )}
                <Link className="button" to={"/results/" + starId}>
                  나중에
                </Link>
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
}
