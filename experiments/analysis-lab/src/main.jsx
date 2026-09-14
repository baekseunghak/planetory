import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import ChartCanvas, { estimateDip, findPeaks } from "./charts.jsx";
import { fineRangeFor, selectionPreview } from "./analysis-state.mjs";
import { PhaseToolbar, PeriodControls } from "./AnalysisControls.jsx";
import "./styles.css";
import "./interactions.css";
import "./background.css";
import "./charts.css";
import "./home-preview.css";

const homePreview =
  new URLSearchParams(window.location.search).get("backdrop") === "home";

function Icon({ name = "scan", size = 18, ...props }) {
  const paths = {
    scan: (
      <>
        <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 12h8M12 8v8" />
      </>
    ),
    expand: (
      <>
        <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
        <path d="M9 9 3 3m12 6 6-6M9 15l-6 6m12-6 6 6" />
      </>
    ),
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    reset: (
      <>
        <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
      </>
    ),
    light: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6m0-10v1" />
      </>
    ),
    wave: <path d="M2 12h4l2-7 4 15 4-13 2 5h4" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}

function Panel({
  id,
  title,
  subtitle,
  className = "",
  children,
  aside,
  onFocus,
}) {
  return (
    <section
      className={`glass-panel ${className}`}
      aria-labelledby={`${id}-title`}
    >
      <span className="corner corner-tl" />
      <span className="corner corner-tr" />
      <span className="corner corner-bl" />
      <span className="corner corner-br" />
      <header className="panel-header">
        <span className="panel-id">{id}</span>
        <div>
          <h2 id={`${id}-title`}>{title}</h2>
          <span className="panel-subtitle">{subtitle}</span>
        </div>
        {aside}
        <button
          className="icon-button panel-expand"
          title={`${title} 크게 보기`}
          aria-label={`${title} 크게 보기`}
          onClick={onFocus}
        >
          <Icon name="expand" size={14} />
        </button>
      </header>
      {children}
    </section>
  );
}

