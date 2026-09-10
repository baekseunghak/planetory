import resultFixtures from '../../../../docs/api/analysis/examples/02-result-states.json';
import retryFixtures from '../../../../docs/api/analysis/examples/03-retry-and-idempotency.json';
import detailFixtures from '../../../../docs/api/analysis/examples/04-unmatched-and-details.json';
import publicationFixtures from '../../../../docs/api/analysis/examples/06-publication-partial-failure.json';
import statisticsFixtures from '../../../../docs/api/analysis/examples/07-public-statistics.json';
import errorFixtures from '../../../../docs/api/analysis/examples/08-visibility-and-errors.json';
import harmonicFixtures from '../../../../docs/api/analysis/examples/10-harmonic-and-epoch-tie.json';

// Local, synthetic adapter only. No HTTP, candidate matching, BLS or access-control engine.
export type Judgment = 'LIKELY_PLANET' | 'UNLIKELY_PLANET' | 'UNSURE';
export type Disposition = 'CONFIRMED' | 'FP' | 'UNCONFIRMED';
export type Grade = 'A' | 'S' | 'SS' | 'SSS' | null;

export interface CurveContext {
  analysis_session_id: string;
  tic_id: string;
  publication_bundle_id: string;
  curve_id: string;
  curve_step: number;
  removed_candidate_ids: string[];
  residual_model_version: string;
  periodogram_config_version: string;
  selection_rules_version: string;
}

export interface Selection {
  period_days: number;
  phase_start: number;
  phase_end: number;
}

export interface SubmissionInput {
  request_id?: string;
  curve_context: CurveContext;
  submission_kind: 'candidate';
  selection: Selection;
  user_judgment: Judgment;
  evidence_flags: string[];
  memo: string;
  view_state: {
    time_domain_btjd: number[];
    periodogram_domain_days: number[];
    folded_x_zoom_ratio: number;
    folded_center_phase: number;
  };
  retry_of_submission_id: string | null;
}

export interface AchievementSummary {
  as_of: string;
  recognized_total: number;
  by_type: Record<Disposition, { recognized_count: number; grade: Grade }>;
}

export interface Achievement {
  status: 'RECOGNIZED' | 'NOT_RECOGNIZED' | 'ALREADY_RECOGNIZED';
  type: Disposition | null;
  reason?: string;
  awarded_now: boolean;
  previously_recognized: boolean;
}

export interface AnalysisResult {
  kind: 'submission_result';
  submission_id: string;
  history_id: string;
  submitted_at: string;
  submission_sequence: number;
  original_input: SubmissionInput;
  centroid_data_status: 'unavailable';
  achievement_summary_at_submission: AchievementSummary;
  judgment_statistics_ref: {
    candidate_id: string;
    basis: JudgmentStatistics['basis'];
    path: string;
  } | null;
  server_derived: { epoch_btjd: number; duration_days: number };
  match: {
    status: 'matched' | 'matched_harmonic' | 'duplicate' | 'not_matched' | 'ambiguous_match';
    candidate_id: string | null;
    correction: { canonical_period_days: number; period_multiplier: number; reason: string } | null;
  };
  opinion_result: null;
  judgment: {
    value: Judgment;
    evaluation: 'AGREES' | 'DISAGREES' | 'UNSURE' | 'UNSCORED' | 'NOT_APPLICABLE';
  };
  signal: {
    candidate_id: string;
    disposition: Disposition;
    ai: {
      execution_status: string;
      score: number | null;
      status: string | null;
      model_version: string | null;
    };
  } | null;
  achievement: Achievement;
  publication: {
    state: 'NOT_ELIGIBLE' | 'UNPUBLISHED' | 'PUBLIC' | 'FAILED';
    public_analysis_id: string | null;
    official_thread_id: string | null;
    author_public?: boolean;
    moderation_hidden: boolean;
    thread_hidden: boolean;
  };
  progress: {
    stage: 'IN_PROGRESS' | 'COMPLETED';
    completion_reason: 'all_found' | 'undiscoverable_only' | 'skipped' | null;
    matched_candidate_ids: string[];
    reopen_pending: boolean;
  };
  detail: {
    available: boolean;
    target_kind: 'CURRENT_MATCH' | 'CURRENT_CURVE_HINT' | null;
    candidate_id: string | null;
  };
  available_actions: string[];
}

