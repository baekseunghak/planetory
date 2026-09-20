import { Link } from "react-router-dom";
import { pagePath } from "../../app/paths";
import type { NextAction, SubmissionReceipt } from "./submission-data";
import type {
  DetailView as DetailViewData,
  JudgmentStatistics,
  ResultExplanation,
  SubmissionSignal,
} from "./submission-result";

// 여섯 축을 각각 보여 준다. 해당 없는 축은 **줄을 만들지 않는다.** 빈 값을
// 채우면 없는 사실이 생긴다. 왜 이렇게 나누는지는 docs/analysis-result.md.

const decimal = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 6 });
const percent = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 });
const count = new Intl.NumberFormat("ko-KR");

function Matched({
  receipt,
  explanation,
}: {
  receipt: SubmissionReceipt;
  explanation: ResultExplanation;
}) {
  // 내 값과 신호의 값을 나란히 두는 일은 비교표가 한다. 여기서는 무슨 일이
  // 있었는지 한 문장으로만 말한다. 같은 숫자를 두 곳에 두지 않는다.
  const { correction } = explanation;
  switch (receipt.matchStatus) {
    case "matched":
      return <p>고른 주기가 신호와 맞았습니다.</p>;
    case "matched_harmonic":
      return (
        <>
          <p>
            고른 주기의 {decimal.format(correction?.multiplier ?? 1)}배가 신호와
            맞았습니다.
          </p>
        </>
      );
    case "duplicate":
      // 배수로 맞힌 신호를 다시 맞히면 정정값도 그대로 온다. 서버가 보낸
      // 정정을 화면에서 지우면 내가 낸 주기가 틀렸던 것처럼 보인다.
      return correction === null ? (
        <p>이미 찾은 신호입니다.</p>
      ) : (
        <>
          <p>
            이미 찾은 신호입니다. 고른 주기의{" "}
            {decimal.format(correction.multiplier)}배가 맞았습니다.
          </p>
        </>
      );
    case "not_matched":
      return <p>맞는 신호를 찾지 못했습니다.</p>;
    case "ambiguous_match":
      // 서버가 일부러 고르지 않았다. 후보를 대신 보여 주지 않는다.
      return (
        <p>
          어느 신호인지 가리지 못했습니다. 주기나 구간을 바꿔 다시 풀어 보세요.
        </p>
      );
    case "none_wrong":
      return <p>더 이상 없음으로 접수했습니다.</p>;
    case "skipped":
      return <p>이 별을 건너뛰었습니다.</p>;
  }
}

const EVALUATION: Record<string, string> = {
  AGREES: "판단이 맞았습니다.",
  DISAGREES: "판단이 달랐습니다.",
  // 모르겠음은 틀린 것이 아니다.
  UNSURE: "모르겠음으로 제출해 맞고 틀림을 매기지 않았습니다.",
  // 미확정을 「아직 정답이 없다」가 아니라 「채점 대상이 아니다」로 적는다.
  UNSCORED: "아직 확정되지 않은 신호라 채점하지 않습니다.",
};

const ACHIEVEMENT: Record<string, string> = {
  recognized: "성과로 인정되었습니다.",
  judgment_mismatch: "판단이 달라 성과로 인정되지 않았습니다.",
  pending_publish: "이 분석을 공개하면 성과 판정을 받습니다.",
  already_recognized: "이미 인정된 신호라 다시 인정되지 않습니다.",
};

const AI_MISSING: Record<string, string> = {
  input_insufficient: "자료가 부족해 실행하지 못했습니다.",
  error: "실행 중 오류가 났습니다.",
  not_evaluated: "아직 실행하지 않았습니다.",
};

const COMPLETION: Record<string, string> = {
  all_found: "찾을 수 있는 신호를 모두 찾았습니다.",
  undiscoverable_only: "남은 신호는 이 자료로 찾을 수 없어 마쳤습니다.",
  skipped: "건너뛰어 마쳤습니다.",
};

/**
 * AI 판정의 구간 이름. 와이어프레임 SC-04가 쓰는 말이다.
 * **모르는 값은 그대로 보여 준다.** 명세의 세 값 밖이 오면 지어내지 않는다.
 */
const AI_BAND: Record<string, string> = {
  approved: "승인 구간",
  hold: "보류 구간",
  rejected: "기각 구간",
};

