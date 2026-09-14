import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Activity, ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronRight, Compass, Crosshair, HelpCircle, Layers, LoaderCircle, Maximize2, Minus, NotebookPen, Orbit, Plus, Radio, RotateCcw, Search, Settings2, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { StarMap } from './StarMap';
import { ObservationChart } from './ObservationChart';
import catalogue from './catalog.json';
import type { ChartKind, Observation, Peak, PhaseRange, SavedNote, StarTarget } from './types';
import { assertObservation, findRestorablePeak, NOTES_KEY, readNotes } from './session';
import { previewTransit } from './chart-math';

const targets = catalogue as StarTarget[];
const cache = new Map<string, Observation>();
const steps = ['봉우리 선택', '주기 맞추기', '구간 선택', '판단하기', '기록 확인'];
const reasons = ['홀짝 깊이', '2차 식', 'V/U형'];
const formatNumber = (value: number) => new Intl.NumberFormat('en-US').format(value);
const coordinate = (value: number, signed = false) => `${signed && value >= 0 ? '+' : ''}${value.toFixed(4)}°`;

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog className="dialog holo-panel" ref={ref} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="panel-heading"><h2>{title}</h2><button className="icon-button" aria-label="닫기" onClick={onClose}><X size={18} /></button></div>{children}
  </dialog>;
}

