import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from './analysis-service';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

async function resolveAfterDelay<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(180);
  return promise;
}

describe('fixture-backed analysis session (no actual matching or API)', () => {
  it('restores a copied original input without creating history or changing completed progress', async () => {
    const session = createMockSession();
    const before = await resolveAfterDelay(session.getResult());
    const originalSnapshot = structuredClone(before);
    const restored = await resolveAfterDelay(session.restore());
    expect(restored.request_id).toBeUndefined();
    expect(restored.retry_of_submission_id).toBe(before.submission_id);
    expect(restored.selection).toEqual(before.original_input.selection);
    expect(restored.curve_context).toEqual(before.original_input.curve_context);
    expect(restored.view_state).toEqual(before.original_input.view_state);
    restored.memo = '외부 수정';
    restored.curve_context.removed_candidate_ids.push('외부 신호');
    before.achievement_summary_at_submission.recognized_total = 99;
    expect(await resolveAfterDelay(session.getResult())).toEqual(originalSnapshot);
    expect(session.getHistory()).toEqual([originalSnapshot]);
    expect(session.getSummary().recognized_total).toBe(0);
  });

  it('awards a corrected FP once, keeps old snapshots, and treats the next wrong judgment as duplicate', async () => {
    const session = createMockSession();
    const original = await resolveAfterDelay(session.getResult());
    await resolveAfterDelay(session.restore());
    const correct = await resolveAfterDelay(session.submitJudgment('UNLIKELY_PLANET'));
    expect(correct.submission_id).not.toBe(original.submission_id);
    expect(correct.history_id).not.toBe(original.history_id);
    expect(correct.original_input.selection).toEqual(original.original_input.selection);
    expect(correct.match.status).toBe('matched');
    expect(correct.judgment.evaluation).toBe('AGREES');
    expect(correct.achievement.awarded_now).toBe(true);
    expect(correct.progress).toEqual(original.progress);
    expect(session.getSummary().by_type.FP).toEqual({ recognized_count: 1, grade: 'A' });
    const wrongAgain = await resolveAfterDelay(session.submitJudgment('LIKELY_PLANET'));
    expect(wrongAgain.match.status).toBe('duplicate');
    expect(wrongAgain.judgment.evaluation).toBe('DISAGREES');
    expect(wrongAgain.achievement).toMatchObject({
      status: 'ALREADY_RECOGNIZED',
      awarded_now: false,
      previously_recognized: true,
    });
    expect(session.getHistory()).toHaveLength(3);
    expect(
      session.getHistory().find((item) => item.submission_id === original.submission_id),
    ).toEqual(original);
    expect(session.getSummary().recognized_total).toBe(1);
    expect(original.achievement_summary_at_submission.recognized_total).toBe(0);
  });

  it('preserves harmonic original and derived values when retrying with an unsure judgment', async () => {
    const session = createMockSession('harmonic');
    const before = await resolveAfterDelay(session.getResult());
    await resolveAfterDelay(session.restore());
    const after = await resolveAfterDelay(session.submitJudgment('UNSURE'));
    expect(after.original_input.selection.period_days).toBe(6);
    expect(after.match.correction?.canonical_period_days).toBe(3);
    expect(after.server_derived).toEqual(before.server_derived);
    expect(after.server_derived.epoch_btjd).toBe(1003);
    expect(after.judgment.evaluation).toBe('UNSURE');
    expect(after.match.status).toBe('duplicate');
    expect(after.achievement.awarded_now).toBe(false);
    expect(after.progress.stage).toBe('COMPLETED');
    expect(session.getSummary().recognized_total).toBe(1);
  });

  it('retains partial publication successes, retries only the failed history, and never rewrites old results', async () => {
    const session = createMockSession('publication-partial');
    const originalHistory = session.getHistory();
    const review = await resolveAfterDelay(session.getReview());
    expect(review.items.map((item) => item.history_id)).toEqual([
      'mock-history-a',
      'mock-history-b',
    ]);
    const first = await resolveAfterDelay(
      session.publish(
        review.items.map((item) => item.history_id),
        'publish-1',
      ),
    );
    expect(first.outcome).toBe('PARTIAL_SUCCESS');
    expect(first.items.map((item) => item.status)).toEqual(['PUBLIC', 'FAILED']);
    expect(session.getPublication('mock-history-b')?.status).toBe('FAILED');
    expect(session.getSummary().recognized_total).toBe(1);
    expect(
      (await resolveAfterDelay(session.getReview())).items.map((item) => item.history_id),
    ).toEqual(['mock-history-b']);
    const retry = await resolveAfterDelay(session.publish(['mock-history-b'], 'publish-2'));
    expect(retry.outcome).toBe('SUCCESS');
    expect(session.getPublication('mock-history-b')?.status).toBe('PUBLIC');
    expect(session.getSummary().by_type.UNCONFIRMED).toEqual({ recognized_count: 2, grade: 'S' });
    expect((await resolveAfterDelay(session.getReview())).items).toEqual([]);
    expect(session.getHistory()).toEqual(originalHistory);
    const replay = await resolveAfterDelay(
      session.publish(['mock-history-a', 'mock-history-b'], 'publish-1'),
    );
    expect(replay).toEqual(first);
    expect(replay.items[1].status).toBe('FAILED');
    expect(session.getSummary().recognized_total).toBe(2);
  });

  it('replays concurrent publication request IDs from copies without duplicating public analyses or awards', async () => {
    const session = createMockSession('last-unconfirmed-unpublished');
    const id = session.getHistory()[0].history_id;
    const [first, concurrentReplay] = await resolveAfterDelay(
      Promise.all([session.publish([id], 'same-request'), session.publish([id], 'same-request')]),
    );
    expect(concurrentReplay).toEqual(first);
    expect(first.items[0].achievement.awarded_now).toBe(true);
    expect(session.getHistory()).toHaveLength(1);
    expect(session.getSummary().recognized_total).toBe(1);
    first.items[0].achievement.awarded_now = false;
    const replay = await resolveAfterDelay(session.publish([id], 'same-request'));
    expect(replay.items[0].achievement.awarded_now).toBe(true);
    expect(session.getSummary().recognized_total).toBe(1);
    expect(session.getStatistics()?.participant_count).toBe(1);
  });

  it('changes public statistics only on publication, selects latest submissions, and permits new duplicate analyses', async () => {
    expect(createMockSession('public-statistics').getStatistics()).toMatchObject({
      participant_count: 15,
      counts: { LIKELY_PLANET: 8, UNLIKELY_PLANET: 4, UNSURE: 3 },
    });
    const session = createMockSession('last-unconfirmed-unpublished');
    const original = session.getHistory()[0];
    const empty = session.getStatistics();
    expect(empty?.participant_count).toBe(0);
    expect(empty?.percentages).toEqual({
      LIKELY_PLANET: null,
      UNLIKELY_PLANET: null,
      UNSURE: null,
    });
    const newPrivate = await resolveAfterDelay(session.submitJudgment('LIKELY_PLANET'));
    expect(session.getStatistics()).toEqual(empty);
    expect(newPrivate.match.status).toBe('matched');
    await resolveAfterDelay(session.publish([newPrivate.history_id], 'publish-new'));
    expect(session.getStatistics()?.counts).toEqual({
      LIKELY_PLANET: 1,
      UNLIKELY_PLANET: 0,
      UNSURE: 0,
    });
    await resolveAfterDelay(session.publish([original.history_id], 'publish-old-later'));
    expect(session.getStatistics()?.counts).toEqual({
      LIKELY_PLANET: 1,
      UNLIKELY_PLANET: 0,
      UNSURE: 0,
    });
    const beforePrivateRetry = session.getStatistics();
    const duplicate = await resolveAfterDelay(session.submitJudgment('UNLIKELY_PLANET'));
    expect(duplicate.match.status).toBe('duplicate');
    expect(session.getStatistics()).toEqual(beforePrivateRetry);
    const review = await resolveAfterDelay(session.getReview());
    expect(review.items.map((item) => item.history_id)).toEqual([duplicate.history_id]);
    expect(review.items[0]).toMatchObject({ eligible: true, is_representative: true });
    const published = await resolveAfterDelay(
      session.publish([duplicate.history_id], 'publish-duplicate'),
    );
    expect(published.items[0].achievement.awarded_now).toBe(false);
    expect(session.getSummary().recognized_total).toBe(1);
    expect(session.getStatistics()?.counts).toEqual({
      LIKELY_PLANET: 0,
      UNLIKELY_PLANET: 1,
      UNSURE: 0,
    });
  });

  it('keeps the submission-stage hint separate from cumulative matching and never invents an ambiguous match', async () => {
    const unmatched = createMockSession('not-matched');
    const result = await resolveAfterDelay(unmatched.getResult());
    const detail = await resolveAfterDelay(unmatched.getDetail());
    expect(result.progress.matched_candidate_ids).toContain(detail?.candidate_id);
    expect(detail?.target_kind).toBe('CURRENT_CURVE_HINT');
    expect(unmatched.getStatistics()).toBeNull();
    expect(await resolveAfterDelay(createMockSession('no-hint').getDetail())).toBeNull();
    const ambiguous = createMockSession('ambiguous');
    const retried = await resolveAfterDelay(ambiguous.submitJudgment('UNLIKELY_PLANET'));
    expect(retried.match).toMatchObject({ status: 'ambiguous_match', candidate_id: null });
    expect(retried.judgment.evaluation).toBe('NOT_APPLICABLE');
    expect(ambiguous.getSummary().recognized_total).toBe(0);
    expect((await resolveAfterDelay(ambiguous.getReview())).items).toEqual([]);
  });

  it('records successful detail views per submission without changing immutable history or achievement', async () => {
    const session = createMockSession();
    const originalHistory = session.getHistory();
    const originalId = originalHistory[0].submission_id;
    const beforeSummary = session.getSummary();
    expect(session.isAnswerViewed(originalId)).toBe(false);
    expect(await resolveAfterDelay(session.getDetail())).toMatchObject({
      submission_id: originalId,
      answer_viewed: true,
    });
    expect(session.isAnswerViewed(originalId)).toBe(true);
    expect(session.getHistory()).toEqual(originalHistory);
    expect(session.getSummary()).toEqual(beforeSummary);

    const corrected = await resolveAfterDelay(session.submitJudgment('UNLIKELY_PLANET'));
    expect(corrected.achievement.awarded_now).toBe(true);
    expect(session.isAnswerViewed(corrected.submission_id)).toBe(false);
    expect(session.isAnswerViewed(originalId)).toBe(true);
    const correctedHistory = session.getHistory();
    const creditedSummary = session.getSummary();
    await resolveAfterDelay(session.getDetail());
    expect(session.isAnswerViewed(corrected.submission_id)).toBe(true);
    expect(session.getHistory()).toEqual(correctedHistory);
    expect(session.getSummary()).toEqual(creditedSummary);
    expect(creditedSummary.recognized_total).toBe(1);

    const noHint = createMockSession('no-hint');
    const noHintId = noHint.getHistory()[0].submission_id;
    expect(await resolveAfterDelay(noHint.getDetail())).toBeNull();
    expect(noHint.isAnswerViewed(noHintId)).toBe(false);
  });

  it('reports expired restoration and hidden-thread publication explicitly without changing saved state', async () => {
    const expired = createMockSession('expired-bundle');
    const expiredHistory = expired.getHistory();
    const restoreAssertion = expect(expired.restore()).rejects.toMatchObject({
      code: 'BUNDLE_EXPIRED',
      status: 410,
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(180);
    await restoreAssertion;
    expect(expired.getHistory()).toEqual(expiredHistory);
    const hidden = createMockSession('hidden-thread');
    const hiddenHistory = hidden.getHistory();
    const publicationAssertion = expect(
      hidden.publish([hiddenHistory[0].history_id], 'hidden-request'),
    ).rejects.toMatchObject({ code: 'THREAD_UNAVAILABLE', status: 409 });
    await vi.advanceTimersByTimeAsync(180);
    await publicationAssertion;
    expect(hidden.getHistory()).toEqual(hiddenHistory);
    expect(hidden.getSummary().recognized_total).toBe(0);
    expect(hidden.getStatistics()).toBeNull();
    expect((await resolveAfterDelay(hidden.getReview())).items[0]).toMatchObject({
      eligible: false,
      reason: 'THREAD_UNAVAILABLE',
    });
  });
});