function Ai({ signal }: { signal: SubmissionSignal }) {
  const { ai } = signal;
  return (
    <section className="result-axis">
      <h5>AI 판정</h5>
      {ai.status === "completed" ? (
        <>
          <p>
            {AI_BAND[ai.verdict!] ?? ai.verdict}{" "}
            {percent.format(ai.score! * 100)}점
            {ai.modelVersion ? ` · ${ai.modelVersion}` : ""}
          </p>
          {/* 성과 판정과 무관하다는 것을 매번 말한다(와이어프레임 SC-04). */}
          <p className="submission-note">인정에는 쓰이지 않습니다.</p>
        </>
      ) : (
        // 실행하지 못한 것을 0점으로 바꾸지 않는다(RES-04).
        <p>{AI_MISSING[ai.status]}</p>
      )}
    </section>
  );
}

function Statistics({ value }: { value: JudgmentStatistics }) {
  if (value.kind === "graded")
    return (
      <section className="result-axis">
        <h5>다른 사람의 판단</h5>
        {/* 분모가 「첫 매칭 회원」이다. 공개 분포와 섞어 쓸 수 없다. */}
        <p>
          이 신호를 처음 찾은 {count.format(value.matchedMemberCount)}명 중{" "}
          {percent.format(value.agreementPercent)}%가 같은 판단이었습니다.
        </p>
      </section>
    );
  return (
    <section className="result-axis">
      <h5>다른 사람의 판단</h5>
      {value.percentages === null ? (
        // 0%가 아니라 아직 없는 것이다.
        <p>아직 공개된 분석이 없습니다.</p>
      ) : (
        <p>
          공개된 분석 {count.format(value.participantCount)}건 · 행성 같음{" "}
          {percent.format(value.percentages.likelyPlanet)}% · 아닌 것 같음{" "}
          {percent.format(value.percentages.unlikelyPlanet)}% · 모르겠음{" "}
          {percent.format(value.percentages.unsure)}%
        </p>
      )}
      {/* 언제 센 값인지 없으면 지금 값으로 읽힌다(와이어프레임 SC-04). */}
      <p className="submission-note">
        집계 시각{" "}
        <time dateTime={value.asOf}>
          {new Date(value.asOf).toLocaleString("ko-KR")}
        </time>
      </p>
    </section>
  );
}

/** 접수 결과의 해설. 여섯 축을 독립으로 읽는다. */
/**
 * 이 축의 값이 **접수 당시 기준**이라는 표시(D-5 재전송 성공 예외).
 *
 * 최신이 필요한 영역은 진행·공개·통계·다음 행동뿐이다. 판정·선택·스냅샷은
 * 당시 값이 정본이므로 이 표시를 붙이지 않는다.
 *
 * 최신 값을 가져오려면 6.6절(145)로 다시 조회해야 하는데 아직 연결 전이다.
 * 그래서 **당시 결과를 그대로 두고 모른다고 말한다.** 최신인 척하지 않는다.
 */
/**
 * D-5 재전송 성공 예외. 접수 뒤 판이 바뀌었어도 성공을 취소하지 않고, 최신이
 * 필요한 축이 어디인지만 알린다. **축마다 같은 문장을 되풀이하지 않는다** —
 * 네 곳에 흩어 놓으면 무엇이 옛 값인지보다 경고가 많다는 인상만 남는다.
 * 당시 값이 정본인 축(매칭·판단·성과·서버 계산값)은 여기에 들어가지 않는다.
 */
function StaleBand({ stale }: { stale: boolean }) {
  if (!stale) return null;
  return (
    <p className="submission-note result-stale" data-testid="stale-axis">
      진행 · 공개 · 다른 사람의 판단 · 다음에 할 수 있는 일은 접수 당시
      기준입니다. 최신 상태는 아직 확인하지 못했습니다.
    </p>
  );
}

/** 표의 한 줄. 양쪽이 모두 비면 줄 자체를 만들지 않는다. */
type Row = { label: string; mine: string | null; theirs: string | null };
const day = (value: number | null | undefined) =>
  value == null ? null : `${decimal.format(value)}일`;
const hour = (value: number | null | undefined) =>
  value == null ? null : `${decimal.format(value)}시간`;
const btjd = (value: number | null | undefined) =>
  value == null ? null : `${decimal.format(value)} BTJD`;