export default function App() {
  const [mode, setMode] = useState<'explore' | 'analyze' | 'records'>('explore');
  const [selectedId, setSelectedId] = useState<string | null>('toi270');
  const [data, setData] = useState<Observation | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const [step, setStep] = useState(0);
  const [peak, setPeak] = useState<Peak | null>(null);
  const [period, setPeriod] = useState(1);
  const [periodDraft, setPeriodDraft] = useState('1');
  const [range, setRange] = useState<PhaseRange | null>(null);
  const [judgment, setJudgment] = useState('');
  const [evidence, setEvidence] = useState<string[]>([]);
  const [memo, setMemo] = useState('');
  const [chartKind, setChartKind] = useState<ChartKind>('period');
  const [chartReset, setChartReset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [mapReset, setMapReset] = useState(0);
  const [grid, setGrid] = useState(true);
  const [motion, setMotion] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [glass, setGlass] = useState(true);
  const [settings, setSettings] = useState(false);
  const [help, setHelp] = useState(false);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [notes, setNotes] = useState<SavedNote[]>(() => { try { return readNotes(localStorage.getItem(NOTES_KEY)); } catch { return []; } });
  const [restore, setRestore] = useState<SavedNote | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const star = targets.find(target => target.id === selectedId) ?? null;
  const filtered = targets.filter(target => `${target.name} ${target.tic}`.toLowerCase().includes(query.trim().toLowerCase()));
  const periodInvalid = !peak || !Number.isFinite(Number(periodDraft)) || periodDraft.trim() === '' || Number(periodDraft) < peak.period_min || Number(periodDraft) > peak.period_max;

  useEffect(() => {
    if (!selectedId) { setData(null); return; }
    const controller = new AbortController();
    let current = true;
    setLoadState('loading'); setData(null);
    const getData = async () => {
      try {
        let next = cache.get(selectedId);
        if (!next) {
          const response = await fetch(`/observations/${selectedId}.json`, { signal: controller.signal });
          if (!response.ok) throw new Error('관측 자료를 불러오지 못했습니다.');
          const payload: unknown = await response.json(); assertObservation(payload);
          if (payload.id !== selectedId) throw new Error('관측 대상이 일치하지 않습니다.');
          next = payload; cache.set(selectedId, next);
        }
        if (!current) return;
        setData(next); setLoadState('ready');
        const initial = next.peaks[0].period_days;
        setPeriod(initial); setPeriodDraft(initial.toFixed(6));
      } catch (error) { if (current && !(error instanceof DOMException && error.name === 'AbortError')) setLoadState('error'); }
    };
    void getData();
    return () => { current = false; controller.abort(); };
  }, [selectedId, retry]);

  useEffect(() => {
    if (!restore || !data || data.id !== restore.starId) return;
    const matchingPeak = findRestorablePeak(data, restore);
    if (!matchingPeak) {
      setNotice('관측 자료가 달라 저장한 입력을 복원할 수 없습니다.'); setRestore(null); return;
    }
    setPeak(matchingPeak); setPeriod(restore.period); setPeriodDraft(restore.period.toFixed(6));
    setRange(restore.range); setJudgment(restore.judgment); setEvidence(restore.reasons); setMemo(restore.memo);
    setStep(4); setChartKind('phase'); setMode('analyze'); setRestore(null);
  }, [restore, data]);

  useEffect(() => {
    if (restore && loadState === 'error') {
      setNotice('기록의 관측 자료를 불러오지 못했습니다. 다시 열어 주세요.'); setRestore(null);
    }
  }, [restore, loadState]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).matches('input, textarea, select') || help) return;
      if (event.key === '/') { event.preventDefault(); searchRef.current?.focus(); setSearchOpen(true); }
      if (event.key === 'Escape') { setSettings(false); setSearchOpen(false); if (mode === 'analyze') setMode('explore'); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [mode, help]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 4500); return () => clearTimeout(timer); }, [notice]);

  const clearDependent = () => { setRange(null); setJudgment(''); setEvidence([]); setMemo(''); };
  const selectStar = (id: string | null) => {
    setRestore(null);
    if (id !== selectedId) { setLoadState('loading'); setPeak(null); setStep(0); setChartKind('period'); clearDependent(); setBusy(false); setChartReset(value => value + 1); }
    setSelectedId(id); setQuery(''); setSearchOpen(false);
  };
  const selectPeak = (next: Peak) => {
    setPeak(next); setPeriod(next.period_days); setPeriodDraft(next.period_days.toFixed(6));
    clearDependent(); setChartReset(value => value + 1); setStep(1); setChartKind('phase');
  };
  const changePeriod = (value: number) => {
    if (!peak || !Number.isFinite(value)) return;
    const next = Math.max(peak.period_min, Math.min(peak.period_max, value));
    if (Math.abs(next - period) < 1e-12) return;
    if (range || judgment || memo) setNotice('주기가 바뀌어 선택 구간과 판단을 초기화했어요.');
    setPeriod(next); setPeriodDraft(next.toFixed(6)); clearDependent(); setStep(1);
  };
  const selectRange = (next: PhaseRange | null) => { setRange(next); setJudgment(''); setEvidence([]); setMemo(''); };
  const openAnalysis = () => { if (!star || !data || loadState !== 'ready') return; setMode('analyze'); setSearchOpen(false); setSettings(false); };
  const saveNote = () => {
    if (!star || !data || !peak || !range || !judgment || busy) return;
    const record: SavedNote = { id: crypto.randomUUID(), starId: star.id, tic: star.tic, starName: star.name, createdAt: new Date().toISOString(), period, range, judgment, reasons: evidence, memo, bundleId: data.bundle_id, referenceTime: data.fold_reference_time_btjd };
    const next = [record, ...notes];
    try { localStorage.setItem(NOTES_KEY, JSON.stringify(next)); setNotes(next); setMode('records'); setNotice('관측 기록을 이 브라우저에 저장했어요.'); }
    catch { setNotice('브라우저 저장 공간에 접근할 수 없습니다. 입력은 유지되어 있어요.'); }
  };
  const canNext = step === 0 ? !!peak : step === 1 ? !!peak && !periodInvalid && !busy : step === 2 ? !!range && !busy : !!judgment;
  const transit = data && range ? previewTransit(range, period, data.fold_reference_time_btjd,
    Math.min(...data.observation_windows.map(window => window.start_btjd)),
    Math.max(...data.observation_windows.map(window => window.end_btjd))) : null;
  const duration = transit?.durationHours ?? null;
  const epoch = transit?.epoch ?? null;
  const chartTitles: Record<ChartKind, string> = { light: '광도 곡선', period: '주기도', phase: '위상 접기' };

  return <div className={`observatory mode-${mode} ${motion ? '' : 'motion-off'} ${glass ? '' : 'solid-panels'}`}>
    <StarMap targets={targets} selectedId={selectedId} onSelect={selectStar} dimmed={mode !== 'explore'} showGrid={grid} motion={motion} zoom={zoom} onZoomChange={setZoom} resetKey={mapReset} />
    <header className="topbar">
      <button className="brand" onClick={() => setMode('explore')} aria-label="Planetory 탐색으로"><Orbit size={30} strokeWidth={1.2} /><span>PLANETORY</span><span className="brand-divider" /><span className="brand-caption">OBSERVATORY</span></button>
      <nav className="main-nav" aria-label="주 메뉴">
        <button className={mode === 'explore' ? 'active' : ''} onClick={() => setMode('explore')}><Compass size={15} />탐색</button>
        <button className={mode === 'analyze' ? 'active' : ''} onClick={openAnalysis} disabled={!star || loadState !== 'ready'}><Activity size={15} />분석</button>
        <button className={mode === 'records' ? 'active' : ''} onClick={() => setMode('records')}><NotebookPen size={15} />관측 기록{notes.length > 0 && <span className="count-badge">{notes.length}</span>}</button>
      </nav>
      <div className="header-right"><span className="connection"><i />TESS ARCHIVE</span><button className="icon-button" aria-label="사용 안내" onClick={() => setHelp(true)}><HelpCircle size={18} /></button><div className="avatar">P</div></div>
    </header>

    <div className="workspace-top">
      <div><div className="eyebrow"><span className="micro-cross">+</span> DEEP SKY EXPLORATION <span className="slash">/</span> 01</div><h1>{mode === 'explore' ? '별빛 너머, 새로운 세계' : mode === 'analyze' ? '신호를 따라가는 시간' : '나의 관측 기록'}</h1></div>
      <div className="workspace-tools">
        <div className="search-wrap"><Search size={15} /><input ref={searchRef} placeholder="별 이름 또는 TIC 검색" aria-label="별 검색" value={query} onChange={e => { setQuery(e.target.value); setSearchOpen(true); }} onFocus={() => setSearchOpen(true)} onKeyDown={e => { if (e.key === 'Escape') setSearchOpen(false); if (e.key === 'Enter' && filtered.length === 1) { selectStar(filtered[0].id); setMode('explore'); } }} /><kbd>/</kbd>
          {searchOpen && <div className="search-results holo-panel">{filtered.length ? filtered.map(target => <button key={target.id} onClick={() => { selectStar(target.id); setMode('explore'); }}><span>{target.name}<small>TIC {target.tic}</small></span><ArrowUpRight size={16} /></button>) : <p>일치하는 관측 대상이 없습니다.</p>}<button className="search-close" onClick={() => setSearchOpen(false)}>검색 닫기 <X size={12} /></button></div>}
        </div>
        <button className={`icon-button control-square ${settings ? 'selected' : ''}`} aria-label="표시 설정" aria-expanded={settings} onClick={() => setSettings(!settings)}><SlidersHorizontal size={17} /></button>
        {settings && <div className="settings-popover holo-panel"><div className="panel-heading"><span>표시 설정</span><button className="icon-button" aria-label="설정 닫기" onClick={() => setSettings(false)}><X size={15} /></button></div>{[['좌표 가이드', grid, setGrid], ['공간 모션', motion, setMotion], ['홀로그램 패널', glass, setGlass]].map(([label, value, setter]) => <label className="setting" key={label as string}><span>{label as string}</span><input type="checkbox" role="switch" checked={value as boolean} onChange={e => (setter as (v: boolean) => void)(e.target.checked)} /></label>)}</div>}
      </div>
    </div>

    {mode === 'explore' && <main className="explore-workspace" aria-label="별 탐색">
      <div className="map-context"><span className="context-line" /><div><span className="eyebrow">YOUR NEXT DISCOVERY</span><p>하나의 별, 아직 읽지 않은 이야기.</p><small>별을 선택하고, 빛에 남은 흔적을 살펴보세요.</small></div></div>
      <div className="map-controls holo-panel" aria-label="별 지도 조작"><button aria-label="지도 확대" onClick={() => setZoom(v => Math.min(3, v + .25))} disabled={zoom >= 3}><Plus size={17} /></button><span>{zoom.toFixed(2)}×</span><button aria-label="지도 축소" onClick={() => setZoom(v => Math.max(1, v - .25))} disabled={zoom <= 1}><Minus size={17} /></button><i /><button aria-label="지도 위치 초기화" onClick={() => { setZoom(1); setMapReset(v => v + 1); }}><Crosshair size={17} /></button><button aria-label="좌표 가이드 전환" aria-pressed={grid} onClick={() => setGrid(!grid)}><Layers size={17} /></button></div>
      <div className="map-scale"><span /><small>SCHEMATIC STAR FIELD</small><small>드래그로 이동 · 스크롤로 확대</small></div>
      {star ? <aside className="target-panel holo-panel" key={star.id} onPointerMove={e => { if (!motion || e.pointerType !== 'mouse') return; const bounds = e.currentTarget.getBoundingClientRect(); e.currentTarget.style.setProperty('--tilt-x', `${-((e.clientY - bounds.top) / bounds.height - .5) * 1.6}deg`); e.currentTarget.style.setProperty('--tilt-y', `${((e.clientX - bounds.left) / bounds.width - .5) * 2}deg`); }} onPointerLeave={e => { e.currentTarget.style.setProperty('--tilt-x', '0deg'); e.currentTarget.style.setProperty('--tilt-y', '0deg'); }}>
        <div className="panel-heading"><span className="eyebrow"><span className="live-dot" /> SELECTED TARGET</span><button className="icon-button" aria-label="별 선택 해제" onClick={() => selectStar(null)}><X size={16} /></button></div>
        <div className="target-title"><div><p className="mono faint">TIC {star.tic}</p><h2>{star.name}</h2></div><span className="star-emblem"><span /><i /></span></div>
        <div className="target-tags"><span><Radio size={11} /> TESS 관측 자료</span><span className="faint">{star.sectors.length} SECTORS</span></div>
        <div className="target-metrics"><div><span>밝기 등급</span><strong>{star.magnitude.toFixed(2)}<small> mag</small></strong></div><div><span>표면 온도</span><strong>{formatNumber(Math.round(star.temperature))}<small> K</small></strong></div><div><span>항성 반지름</span><strong>{star.radius.toFixed(3)}<small> R☉</small></strong></div><div><span>관측점</span><strong>{formatNumber(star.pointCount)}</strong></div></div>
        <div className="coordinates mono"><span>RA <b>{coordinate(star.ra)}</b></span><span>DEC <b>{coordinate(star.dec, true)}</b></span></div>
        <div className="observations-heading"><span>관측 회차</span><span className="mono">SPOC · PDCSAP</span></div>
        <div className="observation-list">{star.observations.map(item => <div key={item.sector}><span className="sector-index">{String(item.sector).padStart(2, '0')}</span><span><b>SECTOR {item.sector}</b><small>{item.start} — {item.end}</small></span><Check size={13} /></div>)}</div>
        <button className="primary-button analysis-start" onClick={openAnalysis} disabled={loadState !== 'ready'}>{loadState === 'loading' ? <><LoaderCircle size={16} className="spin" />관측 자료 불러오는 중</> : loadState === 'error' ? '관측 자료 연결 실패' : <>이 별 분석하기 <ArrowUpRight size={17} /></>}</button>
        {loadState === 'error' ? <button className="text-button retry-button" onClick={() => setRetry(v => v + 1)}>다시 불러오기 <RotateCcw size={13} /></button> : <p className="panel-footnote">작은 밝기 변화 속에서 행성의 흔적을 찾아보세요.</p>}
      </aside> : <aside className="empty-target holo-panel"><Crosshair size={30} /><h2>어떤 별이 궁금한가요?</h2><p>지도 위의 별이나 아래 관측 대상을 선택해 주세요.</p></aside>}
      <section className="target-dock" aria-label="관측 대상 목록"><div className="dock-label"><span className="eyebrow">OBSERVATION TARGETS</span><span>관측 가능한 별 <b>03</b></span></div><div className="target-cards">{targets.map((target, index) => <button key={target.id} className={`target-card holo-panel ${selectedId === target.id ? 'active' : ''}`} onClick={() => selectStar(target.id)}><span className="card-number">0{index + 1}</span><span className="tiny-star" style={{ '--star-color': index === 2 ? '#edb994' : '#a8f0eb' } as CSSProperties} /><div><strong>{target.name}</strong><small>TIC {target.tic}</small></div><span className="card-sectors">{target.sectors.length} SECTORS</span><ArrowUpRight size={15} /></button>)}</div></section>
    </main>}

    {mode === 'analyze' && star && <main className="analysis-workspace" aria-label="관측 분석">
      <div className="analysis-topline"><button className="text-button" onClick={() => setMode('explore')}><ArrowLeft size={14} />별 지도로</button><span className="analysis-target-name">{star.name} <small>TIC {star.tic}</small></span><span className="analysis-data-caption"><i className="live-dot" />{formatNumber(star.pointCount)} OBSERVATIONS</span></div>
      <div className="analysis-grid">
        <section className="analysis-stage holo-panel"><div className="chart-panel-header"><div><span className="eyebrow">SIGNAL EXPLORER</span><h2>{chartTitles[chartKind]}</h2></div><div className="chart-tabs" role="tablist" aria-label="주 분석 차트">{(['light', 'period', 'phase'] as ChartKind[]).map(kind => <button key={kind} role="tab" aria-selected={kind === chartKind} className={kind === chartKind ? 'active' : ''} onClick={() => setChartKind(kind)}>{chartTitles[kind]}</button>)}</div></div>
          {loadState === 'loading' ? <div className="chart-message"><LoaderCircle className="spin" /><p>관측 자료를 불러오고 있어요.</p></div> : loadState === 'error' || !data ? <div className="chart-message"><Radio /><p>관측 자료를 불러오지 못했어요.</p><button className="secondary-button" onClick={() => setRetry(v => v + 1)}>다시 시도</button></div> : <>
            <div className="main-chart"><ObservationChart data={data} kind={chartKind} period={period} range={range} onRangeChange={step === 2 && !busy ? selectRange : undefined} onPeakSelect={selectPeak} resetKey={chartReset} onBusyChange={chartKind === 'phase' ? setBusy : undefined} /></div>
            <div className="chart-reading"><span><i className="legend-dot" />관측 데이터</span>{chartKind === 'phase' && <span><i className="legend-line" />구간별 평균</span>}<span className="chart-guidance">{chartKind === 'period' ? '봉우리를 선택해 반복되는 신호를 찾아보세요' : chartKind === 'light' ? '시간에 따른 밝기 변화와 관측 구간을 살펴보세요' : step === 2 ? '그래프를 드래그해 가려짐 구간을 선택하세요' : '스크롤로 확대 · 0 키로 초기화'}</span>{busy && <span className="computing" role="status">접는 중…</span>}</div>
            <div className="secondary-charts">{(['light', 'period', 'phase'] as ChartKind[]).filter(kind => kind !== chartKind).map(kind => <section key={kind}><button className="secondary-chart-title" onClick={() => setChartKind(kind)}><span>{chartTitles[kind]}<small>{kind === 'light' ? 'LIGHT CURVE' : kind === 'period' ? 'PERIODOGRAM' : 'PHASE FOLD'}</small></span><Maximize2 size={13} /></button><ObservationChart data={data} kind={kind} period={period} range={range} compact onPeakSelect={selectPeak} resetKey={chartReset} onBusyChange={kind === 'phase' ? setBusy : undefined} /></section>)}</div>
          </>}
        </section>
        <aside className="analysis-inspector holo-panel"><div className="panel-heading"><span className="eyebrow">YOUR OBSERVATION</span><span className="step-count mono">0{step + 1}<small> / 05</small></span></div>
          <div className="step-progress" aria-label={`분석 단계 ${step + 1}: ${steps[step]}`}>{steps.map((label, index) => <button key={label} title={label} aria-label={`${index + 1}단계 ${label}`} className={index === step ? 'current' : index < step ? 'done' : ''} disabled={index > step || busy} onClick={() => { setStep(index); setChartKind(index === 0 ? 'period' : 'phase'); }}>{index < step ? <Check size={10} /> : index + 1}</button>)}</div>
          <h2>{steps[step]}</h2><p className="step-description">{['높게 솟은 봉우리는 밝기 변화가 반복될 가능성을 보여줘요.', '주기를 조금씩 조절하며 밝기 변화가 한곳에 모이는지 살펴보세요.', '별빛이 낮아지는 구간의 시작과 끝을 그래프에서 선택하세요.', '직접 살펴본 신호에 대한 생각을 남겨주세요.', '선택한 값과 판단을 확인하고 관측 기록으로 남겨보세요.'][step]}</p>
          <div className="step-content">
            {step === 0 && <div className="peak-list">{data?.peaks.slice(0, 5).map(p => <button key={p.id} onClick={() => selectPeak(p)}><span className="peak-rank">0{p.rank}</span><span><strong>{p.period_days.toFixed(6)} <small>d</small></strong><span className="peak-power"><i style={{ width: `${p.relative_power * 100}%` }} /></span></span><ChevronRight size={15} /></button>)}<p className="field-hint">저장된 BLS 결과의 후보 주기입니다.</p></div>}
            {(step === 1 || step === 2) && peak && <>
              <div className="period-box"><label htmlFor="period-input">반복 주기 <span>PERIOD / DAYS</span></label><div><button aria-label="주기 한 단계 감소" onClick={() => changePeriod(period - peak.period_step)} disabled={period <= peak.period_min || busy}><Minus size={14} /></button><input id="period-input" inputMode="decimal" value={periodDraft} aria-invalid={periodInvalid} onChange={e => { setPeriodDraft(e.target.value); const n = Number(e.target.value); if (e.target.value.trim() && Number.isFinite(n) && n >= peak.period_min && n <= peak.period_max) { changePeriod(n); setPeriodDraft(e.target.value); } }} onBlur={() => { if (periodInvalid) setPeriodDraft(period.toFixed(6)); }} /><button aria-label="주기 한 단계 증가" onClick={() => changePeriod(period + peak.period_step)} disabled={period >= peak.period_max || busy}><Plus size={14} /></button></div></div>
              <input className="period-slider" type="range" aria-label="주기 미세 조절" min={peak.period_min} max={peak.period_max} step={peak.period_step} value={period} onChange={e => changePeriod(Number(e.target.value))} />
              <div className="slider-limits mono"><span>{peak.period_min.toFixed(4)} d</span><span>{peak.period_max.toFixed(4)} d</span></div>
              <button className="text-button reset-period" onClick={() => changePeriod(peak.period_days)}><RotateCcw size={12} />선택한 봉우리의 주기로</button>
              {step === 1 && <div className="step-tip"><Sparkles size={16} /><span>밝기가 낮아지는 점들이 같은 위치에 모이는 주기를 찾아보세요.</span></div>}
              {step === 2 && <div className={`selection-summary ${range ? 'has-range' : ''}`}><div><span>선택한 위상 구간</span>{range && <button className="icon-button" aria-label="선택 구간 지우기" onClick={() => selectRange(null)}><X size={13} /></button>}</div><strong className="mono">{range ? `${range[0].toFixed(4)} — ${range[1].toFixed(4)}` : '구간을 선택해 주세요'}</strong><p>지속 시간 <b>{duration === null ? '—' : `${duration.toFixed(3)} h`}</b></p><small>양 끝 핸들로 경계를 조절할 수 있어요.</small></div>}
            </>}
            {step === 3 && <><div className="judgments" role="radiogroup" aria-label="신호 판단">{['행성 같음', '아닌 것 같음', '모르겠음'].map((value, index) => <button role="radio" aria-checked={judgment === value} className={judgment === value ? 'active' : ''} key={value} onClick={() => setJudgment(value)}><span className="judgment-circle">{judgment === value && <span />}</span>{value}<small>0{index + 1}</small></button>)}</div><label className="input-label">참고한 근거 <small>선택</small></label><div className="evidence-list">{reasons.map(reason => <label key={reason}><input type="checkbox" checked={evidence.includes(reason)} onChange={e => setEvidence(prev => e.target.checked ? [...prev, reason] : prev.filter(item => item !== reason))} />{reason}</label>)}</div><label className="input-label" htmlFor="observation-memo">관측 메모 <small>선택</small></label><textarea id="observation-memo" placeholder="어떤 점이 눈에 띄었나요?" maxLength={500} value={memo} onChange={e => setMemo(e.target.value)} /><small className="memo-count">{memo.length} / 500</small></>}
            {step === 4 && <div className="review-summary"><span className="summary-star"><Orbit size={20} />{star.name}</span><dl><div><dt>판단</dt><dd className="accent">{judgment}</dd></div><div><dt>주기</dt><dd>{period.toFixed(6)} d</dd></div><div><dt>위상 구간</dt><dd>{range?.[0].toFixed(4)} – {range?.[1].toFixed(4)}</dd></div><div><dt>지속 시간</dt><dd>{duration?.toFixed(3)} h</dd></div><div><dt>중심 시각</dt><dd>{epoch?.toFixed(5)}<small> BTJD</small></dd></div><div><dt>근거</dt><dd>{evidence.join(' · ') || '선택 안 함'}</dd></div></dl>{memo && <p className="review-memo">{memo}</p>}<p className="field-hint">이 브라우저의 관측 기록에 저장됩니다.</p></div>}
          </div>
          <div className="step-actions">{step > 0 && <button className="secondary-button" disabled={busy} onClick={() => { const next = step - 1; setStep(next); setChartKind(next === 0 ? 'period' : 'phase'); }}><ArrowLeft size={14} />이전</button>}<button className="primary-button" disabled={step === 4 ? !range || !judgment || busy : !canNext} onClick={() => { if (step === 4) saveNote(); else { setStep(step + 1); setChartKind('phase'); } }}>{step === 4 ? '관측 기록 저장' : step === 1 ? '주기 확정' : '다음 단계'}<ArrowRight size={15} /></button></div>
        </aside>
      </div>
    </main>}

    {mode === 'records' && <main className="records-workspace holo-panel"><div className="panel-heading"><div><span className="eyebrow">OBSERVATION LOG</span><h2>별빛을 읽어낸 순간들 <span>{String(notes.length).padStart(2, '0')}</span></h2></div><button className="secondary-button" onClick={() => setMode('explore')}><Compass size={14} />새로운 관측</button></div>{notes.length === 0 ? <div className="records-empty"><NotebookPen size={38} strokeWidth={1} /><h3>첫 번째 관측을 기다리고 있어요.</h3><p>별을 분석하고 기록을 저장하면 이곳에서 다시 살펴볼 수 있습니다.</p><button className="primary-button" onClick={() => setMode('explore')}>별 탐색하기 <ArrowRight size={15} /></button></div> : <div className="record-list">{notes.map(note => <article key={note.id}><span className="record-orbit"><Orbit size={25} strokeWidth={1} /></span><div className="record-name"><h3>{note.starName}</h3><p>TIC {note.tic}<span>·</span>{new Date(note.createdAt).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</p></div><div><small>주기</small><strong className="mono">{note.period.toFixed(6)} d</strong></div><span className="record-judgment">{note.judgment}</span><button className="text-button" onClick={() => { selectStar(note.starId); setRestore(note); }}>다시 열기 <ArrowUpRight size={16} /></button></article>)}</div>}<p className="records-note">이 기기의 브라우저에 저장된 기록입니다.</p></main>}

    <footer className="statusbar"><span><i className="live-dot" />{mode === 'analyze' ? 'ANALYSIS SESSION' : 'OBSERVATION DECK'}<span className="footer-divider">/</span><span className="muted">LOCAL PREVIEW</span></span><span className="statusbar-center">EXPLORE THE UNKNOWN.</span><button onClick={() => setHelp(true)}>프로토타입 안내<ArrowUpRight size={11} /></button></footer>
    {notice && <div className="toast holo-panel" role="status"><Check size={16} />{notice}<button className="icon-button" aria-label="알림 닫기" onClick={() => setNotice('')}><X size={14} /></button></div>}
    {help && <Dialog title="관측 작업대 사용 안내" onClose={() => setHelp(false)}><p className="dialog-intro">홀로그램 패널의 배치와 조작을 살펴보는 임시 프론트엔드입니다.</p><ol className="help-steps"><li><b>별 선택</b><span>지도 또는 아래 카드에서 관측할 별을 선택합니다.</span></li><li><b>신호 탐색</b><span>주기도의 봉우리를 선택하고 반복 주기를 조절합니다.</span></li><li><b>구간과 판단</b><span>접힌 곡선에서 구간을 드래그한 뒤 판단을 기록합니다.</span></li></ol><div className="help-scope"><Radio size={17} /><p>세 항성의 곡선은 기존 TESS 관측 export를 사용합니다. 별의 화면 위치와 배경은 탐색 시안용 배치이며, 서버 제출·AI 평가에는 연결되어 있지 않습니다.</p></div><p className="keyboard-help"><kbd>/</kbd> 별 검색 <kbd>Esc</kbd> 별 지도로 <kbd>0</kbd> 차트 확대 초기화</p><button className="primary-button" onClick={() => setHelp(false)}>관측 시작하기 <ArrowRight size={15} /></button></Dialog>}
    <div className="desktop-notice"><Orbit size={42} /><h2>넓은 화면에서 만나보세요.</h2><p>관측 작업대는 1024px 이상의 데스크톱 화면에 맞춘 시안입니다.</p></div>
  </div>;
}
