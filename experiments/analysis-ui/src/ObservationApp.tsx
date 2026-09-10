import { useEffect, useMemo, useRef, useState } from 'react';
import { OrbitMark, Icon } from './components/Icons';
import { ObservationChart, type Interval, type View } from './components/ObservationChart';
import {
  fetchJson,
  allowedWidth,
  validateObservation,
  type Observation,
  type Peak,
  type Target,
} from './observation-data';
import { deriveTransit, normalizeInterval, transitWindows } from './observation-math';
import './observation.css';

const judgmentOptions = [
  ['LIKELY_PLANET', '행성 같음'],
  ['UNLIKELY_PLANET', '아닌 것 같음'],
  ['UNSURE', '모르겠음'],
] as const;
type Judgment = (typeof judgmentOptions)[number][0];
type Stage = 1 | 2 | 3 | 4 | 5;
interface Draft {
  peak: Peak;
  period: number;
  phases: Float64Array;
  interval: Interval | null;
  judgment: Judgment | null;
  memo: string;
  view: View;
  stage: Stage;
}
interface Saved {
  id: string;
  created_at: string;
  observation_id: string;
  bundle_id: string;
  curve_step: 0;
  selection_rules_version: string;
  peak_id: string;
  selection: { period_days: number; phase_start: number; phase_end: number };
  user_judgment: Judgment;
  memo: string;
  view: View;
  time_view: View;
  periodogram_view: View;
  retry_of: string | null;
  status: 'LOCAL_DRAFT';
}
const storageKey = 'planetory.observation-drafts.v1';
const emptyView: View = { zoom: 1, center: 0 };
const format = (n: number, digits = 5) =>
  Number(n.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits });
function loadRecords(): Saved[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(value)
      ? value.filter(
          (r): r is Saved =>
            r?.status === 'LOCAL_DRAFT' &&
            typeof r.id === 'string' &&
            typeof r.bundle_id === 'string' &&
            typeof r.memo === 'string' &&
            judgmentOptions.some(([j]) => j === r.user_judgment) &&
            r.selection &&
            [r.selection.period_days, r.selection.phase_start, r.selection.phase_end].every(
              Number.isFinite,
            ) &&
            [r.view, r.time_view, r.periodogram_view].every(
              (v) => v && Number.isFinite(v.center) && v.zoom >= 1 && v.zoom <= 8,
            ),
        )
      : [];
  } catch {
    return [];
  }
}