function Modal({ title, children, close, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      className={`modal ${wide ? "modal-wide" : ""}`}
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="modal-head">
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" aria-label="닫기" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function App() {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  const [open, setOpen] = useState(!homePreview),
    [bright, setBright] = useState(false);
  const [period, setPeriod] = useState(5.660333),
    [center, setCenter] = useState(0.5);
  const [range, setRange] = useState([0.47, 0.53]),
    [selected, setSelected] = useState(false);
  const [judgment, setJudgment] = useState(""),
    [memo, setMemo] = useState(""),
    [evidence, setEvidence] = useState([]);
  const [phaseView, setPhaseView] = useState({ zoom: 1, center: 0.5 });
  const [timeView, setTimeView] = useState(null),
    [periodView, setPeriodView] = useState(null);
  const [fineRange, setFineRange] = useState(null);
  const [modal, setModal] = useState(null),
    [stage, setStage] = useState(1);
  const [loadRevision, setLoadRevision] = useState(0);
  const [inputPeriod, setInputPeriod] = useState("5.660333");
  const [periodError, setPeriodError] = useState("");
  const peaks = useMemo(
    () => (data ? findPeaks(data.periodogram) : []),
    [data],
  );
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    fetch("/observations/toi270.json", { signal: abort.signal })
      .then((response) => {
        if (!response.ok) throw Error();
        return response.json();
      })
      .then((next) => {
        if (abort.signal.aborted) return;
        setData(next);
        setPeriod(next.seedPeriod);
        setInputPeriod(next.seedPeriod.toFixed(6));
        const dip = estimateDip(next, next.seedPeriod);
        setCenter(dip);
        setRange([dip - 0.025, dip + 0.025]);
        setFineRange(fineRangeFor(next.periodogram.periods, next.seedPeriod));
        setPhaseView({ zoom: 1, center: dip });
        setTimeView({ zoom: 1, center: (next.time[0] + next.time.at(-1)) / 2 });
        setPeriodView({
          zoom: 1,
          center:
            (Math.log10(next.periodogram.periods[0]) +
              Math.log10(next.periodogram.periods.at(-1))) /
            2,
        });
      })
      .catch((err) => {
        if (err.name !== "AbortError")
          setError("관측 데이터를 불러오지 못했습니다.");
      });
    return () => abort.abort();
  }, [loadRevision]);
  const clearJudgment = () => {
    setJudgment("");
    setEvidence([]);
    setMemo("");
  };
  const updatePeriod = (value, newPeak = false) => {
    if (!data || !Number.isFinite(value) || value <= 0) return;
    if (
      value < data.periodogram.periods[0] ||
      value > data.periodogram.periods.at(-1)
    ) {
      setPeriodError("관측 주기도의 주기 범위 안에서 입력해 주세요.");
      return;
    }
    if (value === period && !newPeak) {
      setInputPeriod(value.toFixed(6));
      setPeriodError("");
      return;
    }
    if (
      !newPeak &&
      (!fineRange ||
        value < fineRange.min - 0.00000051 ||
        value > fineRange.max + 0.00000051)
    ) {
      setPeriodError(
        "미세 조정 범위를 벗어났어요. 반복 주기 그래프에서 다른 봉우리를 선택해 주세요.",
      );
      return;
    }
    if (!newPeak)
      value = Math.max(fineRange.min, Math.min(fineRange.max, value));
    setPeriod(value);
    setInputPeriod(value.toFixed(6));
    setPeriodError("");
    setSelected(false);
    clearJudgment();
    setStage(1);
    const dip = estimateDip(data, value);
    setCenter(dip);
    setRange([dip - 0.025, dip + 0.025]);
    setPhaseView((previous) => ({
      zoom: newPeak ? 1 : previous.zoom,
      center: dip,
    }));
    if (newPeak) {
      setFineRange(fineRangeFor(data.periodogram.periods, value));
    }
  };
  const validPeriod = Boolean(
    data &&
    !periodError &&
    inputPeriod.trim() &&
    Math.abs(Number(inputPeriod) - period) < 0.00000051,
  );
  const selectRange = (value) => {
    if (!data || !validPeriod) return;
    if (
      !value.every(Number.isFinite) ||
      value[1] - value[0] < 0.002 - 1e-10 ||
      value[1] - value[0] >= 1
    )
      return;
    setRange(value);
    setSelected(true);
    clearJudgment();
    setStage(2);
  };
  const chooseJudgment = (value) => {
    setJudgment(value);
    setStage(3);
  };
  const preview = selectionPreview(data, period, range);
  const phaseStart = preview?.start ?? 0,
    phaseEnd = preview?.end ?? 0;
  const epoch = preview?.epoch ?? 0;
  const duration = preview?.durationHours ?? 0;
  const toolbar = (
    <PhaseToolbar
      view={phaseView}
      reset={() => setPhaseView({ zoom: 1, center })}
      disabled={!validPeriod}
    />
  );
  const renderPeriodControls = (prefix) => (
    <PeriodControls
      prefix={prefix}
      data={data}
      period={period}
      inputPeriod={inputPeriod}
      setInputPeriod={setInputPeriod}
      periodError={periodError}
      setPeriodError={setPeriodError}
      fineRange={fineRange}
      updatePeriod={updatePeriod}
      selected={selected}
      range={range}
      validPeriod={validPeriod && !!preview}
      confirm={() => selectRange(range)}
    />
  );
  const toggleControl = (
    <button
      className="outline-button"
      onClick={() => {
        setModal(null);
        setOpen(!open);
      }}
    >
      <Icon name={open ? "scan" : "expand"} size={15} />
      {homePreview ? "홈으로 돌아가기" : open ? "화면 접기" : "분석 시작"}
    </button>
  );
  const appHeader = (
    <header className="topbar">
      <a className="brand" href="./" aria-label="Planetory 분석실">
        <span className="brand-mark">
          <Icon name="scan" size={24} />
        </span>
        PLANETORY
        <span className="brand-divider" />
        <span className="brand-section">ANALYSIS LAB</span>
      </a>
      <div className="top-actions">
        <span className="prototype-tag">
          공간 시안 <i>01</i>
        </span>
        <button
          className="icon-button"
          aria-label="실내 조명 변경"
          aria-pressed={bright}
          onClick={() => setBright(!bright)}
        >
          <Icon name="light" />
        </button>
        <button
          className="icon-button"
          aria-label="시안 및 데이터 안내"
          onClick={() => setModal("about")}
        >
          <Icon name="info" />
        </button>
        <span className="avatar" aria-label="내 분석 공간">
          JW
        </span>
        {homePreview && toggleControl}
      </div>
    </header>
  );
  const targetHeading = (
    <div className="workspace-heading">
      <div>
        <div className="eyebrow">
          <span className="status-dot" /> OBSERVATION WORKSPACE
        </div>
        <h1>
          분석실 <span>/</span> <span className="target-name">TOI-270</span>
        </h1>
        <p>
          TIC 259377017 <span>·</span> TESS 관측 데이터 <span>·</span> 원본 곡선
        </p>
      </div>
      <div className="workspace-actions">
        <span className="connection">
          <span className="status-dot" />
          {data
            ? "관측 데이터 준비됨"
            : error
              ? "불러오기 실패"
              : "관측 데이터 불러오는 중"}
        </span>
        {!homePreview && toggleControl}
      </div>
    </div>
  );
  const analysisSteps = (
    <nav className="stepbar" aria-label="분석 단계">
      {["봉우리 선택", "주기 맞추기", "구간 선택", "판단", "제출값 확인"].map(
        (label, i) => (
          <div
            key={label}
            className={`step ${i === stage ? "current" : i < stage ? "done" : ""}`}
            aria-current={i === stage ? "step" : undefined}
          >
            <span>
              {i < stage ? <Icon name="check" size={11} /> : `0${i + 1}`}
            </span>
            {label}
            {i < 4 && <b />}
          </div>
        ),
      )}
    </nav>
  );
  const plots = {
    phase: (
      <ChartCanvas
        kind="phase"
        data={data}
        period={period}
        center={center}
        range={range}
        selected={selected}
        view={phaseView}
        onViewChange={setPhaseView}
        onRange={validPeriod ? selectRange : undefined}
        ariaLabel="주기로 겹친 실제 밝기 곡선. 드래그 구간 선택, Shift+드래그 이동, 휠 최대 20배 확대, 더블클릭 전체 보기."
      />
    ),
    time: (
      <ChartCanvas
        kind="time"
        data={data}
        period={period}
        view={timeView}
        onViewChange={setTimeView}
        ariaLabel="TESS TOI-270의 원본 밝기 변화. 가로축 관측 시각 BTJD, 세로축 정규화 밝기."
      />
    ),
    period: (
      <ChartCanvas
        kind="period"
        data={data}
        period={period}
        view={periodView}
        onViewChange={setPeriodView}
        ariaLabel="저장된 BLS 반복 주기 그래프. 아래 봉우리 버튼으로 주기를 선택할 수 있습니다."
      />
    ),
  };
  return (
    <div
      className={`lab ${open ? "is-open" : "is-closed"} ${bright ? "lights-up" : ""} ${homePreview ? "home-preview" : ""}`}
    >
      {homePreview && <div className="home-snapshot" aria-hidden="true" />}
      {homePreview && !open && (
        <section
          className="home-preview-launcher"
          aria-label="홈 배경 비교 테스트"
        >
          <span>홈 화면은 이미지입니다 · 배치 비교용</span>
          <button className="primary-button" onClick={() => setOpen(true)}>
            TOI-270 분석창 열기 <Icon name="arrow" />
          </button>
          <a href="/">기존 태양 배경 보기</a>
        </section>
      )}
      <div className="room" aria-hidden="true">
        <div className="room-light" />
        <div className="wall wall-left" />
        <div className="wall wall-right" />
        <div className="floor" />
        <div className="floor-halo" />
      </div>
      {!homePreview && appHeader}
      <main>
        {!homePreview && targetHeading}
        {!homePreview && analysisSteps}
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button onClick={() => setLoadRevision((x) => x + 1)}>
              다시 불러오기
            </button>
          </div>
        )}
        <div className="scene">
          <div className="scene-coordinate coord-left" aria-hidden="true">
            OPTICAL SIGNAL ANALYSIS
            <br />
            <span>WORKSTATION / 001</span>
          </div>
          <div className="scene-coordinate coord-right" aria-hidden="true">
            TESS · SECTOR 03—05
            <br />
            <span>LOCAL OBSERVATION</span>
          </div>
          <div className="console" aria-hidden="true">
            <div className="console-edge" />
            <div className="console-light" />
            <div className="projector projector-left" />
            <div className="projector projector-center" />
            <div className="projector projector-right" />
          </div>
          <svg
            className="supports"
            viewBox="0 0 1440 650"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <g fill="none" stroke="currentColor" strokeWidth="7">
              <path d="M185 600 215 510 248 455V385" />
              <path d="M1240 600 1210 510 1166 430V350" />
              <path d="M655 595 618 545V440" />
              <path d="M800 595 837 545V440" />
            </g>
            <g fill="#121f29" stroke="#41616e" strokeWidth="2">
              <circle cx="215" cy="510" r="11" />
              <circle cx="1210" cy="510" r="11" />
              <circle cx="618" cy="545" r="10" />
              <circle cx="837" cy="545" r="10" />
            </g>
          </svg>
          <div className="panels" inert={!open} aria-hidden={!open}>
            <Panel
              id="01"
              title="밝기 변화"
              subtitle="LIGHT CURVE"
              className="panel-time"
              onFocus={() => setModal("time")}
            >
              {homePreview && targetHeading}
              <div className="panel-meta">
                <span>
                  <i className="tiny-dot" /> 원본 곡선
                </span>
                <span>SECTOR 03 · 04 · 05</span>
              </div>
              <div className="time-chart">{plots.time}</div>
              <div className="axis-caption">
                <span>정규화 밝기</span>
                <span>관측 시각 · BTJD</span>
              </div>
              <div className="observation-stats">
                <div>
                  <span>관측점</span>
                  <strong>
                    {data ? data.pointCount.toLocaleString() : "—"}
                    <small>개</small>
                  </strong>
                </div>
                <div>
                  <span>관측 기간</span>
                  <strong>
                    {data ? (data.time.at(-1) - data.time[0]).toFixed(1) : "—"}
                    <small>일</small>
                  </strong>
                </div>
              </div>
              <div className="sector-bar">
                <span>03</span>
                <span>04</span>
                <span>05</span>
              </div>
              <p className="panel-note">
                여러 관측 회차의 밝기 변화를 확인하세요.
              </p>
            </Panel>
            <Panel
              id="03"
              title="주기로 겹친 곡선"
              subtitle="PHASE FOLDING"
              className="panel-phase"
              aside={
                <span className="live-label">
                  <span className="status-dot" /> LIVE
                </span>
              }
              onFocus={() => setModal("phase")}
            >
              {homePreview && analysisSteps}
              {toolbar}
              <span className="graph-gesture-hint">
                드래그 구간 선택 · Shift+드래그 이동 · 휠 1–20배 · 더블클릭 전체
                보기
              </span>
              <div className="phase-chart">
                {plots.phase}
                {!data && !error && (
                  <span className="chart-loading">관측 신호 불러오는 중…</span>
                )}
              </div>
              <div className="axis-caption">
                <span>정규화 밝기</span>
                <span>위상 · PHASE</span>
              </div>
              {renderPeriodControls("inline")}
            </Panel>
            <Panel
              id="02"
              title="반복 주기"
              subtitle="BLS POWER × 10⁻³"
              className="panel-period"
              onFocus={() => setModal("period")}
            >
              {homePreview && appHeader}
              <div className="period-chart">{plots.period}</div>
              <div className="peak-list">
                <span>봉우리</span>
                {peaks.map((peak, i) => (
                  <button
                    key={i}
                    className={
                      Math.abs(peak.period - period) < 0.01 ? "selected" : ""
                    }
                    onClick={() => updatePeriod(peak.period, true)}
                  >
                    <b>0{i + 1}</b>
                    {peak.period.toFixed(4)} <small>일</small>
                  </button>
                ))}
              </div>
            </Panel>
            <Panel
              id="04"
              title="내 판단"
              subtitle="SIGNAL ASSESSMENT"
              className="panel-judgment"
              onFocus={() => setModal("judgment")}
            >
              <div className="judgment-content">
                <p className="judgment-intro">이 신호는 행성의 흔적일까요?</p>
                <div className="judgment-options">
                  {["행성 같음", "아닌 것 같음", "모르겠음"].map((label, i) => (
                    <button
                      key={label}
                      disabled={!selected || !validPeriod}
                      className={judgment === label ? "chosen" : ""}
                      aria-pressed={judgment === label}
                      onClick={() => chooseJudgment(label)}
                    >
                      <span className="radio-mark">
                        {judgment === label && <i />}
                      </span>
                      {label}
                      <span className="option-index">0{i + 1}</span>
                    </button>
                  ))}
                </div>
                <p className="judgment-hint">
                  {selected
                    ? "관측 곡선을 보고 직접 판단해 주세요."
                    : "가려짐 구간을 선택하면 판단할 수 있어요."}
                </p>
                <div className="section-label">
                  판단 근거 <span>선택</span>
                </div>
                <div className="evidence-list">
                  {[
                    "홀수·짝수 깊이 비교",
                    "주기 절반 지점의 가려짐",
                    "가려짐의 V / U 모양",
                  ].map((label) => (
                    <label key={label}>
                      <input
                        type="checkbox"
                        disabled={!selected || !validPeriod}
                        checked={evidence.includes(label)}
                        onChange={(event) =>
                          setEvidence(
                            event.target.checked
                              ? [...evidence, label]
                              : evidence.filter((item) => item !== label),
                          )
                        }
                      />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
                <label className="section-label" htmlFor="memo">
                  분석 메모 <span>선택</span>
                </label>
                <textarea
                  id="memo"
                  value={memo}
                  disabled={!selected || !validPeriod}
                  maxLength={1000}
                  onChange={(event) => setMemo(event.target.value)}
                  placeholder="관찰한 특징을 남겨보세요."
                  rows={2}
                />
                <button
                  className="primary-button review-button"
                  disabled={!judgment || !selected || !validPeriod || !preview}
                  onClick={() => {
                    setStage(4);
                    setModal("review");
                  }}
                >
                  제출값 확인 <Icon name="arrow" size={15} />
                </button>
                <div className="local-note">
                  시안에서는 서버로 제출하지 않습니다.
                </div>
              </div>
            </Panel>
          </div>
          {!open && !homePreview && (
            <div className="standby">
              <div className="standby-symbol">
                <Icon name="scan" size={46} />
              </div>
              <span className="eyebrow">YOUR WORKSPACE IS READY</span>
              <h2>분석 준비 완료</h2>
              <p>TOI-270의 관측 신호를 살펴보세요.</p>
              <button className="primary-button" onClick={() => setOpen(true)}>
                분석 시작 <Icon name="arrow" />
              </button>
            </div>
          )}
        </div>
      </main>
      <footer className="statusbar">
        <span>
          <i className="status-dot" /> 개인 분석 공간{" "}
          <span className="footer-divider">/</span>{" "}
          <span className="subtle">{open ? "분석 화면 활성" : "대기 중"}</span>
        </span>
        <span className="footer-hint">
          <Icon name="wave" size={14} />{" "}
          {selected
            ? `선택 구간 ${duration.toFixed(2)}시간 · 주기 ${period.toFixed(6)}일`
            : "봉우리를 고르고, 주기를 맞춰 신호를 겹쳐보세요."}
        </span>
        {homePreview ? (
          <span className="background-credit">
            홈 스크린샷 기반 · 배치 테스트
          </span>
        ) : (
          <a
            className="background-credit"
            href="https://svs.gsfc.nasa.gov/3980/"
            target="_blank"
            rel="noreferrer"
          >
            태양 참고 배경 · NASA/SDO ↗
          </a>
        )}
        <button onClick={() => setModal("about")}>
          실제 관측 데이터 <Icon name="info" size={12} />
        </button>
      </footer>
      {modal && (
        <Modal
          title={
            modal === "about"
              ? "분석실 시안 안내"
              : modal === "review"
                ? "제출값 확인"
                : modal === "judgment"
                  ? "판단 입력 안내"
                  : {
                      phase: "주기로 겹친 곡선",
                      time: "밝기 변화",
                      period: "반복 주기",
                    }[modal]
          }
          close={() => {
            if (modal === "review") setStage(3);
            setModal(null);
          }}
          wide={["phase", "time", "period"].includes(modal)}
        >
          {["phase", "time", "period"].includes(modal) && (
            <>
              {modal === "phase" && toolbar}
              <span className="graph-gesture-hint">
                {modal === "phase"
                  ? "드래그 구간 선택 · Shift+드래그 이동 · 휠 1–20배"
                  : "드래그 이동 · 휠 1–8배"}{" "}
                · 더블클릭 전체 보기 · 키보드 + / − / 0
              </span>
              <div className="expanded-chart">{plots[modal]}</div>
              {modal === "phase" ? (
                <div className="expanded-phase-tools">
                  {renderPeriodControls("expanded")}
                </div>
              ) : (
                <p className="modal-description">
                  {modal === "period"
                    ? "주기는 기본 화면의 봉우리 버튼으로 선택합니다. 그래프에서는 이동과 확대를 조절하세요."
                    : "실제 시간축의 정규화 밝기입니다. 관측 공백은 연결하지 않습니다."}
                </p>
              )}
            </>
          )}
          {modal === "about" && (
            <div className="about-content">
              <p>
                자비스 작업실의 투명 패널과 공간 배치를 참고한{" "}
                <strong>React 인터랙션 시안</strong>입니다. 화면 펼치기, 조명
                변경, 그래프 확대, 주기 조정, 구간 선택, 판단 입력을 체험할 수
                있습니다.
              </p>
              <dl>
                <dt>관측 대상</dt>
                <dd>TOI-270 · TIC 259377017</dd>
                <dt>데이터</dt>
                <dd>
                  TESS Sector 3 · 4 · 5 / {data?.pointCount.toLocaleString()}개
                  관측점
                </dd>
                <dt>곡선</dt>
                <dd>
                  기존 tess-bls 실험에서 내보낸 정리된 밝기 곡선과 BLS 주기도.
                  선택한 주기로 브라우저에서 다시 접습니다.
                </dd>
                <dt>배경</dt>
                <dd>
                  {homePreview ? (
                    "원격 develop a8775c9의 은하형 홈 실행 스크린샷입니다. 홈의 지도·버튼은 이미지이며, 분석창 열기와 닫기의 배치만 비교합니다. 실제 홈 기능은 연결하지 않았습니다."
                  ) : (
                    <>
                      NASA/SDO의 태양 극자외선 이미지(AIA 171 Å)입니다.
                      TOI-270의 실제 사진은 아닙니다. Credit: NASA/Goddard Space
                      Flight Center Scientific Visualization Studio, the SDO
                      Science Team, and the Virtual Solar Observatory.
                    </>
                  )}
                </dd>
                <dt>그래프 조작</dt>
                <dd>
                  접힌 곡선은 드래그로 구간을 선택하고 Shift+드래그로
                  이동합니다. 휠 확대는 최대 20배이며 + / − 키로
                  1·2·4·8·16·20배를 선택합니다. 원본 곡선과 주기도는 기본
                  드래그로 이동하고 최대 8배까지 확대합니다. 더블클릭 또는 0은
                  전체 보기입니다. 가려짐 경계는 양 끝 핸들로 조절합니다.
                </dd>
                <dt>시안 범위</dt>
                <dd>
                  제출값 확인까지. 저장·매칭·성과·공개 API는 연결하지
                  않았습니다. 미세 조정 범위와 초기 구간은 시안용이며 운영
                  정책이 아닙니다.
                </dd>
              </dl>
              <a
                href="https://www.zaiortiz.com/portfolio/iron-man-ll"
                target="_blank"
                rel="noreferrer"
              >
                시각 레퍼런스 · Zai Ortiz / Iron Man II ↗
              </a>
            </div>
          )}
          {modal === "judgment" && (
            <div className="about-content">
              <p>
                가려짐 구간을 선택한 뒤, 오른쪽 패널에서 세 판단 중 하나를
                고르세요. 판단 근거와 메모는 선택 사항입니다.
              </p>
              <p>
                실제 서버 제출과 과학적 확인 도구는 이 공간 시안에 연결하지
                않았습니다.
              </p>
              <button className="primary-button" onClick={() => setModal(null)}>
                분석으로 돌아가기 <Icon name="arrow" />
              </button>
            </div>
          )}
          {modal === "review" && (
            <div className="review-content">
              <span className="review-badge">개인 분석 · 제출 전 확인</span>
              <p>선택한 값으로 분석 기록을 확인하세요.</p>
              <dl>
                <dt>관측 대상</dt>
                <dd>TOI-270 · 원본 곡선</dd>
                <dt>반복 주기</dt>
                <dd>{period.toFixed(6)} 일</dd>
                <dt>위상 구간</dt>
                <dd>
                  {phaseStart.toFixed(4)} — {phaseEnd.toFixed(4)}
                </dd>
                <dt>가려짐 중심 시각 · 미리보기</dt>
                <dd>{epoch.toFixed(5)} BTJD</dd>
                <dt>가려진 시간 · 미리보기</dt>
                <dd>{duration.toFixed(3)} 시간</dd>
                <dt>내 판단</dt>
                <dd>{judgment}</dd>
                <dt>판단 근거</dt>
                <dd>{evidence.join(" / ") || "선택하지 않음"}</dd>
                <dt>분석 메모</dt>
                <dd className="review-memo">{memo || "작성하지 않음"}</dd>
              </dl>
              <div className="review-notice">
                <Icon name="info" size={16} />
                <span>
                  배치와 입력 흐름을 확인하는 시안입니다. 실제 제출·채점·성과
                  인정은 진행하지 않습니다.
                </span>
              </div>
              <button
                className="primary-button"
                onClick={() => {
                  setModal(null);
                  setStage(3);
                }}
              >
                분석으로 돌아가기 <Icon name="arrow" />
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