export interface JudgmentStatistics {
  kind: 'judgment_statistics';
  candidate_id: string;
  basis: 'LATEST_SUBMISSION_PER_CREDITED_USER' | 'LATEST_ELIGIBLE_PUBLIC_SUBMISSION_PER_USER';
  as_of: string;
  participant_count: number;
  counts: Record<Judgment, number>;
  percentages: Record<Judgment, number | null>;
  empty_message: string | null;
}

export interface DetailView {
  kind: 'detail_view';
  submission_id: string;
  target_kind: 'CURRENT_MATCH' | 'CURRENT_CURVE_HINT';
  candidate_id: string;
  answer_viewed: boolean;
  reference: {
    source: string;
    retrieved_at: string;
    period_days: number;
    epoch_btjd: number;
    duration_days: number;
  };
  is_confirmed_answer: boolean;
}

export interface PublicationReview {
  kind: 'publication_review';
  review_id: string;
  tic_id: string;
  items: Array<{
    history_id: string;
    candidate_id: string;
    eligible: boolean;
    reason: string | null;
    is_representative: boolean;
    destination_thread_id: string | null;
    preview: {
      author_id: string;
      submitted_at: string;
      user_judgment: Judgment;
      selection: Selection;
      server_derived: AnalysisResult['server_derived'];
      curve_context: CurveContext;
      evidence_flags: string[];
      memo: string;
    };
  }>;
}

export interface PublicationItem {
  history_id: string;
  candidate_id: string;
  status: 'PUBLIC' | 'FAILED';
  public_analysis_id: string | null;
  official_thread_id: string | null;
  thread_created: boolean;
  author_public?: boolean;
  moderation_hidden?: boolean;
  thread_hidden?: boolean;
  published_at?: string;
  achievement: Achievement;
  failure: { code: string; retryable: boolean } | null;
}

export interface PublicationBatch {
  kind: 'publication_batch';
  request_id: string;
  outcome: 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED';
  items: PublicationItem[];
}

export type PublicItem = PublicationItem;

export interface MockSession {
  getResult(): Promise<AnalysisResult>;
  getHistory(): AnalysisResult[];
  getSummary(): AchievementSummary;
  getStatistics(): JudgmentStatistics | null;
  getPublication(historyId: string): PublicItem | null;
  restore(submissionId?: string): Promise<SubmissionInput>;
  submitJudgment(judgment: Judgment): Promise<AnalysisResult>;
  getDetail(): Promise<DetailView | null>;
  isAnswerViewed(submissionId: string): boolean;
  getReview(): Promise<PublicationReview>;
  publish(historyIds: string[], requestId: string): Promise<PublicationBatch>;
}

export class MockServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'MockServiceError';
  }
}

