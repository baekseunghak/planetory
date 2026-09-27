import { useCallback } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { http } from "../../api";
import { pagePath } from "../../app/paths";
import type { ProfileSlotProps } from "../profile/ProfileSlots";
import { More } from "./MyStarsSection";
import {
  myHistoriesPath,
  readMyHistories,
  type MyHistory,
} from "./my-lists-data";
import { usePagedList } from "./use-paged-list";
import { cinemaDateTime, useCinemaWording } from "../../shared/cinema-wording";
import "./my-lists.css";

// #196 내 분석 기록 목록(탐사 API 8.1). 본인에게만 보인다 — 슬롯이 타인에게는
// 이 자리를 렌더하지 않는다.

/**
 * 서버가 받는 `result` 값. **`matched`는 셋을 묶는다**(`matched`
 * ·`matched_harmonic`·`duplicate`). 화면 이름표를 서버 값과 일대일로 두면
 * 어긋나므로 묶음이라는 것을 이름에 드러낸다.
 */
const FILTERS: { value: string; label: string }[] = [
  { value: "", label: "전체" },
  { value: "matched", label: "맞은 신호" },
  { value: "not_matched", label: "못 맞힌 기록" },
  { value: "ambiguous_match", label: "가리지 못한 기록" },
  { value: "none_wrong", label: "더 없음" },
  { value: "skipped", label: "건너뜀" },
];

const MATCH: Record<string, string> = {
  matched: "고른 주기가 신호와 맞았습니다",
  matched_harmonic: "고른 주기의 배수가 맞았습니다",
  duplicate: "이미 찾은 신호였습니다",
  not_matched: "맞는 신호를 찾지 못했습니다",
  ambiguous_match: "어느 신호인지 가리지 못했습니다",
  none_wrong: "더 이상 없음으로 접수",
  skipped: "건너뛴 별",
};
const when = (value: string) => new Date(value).toLocaleString("ko-KR");

// 슬롯이 타인에게 이 자리를 렌더하지 않으므로 여기서 다시 검사하지 않는다.
// 두 곳에서 판단하면 어긋난다.
export function MyHistorySection(_props: ProfileSlotProps) {
  const location = useLocation();
  // **고른 필터를 주소에 둔다.** 상세로 갔다 돌아올 때 returnTo가 이 주소를
  // 그대로 들고 가므로, 지역 상태로 두면 돌아온 화면에서 조건이 사라진다.
  const [params, setParams] = useSearchParams();
  const requested = params.get("result") ?? "";
  const result = FILTERS.some((filter) => filter.value === requested)
    ? requested
    : "";
  const setResult = (next: string) => {
    const copy = new URLSearchParams(params);
    if (next) copy.set("result", next);
    else copy.delete("result");
    setParams(copy, { replace: true });
  };
  const returnTo = location.pathname + location.search;
  const load = useCallback(
    async (cursor: string | null, signal: AbortSignal) =>
      readMyHistories(
        await http.request(myHistoriesPath({ result }, cursor), { signal }),
      ),
    [result],
  );
  // 필터가 key에 들어간다. 바뀌면 쌓아 둔 것과 커서를 버리고 처음부터 읽는다 —
  // 조건이 다른 커서를 보내면 서버가 400으로 거절한다.
  const { state, reload, more } = usePagedList(`histories:${result}`, load);

  return (
    <div className="my-list">
      <div className="my-list-filters" role="group" aria-label="기록 결과 필터">
        {FILTERS.map((filter) => (
          <button
            key={filter.value || "all"}
            type="button"
            aria-pressed={result === filter.value}
            onClick={() => setResult(filter.value)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {state.phase === "loading" && (
        <p role="status">분석 기록을 불러오는 중입니다.</p>
      )}
      {state.phase === "error" && (
        <p role="alert">
          {state.message}{" "}
          <button type="button" onClick={reload}>
            다시 불러오기
          </button>
        </p>
      )}
      {state.phase === "ready" && !state.items.length && (
        <p role="status">
          {result
            ? "이 조건에 맞는 기록이 없습니다."
            : "아직 제출한 기록이 없습니다."}
        </p>
      )}
      {state.phase === "ready" && state.items.length > 0 && (
        <>
          <ul aria-label="내 분석 기록">
            {state.items.map((history) => (
              <HistoryRow
                key={history.historyId}
                history={history}
                returnTo={returnTo}
              />
            ))}
          </ul>
          <More state={state} more={more} label="기록" />
        </>
      )}
    </div>
  );
}

function HistoryRow({
  history,
  returnTo,
}: {
  history: MyHistory;
  returnTo: string;
}) {
  // Cinema app: dates without seconds (src/shared/cinema-wording).
  const cinema = useCinemaWording();
  return (
    <li className="my-list-row">
      <p className="my-list-title">
        TIC {history.ticId} ·{" "}
        <time dateTime={history.submittedAt}>
          {cinema
            ? cinemaDateTime(history.submittedAt)
            : when(history.submittedAt)}
        </time>
      </p>
      <p>
        {history.matchResult
          ? (MATCH[history.matchResult] ?? history.matchResult)
          : "채점 결과가 없습니다"}
      </p>
      <p>{publication(history)}</p>
      {history.isPreviousBundle && (
        <p className="my-list-note">
          지금 판이 아닌 자료 판에서 낸 기록입니다.
        </p>
      )}
      {/*
        상세가 없는 기록에는 링크를 걸지 않는다(8.1절). 눌러서 막다른 길에
        가는 것뿐이다. `snapshotAvailable`과는 독립이라 함께 끄지 않는다.
      */}
      {history.detailAvailable ? (
        <Link
          to={pagePath(
            "historyDetail",
            { historyId: history.historyId },
            { returnTo },
          )}
        >
          기록 상세 보기
        </Link>
      ) : (
        <p role="status">
          최초 응답이 없어 상세를 제공할 수 없는 기록입니다. 목록에서는 그대로
          보입니다.
        </p>
      )}
    </li>
  );
}

/** 공개 상태. 숨김은 공개가 아니고, 성과 인정과도 다른 말이다. */
function publication(history: MyHistory) {
  if (history.publication.isModerationHidden) return "운영이 숨긴 기록입니다.";
  if (history.publication.isPublic) return "공개되어 있습니다.";
  return history.achievementGranted
    ? "성과로 인정되었고 아직 공개하지 않았습니다."
    : "아직 공개하지 않았습니다.";
}