const plain = (value: number | null | undefined) =>
  value == null ? null : decimal.format(value);

/**
 * 내가 낸 것과 기록의 신호를 **나란히** 둔다. 위아래로 쌓으면 같은 항목을
 * 비교하려고 화면을 오르내려야 한다.
 *
 * 신호가 없으면(미매칭·특수 제출) 한 칸만 그린다. **빈 열을 만들어 두고
 * 줄을 그으면 신호가 있는데 값만 없는 것처럼 보인다.**
 */
/**
 * 오른쪽 칸을 채우는 신호. 매칭에 성공하면 접수 응답이 주고, 실패하면
 * **상세 보기를 눌렀을 때만** 알 수 있다(6.7절). 그 값은 같은 항목이므로
 * 따로 줄을 만들지 않고 이 표의 빈 칸을 채운다.
 */
type Counterpart = { bls: SubmissionSignal["bls"]; label: string } | null;

function comparisonRows(
  explanation: ResultExplanation,
  other: Counterpart,
): Row[] {
  const { submitted, serverDerived } = explanation;
  const bls = other?.bls;
  const span =
    submitted?.phaseStart != null && submitted.phaseEnd != null
      ? `${decimal.format(submitted.phaseStart)} ~ ${decimal.format(submitted.phaseEnd)}`
      : null;
  const rows: Row[] = [
    // 서버가 보존한 원본을 쓴다. 정정값을 배율로 나눠 되돌리지 않는다.
    {
      label: "주기",
      mine: day(submitted?.periodDays),
      theirs: day(bls?.periodDays),
    },
    {
      label: "기준 시각",
      mine: btjd(serverDerived?.epochBtjd),
      theirs: btjd(bls?.epochBtjd),
    },
    {
      label: "가려진 시간",
      mine: hour(serverDerived?.durationHours),
      theirs: hour(bls?.durationHours),
    },
    { label: "위상 구간", mine: span, theirs: null },
    {
      label: "깊이",
      mine: null,
      theirs:
        bls?.depthPpm == null ? null : `${count.format(bls.depthPpm)} ppm`,
    },
    // Gold 스키마에 열이 아직 없어 늘 빈다. 0으로 바꾸지 않는다.
    { label: "SDE", mine: null, theirs: plain(bls?.sde) },
    { label: "SNR", mine: null, theirs: plain(bls?.snr) },
  ].filter((row) => row.mine !== null || row.theirs !== null);
  return rows;
}

