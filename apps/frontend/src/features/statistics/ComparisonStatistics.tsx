import {
  formatMetric,
  metricLabels,
  unitLabels,
  type Metric,
} from "./contracts";
import type { Comparison } from "./comparison";
const timestamp = (v: string) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(v));
const mineLabel = (m: Metric) =>
  m.reason === "HISTORICAL_SOURCE_UNAVAILABLE"
    ? "당시 자료 부족"
    : m.reason === "JOINED_AFTER_CUTOFF"
      ? "가입 전 기준 통계"
      : formatMetric(m);
export function ComparisonStatistics({
  data,
  retry,
}: {
  data: Comparison | null;
  retry: () => void;
}) {
  return (
    <section aria-label="일별 중앙값 비교">
      <h3>일별 중앙값 비교</h3>
      <p>
        개인 최신값·실시간 신호 통계·10분 전체 집계와 다른 일별 기준입니다.
        현재값으로 과거 본인 값을 대신하지 않습니다.
      </p>
      {!data ? (
        <>
          <p role="alert">
            비교 응답을 확인하지 못했습니다. 현재 개인 통계는 계속 확인할 수
            있습니다.
          </p>
          <button type="button" onClick={retry}>
            비교 통계 다시 불러오기
          </button>
        </>
      ) : data.status === "UNAVAILABLE" ? (
        <p role="status">
          비교 통계 준비 중입니다. 아직 성공한 일별 집계가 없습니다.
        </p>
      ) : (
        <>
          {data.status === "STALE" && (
            <p role="status">
              비교 집계 갱신 지연: 마지막 성공 기준일과 값을 표시합니다.
            </p>
          )}
          <dl>
            <dt>마지막 성공 기준일</dt>
            <dd>{data.snapshotDate}</dd>
            <dt>누적 값 계산 종료 (미포함)</dt>
            <dd>
              <time dateTime={data.asOf!}>{timestamp(data.asOf!)}</time> (KST)
            </dd>
            <dt>원천 상태 확인 시각</dt>
            <dd>
              <time dateTime={data.sourceObservedAt!}>
                {timestamp(data.sourceObservedAt!)}
              </time>{" "}
              (KST)
            </dd>
            <dt>집계 완료 시각</dt>
            <dd>
              <time dateTime={data.generatedAt!}>
                {timestamp(data.generatedAt!)}
              </time>{" "}
              (KST)
            </dd>
            <dt>비교 대상 선정 기간 (최근 90일)</dt>
            <dd>
              {timestamp(data.cohortStart!)} 이상 ~ {timestamp(data.cohortEnd!)}{" "}
              미만 (KST)
            </dd>
            <dt>비교 대상 회원</dt>
            <dd>{data.cohortMemberCount!.toLocaleString("ko-KR")}명</dd>
          </dl>
          <p>
            선정 기간에 제출한 회원의 기준 시각 이전 누적 지표입니다. 90일은
            회원 선정 기간이며 지표 계산 기간이 아닙니다. 원천 확인 시점의
            상태가 반영되므로 정확한 자정 상태의 복원은 아닙니다.
          </p>
          <p>
            {data.inCohort === null
              ? "내 과거 모수 포함 여부: 확인할 수 없음"
              : data.inCohort
                ? "내 과거 모수 포함 여부: 포함"
                : "내 과거 모수 포함 여부: 제외"}
          </p>
          <div
            className="statistics-table"
            role="region"
            aria-label="일별 비교 지표 표"
            tabIndex={0}
          >
            <table style={{ tableLayout: "fixed" }}>
              <caption>같은 기준의 본인 값과 전체 중앙값</caption>
              <colgroup>
                <col style={{ width: "25%" }} />
                <col style={{ width: "30%" }} />
                <col style={{ width: "30%" }} />
                <col style={{ width: "15%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">지표</th>
                  <th scope="col">당시 내 값</th>
                  <th scope="col">전체 중앙값</th>
                  <th scope="col">유효 표본</th>
                </tr>
              </thead>
              <tbody>
                {data.metrics.map((m) => {
                  const available =
                    m.myValue.status === "AVAILABLE" &&
                    m.status === "AVAILABLE";
                  const max = Math.max(1, m.myValue.value ?? 0, m.median ?? 0);
                  return (
                    <tr key={m.key}>
                      <th scope="row">{metricLabels[m.key]}</th>
                      <td>
                        {mineLabel(m.myValue)}
                        {available && (
                          <span
                            className="statistics-bar"
                            aria-hidden="true"
                            style={{
                              width: `${(m.myValue.value! / max) * 100}%`,
                            }}
                          />
                        )}
                      </td>
                      <td>
                        {m.median === null
                          ? "표본 없음 (분모 0)"
                          : `${m.median.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}${unitLabels[m.myValue.unit]}`}
                        {available && (
                          <span
                            className="statistics-bar"
                            aria-hidden="true"
                            style={{ width: `${(m.median! / max) * 100}%` }}
                          />
                        )}
                      </td>
                      <td>{m.sampleCount?.toLocaleString("ko-KR")}명</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p>
            유효 표본은 지표마다 다를 수 있습니다. 표본 없음은 0점이 아니며,
            중앙값은 전체 합산 비율이나 사용자 순위·백분위가 아닙니다. 비교
            가능한 두 값이 있을 때만 같은 행 안에서 막대를 표시합니다.
          </p>
        </>
      )}
      <p>
        읽는 법: 첫 매칭 일치율은 채점 가능한 첫 매칭 기록 기준입니다. 별당 제출
        수·고조파 인정 비율·선택 근거 수는 높을수록 좋다는 뜻이 아닙니다. 최근
        분석 기록과 실제 선택 근거를 함께 살펴보세요.
      </p>
    </section>
  );
}