export const scenarioOptions = [
  {
    id: 'last-fp-wrong',
    label: '마지막 FP · 판단 불일치',
    description: '탐색 완료는 유지하고 행성 아님으로 다시 판단하면 최초 성과를 인정합니다.',
  },
  {
    id: 'last-confirmed-wrong',
    label: '마지막 확정 행성 · 판단 불일치',
    description: '모든 신호를 찾았지만 판단이 달라 이번 성과는 없습니다.',
  },
  {
    id: 'last-confirmed-unsure',
    label: '확정 행성 · 모르겠음',
    description: '판단 보류와 탐색 완료를 함께 표시합니다.',
  },
  {
    id: 'last-unconfirmed-unpublished',
    label: '미확정 · 미게시 완료',
    description: '분석 공개는 선택이며 공개 성공 때 신호별 최초 성과를 인정합니다.',
  },
  {
    id: 'correct-confirmed',
    label: '확정 행성 · 올바른 판단',
    description: '성과는 인정됐고 다른 신호가 남아 있습니다.',
  },
  {
    id: 'duplicate',
    label: '이미 인정한 신호 · 재도전',
    description: '새 판단을 기록하되 기존 성과와 추가 성과 없음을 구분합니다.',
  },
  {
    id: 'not-matched',
    label: '미매칭 · 과거 단계 힌트',
    description: '누적 완료와 별개로 당시 곡선의 미제거 신호를 해설합니다.',
  },
  {
    id: 'no-hint',
    label: '미매칭 · 해설 대상 없음',
    description: '해설할 신호가 없어 상세 보기를 제공하지 않습니다.',
  },
  {
    id: 'ambiguous',
    label: '복수 후보 · 매칭 모호',
    description: '하나의 후보를 임의 선택하거나 성과를 만들지 않습니다.',
  },
  {
    id: 'harmonic',
    label: '고조파 · 원본 6일 / 대표 3일',
    description: '원본값·정정값을 분리하고 동률 epoch는 더 이른 시각을 사용합니다.',
  },
  {
    id: 'publication-partial',
    label: '두 신호 공개 · 일부 실패',
    description: '두 번째 신호는 첫 공개만 실패하며 실패분 재시도는 성공합니다.',
  },
  {
    id: 'expired-bundle',
    label: '복원 오류 · 데이터 보존 만료',
    description: '과거 Bundle로 복원할 수 없음을 표시하고 현재 데이터로 대체하지 않습니다.',
  },
  {
    id: 'hidden-thread',
    label: '공개 오류 · 스레드 운영 숨김',
    description: '공개 요청을 거절하고 숨겨진 스레드를 새로 만들지 않습니다.',
  },
  {
    id: 'public-statistics',
    label: '공개 판단 분포 · 8 / 4 / 3',
    description: '기존 15명에 내 공개 분석만 반영하며 비공개 재판단은 집계를 바꾸지 않습니다.',
  },
];

const clone = <T>(value: T): T => structuredClone(value);
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 180));
const judgments: Judgment[] = ['LIKELY_PLANET', 'UNLIKELY_PLANET', 'UNSURE'];
const dispositions: Disposition[] = ['CONFIRMED', 'FP', 'UNCONFIRMED'];
const ownUser = 'mock-user-01';
const baseTime = '2026-09-09T02:00:00Z';

function fixtureBody<T>(document: unknown, name: string): T {
  // These repository fixtures have their own validator; this adapter does not validate an API.
  const fixture = document as { exchanges: Array<{ name: string; response: { body: unknown } }> };
  const exchange = fixture.exchanges.find((item) => item.name === name);
  if (!exchange) throw new Error(`Missing fixture exchange: ${name}`);
  return clone(exchange.response.body as T);
}

function emptyPublication(eligible: boolean): AnalysisResult['publication'] {
  return {
    state: eligible ? 'UNPUBLISHED' : 'NOT_ELIGIBLE',
    public_analysis_id: null,
    official_thread_id: null,
    moderation_hidden: false,
    thread_hidden: false,
  };
}

function isMatched(result: AnalysisResult): boolean {
  return (
    ['matched', 'matched_harmonic', 'duplicate'].includes(result.match.status) &&
    result.signal !== null
  );
}

interface StatisticsRecord {
  user_id: string;
  candidate_id: string;
  user_judgment: Judgment;
  submitted_at: string;
  submission_sequence: number;
  author_public: boolean;
  moderation_hidden: boolean;
  thread_hidden: boolean;
}

function isNewer(left: StatisticsRecord, right: StatisticsRecord): boolean {
  const leftTime = Date.parse(left.submitted_at);
  const rightTime = Date.parse(right.submitted_at);
  return (
    leftTime > rightTime ||
    (leftTime === rightTime && left.submission_sequence > right.submission_sequence)
  );
}

