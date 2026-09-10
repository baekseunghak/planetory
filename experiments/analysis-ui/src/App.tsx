import { useEffect, useMemo, useRef, useState } from 'react';
import { CurvePreview } from './components/CurvePreview';
import { Icon, OrbitMark } from './components/Icons';
import {
  createMockSession,
  scenarioOptions,
  MockServiceError,
  type AnalysisResult,
  type SubmissionInput,
  type Judgment,
  type PublicationReview,
  type PublicationBatch,
  type DetailView,
} from './mock/analysis-service';

const judgments: Record<Judgment, string> = {
  LIKELY_PLANET: '행성 같음',
  UNLIKELY_PLANET: '아닌 것 같음',
  UNSURE: '모르겠음',
};
const types: Record<string, string> = {
  CONFIRMED: '확인된 행성',
  FP: '행성 아님 · FP',
  UNCONFIRMED: '미확정 신호',
};
const reasons: Record<string, string> = {
  AGREES: '판단 일치',
  DISAGREES: '판단 불일치',
  UNSURE: '판단 보류',
  UNSCORED: '정답이 정해지지 않음',
  NOT_APPLICABLE: '판단 비교 대상 없음',
};
const evidenceNames: Record<string, string> = {
  ODD_EVEN_SIMILAR: '홀짝 깊이',
  NO_SECONDARY_ECLIPSE: '2차 식',
  U_SHAPED: 'V·U형',
  OUTSIDE_BAD_QUALITY: '품질 구간',
};
const format = (n: number | undefined, digits = 4) =>
  n === undefined ? '—' : Number(n.toFixed(digits)).toString();
const timestamp = (value: string) =>
  new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Seoul',
    hour12: false,
  }).format(new Date(value));
type Page = 'result' | 'retry' | 'history' | 'publication';
type PublicItem = PublicationBatch['items'][number];

function failureText(error: unknown) {
  if (error instanceof MockServiceError) {
    if (error.code === 'BUNDLE_EXPIRED')
      return '이 분석의 복원 자료를 사용할 수 없습니다. 기존 기록과 탐색 완료는 유지됩니다.';
    if (['THREAD_UNAVAILABLE', 'RESOURCE_UNAVAILABLE'].includes(error.code))
      return '이 신호의 스레드는 현재 공개할 수 없습니다. 개인 분석은 그대로 보관됩니다.';
  }
  return '요청을 처리하지 못했습니다. 현재 기록을 유지했어요. 다시 시도해 주세요.';
}

function initialScenario() {
  const fromUrl = new URLSearchParams(window.location.search).get('scenario');
  return scenarioOptions.some((s) => s.id === fromUrl) ? fromUrl! : 'last-fp-wrong';
}

