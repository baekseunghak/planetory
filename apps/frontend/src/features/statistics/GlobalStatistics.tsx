import { useCallback, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { useSession } from "../../auth/SessionProvider";
import { pagePath } from "../../app/paths";
import { useReadModel } from "../community/useReadModel";
import { formatMetric, type Metric } from "./contracts";
import {
  globalMetricLabels,
  readGlobalStatistics,
  type GlobalMetricKey,
} from "./global-contracts";
import "./statistics.css";

const timestamp = (v: string) =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(v));
function Value({ metric }: { metric: Metric }) {
  return (
    <>
      <strong>{formatMetric(metric)}</strong>
      {metric.denominator !== null && (
        <small>
          분자 {metric.numerator?.toLocaleString("ko-KR")} / 분모{" "}
          {metric.denominator.toLocaleString("ko-KR")}
        </small>
      )}
    </>
  );
}
function Table({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      className="statistics-table"
      role="region"
      aria-label={title}
      tabIndex={0}
    >
      <table>
        <caption>{title}</caption>
        {children}
      </table>
    </div>
  );
}
function Metrics({
  title,
  keys,
  metrics,
  children,
}: {
  title: string;
  keys: GlobalMetricKey[];
  metrics: Record<GlobalMetricKey, Metric>;
  children?: ReactNode;
}) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
      <dl className="statistics-metrics">
        {keys.map((key) => (
          <div key={key}>
            <dt>{globalMetricLabels[key]}</dt>
            <dd>
              <Value metric={metrics[key]} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
export function GlobalStatisticsPage() {
  const session = useSession();
  const load = useCallback(
    async (signal: AbortSignal) =>
      readGlobalStatistics(await api("/v1/statistics", { signal })),
    [],
  );
  const state = useReadModel(
    `${session.member?.memberId ?? ""}:${session.revision}`,
    load,
  );
  const g = state.data;
  const weeklyMax = Math.max(
    1,
    ...(g?.data?.weeklySubmissions.map((w) => w.submissions) ?? []),
  );
  return (
    <section className="global-statistics" aria-label="전체 탐사 통계">
      <h1>전체 탐사 통계</h1>
      <p>
        전체 통계는 10분 주기로 집계합니다. 결과 화면·공식 신호 스레드의 실시간
        신호 통계와 기준 시각이 다릅니다. 새로고침은 마지막 집계본을 다시
        조회합니다.
      </p>
      {state.loading ? (
        <p role="status">전체 탐사 통계를 불러오고 있습니다…</p>
      ) : state.error || !g ? (
        <>
          <p role="alert">
            전체 통계를 불러오지 못했습니다. 표시할 수치를 확인하지 못했습니다.
          </p>
          <button type="button" onClick={state.reload}>
            통계 다시 불러오기
          </button>
        </>
      ) : (
        <>
          {g.status === "UNAVAILABLE" ? (
            <p role="status">
              통계 준비 중입니다. 아직 성공한 집계가 없어 수치와 기준 시각을
              표시할 수 없습니다.
            </p>
          ) : (
            <>
              {g.status === "STALE" && (
                <p role="status">
                  갱신 지연: 마지막 성공 집계의 수치와 기준 시각을 표시합니다.
                </p>
              )}
              <p>
                전체 지표 기준 시각:{" "}
                <time dateTime={g.asOf}>{timestamp(g.asOf)}</time> (KST)
                <br />
                집계 완료 시각:{" "}
                <time dateTime={g.generatedAt}>
                  {timestamp(g.generatedAt)}
                </time>{" "}
                (KST)
              </p>
              <p>
                주간 추이를 제외한 지표는 기록 시작부터 기준 시각까지의 자료와
                당시 상태를 사용합니다. 탈퇴한 회원의 기여 제외는 다음 성공
                집계에 반영됩니다.
              </p>
              <Metrics
                title="발견과 현재 완료"
                keys={[
                  "discoveredStars",
                  "uniqueDiscoveredStars",
                  "startedStars",
                  "currentCompletedStars",
                  "uniqueCurrentCompletedStars",
                ]}
                metrics={g.data.metrics}
              >
                <p>
                  회원×별은 같은 별을 탐사한 회원마다 셉니다. 고유 별은 TIC
                  중복을 제거합니다. 새 후보로 탐사가 재개되면 현재 완료 수는
                  줄어들 수 있습니다.
                </p>
              </Metrics>
              <Metrics
                title="성과와 신호 유형"
                keys={[
                  "recognizedSignals",
                  "confirmedAchievements",
                  "unconfirmedAchievements",
                  "fpAchievements",
                  "uniqueRecognizedSignals",
                  "uniqueConfirmedSignals",
                  "uniqueFpSignals",
                  "uniqueUnconfirmedSignals",
                  "firstMatchAccuracy",
                ]}
                metrics={g.data.metrics}
              >
                <p>
                  성과 유형은 인정 당시 기준이며 고유 신호 유형은 집계 시점의
                  분류입니다. 고유 신호는 성과가 있는 신호만 포함합니다. 첫 매칭
                  일치율은 채점 가능한 첫 매칭 기록 전체의 분자·분모로
                  계산합니다.
                </p>
              </Metrics>
              <Metrics
                title="공개 분석 판단"
                keys={[
                  "publicParticipations",
                  "publicLikelyPlanet",
                  "publicLikelyPlanetRate",
                  "publicUnlikelyPlanet",
                  "publicUnlikelyPlanetRate",
                  "publicUnsure",
                  "publicUnsureRate",
                ]}
                metrics={g.data.metrics}
              >
                <p>
                  유효한 최신 공개 분석을 회원×신호당 하나씩 셉니다. 한 회원이
                  여러 신호에 참여할 수 있어 고유 참여자 수와 다릅니다.
                </p>
              </Metrics>
              <section>
                <h2>최근 8주 제출 추이</h2>
                <p>
                  KST 월요일 시작이며 마지막 주는 기준 시각까지의 부분 주입니다.
                </p>
                <Table title="8주 제출 추이">
                  <thead>
                    <tr>
                      <th scope="col">주 시작일</th>
                      <th scope="col">제출 수</th>
                      <th scope="col">집계 범위</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.data.weeklySubmissions.map((w) => (
                      <tr key={w.weekStart}>
                        <th scope="row">{w.weekStart}</th>
                        <td>
                          {w.submissions.toLocaleString("ko-KR")}건
                          <span
                            aria-hidden="true"
                            className="statistics-bar"
                            style={{
                              width: `${(w.submissions / weeklyMax) * 100}%`,
                            }}
                          />
                        </td>
                        <td>
                          {w.partial ? "진행 중 · 기준 시각까지" : "완료된 주"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </section>
              <section>
                <h2>공개 원글이 많은 별</h2>
                <p>
                  공개 일반 원글과 공식 스레드 수 기준 상위 5개입니다.
                  댓글·반응은 제외하며 동률이면 TIC 순입니다.
                </p>
                {g.data.mostPostsStars.length ? (
                  <Table title="공개 원글 상위 별">
                    <thead>
                      <tr>
                        <th scope="col">별 게시판</th>
                        <th scope="col">원글 수</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.data.mostPostsStars.map((s) => (
                        <tr key={s.ticId}>
                          <th scope="row">
                            <Link
                              to={pagePath("starBoard", { ticId: s.ticId })}
                            >
                              TIC {s.ticId}
                            </Link>
                          </th>
                          <td>{s.postCount.toLocaleString("ko-KR")}개</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  <p>집계할 공개 원글이 없습니다.</p>
                )}
              </section>
              <Metrics
                title="AI 판단 구간"
                keys={["aiAttemptUnknown"]}
                metrics={g.data.metrics}
              >
                <p>
                  후보별 최신 AI 시도를 확인할 원천이 없어 판단 구간을 제공하지
                  않습니다. 아래 건수는 전체 공개 참여와 같으며 추가로 합산하지
                  않습니다. AI 실패나 미실행을 뜻하지 않습니다.
                </p>
              </Metrics>
              <section>
                <h2>진행 중인 챌린지</h2>
                <p>
                  회차 대상 별의 전 기간 공개 참여를 셉니다. 회차 기간에 제출한
                  기록만을 뜻하지 않습니다.
                </p>
                {g.data.challenges.length ? (
                  <Table title="챌린지 참여와 판단">
                    <thead>
                      <tr>
                        {[
                          "회차",
                          "고유 참여자",
                          "회원×신호 참여",
                          "행성 같음",
                          "아닌 것 같음",
                          "모르겠음",
                        ].map((s) => (
                          <th scope="col" key={s}>
                            {s}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {g.data.challenges.map((c) => (
                        <tr key={c.roundId}>
                          <th scope="row">{c.roundNo}회차</th>
                          <td>
                            {c.participantCount.toLocaleString("ko-KR")}명
                          </td>
                          <td>
                            {c.participationCount.toLocaleString("ko-KR")}건
                          </td>
                          <td>{c.likelyPlanet.toLocaleString("ko-KR")}건</td>
                          <td>{c.unlikelyPlanet.toLocaleString("ko-KR")}건</td>
                          <td>{c.unsure.toLocaleString("ko-KR")}건</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  <p>집계 기준 시각에 진행 중인 챌린지가 없습니다.</p>
                )}
              </section>
              <section>
                <h2>Sector별 현재 완료율</h2>
                <p>
                  해당 Sector에 관측이 있는 발견 회원×별 중 현재 완료한
                  비율입니다. 관측 버전 중복은 제거하며 여러 Sector에 있는 같은
                  별은 각각 포함하므로 회차끼리 합산하지 않습니다. 데이터
                  처리율이 아닙니다.
                </p>
                {g.data.sectorCompletion.length ? (
                  <Table title="Sector별 현재 완료율">
                    <thead>
                      <tr>
                        <th scope="col">Sector</th>
                        <th scope="col">현재 완료율</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.data.sectorCompletion.map((s) => (
                        <tr key={s.sector}>
                          <th scope="row">Sector {s.sector}</th>
                          <td>
                            <Value metric={s.metric} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  <p>집계할 Sector별 발견 기록이 없습니다.</p>
                )}
              </section>
            </>
          )}
          <button type="button" onClick={state.reload}>
            통계 새로고침
          </button>
        </>
      )}
    </section>
  );
}