function initialResults(scenarioId: string): AnalysisResult[] {
  if (scenarioId === 'publication-partial') {
    const review = fixtureBody<PublicationReview>(publicationFixtures, 'review');
    return review.items.map((item, index) => {
      const result = fixtureBody<AnalysisResult>(resultFixtures, 'last-unconfirmed-unpublished');
      result.history_id = item.history_id;
      result.submission_id = `sub-${item.history_id}`;
      result.submitted_at = item.preview.submitted_at;
      result.submission_sequence = index + 1;
      result.achievement_summary_at_submission.as_of = result.submitted_at;
      // Preview metadata is not a submission request body.
      result.original_input = {
        request_id: `req-${item.history_id}`,
        curve_context: clone(item.preview.curve_context),
        submission_kind: 'candidate',
        selection: clone(item.preview.selection),
        user_judgment: item.preview.user_judgment,
        evidence_flags: clone(item.preview.evidence_flags),
        memo: item.preview.memo,
        view_state: clone(result.original_input.view_state),
        retry_of_submission_id: null,
      };
      result.server_derived = clone(item.preview.server_derived);
      result.match.candidate_id = item.candidate_id;
      if (result.signal) result.signal.candidate_id = item.candidate_id;
      result.judgment.value = item.preview.user_judgment;
      result.detail.candidate_id = item.candidate_id;
      result.progress.matched_candidate_ids = review.items.map((entry) => entry.candidate_id);
      if (result.judgment_statistics_ref) {
        result.judgment_statistics_ref.candidate_id = item.candidate_id;
        result.judgment_statistics_ref.path = `/api/community/signals/${item.candidate_id}/judgment-statistics`;
      }
      return result;
    });
  }
  if (scenarioId === 'duplicate')
    return [fixtureBody<AnalysisResult>(retryFixtures, 'req-retry-duplicate')];
  if (scenarioId === 'harmonic')
    return [fixtureBody<AnalysisResult>(harmonicFixtures, 'req-harmonic')];
  const detailNames: Record<string, string> = {
    'not-matched': 'req-not-matched',
    'no-hint': 'req-no-hint',
    ambiguous: 'req-ambiguous',
  };
  if (detailNames[scenarioId])
    return [fixtureBody<AnalysisResult>(detailFixtures, detailNames[scenarioId])];
  const baseName =
    scenarioId === 'expired-bundle'
      ? 'last-fp-wrong'
      : ['hidden-thread', 'public-statistics'].includes(scenarioId)
        ? 'last-unconfirmed-unpublished'
        : scenarioId;
  const result = fixtureBody<AnalysisResult>(resultFixtures, baseName);
  if (scenarioId === 'hidden-thread') {
    result.publication.thread_hidden = true;
    result.publication.official_thread_id = 'thread-mock-signal-01';
  }
  if (scenarioId === 'public-statistics') {
    result.match.candidate_id = 'mock-stat-signal';
    if (result.signal) result.signal.candidate_id = 'mock-stat-signal';
    result.detail.candidate_id = 'mock-stat-signal';
    result.progress.matched_candidate_ids = ['mock-stat-signal'];
    if (result.judgment_statistics_ref) {
      result.judgment_statistics_ref.candidate_id = 'mock-stat-signal';
      result.judgment_statistics_ref.path =
        '/api/community/signals/mock-stat-signal/judgment-statistics';
    }
  }
  return [result];
}