function PeriodNumber({
  period,
  peak,
  onChange,
  onInvalid,
}: {
  period: number;
  peak: Peak;
  onChange: (period: number) => void;
  onInvalid: (message: string) => void;
}) {
  const [input, setInput] = useState(String(period));
  useEffect(() => setInput(String(period)), [period]);
  const apply = () => {
    const value = Number(input);
    if (
      !input.trim() ||
      !Number.isFinite(value) ||
      value < peak.period_min ||
      value > peak.period_max
    ) {
      onInvalid(
        `주기를 ${format(peak.period_min)}~${format(peak.period_max)}일 안에서 입력해 주세요.`,
      );
      setInput(String(period));
    } else if (value !== period) onChange(value);
  };
  return (
    <input
      id="period-number"
      type="text"
      inputMode="decimal"
      value={input}
      onChange={(e) => setInput(e.target.value)}
      onBlur={apply}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

export function ObservationApp() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [targetId, setTargetId] = useState(
    new URLSearchParams(location.search).get('target') ?? 'toi270',
  );
  const [observation, setObservation] = useState<Observation | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [previewInterval, setPreviewInterval] = useState<Interval | null>(null);
  const [pendingPeriod, setPendingPeriod] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [foldMs, setFoldMs] = useState<number | null>(null);
  const [timeView, setTimeView] = useState<View>(emptyView);
  const [periodView, setPeriodView] = useState<View>({ zoom: 1, center: 20.25 });
  const [records, setRecords] = useState<Saved[]>(loadRecords);
  const [retryOf, setRetryOf] = useState<string | null>(null);
  const [showRecords, setShowRecords] = useState(false);
  const worker = useRef<Worker | null>(null);
  const foldTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revision = useRef(0);
  const currentData = useRef<Observation | null>(null);
  const busy = pendingPeriod !== null;

  useEffect(() => {
    const controller = new AbortController();
    fetchJson<{ targets: Target[] }>('manifest.json', controller.signal)
      .then((m) => {
        if (!Array.isArray(m.targets) || !m.targets.length)
          throw new Error('관측 목록이 비어 있습니다.');
        setTargets(m.targets);
        setTargetId((id) => (m.targets.some((t) => t.id === id) ? id : m.targets[0].id));
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setLoadError(String(e.message));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    const target = targets.find((t) => t.id === targetId);
    if (!target) return;
    const controller = new AbortController();
    revision.current++;
    worker.current?.terminate();
    if (foldTimeout.current) clearTimeout(foldTimeout.current);
    currentData.current = null;
    setObservation(null);
    setDraft(null);
    setPreviewInterval(null);
    setPendingPeriod(null);
    setError('');
    setNotice('');
    setLoading(true);
    setLoadError('');
    setFoldMs(null);
    setRetryOf(null);
    fetchJson<Observation>(target.file, controller.signal)
      .then(validateObservation)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data.id !== target.id) throw new Error('관측 목록과 데이터가 일치하지 않습니다.');
        currentData.current = data;
        setObservation(data);
        setTimeView({ zoom: 1, center: (data.time_btjd[0] + data.time_btjd.at(-1)!) / 2 });
        setPeriodView({
          zoom: 1,
          center: (data.periodogram.period_days[0] + data.periodogram.period_days.at(-1)!) / 2,
        });
        setLoading(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setLoadError(String(e.message));
          setLoading(false);
        }
      });
    const url = new URL(location.href);
    url.searchParams.set('mode', 'observations');
    url.searchParams.set('target', targetId);
    history.replaceState(null, '', url);
    return () => {
      controller.abort();
      revision.current++;
      worker.current?.terminate();
      if (foldTimeout.current) clearTimeout(foldTimeout.current);
    };
  }, [targetId, targets, reload]);

  function refold(peak: Peak, period: number, mode: 'new' | 'fine' | 'restore', record?: Saved) {
    const data = currentData.current;
    if (!data || !Number.isFinite(period) || period < peak.period_min || period > peak.period_max)
      return;
    const requestRevision = ++revision.current;
    worker.current?.terminate();
    if (foldTimeout.current) clearTimeout(foldTimeout.current);
    setPendingPeriod(period);
    setPreviewInterval(null);
    setError('');
    setNotice('');
    const started = performance.now();
    const failure = () => {
      if (revision.current !== requestRevision) return;
      worker.current?.terminate();
      if (foldTimeout.current) clearTimeout(foldTimeout.current);
      setPendingPeriod(null);
      setError(
        '곡선을 접지 못했습니다. 마지막으로 성공한 주기·구간·판단을 유지했어요. 다시 조정해 주세요.',
      );
    };
    try {
      const nextWorker = new Worker(new URL('./fold.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.current = nextWorker;
      nextWorker.onerror = (event) => {
        event.preventDefault();
        failure();
      };
      nextWorker.onmessage = (
        event: MessageEvent<{ revision: number; phases: Float64Array; error?: string }>,
      ) => {
        if (
          revision.current !== requestRevision ||
          event.data.revision !== requestRevision ||
          currentData.current !== data
        )
          return;
        if (event.data.error || event.data.phases.length !== data.time_btjd.length) {
          failure();
          return;
        }
        nextWorker.terminate();
        if (foldTimeout.current) clearTimeout(foldTimeout.current);
        setDraft((previous) => ({
          peak,
          period,
          phases: event.data.phases,
          interval: record
            ? { phase_start: record.selection.phase_start, phase_end: record.selection.phase_end }
            : null,
          judgment: record?.user_judgment ?? null,
          memo: record?.memo ?? '',
          view: record?.view ?? {
            zoom: mode === 'fine' ? (previous?.view.zoom ?? 1) : 1,
            center: 0,
          },
          stage: record ? 5 : 2,
        }));
        if (record) {
          setTimeView(record.time_view);
          setPeriodView(record.periodogram_view);
          setRetryOf(record.id);
          setShowRecords(false);
        }
        setFoldMs(performance.now() - started);
        setPendingPeriod(null);
      };
      foldTimeout.current = setTimeout(failure, 15_000);
      nextWorker.postMessage({
        revision: requestRevision,
        times: data.time_btjd,
        reference: data.fold_reference_time_btjd,
        period,
      });
    } catch {
      failure();
    }
  }

  function setInterval(interval: Interval) {
    const rules = observation?.selection_rules;
    if (
      !rules ||
      !allowedWidth(
        interval.phase_start,
        interval.phase_end,
        rules.min_width_phase,
        rules.max_width_phase,
      )
    )
      return;
    setDraft((previous) =>
      previous ? { ...previous, interval, judgment: null, memo: '', stage: 3 } : previous,
    );
    setError('');
    setNotice('');
  }
  const shownInterval = previewInterval ?? draft?.interval;
  const derived = useMemo(() => {
    if (!observation || !draft || !shownInterval) return null;
    try {
      const selection = { period_days: draft.period, ...shownInterval };
      return {
        ...deriveTransit(selection, observation.fold_reference_time_btjd, observation.time_btjd),
        bands: transitWindows(
          selection,
          observation.fold_reference_time_btjd,
          observation.time_btjd,
        ),
      };
    } catch {
      return null;
    }
  }, [observation, draft?.period, shownInterval]);

  function saveDraft() {
    if (!observation || !draft?.interval || !draft.judgment || !derived || busy || previewInterval)
      return;
    const record: Saved = {
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      observation_id: observation.id,
      bundle_id: observation.bundle_id,
      curve_step: 0,
      selection_rules_version: observation.selection_rules.version,
      peak_id: draft.peak.id,
      selection: { period_days: draft.period, ...draft.interval },
      user_judgment: draft.judgment,
      memo: draft.memo,
      view: draft.view,
      time_view: timeView,
      periodogram_view: periodView,
      retry_of: retryOf,
      status: 'LOCAL_DRAFT',
    };
    const updated = [record, ...records];
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(updated));
      setRecords(updated);
      setNotice(
        '이 탭에 분석 초안을 저장했어요. 실제 제출·매칭·성과 처리는 아직 연결되지 않았습니다.',
      );
    } catch {
      setError('브라우저 저장 공간을 사용할 수 없습니다. 입력은 유지됩니다.');
    }
  }
  function restore(record: Saved) {
    const peak = observation?.peaks.find((p) => p.id === record.peak_id);
    try {
      if (
        !peak ||
        !observation ||
        record.bundle_id !== observation.bundle_id ||
        record.selection_rules_version !== observation.selection_rules.version
      )
        throw new Error('bundle');
      const normalized = normalizeInterval(
        record.selection.phase_start,
        record.selection.phase_end,
      );
      if (
        !allowedWidth(
          normalized.phase_start,
          normalized.phase_end,
          observation.selection_rules.min_width_phase,
          observation.selection_rules.max_width_phase,
        ) ||
        record.selection.period_days < peak.period_min ||
        record.selection.period_days > peak.period_max
      )
        throw new Error('selection');
      deriveTransit(record.selection, observation.fold_reference_time_btjd, observation.time_btjd);
      refold(peak, record.selection.period_days, 'restore', record);
    } catch {
      setError('현재 데이터 판과 맞지 않는 기록입니다. 원본 기록은 유지합니다.');
    }
  }

  const target = targets.find((t) => t.id === targetId);
  const currentRecords = records.filter((r) => r.observation_id === targetId);
  const baseline = observation ? observation.time_btjd.at(-1)! - observation.time_btjd[0] : 0;
  const stage = draft?.stage ?? 1;
  const previewPeriod = pendingPeriod ?? draft?.period;

  return (
    <>
      <div className="mobile-gate">
        <OrbitMark size={52} />
        <p className="eyebrow">PLANETORY</p>
        <h1>
          데스크톱에서
          <br />
          이용해 주세요
        </h1>
        <p>
          정확한 그래프 분석을 위해
          <br />폭 1024px 이상의 화면이 필요해요.
        </p>
      </div>
      <div className="desktop-app observation-app">
        <div className="preview-bar">
          <span className="preview-label">
            <i /> 실제 TESS 관측 · 분석 실험
          </span>
          <div className="preview-controls">
            <a href="?scenario=last-fp-wrong">
              결과·보상 시나리오 보기 <span>↗</span>
            </a>
            <span className="preview-divider">/</span>
            <span>로컬 초안</span>
          </div>
        </div>
        <header className="observation-header">
          <a className="brand" href="?mode=observations">
            <OrbitMark />
            <span>
              Planetory<span className="brand-period">.</span>
            </span>
          </a>
          <div className="observation-breadcrumb">
            내 탐사 <span>/</span> <b>{target?.label ?? '관측 자료'}</b>
            <span>/</span> 신호 분석
          </div>
          <button
            className="secondary-button"
            onClick={() => setShowRecords((v) => !v)}
            disabled={loading || busy}
          >
            <Icon name="history" size={16} /> 임시 기록 <span>{currentRecords.length}</span>
          </button>
        </header>
        <main className="observation-main">
          <div className="observation-title">
            <div>
              <p className="eyebrow">FOLLOW THE LIGHT</p>
              <h1>빛의 변화에서 신호 찾기</h1>
              <p className="subtitle">
                봉우리를 고르고, 곡선을 겹쳐 보며 반복되는 어두워짐을 찾아보세요.
              </p>
            </div>
            <label className="target-select">
              관측 항성
              <select
                aria-label="관측 항성"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label} · TIC {t.tic_id}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {loading && (
            <div className="loading-view" role="status">
              <span className="spinner" />
              전체 관측 자료를 불러오고 있어요.
            </div>
          )}
          {loadError && (
            <div className="notice error" role="alert">
              <span>{loadError}</span>
              <button onClick={() => setReload((n) => n + 1)}>다시 불러오기</button>
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              {notice}
            </div>
          )}
          {observation && (
            <>
              <ol className="analysis-steps" aria-label="분석 단계">
                {['봉우리 선택', '주기 맞추기', '구간 고르기', '판단', '저장 검토'].map(
                  (name, i) => (
                    <li
                      key={name}
                      className={stage === i + 1 ? 'current' : stage > i + 1 ? 'passed' : ''}
                      aria-current={stage === i + 1 ? 'step' : undefined}
                    >
                      <span>{stage > i + 1 ? '✓' : i + 1}</span>
                      {name}
                    </li>
                  ),
                )}
              </ol>
              {showRecords && (
                <section className="observation-card draft-records">
                  <div className="observation-card-heading">
                    <h2>이 탭의 임시 기록</h2>
                    <button className="text-button" onClick={() => setShowRecords(false)}>
                      닫기
                    </button>
                  </div>
                  <p>
                    새로고침 후에도 이 탭에서 복원할 수 있어요. 복원 후 저장하면 새 기록이 생깁니다.
                  </p>
                  {!currentRecords.length ? (
                    <p className="subtle">아직 저장한 분석이 없어요.</p>
                  ) : (
                    <table>
                      <thead>
                        <tr>
                          <th>저장 시각</th>
                          <th>주기</th>
                          <th>내 판단</th>
                          <th>상태</th>
                          <th>복원</th>
                        </tr>
                      </thead>
                      <tbody>
                        {currentRecords.map((r) => (
                          <tr key={r.id}>
                            <td>{new Date(r.created_at).toLocaleTimeString('ko-KR')}</td>
                            <td>{format(r.selection.period_days)}일</td>
                            <td>{judgmentOptions.find(([j]) => j === r.user_judgment)?.[1]}</td>
                            <td>임시 저장</td>
                            <td>
                              <button
                                onClick={() => restore(r)}
                                disabled={busy || r.bundle_id !== observation.bundle_id}
                              >
                                입력 복원
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              )}
              <div className="observation-top-grid">
                <section className="observation-card">
                  <div className="observation-card-heading">
                    <div>
                      <p className="eyebrow">01 / LIGHT CURVE</p>
                      <h2>밝기 변화 곡선</h2>
                    </div>
                    <span className="pill neutral">원본 단계</span>
                  </div>
                  <ObservationChart
                    label="시간 영역 광도곡선"
                    x={observation.time_btjd}
                    y={observation.normalized_flux}
                    domain={[observation.time_btjd[0], observation.time_btjd.at(-1)!]}
                    view={timeView}
                    onView={setTimeView}
                    bands={derived?.bands}
                    markers={observation.observation_windows.map((w) => ({
                      x: w.start_btjd,
                      label: `S${w.sector}`,
                    }))}
                    unit="관측 시각 (BTJD)"
                  />
                  <div className="observation-card-foot">
                    <span>
                      <i className="legend-dot" />
                      정리된 유효 관측 <b>{observation.time_btjd.length.toLocaleString()}점</b>
                    </span>
                    <span>빈 구간은 관측 공백 · 선 연결 없음</span>
                  </div>
                </section>
                <section className="observation-card">
                  <div className="observation-card-heading">
                    <div>
                      <p className="eyebrow">02 / PERIODOGRAM</p>
                      <h2>반복 주기 그래프</h2>
                    </div>
                    <span className="subtle">로컬 BLS 계산</span>
                  </div>
                  <ObservationChart
                    label="BLS 반복 주기 그래프"
                    x={observation.periodogram.period_days}
                    y={observation.periodogram.power}
                    domain={[
                      observation.periodogram.period_days[0],
                      observation.periodogram.period_days.at(-1)!,
                    ]}
                    view={periodView}
                    onView={setPeriodView}
                    line
                    markers={observation.peaks
                      .slice(0, 5)
                      .map((p) => ({ x: p.period_days, label: `${p.rank}` }))}
                    bands={[
                      { start: baseline / 2, end: observation.periodogram.period_days.at(-1)! },
                    ]}
                    onPick={(p) => {
                      const peak = observation.peaks.reduce((a, b) =>
                        Math.abs(a.period_days - p) < Math.abs(b.period_days - p) ? a : b,
                      );
                      refold(peak, peak.period_days, 'new');
                    }}
                    unit="반복 주기 (일) · BLS power"
                  />
                  <div className="observation-card-foot">
                    <span>클릭하면 가까운 봉우리 선택</span>
                    <span>음영: 시간 범위/2 초과</span>
                  </div>
                </section>
              </div>
              <div className="observation-work-grid">
                <div className="observation-work-column">
                  <section className="observation-card peak-card">
                    <div className="observation-card-heading">
                      <h2>어떤 주기로 겹쳐 볼까요?</h2>
                      <span className="subtle">BLS 봉우리 · 정답 여부 미판정</span>
                    </div>
                    <div className="peak-options">
                      {observation.peaks.map((peak) => (
                        <button
                          key={peak.id}
                          aria-label={`봉우리 ${peak.rank} · ${format(peak.period_days)}일`}
                          aria-pressed={draft?.peak.id === peak.id}
                          onClick={() => refold(peak, peak.period_days, 'new')}
                        >
                          <span className="peak-rank">{peak.rank}</span>
                          <b>
                            {format(peak.period_days)}
                            <small> 일</small>
                          </b>
                          <span
                            className="peak-power"
                            style={{ width: `${peak.relative_power * 100}%` }}
                          />
                        </button>
                      ))}
                    </div>
                  </section>
                  <section className="observation-card folded-card" aria-busy={busy}>
                    <div className="observation-card-heading">
                      <div>
                        <p className="eyebrow">03 / PHASE FOLD</p>
                        <h2>주기로 겹친 곡선</h2>
                      </div>
                      <span className="pill neutral">
                        {previewPeriod ? `${format(previewPeriod)}일` : '봉우리를 선택하세요'}
                      </span>
                    </div>
                    {!draft ? (
                      <div className="fold-empty" role="status">
                        <Icon name="chart" size={34} />
                        <p>
                          {busy
                            ? '전체 관측점을 접고 있어요…'
                            : '위에서 봉우리를 선택하면 곡선이 나타나요.'}
                        </p>
                        <span>같은 주기에서 반복되는 관측을 겹쳐 표시합니다.</span>
                      </div>
                    ) : (
                      <>
                        <div className="period-control">
                          <label htmlFor="fine-period">
                            주기 미세 조정 <span>변경 시 구간·판단 초기화 / 확대 배율 유지</span>
                          </label>
                          <div>
                            <span>{format(draft.peak.period_min)}</span>
                            <input
                              id="fine-period"
                              type="range"
                              min={draft.peak.period_min}
                              max={draft.peak.period_max}
                              step={draft.peak.period_step}
                              value={previewPeriod ?? draft.period}
                              onChange={(e) => refold(draft.peak, Number(e.target.value), 'fine')}
                            />
                            <span>{format(draft.peak.period_max)}</span>
                          </div>
                          <div className="period-number">
                            <label htmlFor="period-number">주기 (일)</label>
                            <PeriodNumber
                              period={previewPeriod ?? draft.period}
                              peak={draft.peak}
                              onChange={(p) => refold(draft.peak, p, 'fine')}
                              onInvalid={setError}
                            />
                            <span>
                              {busy
                                ? '전체 점 다시 접는 중…'
                                : `전체 ${draft.phases.length.toLocaleString()}점 접기 완료`}
                            </span>
                          </div>
                        </div>
                        <div className="fold-tools">
                          <span>
                            {stage < 3
                              ? '주기를 맞춘 뒤 구간 선택을 시작하세요.'
                              : '그래프를 드래그하거나 두 핸들을 움직여 구간을 골라보세요.'}
                          </span>
                          <button
                            className="text-button"
                            disabled={busy}
                            onClick={() => setDraft((d) => (d ? { ...d, view: emptyView } : d))}
                          >
                            확대 초기화
                          </button>
                        </div>
                        <ObservationChart
                          label="접힌 광도곡선"
                          x={draft.phases}
                          y={observation.normalized_flux}
                          domain={[-1, 1]}
                          view={draft.view}
                          onView={(view) => setDraft((d) => (d ? { ...d, view } : d))}
                          repeat
                          interval={draft.interval}
                          onInterval={stage >= 3 ? setInterval : undefined}
                          onPreview={setPreviewInterval}
                          minWidth={observation.selection_rules.min_width_phase}
                          maxWidth={observation.selection_rules.max_width_phase}
                          onInvalid={setError}
                          disabled={busy}
                          unit="접기 기준에 대한 위상 · 2주기"
                        />
                        <div className="fold-action">
                          <span className="subtle">
                            휠: 포인터 중심 확대 · +/-: 중앙 확대 · 핸들: ← →
                          </span>
                          {stage === 2 ? (
                            <button
                              className="primary-button"
                              disabled={busy}
                              onClick={() => setDraft((d) => (d ? { ...d, stage: 3 } : d))}
                            >
                              이 주기로 구간 고르기 <Icon name="arrow" size={15} />
                            </button>
                          ) : (
                            <button
                              className="secondary-button"
                              disabled={busy}
                              onClick={() =>
                                setInterval(
                                  normalizeInterval(
                                    draft.view.center -
                                      Math.min(
                                        observation.selection_rules.max_width_phase,
                                        Math.max(observation.selection_rules.min_width_phase, 0.04),
                                      ) /
                                        2,
                                    draft.view.center +
                                      Math.min(
                                        observation.selection_rules.max_width_phase,
                                        Math.max(observation.selection_rules.min_width_phase, 0.04),
                                      ) /
                                        2,
                                  ),
                                )
                              }
                            >
                              중앙 구간에서 시작
                            </button>
                          )}
                        </div>
                        <div className="selection-summary" aria-live="polite">
                          <div>
                            <span>위상 구간</span>
                            <b data-testid="phase-selection">
                              {shownInterval
                                ? `${format(shownInterval.phase_start)} → ${format(shownInterval.phase_end)}`
                                : '구간을 선택하세요'}
                            </b>
                          </div>
                          <div>
                            <span>기준 시각 미리보기</span>
                            <b data-testid="epoch-preview">
                              {derived ? `${format(derived.epoch_btjd)} BTJD` : '—'}
                            </b>
                          </div>
                          <div>
                            <span>가려진 시간 미리보기</span>
                            <b data-testid="duration-preview">
                              {derived ? `${format(derived.duration_days * 24, 3)}시간` : '—'}
                            </b>
                          </div>
                        </div>
                        {draft.interval && !derived && (
                          <p className="observation-inline-error" role="alert">
                            관측 범위 안에 기준 시각을 정할 수 없습니다. 구간을 다시 선택하세요.
                          </p>
                        )}
                        {stage === 3 && (
                          <div className="fold-action">
                            <span>선택한 구간이 시간 영역의 예상 띠에도 표시돼요.</span>
                            <button
                              className="primary-button"
                              disabled={busy || !derived}
                              onClick={() => setDraft((d) => (d ? { ...d, stage: 4 } : d))}
                            >
                              이 구간으로 판단하기 <Icon name="arrow" size={15} />
                            </button>
                          </div>
                        )}
                      </>
                    )}
                    <div className="observation-card-foot">
                      <span role="status">
                        {busy
                          ? '접기 계산 중 · 구간과 판단 입력 잠금'
                          : foldMs !== null
                            ? `마지막 접기 ${Math.round(foldMs)}ms · Worker 시작/전달 포함`
                            : '선택한 주기로 전체 관측점을 접습니다.'}
                      </span>
                      <span>가로 ×1~8</span>
                    </div>
                  </section>
                </div>
                <aside className="observation-side-column">
                  <section className="observation-card star-data-card">
                    <p className="eyebrow">OBSERVATION</p>
                    <h2>{observation.label}</h2>
                    <p className="subtle">TIC {observation.tic_id} · TESS / SPOC</p>
                    <dl>
                      <div>
                        <dt>관측 회차</dt>
                        <dd>{target?.sectors.map((s) => `S${s}`).join(' · ')}</dd>
                      </div>
                      <div>
                        <dt>첫~마지막 관측</dt>
                        <dd>{format(baseline, 1)}일</dd>
                      </div>
                      <div>
                        <dt>접기 기준 (BTJD)</dt>
                        <dd>{format(observation.fold_reference_time_btjd)}</dd>
                      </div>
                      <div>
                        <dt>유효 관측점</dt>
                        <dd>{observation.time_btjd.length.toLocaleString()}</dd>
                      </div>
                    </dl>
                    <p className="observation-help">
                      여러 회차 사이의 공백이 포함된 시간 범위입니다. 봉우리의 실제 관측 횟수·탐색
                      가능 여부는 아직 판정하지 않습니다.
                    </p>
                    <details>
                      <summary>자료와 처리 기준</summary>
                      <p>
                        원본 FITS에서 품질 제외·정규화·추세 제거 후 전체 점을 사용합니다. 상세
                        내역은 공개 데이터 파일의 provenance에 보관합니다.
                      </p>
                      <code>{observation.bundle_id}</code>
                      {observation.provenance.quality_counts && (
                        <p>
                          원본 {observation.provenance.quality_counts.raw.toLocaleString()}점 · 품질
                          제외{' '}
                          {observation.provenance.quality_counts.quality_nonzero.toLocaleString()}점
                          · 비유한/비양수 제외{' '}
                          {(
                            observation.provenance.quality_counts.nonfinite +
                            observation.provenance.quality_counts.nonpositive_flux
                          ).toLocaleString()}
                          점 · 상단 이상치 제외{' '}
                          {observation.provenance.quality_counts.upper_sigma_clip.toLocaleString()}
                          점
                        </p>
                      )}
                      <p>
                        선택 폭: 위상 {observation.selection_rules.min_width_phase}~
                        {observation.selection_rules.max_width_phase} · 실험 설정, 최종 정책 미확정
                      </p>
                    </details>
                  </section>
                  <section className="observation-card judgment-card">
                    <div className="observation-card-heading">
                      <h2>내 판단</h2>
                      <span className="subtle">04</span>
                    </div>
                    <fieldset disabled={!draft || stage < 4 || busy}>
                      <legend>이 신호를 어떻게 생각하나요?</legend>
                      {judgmentOptions.map(([value, name]) => (
                        <label
                          key={value}
                          className={
                            'observation-judgment ' + (draft?.judgment === value ? 'selected' : '')
                          }
                        >
                          <input
                            type="radio"
                            name="observation-judgment"
                            value={value}
                            checked={draft?.judgment === value}
                            onChange={() =>
                              setDraft((d) => (d ? { ...d, judgment: value, stage: 4 } : d))
                            }
                          />
                          {name}
                        </label>
                      ))}
                      <label className="observation-memo">
                        관찰 메모 (선택)
                        <textarea
                          aria-label="관찰 메모"
                          maxLength={2000}
                          rows={4}
                          placeholder="반복되는 깊이나 모양에서 눈에 띈 점을 남겨보세요."
                          value={draft?.memo ?? ''}
                          onChange={(e) =>
                            setDraft((d) => (d ? { ...d, memo: e.target.value, stage: 4 } : d))
                          }
                        />
                      </label>
                      <p className="observation-help">
                        홀짝 비교·2차 식 등 근거 확인 도구는 다음 단계에 연결합니다.
                      </p>
                      <button
                        className="primary-button"
                        disabled={!draft?.judgment || !derived}
                        onClick={() => setDraft((d) => (d ? { ...d, stage: 5 } : d))}
                      >
                        선택값 검토
                      </button>
                    </fieldset>
                  </section>
                  {stage === 5 && draft && (
                    <section className="observation-card review-card">
                      <p className="eyebrow">REVIEW YOUR DRAFT</p>
                      <h2>저장할 내용</h2>
                      <p>
                        <b>{format(draft.period)}일</b> ·{' '}
                        {judgmentOptions.find(([j]) => j === draft.judgment)?.[1]}
                      </p>
                      <p className="observation-help">
                        주기·위상 구간·판단·메모·확대 상태를 이 탭에 임시 저장합니다.
                        매칭·성과·공개는 처리하지 않습니다.
                      </p>
                      {retryOf && <p className="subtle">복원한 입력을 새 기록으로 저장합니다.</p>}
                      <button
                        className="primary-button"
                        disabled={busy || !derived || !draft.judgment || !!previewInterval}
                        onClick={saveDraft}
                      >
                        브라우저에 임시 저장 <Icon name="check" size={16} />
                      </button>
                    </section>
                  )}
                </aside>
              </div>
              <footer className="observation-footer">
                <span>곡선 단계 0 · 실제 관측 데이터</span>
                <span>
                  예상 시각·시간은 브라우저 미리보기입니다. 서버 제출 시 재계산이 필요합니다.
                </span>
              </footer>
            </>
          )}
        </main>
      </div>
    </>
  );
}
