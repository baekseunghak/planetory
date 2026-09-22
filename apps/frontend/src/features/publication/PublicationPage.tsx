import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { http } from "../../api";
import { usePageContext } from "../../app/usePageContext";
import { pagePath } from "../../app/paths";
import { useSession } from "../../auth/SessionProvider";
import { judgments, evidenceOptions } from "../analysis/analysis-judgment";
import {
  historyGraphPath,
  readHistoryGraphView,
} from "../analysis/history-graph";
import {
  SharedHistoryGraph,
  type HistoryGraphDto,
} from "../history/HistoryGraph";
import { readMyHistories, type MyHistory } from "../my-lists/my-lists-data";
import {
  usePublication,
  canPublish,
  canRetryPublication,
  type ReviewItem,
} from "./use-publication";
import { MAX_PUBLICATION_BATCH_SIZE } from "./publication-data";
import "./publication.css";

const when = (value: string) => new Date(value).toLocaleString("ko-KR");
const judgmentLabel = (value: string) =>
  judgments.find((item) => item.value === value)?.label ?? value;
const publicLabels = {
  PUBLISHED: "공개 중",
  UNPUBLISHED: "공개되지 않음",
  HIDDEN: "운영에 의해 숨겨짐",
  NOT_ELIGIBLE: "공개 대상 아님",
};

function StoredGraph({
  historyId,
  ticId,
}: {
  historyId: string;
  ticId: string;
}) {
  const [graph, setGraph] = useState<HistoryGraphDto>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(undefined);
    void http
      .request(historyGraphPath(historyId, "SUBMITTED"), {
        signal: controller.signal,
      })
      .then((value) => {
        if (!controller.signal.aborted)
          setGraph(
            readHistoryGraphView(value, historyId, ticId, "SUBMITTED").dto,
          );
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("제출 당시 그래프를 불러오지 못했습니다.");
      });
    return () => controller.abort();
  }, [historyId, ticId, attempt]);
  if (error)
    return (
      <>
        <p role="alert">{error}</p>
        <button onClick={() => setAttempt((value) => value + 1)}>
          그래프 다시 확인
        </button>
      </>
    );
  if (!graph) return <p role="status">제출 당시 그래프를 불러오는 중입니다.</p>;
  if (!graph.snapshot)
    return (
      <p>
        저장된 그래프가 없어 미리 볼 수 없습니다. 현재 데이터로 대신 계산하지
        않습니다.
      </p>
    );
  return <SharedHistoryGraph graph={graph} mode="SUBMITTED" readOnly />;
}