export function App() {
  const [scenario, setScenario] = useState(initialScenario);
  const [reset, setReset] = useState(0);
  const session = useMemo(() => createMockSession(scenario), [scenario, reset]);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [page, setPage] = useState<Page>('result');
  const [draft, setDraft] = useState<SubmissionInput | null>(null);
  const [judgment, setJudgment] = useState<Judgment>('UNSURE');
  const [review, setReview] = useState<PublicationReview | null>(null);
  const [reviewChoices, setReviewChoices] = useState<Record<string, string>>({});
  const [publicItems, setPublicItems] = useState<Record<string, PublicItem>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [posting, setPosting] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>('load');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [detail, setDetail] = useState<DetailView | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const liveSession = useRef(session);

  useEffect(() => {
    liveSession.current = session;
    let active = true;
    setBusy('load');
    setResult(null);
    setPage('result');
    setDraft(null);
    setReview(null);
    setPublicItems({});
    setReviewChoices({});
    setSelected([]);
    setPosting([]);
    setError('');
    setNotice('');
    setDetail(null);
    session
      .getResult()
      .then((value) => {
        if (active) setResult(value);
      })
      .catch((e) => {
        if (active) setError(failureText(e));
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => {
      active = false;
    };
  }, [session]);

  useEffect(() => {
    if (detail && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [detail]);
  useEffect(() => {
    if (result) heading.current?.focus({ preventScroll: true });
  }, [page]);

  async function run(action: string, work: () => Promise<void>) {
    if (busy) return;
    const current = session;
    setBusy(action);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      if (liveSession.current === current) setError(failureText(e));
    } finally {
      if (liveSession.current === current) {
        setBusy(null);
        setPosting([]);
      }
    }
  }
  function chooseScenario(id: string) {
    const url = new URL(window.location.href);
    url.searchParams.set('scenario', id);
    window.history.replaceState(null, '', url);
    setScenario(id);
  }
  async function openReview() {
    await run('review', async () => {
      const next = await session.getReview();
      setReview(next);
      setReviewChoices(
        Object.fromEntries(
          next.items
            .filter((item) => item.is_representative)
            .map((item) => [item.candidate_id, item.history_id]),
        ),
      );
      setSelected(
        next.items
          .filter((item) => item.eligible && item.is_representative)
          .map((item) => item.history_id),
      );
      if (next.items.some((item) => item.reason === 'THREAD_UNAVAILABLE'))
        setError('이 신호의 스레드는 현재 공개할 수 없습니다. 개인 분석은 그대로 보관됩니다.');
      setPage('publication');
    });
  }
  async function restore() {
    await run('restore', async () => {
      const input = await session.restore();
      setDraft(input);
      setJudgment(input.user_judgment);
      setPage('retry');
    });
  }
  function chooseHistory(candidateId: string, historyId: string) {
    const alternatives =
      review?.items
        .filter((item) => item.candidate_id === candidateId)
        .map((item) => item.history_id) ?? [];
    setReviewChoices((previous) => ({ ...previous, [candidateId]: historyId }));
    setSelected((previous) => [
      ...previous.filter((id) => !alternatives.includes(id)),
      ...(previous.some((id) => alternatives.includes(id)) ? [historyId] : []),
    ]);
  }
  async function submit() {
    await run('submit', async () => {
      const next = await session.submitJudgment(judgment);
      setResult(next);
      setDraft(null);
      setPage('result');
      setNotice('새 분석을 개인 기록에 저장했어요. 이전 제출은 그대로 남아 있습니다.');
    });
  }
  async function publish(ids: string[]) {
    if (!ids.length) return;
    await run('publish', async () => {
      setPosting(ids);
      const batch = await session.publish(ids, crypto.randomUUID());
      setPublicItems((previous) => ({
        ...previous,
        ...Object.fromEntries(batch.items.map((item) => [item.history_id, item])),
      }));
      const failures = batch.items
        .filter((item) => item.status === 'FAILED')
        .map((item) => item.history_id);
      setSelected(failures);
      setNotice(
        failures.length
          ? '일부 분석을 게시하지 못했어요. 성공한 분석은 유지되며, 실패한 항목만 다시 시도할 수 있어요.'
          : '분석을 공개했어요. 최신 성과에 반영했습니다.',
      );
    });
  }

  const summary = session.getSummary();
  const stats = session.getStatistics();
  const history = session.getHistory();
  const complete = result?.progress.stage === 'COMPLETED';
  const matched = result?.match.candidate_id !== null;
  const currentPublication = result ? session.getPublication(result.history_id) : null;
  const currentPublic = currentPublication?.status === 'PUBLIC';
  const visibleReview =
    review?.items.filter((item) => reviewChoices[item.candidate_id] === item.history_id) ?? [];
  const eligibleIds = visibleReview
    .filter((item) => item.eligible && publicItems[item.history_id]?.status !== 'PUBLIC')
    .map((item) => item.history_id);
  const failedIds = visibleReview
    .filter((item) => publicItems[item.history_id]?.status === 'FAILED')
    .map((item) => item.history_id);
  const pageNames = {
    result: '분석 결과',
    retry: '다시 풀기',
    history: '개인 분석 기록',
    publication: '분석 공개 검토',
  };

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
        <span className="pill neutral">분석 화면 미리보기</span>
      </div>
      <div className="desktop-app">
        <div className="preview-bar">
          <span className="preview-label">
            <i />
            분석 흐름 미리보기 <span className="preview-divider">/</span> 합성 데이터
          </span>
          <div className="preview-controls">
            <label htmlFor="scenario">시나리오</label>
            <select
              id="scenario"
              value={scenario}
              disabled={!!busy}
              onChange={(e) => chooseScenario(e.target.value)}
            >
              {scenarioOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              className="text-button"
              disabled={!!busy}
              onClick={() => setReset((n) => n + 1)}
            >
              <Icon name="retry" size={14} />
              초기화
            </button>
          </div>
        </div>
        <div className="app-shell">
          <aside className="sidebar">
            <div className="brand">
              <OrbitMark />
              <span>
                Planetory<span className="brand-period">.</span>
              </span>
            </div>
            <div className="workspace-label">MY EXPLORATION</div>
            <nav aria-label="분석 화면">
              <button
                className={page === 'result' || page === 'retry' ? 'active' : ''}
                onClick={() => setPage('result')}
                disabled={!!busy}
              >
                <Icon name="chart" />
                분석 결과
                <span className="nav-dot" />
              </button>
              <button
                className={page === 'history' ? 'active' : ''}
                onClick={() => setPage('history')}
                disabled={!!busy}
              >
                <Icon name="history" />
                개인 기록<span className="nav-count">{history.length}</span>
              </button>
              <button
                className={page === 'publication' ? 'active' : ''}
                onClick={openReview}
                disabled={!!busy || result?.signal?.disposition !== 'UNCONFIRMED'}
              >
                <Icon name="share" />
                분석 공개
              </button>
            </nav>
            <div className="sidebar-star">
              <div className="star-orbit">
                <span />
              </div>
              <span className="eyebrow">CURRENT STAR</span>
              <strong>샘플 항성 001</strong>
              <span className="subtle">TIC · 합성 관측 대상</span>
              <div className={'star-progress ' + (complete ? 'done' : '')}>
                <Icon name={complete ? 'check' : 'chart'} size={14} />
                {complete ? '탐색 완료' : '탐색 진행 중'}
              </div>
            </div>
            <div className="sidebar-bottom">
              <span className="avatar">P</span>
              <div>
                나의 탐사 공간<small>로컬 미리보기</small>
              </div>
            </div>
          </aside>
          <main className="main-content" aria-busy={!!busy}>
            <header className="topbar">
              <div>
                내 탐사 <span>/</span> 샘플 항성 001 <span>/</span> <b>{pageNames[page]}</b>
              </div>
              <span className="private-note">
                <i />
                개인 기록으로 저장
              </span>
            </header>
            {!result ? (
              <div className="loading-view" role="status">
                <span className="spinner" />
                분석 기록을 불러오고 있어요.
              </div>
            ) : (
              <div className="page-content">
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">
                      {page === 'publication'
                        ? 'SHARE YOUR DISCOVERY'
                        : page === 'history'
                          ? 'YOUR ANALYSIS LOG'
                          : 'SIGNAL ANALYSIS'}
                    </p>
                    <h1 ref={heading} tabIndex={-1}>
                      {pageNames[page]}
                    </h1>
                    <p className="subtitle">
                      {page === 'publication'
                        ? '공개할 내용을 확인하고, 공유할 분석을 선택하세요.'
                        : page === 'history'
                          ? '제출한 분석을 보관하고, 판단이 바뀐 과정을 확인하세요.'
                          : page === 'retry'
                            ? '제출 당시의 곡선과 입력을 불러왔어요. 판단을 다시 살펴보세요.'
                            : '신호의 발견, 내 판단, 성과를 각각 확인하세요.'}
                    </p>
                  </div>
                  <span className={'pill ' + (complete ? 'success' : 'neutral')}>
                    <Icon name={complete ? 'check' : 'chart'} size={14} />
                    {complete ? '탐색 완료' : '탐색 진행 중'}
                  </span>
                </div>
                {error && (
                  <div role="alert" className="notice error">
                    <span>{error}</span>
                    <button
                      className="icon-button"
                      aria-label="오류 안내 닫기"
                      onClick={() => setError('')}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                )}
                {notice && (
                  <div role="status" className="notice">
                    <Icon name="check" />
                    <span>{notice}</span>
                  </div>
                )}

                {page === 'result' && (
                  <>
                    <section className="result-hero">
                      <div className="hero-symbol">
                        <OrbitMark size={54} />
                      </div>
                      <div>
                        <span className="eyebrow">
                          {matched ? types[result.signal?.disposition ?? ''] : 'SIGNAL REVIEW'}
                        </span>
                        <h2>
                          {result.match.status === 'not_matched'
                            ? '일치하는 신호를 찾지 못했어요.'
                            : result.match.status === 'ambiguous_match'
                              ? '신호를 구분하기 어려워요.'
                              : result.judgment.evaluation === 'DISAGREES'
                                ? '신호는 찾았어요. 판단을 다시 살펴볼까요?'
                                : result.judgment.evaluation === 'UNSURE'
                                  ? '신호를 찾았고, 판단은 보류했어요.'
                                  : result.signal?.disposition === 'UNCONFIRMED'
                                    ? '새로운 분석을 함께 살펴볼 수 있어요.'
                                    : result.match.status === 'duplicate'
                                      ? '이미 성과를 인정받은 신호예요.'
                                      : '신호와 판단을 확인했어요.'}
                        </h2>
                        <p>
                          {result.judgment.evaluation === 'DISAGREES'
                            ? '내 판단이 확인된 기록과 달라도 신호 매칭과 탐색 완료는 유지돼요.'
                            : result.signal?.disposition === 'UNCONFIRMED'
                              ? '공개는 선택이에요. 공개하지 않아도 탐색 완료와 개인 기록은 유지됩니다.'
                              : !matched
                                ? '개인 기록에 저장했어요. 행성이 없거나 새 신호라고 단정하지 않습니다.'
                                : '이번 분석 결과와 기존에 인정받은 성과를 구분해 확인해 보세요.'}
                        </p>
                      </div>
                    </section>
                    <div className="result-status-grid">
                      <StatusCard
                        label="신호 매칭"
                        value={
                          matched
                            ? result.match.status === 'matched_harmonic'
                              ? '고조파 일치'
                              : '신호 일치'
                            : result.match.status === 'ambiguous_match'
                              ? '구분 어려움'
                              : '일치 없음'
                        }
                        tone={matched ? 'mint' : 'muted'}
                      />
                      <StatusCard
                        label="내 판단"
                        value={reasons[result.judgment.evaluation]}
                        tone={
                          result.judgment.evaluation === 'DISAGREES'
                            ? 'amber'
                            : result.judgment.evaluation === 'AGREES'
                              ? 'mint'
                              : 'muted'
                        }
                      />
                      <StatusCard
                        label="이번 성과"
                        value={
                          result.achievement.awarded_now ||
                          currentPublication?.achievement.awarded_now
                            ? '최초 성과 인정'
                            : result.achievement.previously_recognized ||
                                currentPublication?.achievement.previously_recognized
                              ? '추가 인정 없음'
                              : '성과 미인정'
                        }
                        tone={
                          result.achievement.awarded_now ||
                          currentPublication?.achievement.awarded_now
                            ? 'mint'
                            : 'muted'
                        }
                      />
                      <StatusCard
                        label="분석 공개"
                        value={
                          currentPublic
                            ? '공개됨'
                            : result.signal?.disposition === 'UNCONFIRMED'
                              ? '미게시'
                              : '공개 대상 아님'
                        }
                        tone={currentPublic ? 'mint' : 'muted'}
                      />
                    </div>
                    <div className="analysis-columns">
                      <div className="main-column">
                        <section className="panel">
                          <CurvePreview />
                          <div className="panel-divider" />
                          <div className="panel-pad">
                            <div className="section-label">
                              제출한 분석
                              <span className="subtle">{timestamp(result.submitted_at)} KST</span>
                            </div>
                            <InputValues
                              input={result.original_input}
                              derived={result.server_derived}
                            />
                            {result.match.correction && (
                              <div className="correction-note">
                                고조파 정정 · 내 주기{' '}
                                <b>{format(result.original_input.selection.period_days)}일</b> →
                                대표 주기{' '}
                                <b>{format(result.match.correction.canonical_period_days)}일</b> · ×
                                {result.match.correction.period_multiplier}
                                <span>제출 원본과 재도전 입력은 그대로 보존됩니다.</span>
                              </div>
                            )}
                            <div className="judgment-line">
                              <span>내 판단</span>
                              <b>{judgments[result.original_input.user_judgment]}</b>
                              {result.signal && (
                                <>
                                  <span className="line-divider" />
                                  <span>확인 상태</span>
                                  <b>{types[result.signal.disposition]}</b>
                                </>
                              )}
                            </div>
                            <details className="record-details">
                              <summary>제출 당시 기록 정보</summary>
                              <RecordContext input={result.original_input} />
                              <p>기록 ID · {result.history_id}</p>
                            </details>
                          </div>
                        </section>
                        <div className="action-bar">
                          <div>
                            {result.achievement.previously_recognized ? (
                              <>
                                <Icon name="check" />
                                <span>기존에 인정받은 성과는 유지돼요.</span>
                              </>
                            ) : (
                              <span>판단을 다시 해도 이전 기록은 남아 있어요.</span>
                            )}
                          </div>
                          <div className="actions">
                            <button
                              className="button secondary"
                              disabled={!!busy || !result.detail.available}
                              onClick={() =>
                                run('detail', async () => setDetail(await session.getDetail()))
                              }
                            >
                              {busy === 'detail'
                                ? '불러오는 중…'
                                : matched
                                  ? '이 신호 상세 보기'
                                  : '상세 보기'}
                            </button>
                            <button className="button primary" disabled={!!busy} onClick={restore}>
                              <Icon name="retry" size={16} />
                              {busy === 'restore' ? '복원 중…' : '다시 풀기'}
                            </button>
                          </div>
                        </div>
                        {!result.detail.available && (
                          <p className="footnote">이 제출에 제공할 신호 해설이 없습니다.</p>
                        )}
                        {result.signal?.disposition === 'UNCONFIRMED' && (
                          <div className="share-strip">
                            <div>
                              <Icon name="share" />
                              <span>
                                내 분석을 다른 탐사자와 공유해 보세요.
                                <small>첫 공개 성공 시 미확정 성과를 인정해요.</small>
                              </span>
                            </div>
                            <button
                              className="button secondary"
                              disabled={!!busy}
                              onClick={openReview}
                            >
                              공개 내용 검토
                              <Icon name="arrow" size={16} />
                            </button>
                          </div>
                        )}
                      </div>
                      <aside className="context-column">
                        <SummaryCard
                          summary={summary}
                          matchedCount={result.progress.matched_candidate_ids.length}
                        />
                        {matched && (
                          <>
                            <section className="panel panel-pad">
                              <div className="section-label">
                                AI 평가<span className="tag">참고 정보</span>
                              </div>
                              <div className="empty-ai">
                                <span>평가 정보 없음</span>
                                <p>아직 평가하지 않은 신호예요.</p>
                              </div>
                              <p className="footnote">AI 점수는 성과 인정에 사용하지 않아요.</p>
                            </section>
                            <StatisticsCard stats={stats} />
                          </>
                        )}
                      </aside>
                    </div>
                  </>
                )}

                {page === 'retry' && draft && (
                  <div className="analysis-columns">
                    <section className="panel">
                      <div className="panel-pad">
                        <div className="section-label">
                          제출 당시 분석 복원<span className="pill success">복원됨</span>
                        </div>
                        <InputValues input={draft} derived={result.server_derived} />
                        <p className="footnote">
                          이번 미리보기에서는 복원한 수치를 유지하고 판단을 다시 제출합니다.
                        </p>
                        <RecordContext input={draft} />
                        <div className="panel-divider spaced" />
                        <fieldset className="judgment-options">
                          <legend>이 신호는 행성일까요?</legend>
                          {(Object.keys(judgments) as Judgment[]).map((j) => (
                            <label key={j} className={judgment === j ? 'selected' : ''}>
                              <input
                                type="radio"
                                name="judgment"
                                value={j}
                                checked={judgment === j}
                                onChange={() => setJudgment(j)}
                                disabled={!!busy}
                              />
                              <span>{judgments[j]}</span>
                            </label>
                          ))}
                        </fieldset>
                        <div className="evidence">
                          <span className="section-label">복원한 근거</span>
                          <div>
                            {draft.evidence_flags.length ? (
                              draft.evidence_flags.map((flag) => (
                                <span className="evidence-chip" key={flag}>
                                  <Icon name="check" size={13} />
                                  {evidenceNames[flag] ?? flag}
                                </span>
                              ))
                            ) : (
                              <span className="subtle">선택한 근거 없음</span>
                            )}
                          </div>
                          <span className="disabled-evidence">중심 위치 · 데이터 없음</span>
                        </div>
                        <label className="memo-label">
                          복원한 메모
                          <textarea value={draft.memo} readOnly rows={3} />
                        </label>
                        <div className="button-row">
                          <button
                            className="button secondary"
                            disabled={!!busy}
                            onClick={() => {
                              setPage('result');
                              setDraft(null);
                            }}
                          >
                            취소
                          </button>
                          <button className="button primary" disabled={!!busy} onClick={submit}>
                            {busy === 'submit' ? '제출 중…' : '새 분석으로 제출'}
                            <Icon name="arrow" size={16} />
                          </button>
                        </div>
                      </div>
                    </section>
                    <aside className="context-column">
                      <SummaryCard
                        summary={summary}
                        matchedCount={result.progress.matched_candidate_ids.length}
                      />
                      <div className="quiet-note">
                        <Icon name="history" />
                        <h3>기록은 덮어쓰지 않아요</h3>
                        <p>
                          복원만으로 제출이나 성과가 추가되지 않아요. 제출하면 새로운 개인 기록으로
                          남습니다.
                        </p>
                        <p>현재 별의 탐색 상태는 유지됩니다.</p>
                      </div>
                    </aside>
                  </div>
                )}

                {page === 'history' && (
                  <section className="panel history-panel">
                    <div className="section-label">
                      개인 분석 기록<span className="subtle">{history.length}건 · 원본 보존</span>
                    </div>
                    <table>
                      <thead>
                        <tr>
                          <th>제출 시각 (KST)</th>
                          <th>주기 · 내 판단</th>
                          <th>이번 성과</th>
                          <th>기록 확인</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.map((item) => (
                          <tr key={item.history_id}>
                            <td>
                              {timestamp(item.submitted_at)}
                              <small>
                                곡선 단계 {item.original_input.curve_context.curve_step}
                              </small>
                              {session.isAnswerViewed(item.submission_id) && (
                                <small className="viewed-note">해설 열람</small>
                              )}
                            </td>
                            <td>
                              {format(item.original_input.selection.period_days)}일
                              <small>{judgments[item.original_input.user_judgment]}</small>
                            </td>
                            <td>
                              {item.achievement.awarded_now
                                ? '최초 성과 인정'
                                : item.achievement.previously_recognized
                                  ? '추가 인정 없음'
                                  : '성과 미인정'}
                            </td>
                            <td>
                              <details>
                                <summary>원본값 보기</summary>
                                <div className="history-source">
                                  <InputValues
                                    input={item.original_input}
                                    derived={item.server_derived}
                                  />
                                  <RecordContext input={item.original_input} />
                                  <p>{item.original_input.memo}</p>
                                  <code>{item.history_id}</code>
                                </div>
                              </details>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="footnote">
                      제출 당시 결과를 보여줍니다. 현재 누적 성과는 분석 결과 화면에서 확인할 수
                      있어요.
                    </p>
                  </section>
                )}

                {page === 'publication' && review && (
                  <>
                    <div className="publication-intro">
                      <span className="share-icon">
                        <Icon name="share" size={24} />
                      </span>
                      <div>
                        <h2>분석 공개는 선택이에요.</h2>
                        <p>
                          작성자·판단·수치·곡선·근거·메모가 공개됩니다.
                          <br />
                          나중에 게시해도 개인 기록과 탐색 완료는 그대로 유지돼요.
                        </p>
                      </div>
                    </div>
                    <div className="analysis-columns">
                      <section className="panel publication-panel">
                        <div className="section-label">
                          공개 내용 미리보기
                          <span className="subtle">{visibleReview.length}개 신호</span>
                        </div>
                        {review.items.length === 0 && (
                          <div className="empty-state">
                            <Icon name="check" size={30} />
                            <h3>지금 공개할 새 분석이 없습니다.</h3>
                            <p>이미 공개한 동일 기록은 다시 등록하지 않아요.</p>
                          </div>
                        )}
                        {visibleReview.map((item, index) => {
                          const current = publicItems[item.history_id];
                          const published = current?.status === 'PUBLIC';
                          const isPosting = posting.includes(item.history_id);
                          return (
                            <article className="publication-item" key={item.history_id}>
                              <div className="publication-item-top">
                                <label className="publish-choice">
                                  <input
                                    aria-label={'분석 ' + (index + 1) + ' 선택'}
                                    type="checkbox"
                                    checked={selected.includes(item.history_id)}
                                    onChange={(e) =>
                                      setSelected((ids) =>
                                        e.target.checked
                                          ? [...ids, item.history_id]
                                          : ids.filter((id) => id !== item.history_id),
                                      )
                                    }
                                    disabled={!!busy || published || !item.eligible}
                                  />
                                  <span>
                                    <strong>
                                      신호 {index + 1} ·{' '}
                                      {format(item.preview.selection.period_days)}일
                                    </strong>
                                    <small>
                                      {timestamp(item.preview.submitted_at)} KST · 나의 분석
                                    </small>
                                  </span>
                                </label>
                                <span
                                  className={
                                    'pill ' +
                                    (published
                                      ? 'success'
                                      : current?.status === 'FAILED'
                                        ? 'warning'
                                        : 'neutral')
                                  }
                                >
                                  {isPosting
                                    ? '게시 중…'
                                    : published
                                      ? '공개됨'
                                      : !item.eligible
                                        ? '공개 불가'
                                        : current?.status === 'FAILED'
                                          ? '게시 실패'
                                          : '미게시'}
                                </span>
                              </div>
                              <div className="publication-body">
                                {review.items.filter(
                                  (option) => option.candidate_id === item.candidate_id,
                                ).length > 1 && (
                                  <label className="history-picker">
                                    공개할 제출 기록
                                    <select
                                      aria-label={'신호 ' + (index + 1) + ' 공개 기록'}
                                      value={item.history_id}
                                      onChange={(event) =>
                                        chooseHistory(item.candidate_id, event.target.value)
                                      }
                                      disabled={!!busy || published || !item.eligible}
                                    >
                                      {review.items
                                        .filter(
                                          (option) => option.candidate_id === item.candidate_id,
                                        )
                                        .map((option) => (
                                          <option key={option.history_id} value={option.history_id}>
                                            {option.is_representative
                                              ? '최신 제출 · '
                                              : '과거 제출 · '}
                                            {timestamp(option.preview.submitted_at)} ·{' '}
                                            {judgments[option.preview.user_judgment]}
                                          </option>
                                        ))}
                                    </select>
                                  </label>
                                )}
                                <span className="pill neutral">
                                  {judgments[item.preview.user_judgment]}
                                </span>
                                <p>
                                  {published
                                    ? '공식 신호 스레드의 공개 분석 목록에 등록했어요.'
                                    : item.destination_thread_id
                                      ? '이 신호의 공식 스레드에 분석을 추가해요.'
                                      : '첫 공개 성공 시 공식 신호 스레드가 생성돼요.'}
                                </p>
                                <details>
                                  <summary>공개할 전체 내용 보기</summary>
                                  <dl className="public-preview">
                                    <dt>작성자</dt>
                                    <dd>나 · {item.preview.author_id}</dd>
                                    <dt>원본 주기</dt>
                                    <dd>{format(item.preview.selection.period_days)}일</dd>
                                    <dt>위상 구간</dt>
                                    <dd>
                                      {format(item.preview.selection.phase_start)} ~{' '}
                                      {format(item.preview.selection.phase_end)}
                                    </dd>
                                    <dt>서버 파생값</dt>
                                    <dd>
                                      epoch {format(item.preview.server_derived.epoch_btjd)} BTJD ·
                                      지속 {format(item.preview.server_derived.duration_days)}일
                                    </dd>
                                    <dt>근거</dt>
                                    <dd>
                                      {item.preview.evidence_flags
                                        .map((flag) => evidenceNames[flag] ?? flag)
                                        .join(', ') || '선택 없음'}
                                    </dd>
                                    <dt>메모</dt>
                                    <dd>{item.preview.memo || '메모 없음'}</dd>
                                    <dt>곡선 · 버전</dt>
                                    <dd>
                                      단계 {item.preview.curve_context.curve_step} ·{' '}
                                      {item.preview.curve_context.publication_bundle_id}
                                    </dd>
                                  </dl>
                                  <CurvePreview />
                                </details>
                                {current?.status === 'FAILED' && (
                                  <p className="inline-error">
                                    일시적으로 게시하지 못했습니다. 개인 기록은 유지되며 다시 시도할
                                    수 있어요.
                                  </p>
                                )}
                                {published && (
                                  <p className="publication-reward">
                                    <Icon name="check" size={15} />
                                    {current.achievement.awarded_now
                                      ? '최초 미확정 성과 인정'
                                      : '기존 성과 유지 · 추가 인정 없음'}
                                  </p>
                                )}
                                <div className="item-actions">
                                  <button
                                    className="button small secondary"
                                    disabled={!!busy || published || !item.eligible}
                                    onClick={() => publish([item.history_id])}
                                  >
                                    {published
                                      ? '공개 완료'
                                      : current?.status === 'FAILED'
                                        ? '이 항목 재시도'
                                        : '이 분석 게시'}
                                  </button>
                                </div>
                              </div>
                            </article>
                          );
                        })}
                        <div className="publication-footer">
                          <button
                            className="button secondary"
                            disabled={!!busy}
                            onClick={() => {
                              setPage('result');
                              setNotice(
                                '공개하지 않은 분석은 개인 기록에 보관했어요. 나중에 이어서 게시할 수 있어요.',
                              );
                            }}
                          >
                            나중에
                          </button>
                          <div className="actions">
                            {failedIds.length > 0 && (
                              <button
                                className="button secondary"
                                disabled={!!busy}
                                onClick={() => publish(failedIds)}
                              >
                                실패한 항목 재시도 ({failedIds.length}건)
                              </button>
                            )}
                            <button
                              className="button primary"
                              disabled={
                                !!busy ||
                                selected.filter((id) => eligibleIds.includes(id)).length === 0
                              }
                              onClick={() =>
                                publish(selected.filter((id) => eligibleIds.includes(id)))
                              }
                            >
                              {busy === 'publish'
                                ? '게시 중…'
                                : selected.length === eligibleIds.length
                                  ? `모두 게시 (${selected.length}건)`
                                  : `선택 게시 (${selected.length}건)`}
                              <Icon name="arrow" size={16} />
                            </button>
                          </div>
                        </div>
                      </section>
                      <aside className="context-column">
                        <SummaryCard
                          summary={summary}
                          matchedCount={result.progress.matched_candidate_ids.length}
                        />
                        <div className="quiet-note">
                          <h3>대화와 분석을 구분해요</h3>
                          <p>
                            분석은 신호별 공식 스레드에 모입니다. 공개해도 토론 댓글이나 동의가
                            자동으로 작성되지는 않아요.
                          </p>
                        </div>
                      </aside>
                    </div>
                  </>
                )}
                <footer className="page-footer">
                  <span>PLANETORY · ANALYSIS PREVIEW</span>
                  <span>
                    합성 데이터로 화면 흐름을 확인합니다. 새로고침하면 초기 상태로 돌아가요.
                  </span>
                </footer>
              </div>
            )}
          </main>
        </div>
        <dialog
          ref={dialog}
          aria-labelledby="detail-title"
          className="detail-dialog"
          onClose={() => setDetail(null)}
        >
          <div className="dialog-heading">
            <div>
              <p className="eyebrow">SIGNAL DETAILS</p>
              <h2 id="detail-title">
                {detail?.target_kind === 'CURRENT_CURVE_HINT'
                  ? '제출 곡선의 신호 힌트'
                  : '방금 매칭한 신호'}
              </h2>
            </div>
            <button
              className="icon-button"
              aria-label="상세 보기 닫기"
              onClick={() => dialog.current?.close()}
            >
              <Icon name="close" />
            </button>
          </div>
          {detail && (
            <>
              <p>
                {detail.target_kind === 'CURRENT_CURVE_HINT'
                  ? '해당 제출 당시 곡선에서 제거되지 않은 신호를 보여줍니다.'
                  : '이번에 매칭한 신호의 비교값입니다. 다른 남은 신호의 힌트가 아닙니다.'}
              </p>
              <dl className="public-preview">
                <dt>신호</dt>
                <dd>{detail.candidate_id}</dd>
                <dt>비교 주기</dt>
                <dd>{format(detail.reference.period_days)}일</dd>
                <dt>epoch</dt>
                <dd>{format(detail.reference.epoch_btjd)} BTJD</dd>
                <dt>지속시간</dt>
                <dd>{format(detail.reference.duration_days)}일</dd>
                <dt>출처</dt>
                <dd>합성 시나리오의 신호 기준값</dd>
                <dt>조회일</dt>
                <dd>{timestamp(detail.reference.retrieved_at)} KST</dd>
              </dl>
              <p className="footnote">
                실제 관측 해설이 아닌 Mock 예시입니다. 상세 열람만으로 성과를 감점하지 않습니다.
              </p>
            </>
          )}
        </dialog>
      </div>
    </>
  );
}

function StatusCard({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <section className={'status-card ' + tone}>
      <span>{label}</span>
      <strong>
        <i />
        {value}
      </strong>
    </section>
  );
}
function InputValues({
  input,
  derived,
}: {
  input: SubmissionInput;
  derived: AnalysisResult['server_derived'];
}) {
  return (
    <dl className="input-values">
      <div>
        <dt>내 주기</dt>
        <dd>
          {format(input.selection.period_days)} <span>일</span>
        </dd>
      </div>
      <div>
        <dt>선택한 위상 구간</dt>
        <dd>
          {format(input.selection.phase_start)} <span>~</span> {format(input.selection.phase_end)}
        </dd>
      </div>
      <div>
        <dt>서버 파생 epoch</dt>
        <dd>
          {format(derived?.epoch_btjd)} <span>BTJD</span>
        </dd>
      </div>
      <div>
        <dt>서버 파생 지속시간</dt>
        <dd>
          {format(derived?.duration_days)} <span>일</span>
        </dd>
      </div>
    </dl>
  );
}
function RecordContext({ input }: { input: SubmissionInput }) {
  return (
    <dl className="record-context">
      <dt>원본 Bundle</dt>
      <dd>{input.curve_context.publication_bundle_id}</dd>
      <dt>제출 전 곡선</dt>
      <dd>
        단계 {input.curve_context.curve_step} · 제거 신호{' '}
        {input.curve_context.removed_candidate_ids.length}개
      </dd>
      <dt>표시 배율</dt>
      <dd>접힌 곡선 ×{input.view_state.folded_x_zoom_ratio}</dd>
    </dl>
  );
}
function SummaryCard({
  summary,
  matchedCount,
}: {
  summary: ReturnType<ReturnType<typeof createMockSession>['getSummary']>;
  matchedCount: number;
}) {
  return (
    <section className="panel summary-panel">
      <div className="section-label">
        이 별에서의 내 성과<span className="tag">현재 누적</span>
      </div>
      <div className="summary-total">
        <div>
          <strong data-testid="recognized-total">{summary.recognized_total}</strong>
          <span>인정된 신호</span>
        </div>
        <div>
          <b>{matchedCount}</b>
          <span>매칭한 신호</span>
        </div>
      </div>
      <div className="grade-list">
        {Object.entries(summary.by_type).map(([type, value]) => (
          <div key={type}>
            <span>{types[type]}</span>
            <b>{value.recognized_count}개</b>
            <span className={'grade ' + (value.grade ? 'earned' : '')}>{value.grade ?? '—'}</span>
          </div>
        ))}
      </div>
      <p className="footnote">탐색 완료 자체에 추가 보상은 없어요.</p>
    </section>
  );
}
function StatisticsCard({
  stats,
}: {
  stats: ReturnType<ReturnType<typeof createMockSession>['getStatistics']>;
}) {
  if (!stats) return null;
  return (
    <section className="panel panel-pad statistics-card">
      <div className="section-label">
        {stats.basis === 'LATEST_ELIGIBLE_PUBLIC_SUBMISSION_PER_USER'
          ? '공개 분석의 판단'
          : '성과 인정 참여자의 최신 판단'}
      </div>
      {stats.participant_count === 0 ? (
        <div className="empty-stat">
          <Icon name="chart" size={27} />
          <p>{stats.empty_message ?? '아직 공개된 분석이 없습니다'}</p>
        </div>
      ) : (
        <>
          <div className="participant-count">
            참여자 <b>{stats.participant_count}명</b>
          </div>
          <div className="distribution" aria-hidden="true">
            {(Object.keys(judgments) as Judgment[]).map((j) => (
              <span
                key={j}
                className={j.toLowerCase()}
                style={{ width: `${stats.percentages[j] ?? 0}%` }}
              />
            ))}
          </div>
          <ul className="distribution-legend">
            {(Object.keys(judgments) as Judgment[]).map((j) => (
              <li key={j}>
                <i className={j.toLowerCase()} />
                <span>{judgments[j]}</span>
                <b>{stats.counts[j]}명</b>
                <small>{stats.percentages[j]?.toFixed(1)}%</small>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="footnote">
        집계 {timestamp(stats.as_of)} KST
        <br />
        참여자의 판단 분포이며 행성일 확률이 아닙니다.
      </p>
    </section>
  );
}
