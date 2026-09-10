import { useState } from "react";
import { Link } from "react-router-dom";
import type { History, PublicHistory } from "../../shared/types";
import { JUDGMENTS } from "../../shared/types";
import { AI, Curve, HistorySummary, date } from "./ui";
import { RequestState } from "./ui";
import { useResource } from "../api/hooks";
import type { Replay } from "../../shared/replay";
type RecordViewProps = {
  history: History | PublicHistory;
  actions?: boolean;
  replayPath?: string;
};
export function RecordView(props: RecordViewProps) {
  // A different record or replay source must not inherit the previous graph.
  return (
    <RecordContent
      key={[
        props.history.id,
        props.history.bundleId,
        props.history.currentBundleId,
        props.replayPath,
      ].join(":")}
      {...props}
    />
  );
}
function RecordContent({
  history: h,
  actions = true,
  replayPath,
}: RecordViewProps) {
  const [original, setOriginal] = useState(true);
  const latest = !h.snapshot || !original;
  const replay = useResource<Replay>(
    latest ? replayPath || "/history/" + h.id + "/replay" : null,
  );
  const points = latest ? replay.data?.points : h.snapshot;
  const selection = latest ? replay.data : h;
  const shownBundle = latest ? replay.data?.bundleId : h.bundleId;
  return (
    <div className="record-view">
      <div className="record-heading">
        <strong>TIC {h.starId}</strong>
        <small>{date(h.submittedAt)}</small>
      </div>
      <HistorySummary
        h={
          latest && replay.data
            ? { ...h, currentBundleId: replay.data.bundleId }
            : h
        }
      />
      <p className="muted">
        공개 상태:{" "}
        {h.publication?.hidden
          ? "운영자가 숨긴 자료"
          : h.publication?.active
            ? "공개됨"
            : "미게시"}
      </p>
      {h.snapshot && (
        <div className="segmented" aria-label="곡선 데이터 선택">
          <button aria-pressed={original} onClick={() => setOriginal(true)}>
            제출 당시
          </button>
          <button aria-pressed={!original} onClick={() => setOriginal(false)}>
            최신 데이터
          </button>
        </div>
      )}
      {latest && <RequestState state={replay} />}
      {latest && replay.data?.restoreFallback && (
        <p className="notice">
          이전 단계 복원 불가 · 원본 곡선 위에 표시합니다.
        </p>
      )}
      {points && (
        <Curve
          points={points}
          zoom={h.foldedZoom}
          label={
            h.snapshot && original
              ? "제출 당시 주기로 겹친 곡선 · 150구간 스냅샷"
              : "최신 데이터의 주기로 겹친 곡선"
          }
          band={
            selection?.phaseStart != null && selection.phaseEnd != null
              ? [selection.phaseStart, selection.phaseEnd]
              : null
          }
        />
      )}
      {points && (
        <small className="muted record-data-source">
          표시 중인 데이터 판: {shownBundle} ·{" "}
          {latest ? "최신 데이터" : "제출 당시 스냅샷"}
        </small>
      )}
      <dl className="facts record-facts">
        {h.originalPeriod !== null && h.originalPeriod !== h.period && (
          <div>
            <dt>내가 선택한 주기</dt>
            <dd>{h.originalPeriod}일 · 배수 주기 보정 전</dd>
          </div>
        )}
        <div>
          <dt>반복 주기</dt>
          <dd>{h.period ?? "—"}일</dd>
        </div>
        <div>
          <dt>기준 시각</dt>
          <dd>{h.epoch == null ? "—" : h.epoch + " BTJD"}</dd>
        </div>
        <div>
          <dt>제출 당시 구간 시작</dt>
          <dd>{h.phaseStart ?? "—"}</dd>
        </div>
        <div>
          <dt>제출 당시 구간 끝</dt>
          <dd>{h.phaseEnd ?? "—"}</dd>
        </div>
        {latest && replay.data && (
          <>
            <div>
              <dt>최신 곡선 위 구간 시작</dt>
              <dd>{replay.data.phaseStart ?? "—"}</dd>
            </div>
            <div>
              <dt>최신 곡선 위 구간 끝</dt>
              <dd>{replay.data.phaseEnd ?? "—"}</dd>
            </div>
          </>
        )}
        <div>
          <dt>가려진 시간</dt>
          <dd>
            {h.duration == null ? (
              "—"
            ) : (
              <span title={"저장 원본: " + h.duration + "일"}>
                {h.duration * 24}시간
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>제출 당시 곡선</dt>
          <dd>{h.curveStep === 0 ? "원본" : "뺀 곡선 " + h.curveStep}</dd>
        </div>
        <div>
          <dt>내 판단</dt>
          <dd>{h.judgment ? JUDGMENTS[h.judgment] : "판단 없음"}</dd>
        </div>
        <div>
          <dt>근거</dt>
          <dd>{h.evidence.join(" · ") || "선택한 근거 없음"}</dd>
        </div>
        <div>
          <dt>가로 확대</dt>
          <dd>{h.foldedZoom}배</dd>
        </div>
      </dl>
      <details className="reproduction-details">
        <summary>제출 당시 재현 설정·계산 버전</summary>
        <p>
          위상 기준 시각: {h.referenceTime} BTJD · 제거한 신호:{" "}
          {h.removedIds.join(", ") || "없음"}
        </p>
        {h.reproduction ? (
          <>
            <p>
              주기도 범위:{" "}
              {h.reproduction.periodogramViewport
                ? `주기 ${h.reproduction.periodogramViewport.xMin}~${h.reproduction.periodogramViewport.xMax}일 · 세로 ${h.reproduction.periodogramViewport.yMin}~${h.reproduction.periodogramViewport.yMax}`
                : "저장된 범위 없음"}
            </p>
            <p>
              위상 접기:{" "}
              {h.reproduction.folding
                ? `Bundle 기준 시각 · BTJD · 위상 이동 ${h.reproduction.folding.phaseOffset}`
                : "저장된 설정 없음"}
            </p>
            <dl className="facts">
              {Object.entries(h.reproduction.versions).map(([key, value]) => (
                <div key={key}>
                  <dt>
                    {{
                      preprocessing: "전처리",
                      residual: "잔차",
                      periodogram: "주기도",
                      feature: "특징 추출",
                      ai: "AI",
                      matching: "매칭",
                      external: "외부 자료",
                      folding: "위상 접기",
                    }[key] || key}
                  </dt>
                  <dd>{value || "버전 미제공"}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <p>
            이전 기록에는 세부 계산 버전·주기도 범위·접기 설정이 저장되지
            않았습니다. 원본 기록은 유지합니다.
          </p>
        )}
      </details>
      {h.memo && <blockquote className="record-memo">{h.memo}</blockquote>}
      <small className="muted">
        제출 당시 데이터 판: {h.bundleId} · 중심 위치: 데이터 없음
      </small>
      {h.signal && (
        <>
          <AI signal={h.signal} />
          <p className="source-line">
            출처:{" "}
            <a href={h.signal.source.url} target="_blank" rel="noreferrer">
              {h.signal.source.title}
            </a>{" "}
            · 조회 {h.signal.source.retrievedAt}
          </p>
        </>
      )}
      {h.retired && (
        <p className="notice">
          최신 데이터에서 더 이상 후보가 아닙니다. 재도전할 수 없습니다.
        </p>
      )}
      {actions && (
        <div className="actions">
          {h.retired ? (
            <button disabled>다시 풀기 불가</button>
          ) : (
            h.outcome !== "skipped" && (
              <Link
                className="button"
                to={"/analysis/" + h.starId + "?retry=" + h.id}
              >
                다시 풀기
              </Link>
            )
          )}
          {h.type === "unconfirmed" &&
            h.signalId &&
            !h.publication?.active &&
            !h.publication?.hidden && (
              <Link
                className="button primary"
                to={"/publish/" + h.starId + "?record=" + h.id}
              >
                분석 공개
              </Link>
            )}
          <Link className="button" to={"/results/" + h.starId}>
            별 결과 보기
          </Link>
        </div>
      )}
    </div>
  );
}
