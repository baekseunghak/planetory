import { useCallback } from "react";
import { api } from "../../api";
import { ApiError } from "../../api/client";
import { useReadModel } from "../community/useReadModel";
import type { ProfileSlotProps } from "../profile/ProfileSlots";
import {
  formatMetric,
  metricLabels,
  readPersonalStatistics,
  type Metric,
} from "./contracts";
import "./statistics.css";
const labels: Record<string, string> = {
  confirmed: "확정 행성",
  unconfirmed: "미확정",
  fp: "거짓 양성",
  LIKELY_PLANET: "행성 같음",
  UNLIKELY_PLANET: "아닌 것 같음",
  UNSURE: "모르겠음",
  oddeven: "홀짝 깊이",
  secondary: "이차 식",
  ushape: "U자 형태",
};
function Value({ metric }: { metric: Metric }) {
  return (
    <>
      <strong>{formatMetric(metric)}</strong>
      {metric.denominator !== null && (
        <small>
          분자 {metric.numerator ?? "자료 없음"} / 분모 {metric.denominator}
        </small>
      )}
    </>
  );
}
function Metrics({
  title,
  values,
}: {
  title: string;
  values: Record<string, Metric>;
}) {
  return (
    <section>
      <h3>{title}</h3>
      <dl className="statistics-metrics">
        {Object.entries(values).map(([key, metric]) => (
          <div key={key}>
            <dt>
              {metricLabels[key as keyof typeof metricLabels] ??
                labels[key] ??
                key}
            </dt>
            <dd>
              <Value metric={metric} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
const timestamp = (v: string) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(v));
export function PersonalStatistics(props: ProfileSlotProps) {
  return props.isOwn ? (
    <Statistics key={props.memberId} memberId={props.memberId} />
  ) : null;
}
function Statistics({ memberId }: { memberId: string }) {
  const load = useCallback(
    async (signal: AbortSignal) =>
      readPersonalStatistics(await api("/v1/me/statistics", { signal })),
    [],
  );
  const state = useReadModel(memberId, load);
  if (state.loading)
    return <p role="status">내 탐사 통계를 불러오고 있습니다…</p>;
  if (state.error || !state.data)
    return (
      <section>
        <p role="alert">
          {state.error instanceof ApiError && state.error.status === 403
            ? "통계 접근 권한이 없습니다."
            : "내 탐사 통계를 불러오지 못했습니다. 표시할 수치를 확인하지 못했습니다."}
        </p>
        <button type="button" onClick={state.reload}>
          통계 다시 불러오기
        </button>
      </section>
    );
  const c = state.data,
    max = Math.max(1, ...c.weeks.map((w) => w.submissionCount));
  return (
    <section className="personal-statistics" aria-label="내 탐사 통계">
      <h2>내 탐사 통계</h2>
      <p>
        조회 기준 <time dateTime={c.asOf}>{timestamp(c.asOf)}</time> ·
        Asia/Seoul
      </p>
      <p>
        누적 기간: {timestamp(c.periodStart)}부터 {timestamp(c.periodEnd)}까지
      </p>
      <p>응답 생성: {timestamp(c.generatedAt)}</p>
      {c.metrics.submissionCount.value === 0 && (
        <p role="status">
          아직 탐사 제출 기록이 없습니다. 건수 0과 비율의 표본 없음을 구분해
          표시합니다.
        </p>
      )}
      <Metrics title="현재 기록" values={c.metrics} />
      <p>
        시작한 별은 제출 기록이 있는 별입니다. 탐색 완료한 별은 재개 시 줄어들
        수 있으며 튜토리얼 누적 완료와 다릅니다. 일치율은 첫 매칭 기록을
        기준으로 하며 실력이나 과학적 진위를 단정하지 않습니다.
      </p>
      <Metrics title="성과 유형" values={c.achievementByType} />
      <Metrics title="별 등급 분포" values={c.gradeDistribution} />
      <section>
        <h3>최근 8주 제출 추이</h3>
        <p>
          한국 시각 월요일 시작 포함, 다음 월요일 끝 제외입니다. 이번 주는 진행
          중이며 빈 주도 0건으로 표시합니다.
        </p>
        <div
          className="statistics-table"
          role="region"
          aria-label="8주 추이 표"
          tabIndex={0}
        >
          <table>
            <caption>주별 제출 기록과 막대</caption>
            <thead>
              <tr>
                <th scope="col">주 시작</th>
                <th scope="col">주 끝 (제외)</th>
                <th scope="col">제출</th>
                <th scope="col">상태</th>
              </tr>
            </thead>
            <tbody>
              {c.weeks.map((w) => (
                <tr key={w.weekStart}>
                  <th scope="row">{w.weekStart}</th>
                  <td>{w.weekEnd}</td>
                  <td>
                    {w.submissionCount}건{" "}
                    <span
                      className="statistics-bar"
                      aria-hidden="true"
                      style={{ width: `${(w.submissionCount / max) * 100}%` }}
                    />
                  </td>
                  <td>{w.partial ? "진행 중" : "종료"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <Metrics title="모든 후보 제출 판단" values={c.judgmentDistribution} />
      <Metrics title="첫 매칭의 판단별 일치율" values={c.judgmentAccuracy} />
      <Metrics
        title="최신 유효 공개 판단"
        values={c.publicJudgmentDistribution}
      />
      <section>
        <h3>선택 근거</h3>
        <p>
          제출별 중복을 제외합니다. 중심 위치 자료 없음은 집계하지 않습니다.
          당시 판단을 확인할 수 없는 선택 기록은 일치율 분모에서 제외합니다.
        </p>
        <div
          className="statistics-table"
          role="region"
          aria-label="근거 통계 표"
          tabIndex={0}
        >
          <table>
            <caption>근거 사용과 일치율 제외 기록</caption>
            <thead>
              <tr>
                <th scope="col">근거</th>
                <th scope="col">사용</th>
                <th scope="col">일치율</th>
                <th scope="col">분모 제외</th>
              </tr>
            </thead>
            <tbody>
              {c.evidence.map((e) => (
                <tr key={e.key}>
                  <th scope="row">{labels[e.key]}</th>
                  <td>{e.useCount}건</td>
                  <td>
                    <Value metric={e.accuracy} />
                  </td>
                  <td>{e.excludedCount}건</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p>{c.nextGoal}</p>
      <button type="button" onClick={state.reload}>
        통계 새로고침
      </button>
    </section>
  );
}
