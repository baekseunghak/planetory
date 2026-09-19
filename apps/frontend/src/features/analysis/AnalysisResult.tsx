import type { SubmissionReceipt } from "./submission-data";
import type {
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
  const { correction, submitted } = explanation;
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
          {/* 내 입력과 정정값을 함께 둔다. 어느 쪽이 내 것인지 분명해야 한다. */}
          <dl className="result-pairs">
            <dt>내가 고른 주기</dt>
            {/* 나눠서 되돌리지 않고 서버가 보존한 원본을 쓴다. */}
            <dd>{decimal.format(submitted?.periodDays ?? 0)}일</dd>
            <dt>신호의 주기</dt>
            <dd>{decimal.format(correction?.correctedPeriodDays ?? 0)}일</dd>
          </dl>
        </>
      );
    case "duplicate":
      return <p>이미 찾은 신호입니다.</p>;
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

function Ai({ signal }: { signal: SubmissionSignal }) {
  const { ai } = signal;
  return (
    <section className="result-axis">
      <h5>AI 판정</h5>
      {ai.status === "completed" ? (
        <p>
          {percent.format(ai.score! * 100)}점 · {ai.verdict}
          {ai.modelVersion ? ` · ${ai.modelVersion}` : ""}
        </p>
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
    </section>
  );
}

/** 접수 결과의 해설. 여섯 축을 독립으로 읽는다. */
export function ResultExplanationView({
  receipt,
}: {
  receipt: SubmissionReceipt;
}) {
  const { explanation, progress } = receipt;
  const { signal, evaluation, achievement, publication, statistics } =
    explanation;
  return (
    <div className="submission-result">
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
        <section className="result-axis">
          <h5>성과</h5>
          <p>{ACHIEVEMENT[achievement.result]}</p>
          {achievement.unlockedTicIds.length > 0 && (
            <p>
              새로 열린 별 {count.format(achievement.unlockedTicIds.length)}개 ·
              TIC {achievement.unlockedTicIds.join(", ")}
            </p>
          )}
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

      {explanation.serverDerived && (
        <section className="result-axis">
          <h5>서버가 계산한 값</h5>
          {/* 제출값 확인의 미리보기가 아니라 서버 산정값이다. */}
          <dl className="result-pairs">
            <dt>기준 시각</dt>
            <dd>{decimal.format(explanation.serverDerived.epochBtjd)} BTJD</dd>
            <dt>가려진 시간</dt>
            <dd>
              {decimal.format(explanation.serverDerived.durationHours)} 시간
            </dd>
          </dl>
        </section>
      )}
    </div>
  );
}