function Comparison({
  explanation,
  other,
}: {
  explanation: ResultExplanation;
  other: Counterpart;
}) {
  const { correction } = explanation;
  const rows = comparisonRows(explanation, other);
  if (rows.length === 0) return null;

  return (
    <section className="result-compare" data-testid="result-compare">
      <table>
        <caption>내가 낸 것{other ? ` · ${other.label}` : ""}</caption>
        <thead>
          <tr>
            <th scope="col">항목</th>
            <th scope="col">내가 낸 것</th>
            {other && <th scope="col">{other.label}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              {/* 없는 값은 빈 칸이 아니라 없음 표시다. 0으로 바꾸지 않는다. */}
              <td>{row.mine ?? <span className="result-none">—</span>}</td>
              {other && (
                <td>{row.theirs ?? <span className="result-none">—</span>}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {correction && (
        <p className="submission-note">
          두 주기는 배수 관계입니다. 정정 주기 = 고른 주기 ×{" "}
          {decimal.format(correction.multiplier)} ={" "}
          {decimal.format(correction.correctedPeriodDays)}일
          {correction.reason ? ` · ${correction.reason}` : ""}
        </p>
      )}
    </section>
  );
}

export function ResultExplanationView({
  receipt,
  detail,
  staleBundle = false,
  celebrate = false,
}: {
  receipt: SubmissionReceipt;
  /**
   * 상세 보기의 상태. **미매칭이면 신호를 여기서만 알 수 있다.** 열기
   * 전에는 표가 한 칸이고, 열면 그 값이 오른쪽 칸을 채운다.
   */
  detail: DetailState;
  /** 접수 뒤 판이 바뀌었는가. 최신이 필요한 축에만 표시를 붙인다. */
  staleBundle?: boolean;
  /**
   * 성과 연출을 보여 줄 차례인가. 이 회원이 이 `submissionId`를 처음 볼
   * 때만 참이며, 201인지 200인지로 가르지 않는다(2.2절).
   */
  celebrate?: boolean;
}) {
  const { explanation, progress } = receipt;
  const { signal, evaluation, achievement, publication, statistics } =
    explanation;
  // 접수 응답이 신호를 줬으면 그것이 정본이다. 상세는 같은 신호를 다시
  // 말할 뿐이라 수치를 두 번 싣지 않는다.
  const other: Counterpart = signal
    ? { bls: signal.bls, label: "기록의 신호" }
    : detail.phase === "shown"
      ? { bls: detail.view.signal.bls, label: "이 단계의 신호" }
      : null;
  return (
    <div
      className={
        // 표가 없으면 왼쪽 칸을 비워 두지 않는다. 빈 칸을 남기면 값이
        // 빠진 것처럼 보인다.
        comparisonRows(explanation, other).length === 0
          ? "submission-result submission-result-plain"
          : "submission-result"
      }
    >
      <Comparison explanation={explanation} other={other} />
      <div className="result-bands">
        <section className="result-axis">
          <h5>매칭</h5>
          <Matched receipt={receipt} explanation={explanation} />
        </section>

        {/* 채점 대상이 아니면 줄을 만들지 않는다. */}
        {evaluation && evaluation !== "NOT_APPLICABLE" && (
          <section className="result-axis">
            <h5>내 판단</h5>
            <p>{EVALUATION[evaluation]}</p>
          </section>
        )}

        {/* 성과 판정 자체가 없으면(`none`) 줄을 만들지 않는다. */}
        {achievement.result !== "none" && (
          <section className="result-axis" data-testid="achievement">
            <h5>성과</h5>
            <p>{ACHIEVEMENT[achievement.result]}</p>
            {/*
            이 별의 누적 성과. 와이어프레임 SC-04가 「이 별 성과 2건(등급 S)」로
            함께 보여 준다. 0건이면 등급이 없으므로 줄을 만들지 않는다.
          */}
            {achievement.star.count > 0 && (
              <p>
                이 별 성과 {count.format(achievement.star.count)}건
                {achievement.star.grade
                  ? ` · 등급 ${achievement.star.grade}`
                  : ""}
              </p>
            )}
            {achievement.unlockedTicIds.length > 0 && (
              <p>
                새로 열린 별 {count.format(achievement.unlockedTicIds.length)}개
                · TIC {achievement.unlockedTicIds.join(", ")}
              </p>
            )}
            {/*
            연출은 이 회원이 이 제출을 처음 볼 때만이다(2.2절). 재현 응답에도
            당시 값이 그대로 실리므로 사실은 언제나 보여 주고, 축하만 가린다.
          */}
            {celebrate && <p className="result-celebrate">축하합니다!</p>}
          </section>
        )}

        <section className="result-axis">
          <h5>이 별의 탐색</h5>
          {progress.stage === "completed" ? (
            <p>
              탐색을 마쳤습니다.
              {progress.completionReason
                ? ` ${COMPLETION[progress.completionReason]}`
                : ""}
            </p>
          ) : (
            <p>
              남은 탐색 가능 신호{" "}
              {count.format(progress.remainingDiscoverableCount)}개
            </p>
          )}
        </section>

        {/* 공개는 할 수 있을 때만 알린다. 게시 화면으로 끌고 가지 않는다(AT-36). */}
        {publication.state === "UNPUBLISHED" && (
          <section className="result-axis">
            <h5>공개</h5>
            <p>이 분석은 공개할 수 있습니다.</p>
          </section>
        )}

        {signal && <Ai signal={signal} />}

        {signal && signal.external.length > 0 && (
          <section className="result-axis">
            <h5>외부 자료</h5>
            <ul>
              {signal.external.map((item) => (
                <li key={`${item.source}:${item.externalId}`}>
                  {/* 원천 표기를 그대로 둔다. 우리 판정으로 번역하지 않는다. */}
                  {item.source} {item.externalId} · {item.disposition} ·{" "}
                  <time dateTime={item.fetchedOn}>{item.fetchedOn}</time> 조회
                </li>
              ))}
            </ul>
          </section>
        )}

        {statistics && <Statistics value={statistics} />}
      </div>
      <StaleBand stale={staleBundle} />
    </div>
  );
}

/**
 * 상세 보기(6.7절). **누르면 열람 기록이 남는다.** 그 기록이 튜토리얼
 * 건너뛰기 조건에 쓰이므로 화면을 열 때 자동으로 부르지 않는다.
 */
export type DetailState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "shown"; view: DetailViewData }
  | { phase: "unavailable"; message: string };

export function DetailView({
  receipt,
  detail,
  onView,
  onSkip,
}: {
  receipt: SubmissionReceipt;
  detail: DetailState;
  onView: (submissionId: string) => void;
  onSkip?: () => void;
}) {
  if (!receipt.explanation.detail.available && detail.phase === "idle")
    return null;
  if (detail.phase === "idle")
    return (
      // 안내는 왼쪽, 누르는 것은 오른쪽이다. 아래로 쌓으면 판의 오른쪽이
      // 비고 그만큼 세로가 길어진다.
      <section className="result-axis result-detail">
        <div>
          <h5>상세 보기</h5>
          <p>
            {receipt.explanation.detail.targetKind === "CURRENT_CURVE_HINT"
              ? "이 단계에서 찾을 수 있었던 신호를 볼 수 있습니다."
              : "이 신호가 무엇이었는지 볼 수 있습니다."}
          </p>
        </div>
        {/*
          누르면 열람 기록이 남는다. 대신 눌러 주지 않는다.
          대상이 다르면 이름도 다르다(와이어프레임 SC-04). 매칭 뒤에는 방금
          맞힌 신호를, 미매칭에는 그 단계에서 찾을 수 있었던 신호를 본다.
        */}
        <button type="button" onClick={() => onView(receipt.submissionId)}>
          {receipt.explanation.detail.targetKind === "CURRENT_CURVE_HINT"
            ? "상세 보기"
            : "이 신호 상세 보기"}
        </button>
      </section>
    );
  if (detail.phase === "loading")
    return (
      <section className="result-axis">
        <h5>상세 보기</h5>
        <p role="status">상세를 불러오고 있습니다.</p>
      </section>
    );
  if (detail.phase === "unavailable")
    return (
      <section className="result-axis">
        <h5>상세 보기</h5>
        <p role="alert">{detail.message}</p>
      </section>
    );

  const { view } = detail;
  return (
    <section className="result-axis">
      <h5>
        {view.targetKind === "CURRENT_MATCH"
          ? "이 신호는"
          : "이 단계에서 찾을 수 있었던 신호"}
      </h5>
      {/* 미확정 후보에는 「정답」이라는 표현을 쓰지 않는다. */}
      <p>{view.signal.explanation}</p>
      {/* 수치는 비교표가 들고 있다. 같은 값을 두 곳에 두면 판만 길어지고,
          내가 낸 값 옆에 있어야 견줄 수 있다. */}
      {view.userJudgmentAgrees !== null && (
        <p>
          {view.userJudgmentAgrees
            ? "내 판단과 같습니다."
            : "내 판단과 다릅니다."}
        </p>
      )}
      {view.tutorial.skipAvailable && onSkip && (
        <p>
          <button type="button" onClick={onSkip}>
            다음 튜토리얼로
          </button>
        </p>
      )}
    </section>
  );
}

/**
 * 다음 행동(6.4절 `nextActions`). **서버 힌트**이므로 조건을 다시 계산하지
 * 않고 받은 목록만 내놓는다. 실행하면 서버가 다시 검증한다.
 *
 * 게시 화면으로 강제로 옮기지 않는다(AT-36). 모두 사용자가 고르는 선택지다.
 *
 * 목적지가 아직 없는 화면은 앱의 「연결 준비 중」 규약이 받아 준다. 이 티켓이
 * 목적지를 지어내지 않고, 각 화면 담당이 채우면 그대로 이어진다.
 */
export function NextActions({
  receipt,
  returnTo,
  from,
  onNextCurve,
}: {
  receipt: SubmissionReceipt;
  /**
   * [다음 곡선 단계로]를 누르면 할 일. **같은 화면에서** 일어나므로 링크가
   * 아니다(SRS 3.2 흐름). 없으면 버튼을 비활성으로 둔다.
   */
  onNextCurve?: () => void;
  /** 분석에 들어오기 전 화면. 분석을 끝내고 나갈 때 쓴다. */
  returnTo: string;
  /**
   * 지금 화면. 앞으로 가는 링크에 실어 보내 거기서 「이전 화면으로」가 분석
   * 화면으로 돌아오게 한다. 돌아와도 결과는 다시 열리지 않는다. 결과가 남는
   * 경로(`submissionResult`)는 아직 연결 전이라 그 화면 담당이 채워야 한다.
   */
  from: string;
}) {
  const { ticId, historyId, nextActions } = receipt;
  const offered = new Set(nextActions);

  const links: Partial<Record<NextAction, { label: string; to: string }>> = {
    PUBLISH_ANALYSIS: {
      label: "공개 내용 검토",
      to: pagePath("publication", { historyId }, { returnTo: from }),
    },
    VIEW_RESULT: {
      label: "결과 보기",
      to: pagePath("starResults", { ticId }, { returnTo: from }),
    },
    /**
     * 6.4절: 같은 TIC·`DISCUSSION`·현재 본인 `historyId`를 가진 **작성
     * 초안을 연다**(COM-10). 별 게시판 목록으로 보내는 것이 아니다.
     *
     * `historyId`는 아직 글쓰기 화면이 읽지 않는다. 첨부까지 이으려면
     * 커뮤니티 쪽(하서진) 조율이 필요해 미결로 남겼다.
     */
    DISCUSS: {
      label: "일반 토론 쓰기",
      to:
        pagePath("postCreate", {}, { ticId, historyId, returnTo: from }) +
        "&purposeTag=DISCUSSION",
    },
    LATER: { label: "나중에 하기", to: returnTo },
    GO_HOME: { label: "별지도로", to: "/sky" },
  };
  // 분석 화면 안에서 일어나는 동작이라 옮겨 갈 곳이 없다. 각자 다른 티켓이다.
  // 아직 연결되지 않은 화면 안 동작. `NEXT_CURVE`는 이제 실제 버튼이다.
  const inScreen: Partial<Record<NextAction, string>> = {
    RETRY: "다시 풀기",
  };
  /**
   * 그리는 순서는 화면이 정한다. 서버의 목록은 순위가 아니라 가능한 행동의
   * 집합이고(6.4절), 파서도 이미 한 번 정규화한다. 하던 일을 이어가는 쪽을
   * 먼저, 이 화면을 떠나는 쪽을 마지막에 둔다.
   *
   * `VIEW_DETAIL`·`SKIP_TUTORIAL`은 상세 보기 절이 이미 버튼으로 내놓으므로
   * 여기 없다. 두 번 내면 같은 일에 버튼이 두 개가 된다.
   */
  const order = [
    "RETRY",
    "NEXT_CURVE",
    "PUBLISH_ANALYSIS",
    "VIEW_RESULT",
    "DISCUSS",
    "LATER",
    "GO_HOME",
  ] as const;
  const shown = order.filter((action) => offered.has(action));
  if (shown.length === 0) return null;

  /*
    닫기와 같은 구역에 둔다. 「다음에 할 수 있는 일」이라는 이름표는 두지
    않는다 — 바닥 줄에 있는 것이 이미 그 뜻이고, 이름표가 있으면 결과의 한
    축처럼 읽혀 사실과 선택지의 경계가 흐려진다.

    떠나는 링크는 왼쪽, 이 화면에서 계속하는 동작은 오른쪽 닫기 옆에 둔다.
    누르면 화면이 바뀌는 것과 여기 남는 것은 무게가 다르다.
  */
  return (
    <div className="result-actions" data-testid="next-actions">
      <ul className="result-actions-links">
        {shown
          .filter((action) => links[action])
          .map((action) => (
            <li key={action}>
              <Link to={links[action]!.to}>{links[action]!.label}</Link>
            </li>
          ))}
      </ul>
      <ul className="result-actions-here">
        {shown
          .filter((action) => !links[action])
          .map((action) => (
            <li key={action}>
              {action === "NEXT_CURVE" ? (
                // 같은 화면에서 일어나므로 링크가 아니다(SRS 3.2 흐름).
                // 할 일이 없으면 비활성으로 둔다.
                <button
                  type="button"
                  onClick={onNextCurve}
                  disabled={!onNextCurve}
                >
                  다음 곡선 단계로
                </button>
              ) : (
                // 목적지가 아직 없다. 있는 척하지 않는다.
                <span className="submission-note">
                  {inScreen[action]} · 연결 예정
                </span>
              )}
            </li>
          ))}
      </ul>
    </div>
  );
}
