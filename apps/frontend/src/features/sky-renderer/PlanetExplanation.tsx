import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import {
  DetailVersionChanged,
  readPlanetExplanations,
  type PlanetExplanation,
  type StarDetail,
} from "./detail";

type State = {
  item: PlanetExplanation | null;
  error: Error | null;
  loading: boolean;
};
const empty: State = { item: null, error: null, loading: false };
const date = (value: string) => new Date(value).toLocaleString("ko-KR");
const measured = (
  value: NonNullable<NonNullable<PlanetExplanation["facts"]>["radius"]>,
  unit: string,
) => {
  if (value.value === null) return "정보 없음";
  const amount = `${value.value}${unit}`;
  return value.limit === -1
    ? `${amount} 미만`
    : value.limit === 1
      ? `${amount} 초과`
      : value.limit === null
        ? `자료에 ${amount}로 기록`
        : amount;
};
const missingMessage = (item: PlanetExplanation) => {
  if (item.status === "not_requested")
    return item.sourceStatus === "not_requested"
      ? "아직 요청한 NASA 행성 자료가 없습니다."
      : "아직 요청한 쉬운 설명이 없습니다.";
  if (item.status === "pending" || item.sourceStatus === "refreshing")
    return "자료를 준비하고 있습니다. 잠시 뒤 다시 확인합니다.";
  if (item.status === "disabled")
    return "현재 쉬운 설명 요청이 중지돼 있습니다.";
  if (item.status === "failed")
    return item.facts
      ? "NASA 자료는 유지되지만 쉬운 설명을 만들지 못했습니다."
      : "쉬운 설명을 만들지 못했습니다.";
  if (item.status === "busy") return "요청이 많아 잠시 기다려야 합니다.";
  if (item.status === "quota_exceeded")
    return "현재 쉬운 설명 요청 한도에 도달했습니다.";
  if (item.sourceStatus === "not_eligible")
    return "이 후보는 현재 NASA 설명 대상이 아닙니다. 별 정보를 다시 확인해 주세요.";
  if (item.sourceStatus === "not_found")
    return "NASA의 현재 기본 자료에서 연결된 행성을 찾지 못했습니다. 실제 행성이 없다는 뜻은 아닙니다.";
  if (item.sourceStatus === "identity_unresolved")
    return "NASA 행성과 이 후보의 연결을 확인해야 합니다.";
  if (
    item.sourceStatus === "temporarily_unavailable" &&
    item.refreshStatus === "disabled"
  )
    return "현재 NASA 자료 조회가 운영 설정으로 중지돼 있습니다. 나중에 상태를 다시 확인해 주세요.";
  if (item.sourceStatus === "temporarily_unavailable")
    return "일시적으로 NASA 자료를 확인하지 못했습니다. 잠시 뒤 다시 요청해 주세요.";
  if (item.status === "source_changed")
    return "원천 자료가 바뀌어 설명을 다시 확인해야 합니다.";
  return "설명을 표시할 수 없습니다. 상태를 다시 확인해 주세요.";
};

