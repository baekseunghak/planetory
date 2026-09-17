import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../../api";
import { pagePath } from "../../app/paths";
import type { SkySceneProps } from "../sky-data/SkyDataPage";
import { GalaxyScene, type SceneControl } from "./GalaxyScene";
import { type GalaxyCamera } from "./model";
import {
  DetailVersionChanged,
  readStarDetail,
  detailStar,
  type StarDetail,
} from "./detail";
import { starLabel } from "./interaction";

const progressLabel = {
  unexplored: "미탐사",
  in_progress: "탐색 중",
  completed: "탐색 완료",
};
const actionLabel = {
  start: "분석 시작",
  continue: "이어서 분석",
  review: "분석 다시 보기",
};
const reasonLabel: Record<string, string> = {
  initial: "첫 방문",
  tutorial: "튜토리얼",
  achievement: "탐사 성과",
  challenge: "챌린지",
};
const info = (value: number | null, unit = "") =>
  value === null ? "정보 없음" : `${value}${unit}`;

export function PersonalGalaxyScene(props: SkySceneProps) {
  const { data, store } = props,
    ticId = data.selectedTicId,
    meta = data.meta!;
  const navigate = useNavigate();
  const [result, setResult] = useState<{
    ticId: string;
    version: string;
    detail?: StarDetail;
    error?: Error;
  } | null>(null);
  const [retry, setRetry] = useState(0),
    [planet, setPlanet] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [listOpen, setListOpen] = useState(false),
    [page, setPage] = useState(0),
    [sceneReady, setSceneReady] = useState(false);
  const control = useRef<SceneControl | null>(null),
    savedCamera = useRef<GalaxyCamera | null>(null);
  const previousSelection = useRef<string | null>(null),
    focused = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null),
    launcher = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement>(null),
    planetInfoRef = useRef<HTMLDivElement>(null);
  const listLauncher = useRef<string | null>(null);
  const refreshedVersions = useRef(new Set<string>());
  const current = useRef(data);
  current.current = data;
  const onReady = useCallback((value: SceneControl | null) => {
    control.current = value;
    setSceneReady(!!value?.getCamera());
  }, []);
  // Key the whole owner by memberId. Abort plus scope checks protect rapid star/account changes.
  useEffect(() => {
    setResult(null);
    setPlanet(null);
    if (!ticId || data.needsRefresh) return;
    const controller = new AbortController();
    void api<unknown>(`/v1/me/stars/${encodeURIComponent(ticId)}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (controller.signal.aborted) return;
        const detail = readStarDetail(
          value,
          meta,
          ticId,
          current.current.stars.find((s) => s.ticId === ticId),
        );
        setResult({ ticId, version: meta.version, detail });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (
          error instanceof DetailVersionChanged &&
          !refreshedVersions.current.has(meta.version)
        ) {
          refreshedVersions.current.add(meta.version);
          void store.refresh();
        }
        setResult({
          ticId,
          version: meta.version,
          error:
            error instanceof Error
              ? error
              : new Error("별 정보를 불러오지 못했습니다."),
        });
      });
    return () => controller.abort();
  }, [store, ticId, meta, data.needsRefresh, retry]);
  const scoped =
    result?.ticId === ticId &&
    result.version === meta.version &&
    !data.needsRefresh
      ? result
      : null;
  const detail = scoped?.detail ?? null;
  const selectedPlanet =
    detail?.system.items.find((p) => p.candidateId === planet) ?? null;
  useEffect(() => {
    if (!selectedPlanet || !panelRef.current || !planetInfoRef.current) return;
    const panel = panelRef.current,
      info = planetInfoRef.current;
    panel.scrollTop += Math.max(
      0,
      info.getBoundingClientRect().bottom -
        panel.getBoundingClientRect().bottom +
        20,
    );
  }, [selectedPlanet]);
  useEffect(() => {
    if (ticId && !previousSelection.current) {
      savedCamera.current = control.current?.getCamera() ?? null;
      launcher.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    if (!ticId && previousSelection.current) {
      if (savedCamera.current) control.current?.setCamera(savedCamera.current);
      savedCamera.current = null;
      const target = launcher.current?.isConnected
        ? launcher.current
        : document.querySelector<HTMLCanvasElement>(".galaxy-scene canvas");
      target?.focus({ preventScroll: true });
    }
    if (previousSelection.current !== ticId) {
      focused.current = null;
      setPlanet(null);
    }
    previousSelection.current = ticId;
  }, [ticId]);
  useEffect(() => {
    if (ticId || !listLauncher.current) return;
    const target = document.querySelector<HTMLButtonElement>(
      `.accessible-stars button[data-tic-id="${CSS.escape(listLauncher.current)}"]`,
    );
    if (target) {
      target.focus({ preventScroll: true });
      listLauncher.current = null;
    }
  }, [ticId, data.stars]);
  useEffect(() => {
    if (!detail || !sceneReady) return;
    const key = detail.system.ticId;
    if (focused.current !== key) {
      if (!savedCamera.current)
        savedCamera.current = control.current?.getCamera() ?? null;
      control.current?.focusStar(detail.system.position);
      focused.current = key;
      if (panelRef.current) panelRef.current.scrollTop = 0;
      heading.current?.focus({ preventScroll: true });
    }
  }, [detail, sceneReady]);
  const close = () => {
    store.select(null);
    // Also retire a deep-link selection so later search changes cannot resurrect it.
    navigate("/sky", { replace: true });
  };
  const selectPlanet = useCallback((id: string | null) => setPlanet(id), []);
  const retryDetail = () => {
    refreshedVersions.current.delete(meta.version);
    setRetry((n) => n + 1);
  };
  const returnTo = `/sky?${new URLSearchParams({ star: ticId ?? "" })}`;
  const listed = listOpen
    ? data.stars.filter((s) => s.ticId.includes(filter.trim()))
    : [];
  const lastPage = Math.max(0, Math.ceil(listed.length / 50) - 1),
    activePage = Math.min(page, lastPage);
  return (
    <>
      <div className={`personal-galaxy${ticId ? " has-detail" : ""}`}>
        <GalaxyScene
          {...props}
          onReady={onReady}
          personalSystem={detail?.system ?? null}
          selectedStar={detail ? detailStar(detail) : null}
          focusedPlanet={selectedPlanet?.candidateId ?? null}
          onPlanetSelect={selectPlanet}
          onDeselect={close}
        />
        {ticId && (
          <aside
            ref={panelRef}
            className="star-detail"
            aria-label="별 상세"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
            }}
          >
            <button className="detail-return" onClick={close}>
              ← 은하로 돌아가기
            </button>
            <p className="eyebrow">YOUR DISCOVERY</p>
            <h2 ref={heading} tabIndex={-1}>
              TIC {ticId}
            </h2>
            {!detail && !scoped?.error && (
              <p role="status">별과 내 행성 정보를 불러오고 있습니다.</p>
            )}
            {scoped?.error && (
              <div role="alert">
                <p>
                  {scoped.error instanceof ApiError &&
                  scoped.error.code === "STAR_LOCKED"
                    ? "아직 발견하지 않은 별이에요. 먼저 튜토리얼과 탐사를 진행해 주세요."
                    : scoped.error.message}
                </p>
                <button onClick={retryDetail}>별 정보 다시 불러오기</button>
              </div>
            )}
            {detail && (
              <>
                <p className="detail-progress">
                  {progressLabel[detail.progress.stage]}
                  {detail.progress.reopenPending ? " · 새 관측 자료 대기" : ""}
                </p>
                <p>
                  <strong>내 행성 {detail.system.items.length}개</strong>{" "}
                  <span className="detail-muted">
                    {" "}
                    · 인정된 성과 {detail.achievement.count}건
                    {detail.achievement.grade
                      ? ` (${detail.achievement.grade})`
                      : ""}
                  </span>
                </p>
                <div className="detail-actions">
                  <Link
                    className="detail-primary"
                    to={pagePath("analysis", { ticId }, { returnTo })}
                  >
                    {actionLabel[detail.actions.analysis]} ↗
                  </Link>
                  {detail.actions.resultAvailable ? (
                    <Link to={pagePath("starResults", { ticId }, { returnTo })}>
                      분석 결과 보기
                    </Link>
                  ) : (
                    <button disabled aria-describedby="result-locked">
                      분석 결과 보기
                    </button>
                  )}
                  {detail.actions.boardOpen ? (
                    <Link to={pagePath("starBoard", { ticId }, { returnTo })}>
                      별 게시판 · 공식 신호 스레드 {detail.actions.threadCount}
                      개
                    </Link>
                  ) : (
                    <button disabled>별 게시판 잠김</button>
                  )}
                </div>
                {!detail.actions.resultAvailable && (
                  <p id="result-locked" className="detail-muted">
                    분석을 제출하면 결과를 볼 수 있어요.
                  </p>
                )}
                <section aria-labelledby="owned-planets-title">
                  <h3 id="owned-planets-title">내가 찾은 행성</h3>
                  <button
                    onClick={() => {
                      setPlanet(null);
                      control.current?.focusStar(detail.system.position);
                    }}
                  >
                    별 전체 보기
                  </button>
                  {!detail.system.items.length ? (
                    <p>아직 표시할 내 행성이 없어요</p>
                  ) : (
                    <ul className="planet-list" aria-label="내 행성 목록">
                      {detail.system.items.map((p, i) => (
                        <li key={p.candidateId}>
                          <button
                            aria-pressed={
                              selectedPlanet?.candidateId === p.candidateId
                            }
                            onClick={() => setPlanet(p.candidateId)}
                          >
                            <span>행성 {i + 1}</span>
                            <small>{p.candidateId}</small>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {detail.completedWithoutPlanets && (
                    <p className="detail-muted">
                      이 별의 탐색을 완료했어요. 실제 행성이 없다는 의미는
                      아닙니다.
                    </p>
                  )}
                  {selectedPlanet && (
                    <div
                      ref={planetInfoRef}
                      className="planet-information"
                      aria-live="polite"
                    >
                      <h3>{selectedPlanet.candidateId}</h3>
                      <p>
                        {selectedPlanet.kind === "confirmed"
                          ? "확인된 행성"
                          : "아직 확인되지 않은 후보"}
                      </p>
                      <dl>
                        <dt>반복 주기</dt>
                        <dd>{info(selectedPlanet.periodDays, "일")}</dd>
                        <dt>어두워진 정도</dt>
                        <dd>
                          {selectedPlanet.depthPpm === null
                            ? "정보 없음"
                            : `${selectedPlanet.depthPpm} ppm (${selectedPlanet.depthPpm / 10000}%)`}
                        </dd>
                      </dl>
                    </div>
                  )}
                  <p className="detail-muted">
                    표면과 궤도는 이해를 돕기 위한 시각화입니다.
                  </p>
                </section>
                <details className="star-observations">
                  <summary>관측·발견 정보</summary>
                  <dl>
                    <dt>관측 회차</dt>
                    <dd>
                      {detail.star.sectorCount}회 ·{" "}
                      {detail.star.sectors
                        .map((s) => `Sector ${s}`)
                        .join(", ") || "정보 없음"}
                    </dd>
                    <dt>밝기 (TESS 등급)</dt>
                    <dd>{info(detail.star.tmag)}</dd>
                    <dt>유효 온도</dt>
                    <dd>{info(detail.star.teffK, " K")}</dd>
                    <dt>반지름 (태양=1)</dt>
                    <dd>{info(detail.star.radiusRsun)}</dd>
                    <dt>발견 계기</dt>
                    <dd>
                      {reasonLabel[detail.unlock.reason] ??
                        detail.unlock.reason}
                    </dd>
                    <dt>발견 시각</dt>
                    <dd>
                      {Number.isFinite(Date.parse(detail.unlock.unlockedAt))
                        ? new Date(detail.unlock.unlockedAt).toLocaleString(
                            "ko-KR",
                          )
                        : "정보 없음"}
                    </dd>
                    <dt>현재 곡선 단계</dt>
                    <dd>{info(detail.progress.currentCurveStep)}</dd>
                  </dl>
                </details>
              </>
            )}
          </aside>
        )}
      </div>
      <details
        className="accessible-stars"
        onToggle={(e) => setListOpen(e.currentTarget.open)}
      >
        <summary>별 목록으로 선택하기</summary>
        <label>
          적재된 별의 TIC 검색{" "}
          <input
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <p>
          현재 적재된 {data.loadedCount}개 별입니다. 지도 표시가 어려워도
          목록으로 선택할 수 있어요.
        </p>
        <ul>
          {listed.slice(activePage * 50, (activePage + 1) * 50).map((s) => (
            <li key={s.ticId}>
              <button
                data-tic-id={s.ticId}
                disabled={data.needsRefresh}
                onClick={() => {
                  listLauncher.current = s.ticId;
                  store.select(s.ticId);
                }}
              >
                {starLabel(s)}
              </button>
            </li>
          ))}
        </ul>
        <p>
          {listed.length}개 중 {activePage + 1} / {lastPage + 1}페이지
        </p>
        <button
          disabled={activePage === 0}
          onClick={() => setPage(activePage - 1)}
        >
          이전 별 목록
        </button>
        <button
          disabled={activePage === lastPage}
          onClick={() => setPage(activePage + 1)}
        >
          다음 별 목록
        </button>
      </details>
    </>
  );
}