function OtherHistories({
  item,
  disabled,
  replace,
}: {
  item: ReviewItem;
  disabled: boolean;
  replace: (id: string) => void;
}) {
  const [rows, setRows] = useState<MyHistory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [requestedCursor, setRequestedCursor] = useState<string | null>(null);
  const detail = item.preview!.detail;
  useEffect(() => {
    if (!attempt) return;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    const query = new URLSearchParams({
      ticId: detail.ticId,
      candidateId: item.candidateId!,
      size: "20",
    });
    if (requestedCursor) query.set("cursor", requestedCursor);
    void http
      .request(`/v1/me/histories?${query}`, { signal: controller.signal })
      .then((value) => {
        const page = readMyHistories(value);
        if (
          page.items.some(
            (row) =>
              row.ticId !== detail.ticId ||
              row.candidateId !== item.candidateId,
          )
        )
          throw new Error();
        if (controller.signal.aborted) return;
        setRows((old) =>
          requestedCursor
            ? [
                ...old,
                ...page.items.filter(
                  (row) =>
                    !old.some(
                      (existing) => existing.historyId === row.historyId,
                    ),
                ),
              ]
            : page.items,
        );
        setCursor(page.nextCursor);
        setLoaded(true);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("이 신호의 다른 기록을 불러오지 못했습니다.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt, requestedCursor, detail.ticId, item.candidateId]);
  return (
    <div>
      <button
        disabled={disabled || loading}
        onClick={() => {
          setRequestedCursor(null);
          setAttempt((value) => value + 1);
        }}
      >
        이 신호의 다른 기록 찾기
      </button>
      {loading && <p role="status">기록을 불러오는 중입니다.</p>}
      {error && <p role="alert">{error}</p>}
      {loaded && (
        <>
          <p>다른 기록을 선택하면 공개 가능한 기록인지 다시 확인합니다.</p>
          <ul>
            {rows.map((row) => (
              <li key={row.historyId}>
                {when(row.submittedAt)} ·{" "}
                {judgmentLabel(row.userJudgment ?? "판단 없음")} ·{" "}
                {row.historyId}{" "}
                <button
                  disabled={
                    disabled ||
                    !row.detailAvailable ||
                    !!row.publication.publicAnalysisId ||
                    row.historyId === item.historyId
                  }
                  onClick={() => replace(row.historyId)}
                >
                  이 기록 검토
                </button>
              </li>
            ))}
          </ul>
          {!rows.length && <p>다른 기록이 없습니다.</p>}
          {cursor && (
            <button
              disabled={disabled || loading}
              onClick={() => {
                setRequestedCursor(cursor);
                setAttempt((value) => value + 1);
              }}
            >
              기록 더 보기
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function PublicationPage() {
  const context = usePageContext(),
    session = useSession(),
    location = useLocation();
  if (!session.member) return null;
  return (
    <Review
      key={`${session.member.memberId}:${location.key}`}
      historyId={context.historyId}
      ticId={context.ticId}
      returnTo={context.returnTo}
      memberId={session.member.memberId}
      nickname={session.member.nickname}
    />
  );
}
function Review({
  historyId,
  ticId,
  returnTo,
  memberId,
  nickname,
}: {
  historyId?: string;
  ticId?: string;
  returnTo: string;
  memberId: string;
  nickname: string;
}) {
  const review = usePublication(historyId, ticId, memberId);
  const selected = review.items.filter(
    (item) => item.selected && canPublish(item),
  );
  const retryable = review.items.filter(canRetryPublication);
  const retryBatch = retryable.slice(0, MAX_PUBLICATION_BATCH_SIZE);
  return (
    <main className="publication-review" id="publication-review">
      <h1>{historyId ? "분석 공개 검토" : "이 별의 분석 공개 검토"}</h1>
      <p>
        검토만으로 게시되지는 않습니다. 선택한 기록의 판단·근거·메모와 분석
        자료가 함께 공개됩니다.
      </p>
      <p>
        게시 위치는 각 신호의 공식 스레드입니다. 스레드가 없으면 첫 게시 때
        생성됩니다.
      </p>
      <Link to={returnTo}>나중에 · 돌아가기</Link>
      {review.loading && (
        <p role="status">공개 검토 자료를 불러오는 중입니다.</p>
      )}
      {review.error && (
        <>
          <p role="alert">{review.error}</p>
          <button disabled={review.busy} onClick={review.reload}>
            목록 다시 확인
          </button>
        </>
      )}
      {!review.loading && !review.error && !review.items.length && (
        <p>
          아직 게시하지 않은 공개 대상 기록이 없습니다. 취소한 공개는
          History에서 다시 검토할 수 있습니다.
        </p>
      )}
      {review.items.map((item) => {
        const preview = item.preview,
          detail = preview?.detail,
          publication = detail?.explanation.publication;
        return (
          <section
            className="publication-card"
            key={item.historyId}
            aria-label={`기록 ${item.historyId}`}
          >
            <h2>
              {item.candidateId ? `신호 ${item.candidateId}` : "공개할 기록"} ·{" "}
              {item.historyId}
            </h2>
            {item.loading && <p role="status">기록을 불러오는 중입니다.</p>}
            {item.error && <p role="alert">{item.error}</p>}
            {preview && detail && publication && (
              <>
                <dl>
                  <dt>공개 닉네임</dt>
                  <dd>{nickname}</dd>
                  <dt>별 · 신호</dt>
                  <dd>
                    TIC {detail.ticId} ·{" "}
                    {detail.explanation.signal?.candidateId ?? "없음"}
                  </dd>
                  <dt>제출 시각</dt>
                  <dd>{when(detail.submittedAt)}</dd>
                  <dt>내 판단</dt>
                  <dd>{judgmentLabel(preview.judgment)}</dd>
                  <dt>근거</dt>
                  <dd>
                    {preview.evidence
                      .map(
                        (code) =>
                          evidenceOptions.find(
                            (option) => option.value === code,
                          )?.label ?? code,
                      )
                      .join(", ") || "없음"}
                  </dd>
                  <dt>메모</dt>
                  <dd className="publication-memo">{preview.memo || "없음"}</dd>
                  <dt>제출 주기</dt>
                  <dd>
                    {detail.explanation.submitted?.periodDays ?? "없음"}일
                  </dd>
                  <dt>위상 구간</dt>
                  <dd>
                    {detail.explanation.submitted?.phaseStart ?? "없음"} ~{" "}
                    {detail.explanation.submitted?.phaseEnd ?? "없음"}
                  </dd>
                  <dt>데이터 · 규칙 버전</dt>
                  <dd>
                    {detail.versions.data ?? "보관되지 않음"} ·{" "}
                    {detail.versions.rule ?? "보관되지 않음"}
                  </dd>
                  <dt>처리 · 스냅샷 버전</dt>
                  <dd>
                    {detail.versions.preprocess ?? "보관되지 않음"} ·{" "}
                    {detail.versions.pipeline ?? "보관되지 않음"} ·{" "}
                    {detail.versions.snapshot ?? "보관되지 않음"}
                  </dd>
                  <dt>잔차 · 주기도 버전</dt>
                  <dd>
                    {detail.versions.residualModel ?? "보관되지 않음"} ·{" "}
                    {detail.versions.periodogramConfig ?? "보관되지 않음"}
                  </dd>
                  <dt>현재 공개 상태</dt>
                  <dd>
                    {item.stale
                      ? "다시 확인 필요"
                      : publicLabels[publication.state]}
                  </dd>
                </dl>
                {detail.isPreviousBundle && (
                  <p>
                    이전 데이터 판에서 제출한 기록입니다. 제출 원본을
                    공개합니다.
                  </p>
                )}
                {detail.relabel && (
                  <p>
                    제출 후 분류가 변경되었습니다. 당시 판단과 기록은
                    유지됩니다.
                  </p>
                )}
                <StoredGraph historyId={item.historyId} ticId={detail.ticId} />
                <Link
                  to={pagePath(
                    "historyDetail",
                    { historyId: item.historyId },
                    { returnTo },
                  )}
                >
                  History 상세 보기
                </Link>
                <p>
                  내용을 바꾸려면{" "}
                  <Link
                    to={pagePath(
                      "analysis",
                      { ticId: detail.ticId },
                      { returnTo },
                    )}
                  >
                    새로 분석하기
                  </Link>
                  에서 새 기록을 제출해 주세요.
                </p>
                {!historyId && !item.outcome && item.candidateId && (
                  <OtherHistories
                    item={item}
                    disabled={review.busy}
                    replace={(id) => review.replace(item, id)}
                  />
                )}
                {canPublish(item) && (
                  <div className="publication-actions">
                    {!historyId && (
                      <label>
                        <input
                          type="checkbox"
                          name={`publish-${item.historyId}`}
                          checked={item.selected}
                          disabled={
                            review.busy ||
                            (!item.selected &&
                              selected.length >= MAX_PUBLICATION_BATCH_SIZE)
                          }
                          onChange={(event) =>
                            review.select(item.historyId, event.target.checked)
                          }
                        />
                        모두 게시에 포함
                      </label>
                    )}
                    <button
                      disabled={review.busy}
                      onClick={() => review.publish([item])}
                    >
                      이 기록 게시
                    </button>
                  </div>
                )}
                {publication.publicAnalysisId && !item.stale && (
                  <div className="publication-actions">
                    {publication.state === "PUBLISHED" && (
                      <Link
                        to={pagePath(
                          "publicAnalysis",
                          { analysisId: publication.publicAnalysisId },
                          { returnTo },
                        )}
                      >
                        공개 분석 보기
                      </Link>
                    )}
                    <button
                      disabled={review.busy}
                      onClick={() => review.visibility(item, false)}
                    >
                      공개 취소
                    </button>
                    {publication.state === "UNPUBLISHED" && (
                      <button
                        disabled={review.busy}
                        onClick={() => review.visibility(item, true)}
                      >
                        이 기록 재공개
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
            {item.notice && <p role="status">{item.notice}</p>}
            {item.receipt && (
              <p>
                이번 응답의 성과:{" "}
                {item.receipt.newlyGranted
                  ? "새로 인정됨"
                  : item.receipt.achievementGranted
                    ? "이미 인정된 성과"
                    : "인정되지 않음"}
                {item.receipt.unlockedTicIds.length > 0 &&
                  ` · ${item.receipt.newlyGranted ? "새로 발견한 별" : "이 공개와 연결된 발견 별"}: ${item.receipt.unlockedTicIds.join(", ")}`}
              </p>
            )}
            {item.outcome === "failed" && !item.receipt && (
              <p>이 응답으로는 성과 인정 여부를 확인할 수 없습니다.</p>
            )}
            <button
              disabled={review.busy || item.loading}
              onClick={() => review.refresh(item)}
            >
              현재 상태 다시 확인
            </button>
            {item.outcome === "unknown" &&
              !item.stale &&
              item.preview &&
              !item.preview.detail.explanation.publication.publicAnalysisId && (
                <button
                  disabled={review.busy}
                  onClick={() => review.reviewUnknown(item)}
                >
                  같은 기록 다시 검토
                </button>
              )}
          </section>
        );
      })}
      {!historyId && review.items.length > 0 && (
        <div className="publication-actions">
          <button
            disabled={review.busy || !selected.length}
            onClick={() => review.publish(selected)}
          >
            선택한 {selected.length}개 모두 게시
          </button>
          {review.cursor && (
            <button
              disabled={review.busy || review.loading}
              onClick={review.more}
            >
              공개 대상 더 보기
            </button>
          )}
        </div>
      )}
      {retryable.length > 0 && (
        <div>
          {retryable.length > MAX_PUBLICATION_BATCH_SIZE && (
            <p>
              재시도 대상 {retryable.length}개 중 한 번에 최대{" "}
              {MAX_PUBLICATION_BATCH_SIZE}개를 보냅니다.
            </p>
          )}
          <button
            disabled={review.busy}
            onClick={() => review.publish(retryBatch, true)}
          >
            실패한 {retryBatch.length}개만 다시 게시
          </button>
        </div>
      )}
      {review.busy && (
        <p role="status">
          요청을 처리하고 현재 상태를 확인하는 중입니다. 화면을 나가도 서버에서
          요청이 처리될 수 있습니다.
        </p>
      )}
    </main>
  );
}