export function PlanetExplanationPanel({
  detail,
  candidateId,
  refreshDetail,
}: {
  detail: StarDetail;
  candidateId: string;
  refreshDetail(): void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>(empty);
  const [quotaUntil, setQuotaUntil] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const path = `/v1/me/stars/${encodeURIComponent(detail.system.ticId)}/planet-explanations`;
  const readItem = (value: unknown) =>
    readPlanetExplanations(value, detail).find(
      (item) => item.candidateId === candidateId,
    )!;

  const read = async () => {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setState((previous) => ({ ...previous, error: null, loading: true }));
    try {
      const item = readItem(
        await api<unknown>(path, { signal: controller.signal }),
      );
      if (!controller.signal.aborted) {
        if (item.status === "ready") setQuotaUntil(null);
        setState({ item, error: null, loading: false });
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setState({
          item: null,
          error:
            error instanceof Error
              ? error
              : new Error("설명 상태를 확인하지 못했습니다."),
          loading: false,
        });
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  };

  const request = async () => {
    if (inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setState((previous) => ({ ...previous, error: null, loading: true }));
    try {
      const value = await api<unknown>(path, {
        method: "POST",
        json: { candidateId },
        timeoutMs: 30000,
        signal: controller.signal,
      });
      const item = readItem(value);
      if (!controller.signal.aborted) {
        setQuotaUntil(item.status === "quota_exceeded" ? item.retryAt : null);
        setState({ item, error: null, loading: false });
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.outcomeUnknown) {
        try {
          const item = readItem(
            await api<unknown>(path, { signal: controller.signal }),
          );
          if (!controller.signal.aborted) {
            if (item.status === "quota_exceeded") setQuotaUntil(item.retryAt);
            setState({ item, error: null, loading: false });
          }
        } catch (readError) {
          if (!controller.signal.aborted)
            setState({
              item: null,
              error:
                readError instanceof Error
                  ? readError
                  : new Error("요청 결과를 확인하지 못했습니다."),
              loading: false,
            });
        }
      } else {
        setState({
          item: null,
          error:
            error instanceof Error
              ? error
              : new Error("설명을 요청하지 못했습니다."),
          loading: false,
        });
      }
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  };

  useEffect(() => () => inFlight.current?.abort(), []);
  useEffect(() => {
    if (
      !open ||
      (state.item?.status !== "pending" &&
        state.item?.sourceStatus !== "refreshing") ||
      state.loading
    )
      return;
    const timer = setTimeout(() => void read(), 3000);
    return () => clearTimeout(timer);
  }, [open, state.item, state.loading]);

  const item = state.item;
  const retryReady = !item?.retryAt || Date.parse(item.retryAt) <= Date.now();
  const sourceNeedsRecheck =
    item?.status === "source_unavailable" &&
    ["not_found", "identity_unresolved"].includes(item.sourceStatus ?? "");
  const sourceDisabled =
    item?.status === "source_unavailable" &&
    item.sourceStatus === "temporarily_unavailable" &&
    item.refreshStatus === "disabled";
  const canRequest =
    !sourceDisabled &&
    (!quotaUntil || Date.parse(quotaUntil) <= Date.now()) &&
    (item?.status === "not_requested" ||
      item?.status === "busy" ||
      item?.status === "source_changed" ||
      (item?.status === "quota_exceeded" && retryReady) ||
      (item?.status === "failed" && item.retryAt !== null && retryReady) ||
      (item?.status === "source_unavailable" &&
        [
          "not_found",
          "identity_unresolved",
          "temporarily_unavailable",
        ].includes(item.sourceStatus ?? "")));
  const needsDetail =
    state.error instanceof DetailVersionChanged ||
    (state.error instanceof ApiError &&
      ["STAR_LOCKED", "RESOURCE_NOT_FOUND"].includes(state.error.code));
  return (
    <section className="planet-explanation" aria-label="NASA 행성 자료">
      <button
        aria-expanded={open}
        onClick={() => {
          if (open) {
            inFlight.current?.abort();
            inFlight.current = null;
            setOpen(false);
            setState(empty);
          } else {
            setOpen(true);
            void read();
          }
        }}
      >
        NASA 행성 자료 {open ? "닫기" : "보기"}
      </button>
      {open && (
        <div className="planet-explanation-content">
          {state.loading && (
            <p role="status">NASA 행성 자료를 확인하고 있습니다.</p>
          )}
          {state.error && (
            <div role="alert">
              <p>
                {state.error instanceof DetailVersionChanged
                  ? state.error.message
                  : needsDetail
                    ? "별 접근 권한이 변경됐어요. 별 정보를 다시 확인해 주세요."
                    : "행성 자료를 불러오지 못했습니다."}
              </p>
              <button onClick={needsDetail ? refreshDetail : () => void read()}>
                {needsDetail ? "별 정보 다시 불러오기" : "상태 다시 확인"}
              </button>
            </div>
          )}
          {item && (
            <>
              {item.facts && (
                <>
                  <h4>{item.facts.planetName}</h4>
                  <dl aria-label="NASA 행성 주요 수치">
                    <dt>공전 주기</dt>
                    <dd>
                      {item.facts.orbitalPeriod
                        ? measured(item.facts.orbitalPeriod, "일")
                        : "정보 없음"}
                    </dd>
                    <dt>반지름</dt>
                    <dd>
                      {item.facts.radius
                        ? measured(item.facts.radius, " 지구 반지름")
                        : "정보 없음"}
                    </dd>
                    <dt>질량</dt>
                    <dd>
                      {item.facts.mass
                        ? measured(item.facts.mass, " 지구 질량")
                        : "정보 없음"}
                    </dd>
                    <dt>발견 방법</dt>
                    <dd>{item.facts.discoveryMethod ?? "정보 없음"}</dd>
                    <dt>발견 연도</dt>
                    <dd>{item.facts.discoveryYear ?? "정보 없음"}</dd>
                  </dl>
                  {item.facts.controversial && (
                    <p>NASA 자료에 분류 논쟁 표시가 있습니다.</p>
                  )}
                  <p>
                    출처:{" "}
                    <a
                      href={item.facts.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      NASA Exoplanet Archive (PS)
                    </a>
                  </p>
                  {item.fetchedAt && (
                    <p>NASA 자료 조회: {date(item.fetchedAt)}</p>
                  )}
                  {item.refreshStatus && item.refreshStatus !== "ok" && (
                    <p>
                      최근 NASA 자료를 다시 확인하지 못했습니다. 위 조회 시각의
                      저장 자료를 표시합니다.
                    </p>
                  )}
                </>
              )}
              {item.content ? (
                <div className="planet-explanation-text">
                  <h4>쉬운 설명</h4>
                  <p>{item.content.name}</p>
                  <p>{item.content.orbitalPeriod}</p>
                  <p>{item.content.radius}</p>
                  <p>{item.content.mass}</p>
                  <p>{item.content.discovery}</p>
                  {item.generatedAt && (
                    <p>설명 생성: {date(item.generatedAt)}</p>
                  )}
                </div>
              ) : (
                <p role="status">{missingMessage(item)}</p>
              )}
              {sourceNeedsRecheck && (
                <p>
                  저장된 NASA 조회 결과가 유효한 동안에는 재확인해도 같은 결과가
                  나올 수 있습니다.
                </p>
              )}
              {item.retryAt && <p>다음 설명 요청 가능: {date(item.retryAt)}</p>}
              {quotaUntil &&
                Date.parse(quotaUntil) > Date.now() &&
                item.retryAt !== quotaUntil && (
                  <p>
                    설명 요청 한도로 {date(quotaUntil)} 이후 다시 요청할 수
                    있습니다.
                  </p>
                )}
              {item.sourceStatus === "not_eligible" && (
                <button onClick={refreshDetail}>별 정보 다시 불러오기</button>
              )}
              {canRequest && (
                <button disabled={state.loading} onClick={() => void request()}>
                  {item.sourceStatus === "not_requested"
                    ? "NASA 자료 요청"
                    : item.status === "not_requested"
                      ? "쉬운 설명 요청"
                      : sourceNeedsRecheck
                        ? "NASA 자료 재확인"
                        : "자료 다시 요청"}
                </button>
              )}
              <button disabled={state.loading} onClick={() => void read()}>
                상태 다시 확인
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