export function createMockSession(scenarioId = 'last-fp-wrong'): MockSession {
  if (!scenarioOptions.some((option) => option.id === scenarioId)) {
    throw new MockServiceError('UNKNOWN_SCENARIO', '알 수 없는 합성 시나리오입니다.', 400);
  }
  const history = initialResults(scenarioId);
  let current = history[0];
  let retrySource: AnalysisResult | null = null;
  let sequence = Math.max(...history.map((item) => item.submission_sequence));
  let clock = Date.parse(baseTime);
  const tick = () => new Date((clock += 1000)).toISOString();
  const progress = clone(current.progress);
  const credited = new Map<string, Disposition>();
  const publications = new Map<string, PublicationItem>();
  const threads = new Map<string, string>();
  const publicationRequests = new Map<string, PublicationBatch>();
  const answerViewed = new Set<string>();
  const publicRecords: StatisticsRecord[] = [];
  const gradedRecords: StatisticsRecord[] = [];
  let summaryAsOf = current.achievement_summary_at_submission.as_of;
  let statisticsAsOf = baseTime;
  let failedSecondSignal = false;

  for (const item of history) {
    if (item.signal && (item.achievement.awarded_now || item.achievement.previously_recognized)) {
      credited.set(item.signal.candidate_id, item.signal.disposition);
    }
  }
  if (scenarioId === 'hidden-thread' && current.signal)
    threads.set(current.signal.candidate_id, 'thread-mock-signal-01');
  if (scenarioId === 'public-statistics') {
    const setup = (statisticsFixtures as unknown as { setup: { records: StatisticsRecord[] } })
      .setup;
    publicRecords.push(...clone(setup.records));
  }
  if (current.signal && current.signal.disposition !== 'UNCONFIRMED') {
    const fixture = fixtureBody<JudgmentStatistics>(resultFixtures, 'known-judgment-distribution');
    for (const judgment of judgments) {
      for (let i = 0; i < fixture.counts[judgment]; i++) {
        gradedRecords.push({
          user_id: `peer-${judgment}-${i}`,
          candidate_id: current.signal.candidate_id,
          user_judgment: judgment,
          submitted_at: fixture.as_of,
          submission_sequence: i,
          author_public: true,
          moderation_hidden: false,
          thread_hidden: false,
        });
      }
    }
    if (credited.has(current.signal.candidate_id)) {
      const record = gradedRecords.find((entry) => entry.user_judgment === current.judgment.value);
      if (record) record.user_id = ownUser;
    }
    statisticsAsOf = fixture.as_of;
  }

  const getSummary = (): AchievementSummary => {
    const by_type: AchievementSummary['by_type'] = {
      CONFIRMED: { recognized_count: 0, grade: null },
      FP: { recognized_count: 0, grade: null },
      UNCONFIRMED: { recognized_count: 0, grade: null },
    };
    for (const type of credited.values()) by_type[type].recognized_count += 1;
    for (const type of dispositions) {
      const count = by_type[type].recognized_count;
      by_type[type].grade =
        count === 0
          ? null
          : type === 'FP'
            ? 'A'
            : (['A', 'S', 'SS', 'SSS'] as const)[Math.min(count, 4) - 1];
    }
    return { as_of: summaryAsOf, recognized_total: credited.size, by_type };
  };

  const getStatistics = (): JudgmentStatistics | null => {
    if (!current.signal || !isMatched(current) || scenarioId === 'hidden-thread') return null;
    const publicBasis = current.signal.disposition === 'UNCONFIRMED';
    const latest = new Map<string, StatisticsRecord>();
    for (const record of publicBasis ? publicRecords : gradedRecords) {
      if (
        record.candidate_id !== current.signal.candidate_id ||
        !record.author_public ||
        record.moderation_hidden ||
        record.thread_hidden
      )
        continue;
      const previous = latest.get(record.user_id);
      if (!previous || isNewer(record, previous)) latest.set(record.user_id, record);
    }
    const counts: JudgmentStatistics['counts'] = {
      LIKELY_PLANET: 0,
      UNLIKELY_PLANET: 0,
      UNSURE: 0,
    };
    for (const record of latest.values()) counts[record.user_judgment] += 1;
    const percentages: JudgmentStatistics['percentages'] = {
      LIKELY_PLANET: null,
      UNLIKELY_PLANET: null,
      UNSURE: null,
    };
    for (const judgment of judgments)
      if (latest.size)
        percentages[judgment] = Math.round((counts[judgment] / latest.size) * 1000) / 10;
    return {
      kind: 'judgment_statistics',
      candidate_id: current.signal.candidate_id,
      basis: publicBasis
        ? 'LATEST_ELIGIBLE_PUBLIC_SUBMISSION_PER_USER'
        : 'LATEST_SUBMISSION_PER_CREDITED_USER',
      as_of: statisticsAsOf,
      participant_count: latest.size,
      counts,
      percentages,
      empty_message: latest.size ? null : '아직 공개된 분석이 없습니다',
    };
  };

  const getReview = async (): Promise<PublicationReview> => {
    await delay();
    const eligible = history.filter(
      (item) =>
        isMatched(item) &&
        item.signal?.disposition === 'UNCONFIRMED' &&
        publications.get(item.history_id)?.status !== 'PUBLIC',
    );
    const representatives = new Map<string, AnalysisResult>();
    for (const item of eligible) {
      const signalId = item.signal!.candidate_id;
      const old = representatives.get(signalId);
      if (
        !old ||
        Date.parse(item.submitted_at) > Date.parse(old.submitted_at) ||
        (Date.parse(item.submitted_at) === Date.parse(old.submitted_at) &&
          item.submission_sequence > old.submission_sequence)
      )
        representatives.set(signalId, item);
    }
    return {
      kind: 'publication_review',
      review_id: `mock-review-${scenarioId}`,
      tic_id: current.original_input.curve_context.tic_id,
      items: eligible.map((item) => ({
        history_id: item.history_id,
        candidate_id: item.signal!.candidate_id,
        eligible: scenarioId !== 'hidden-thread',
        reason: scenarioId === 'hidden-thread' ? 'THREAD_UNAVAILABLE' : null,
        is_representative:
          representatives.get(item.signal!.candidate_id)?.history_id === item.history_id,
        destination_thread_id: threads.get(item.signal!.candidate_id) ?? null,
        preview: {
          author_id: ownUser,
          submitted_at: item.submitted_at,
          user_judgment: item.judgment.value,
          selection: clone(item.original_input.selection),
          server_derived: clone(item.server_derived),
          curve_context: clone(item.original_input.curve_context),
          evidence_flags: clone(item.original_input.evidence_flags),
          memo: item.original_input.memo,
        },
      })),
    };
  };

  return {
    async getResult() {
      await delay();
      return clone(current);
    },
    getHistory: () =>
      clone([...history].sort((a, b) => b.submission_sequence - a.submission_sequence)),
    getSummary,
    getStatistics,
    getPublication: (historyId) => clone(publications.get(historyId) ?? null),
    isAnswerViewed: (submissionId) => answerViewed.has(submissionId),
    async restore(submissionId) {
      await delay();
      if (scenarioId === 'expired-bundle') {
        const error = fixtureBody<{ code: string; retryable: boolean }>(
          errorFixtures,
          'expired-bundle-retry',
        );
        throw new MockServiceError(
          error.code,
          '이 제출의 데이터 보존기간이 지나 복원할 수 없습니다.',
          410,
          error.retryable,
        );
      }
      const source = submissionId
        ? history.find((item) => item.submission_id === submissionId)
        : current;
      if (!source)
        throw new MockServiceError(
          'SUBMISSION_NOT_FOUND',
          '복원할 제출 기록을 찾을 수 없습니다.',
          404,
        );
      retrySource = clone(source);
      const input = clone(source.original_input);
      delete input.request_id;
      input.retry_of_submission_id = source.submission_id;
      return input;
    },
    async submitJudgment(judgment) {
      if (!judgments.includes(judgment))
        throw new MockServiceError('INVALID_JUDGMENT', '세 판단 중 하나를 선택해주세요.', 422);
      const source = clone(retrySource ?? current);
      await delay();
      if (scenarioId === 'expired-bundle')
        throw new MockServiceError(
          'BUNDLE_EXPIRED',
          '복원할 수 없는 데이터로 새 판단을 제출할 수 없습니다.',
          410,
        );
      const time = tick();
      const result = clone(source);
      const requestId = `mock-${scenarioId}-submission-${++sequence}`;
      result.submission_id = `sub-${requestId}`;
      result.history_id = `hist-${requestId}`;
      result.submitted_at = time;
      result.submission_sequence = sequence;
      result.original_input = {
        ...clone(source.original_input),
        request_id: requestId,
        user_judgment: judgment,
        retry_of_submission_id: source.submission_id,
      };
      result.judgment.value = judgment;
      result.progress = clone(progress);
      result.publication = emptyPublication(
        result.signal?.disposition === 'UNCONFIRMED' && isMatched(result),
      );
      if (scenarioId === 'hidden-thread') result.publication.thread_hidden = true;
      const signal = result.signal;
      // Deliberately mock-only: numeric match/correction is fixed by the fixture.
      if (signal && isMatched(result)) {
        const previous = credited.has(signal.candidate_id);
        const correct =
          (signal.disposition === 'CONFIRMED' && judgment === 'LIKELY_PLANET') ||
          (signal.disposition === 'FP' && judgment === 'UNLIKELY_PLANET');
        result.judgment.evaluation =
          signal.disposition === 'UNCONFIRMED'
            ? 'UNSCORED'
            : judgment === 'UNSURE'
              ? 'UNSURE'
              : correct
                ? 'AGREES'
                : 'DISAGREES';
        result.match.status = previous
          ? 'duplicate'
          : result.match.correction
            ? 'matched_harmonic'
            : 'matched';
        const award = correct && !previous;
        if (award) {
          credited.set(signal.candidate_id, signal.disposition);
          summaryAsOf = time;
        }
        result.achievement = {
          status: previous ? 'ALREADY_RECOGNIZED' : award ? 'RECOGNIZED' : 'NOT_RECOGNIZED',
          type: signal.disposition,
          awarded_now: award,
          previously_recognized: previous,
          reason: previous
            ? 'PREVIOUSLY_RECOGNIZED'
            : award
              ? 'MATCH_AND_CORRECT_JUDGMENT'
              : signal.disposition === 'UNCONFIRMED'
                ? 'PUBLICATION_REQUIRED'
                : judgment === 'UNSURE'
                  ? 'JUDGMENT_UNSURE'
                  : 'JUDGMENT_DISAGREES',
        };
        if (signal.disposition !== 'UNCONFIRMED' && credited.has(signal.candidate_id)) {
          gradedRecords.push({
            user_id: ownUser,
            candidate_id: signal.candidate_id,
            user_judgment: judgment,
            submitted_at: time,
            submission_sequence: sequence,
            author_public: true,
            moderation_hidden: false,
            thread_hidden: false,
          });
          statisticsAsOf = time;
        }
        if (result.judgment_statistics_ref)
          result.judgment_statistics_ref.path =
            signal.disposition === 'UNCONFIRMED'
              ? `/api/community/signals/${signal.candidate_id}/judgment-statistics`
              : `/api/analysis/submissions/${result.submission_id}/judgment-statistics`;
      }
      result.achievement_summary_at_submission = getSummary();
      history.push(clone(result));
      current = clone(result);
      retrySource = null;
      return clone(result);
    },
    async getDetail() {
      const source = clone(current);
      await delay();
      if (!source.detail.available) return null;
      const detail = fixtureBody<DetailView>(detailFixtures, 'hint');
      detail.submission_id = source.submission_id;
      if (source.detail.target_kind === 'CURRENT_MATCH' && source.signal) {
        detail.target_kind = 'CURRENT_MATCH';
        detail.candidate_id = source.signal.candidate_id;
        detail.is_confirmed_answer = source.signal.disposition !== 'UNCONFIRMED';
        detail.reference = {
          source: detail.is_confirmed_answer ? 'SYNTHETIC_EXTERNAL_DISPOSITION' : 'SYNTHETIC_BLS',
          retrieved_at: source.submitted_at,
          period_days:
            source.match.correction?.canonical_period_days ??
            source.original_input.selection.period_days,
          epoch_btjd: source.server_derived.epoch_btjd,
          duration_days: source.server_derived.duration_days,
        };
      }
      answerViewed.add(source.submission_id);
      return detail;
    },
    getReview,
    async publish(historyIds, requestId) {
      const selectedIds = [...new Set(historyIds)];
      await delay();
      const replay = publicationRequests.get(requestId);
      if (replay) return clone(replay);
      if (!requestId || !selectedIds.length)
        throw new MockServiceError(
          'INVALID_PUBLICATION_REQUEST',
          '공개할 기록과 요청 ID가 필요합니다.',
          422,
        );
      if (scenarioId === 'hidden-thread') {
        const error = fixtureBody<{ code: string; retryable: boolean }>(
          errorFixtures,
          'hidden-parent-blocks-publish',
        );
        throw new MockServiceError(
          error.code,
          '운영 숨김 중인 공식 스레드에는 분석을 공개할 수 없습니다.',
          409,
          error.retryable,
        );
      }
      const selected = selectedIds.map((id) => {
        const record = history.find((item) => item.history_id === id);
        if (!record || record.signal?.disposition !== 'UNCONFIRMED' || !isMatched(record))
          throw new MockServiceError(
            'HISTORY_NOT_ELIGIBLE',
            '공개할 수 있는 본인의 미확정 매칭 기록이 아닙니다.',
            422,
          );
        return record;
      });
      const time = tick();
      const items: PublicationItem[] = selected.map((record) => {
        const signalId = record.signal!.candidate_id;
        const previous = credited.has(signalId);
        if (
          scenarioId === 'publication-partial' &&
          signalId === 'mock-signal-b' &&
          !failedSecondSignal
        ) {
          failedSecondSignal = true;
          const failure = fixtureBody<PublicationBatch>(publicationFixtures, 'partial').items.find(
            (item) => item.status === 'FAILED',
          )!;
          failure.history_id = record.history_id;
          publications.set(record.history_id, clone(failure));
          return failure;
        }
        const existing = publications.get(record.history_id);
        if (existing?.status === 'PUBLIC')
          return {
            ...clone(existing),
            thread_created: false,
            achievement: {
              status: 'ALREADY_RECOGNIZED',
              type: 'UNCONFIRMED',
              awarded_now: false,
              previously_recognized: true,
            },
          };
        const created = !threads.has(signalId);
        const threadId = threads.get(signalId) ?? `thread-${signalId}`;
        threads.set(signalId, threadId);
        const item: PublicationItem = {
          history_id: record.history_id,
          candidate_id: signalId,
          status: 'PUBLIC',
          public_analysis_id: `public-${record.history_id}`,
          official_thread_id: threadId,
          thread_created: created,
          author_public: true,
          moderation_hidden: false,
          thread_hidden: false,
          published_at: time,
          achievement: {
            status: previous ? 'ALREADY_RECOGNIZED' : 'RECOGNIZED',
            type: 'UNCONFIRMED',
            awarded_now: !previous,
            previously_recognized: previous,
          },
          failure: null,
        };
        if (!previous) {
          credited.set(signalId, 'UNCONFIRMED');
          summaryAsOf = time;
        }
        publications.set(record.history_id, clone(item));
        publicRecords.push({
          user_id: ownUser,
          candidate_id: signalId,
          user_judgment: record.judgment.value,
          submitted_at: record.submitted_at,
          submission_sequence: record.submission_sequence,
          author_public: true,
          moderation_hidden: false,
          thread_hidden: false,
        });
        statisticsAsOf = time;
        return item;
      });
      const successes = items.filter((item) => item.status === 'PUBLIC').length;
      const result: PublicationBatch = {
        kind: 'publication_batch',
        request_id: requestId,
        outcome: successes === items.length ? 'SUCCESS' : successes ? 'PARTIAL_SUCCESS' : 'FAILED',
        items,
      };
      publicationRequests.set(requestId, clone(result));
      return clone(result);
    },
  };
}
