'use strict';

// Static draft checks only: no HTTP server, database, browser or astronomy pipeline.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const dir = path.join(__dirname, 'examples');
const read = file => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const judgments = ['LIKELY_PLANET', 'UNLIKELY_PLANET', 'UNSURE'];
const matched = ['matched', 'matched_harmonic', 'duplicate'];
const evidence = ['ODD_EVEN_SIMILAR', 'NO_SECONDARY_ECLIPSE', 'U_SHAPED', 'OUTSIDE_BAD_QUALITY'];
const contextKeys = ['analysis_session_id', 'tic_id', 'publication_bundle_id', 'curve_id',
  'curve_step', 'removed_candidate_ids', 'residual_model_version',
  'periodogram_config_version', 'selection_rules_version'];
const equal = (a, b, message) => assert.deepStrictEqual(a, b, message);
const close = (a, b) => assert(Number.isFinite(a) && Math.abs(a - b) < 1e-9, 'Derived value differs');
const setEqual = (a, b) => equal([...a].sort(), [...b].sort());
const unique = values => equal(values.length, new Set(values).size, 'Duplicate identifiers');

function checkContext(context) {
  equal(Object.keys(context).sort(), [...contextKeys].sort());
  for (const key of contextKeys.filter(k => !['curve_step', 'removed_candidate_ids'].includes(k))) {
    assert(typeof context[key] === 'string' && context[key].length > 0, key);
  }
  assert(Number.isInteger(context.curve_step) && context.curve_step >= 0);
  unique(context.removed_candidate_ids);
}

function checkProgress(progress) {
  unique(progress.matched_candidate_ids);
  assert(['IN_PROGRESS', 'COMPLETED'].includes(progress.stage));
  if (progress.stage === 'IN_PROGRESS') equal(progress.completion_reason, null);
  else assert(['all_found', 'undiscoverable_only', 'skipped'].includes(progress.completion_reason));
  equal(progress.reopen_pending, progress.completion_reason === 'undiscoverable_only');
}

function derive(selection, curve) {
  const { period_days: p, phase_start: start, phase_end: end } = selection;
  assert([p, start, end].every(Number.isFinite) && p > 0, 'Finite positive period required');
  assert(start >= 0 && start < 1 && end > start && end < start + 1, 'Invalid phase interval');
  const ref = curve.fold_reference_time_btjd;
  const [lo, hi] = curve.observation_bounds_btjd;
  const center = ((start + end) / 2) % 1;
  const first = Math.ceil((lo - ref) / p - center);
  const last = Math.floor((hi - ref) / p - center);
  assert(first <= last, 'No epoch in observation bounds');
  // Nearest integers to -center, clipped to the allowed integer interval.
  const options = [Math.floor(-center), Math.ceil(-center)]
    .map(k => ref + (center + Math.max(first, Math.min(last, k))) * p)
    .sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref) || a - b);
  return { epoch_btjd: options[0], duration_days: (end - start) * p };
}

function checkResult(request, response, curve) {
  equal(response.original_input, request, 'Original input must survive submission');
  checkContext(request.curve_context);
  checkProgress(response.progress);
  equal(response.centroid_data_status, 'unavailable');
  checkSummary(response.achievement_summary_at_submission);
  for (const key of ['epoch', 'epoch_btjd', 'duration', 'duration_days', 'achievement', 'progress']) {
    assert(!(key in request), 'Client must not supply authoritative ' + key);
  }
  const candidate = request.submission_kind === 'candidate';
  const found = candidate && matched.includes(response.match.status);
  if (candidate) {
    assert(judgments.includes(request.user_judgment));
    assert(request.evidence_flags.every(value => evidence.includes(value)), 'Unsupported evidence');
    const expected = derive(request.selection, curve);
    close(response.server_derived.epoch_btjd, expected.epoch_btjd);
    close(response.server_derived.duration_days, expected.duration_days);
    equal(response.judgment.value, request.user_judgment);
  } else {
    assert(['no_candidate', 'skipped'].includes(request.submission_kind));
    for (const key of ['selection', 'user_judgment', 'evidence_flags']) assert(!(key in request));
    equal(response.server_derived, null);
    equal(response.match.status, null);
    equal(response.judgment.value, null);
  }
  assert(found ? typeof response.match.candidate_id === 'string' : response.match.candidate_id === null);
  equal(response.signal !== null, found);
  if (found) {
    equal(response.signal.candidate_id, response.match.candidate_id);
    assert(response.progress.matched_candidate_ids.includes(response.match.candidate_id));
    equal(response.detail.target_kind, 'CURRENT_MATCH');
    equal(response.detail.candidate_id, response.match.candidate_id);
  } else if (response.detail.available) {
    equal(response.detail.target_kind, 'CURRENT_CURVE_HINT');
    equal(response.detail.candidate_id, null, 'Hint must be gated by detail viewing');
  } else {
    equal(response.detail.target_kind, null);
    assert(!response.available_actions.includes('VIEW_DETAIL'));
  }
  const disposition = response.signal?.disposition;
  if (found) {
    equal(response.judgment_statistics_ref.candidate_id, response.match.candidate_id);
    equal(response.judgment_statistics_ref.basis, disposition === 'UNCONFIRMED'
      ? 'LATEST_ELIGIBLE_PUBLIC_SUBMISSION_PER_USER' : 'LATEST_SUBMISSION_PER_CREDITED_USER');
    equal(response.judgment_statistics_ref.path, '/api/analysis/submissions/' + response.submission_id + '/judgment-statistics');
  } else equal(response.judgment_statistics_ref, null);
  const expectedJudgment = !found ? 'NOT_APPLICABLE' : disposition === 'UNCONFIRMED' ? 'UNSCORED'
    : request.user_judgment === 'UNSURE' ? 'UNSURE'
      : ((disposition === 'CONFIRMED' && request.user_judgment === 'LIKELY_PLANET') ||
         (disposition === 'FP' && request.user_judgment === 'UNLIKELY_PLANET')) ? 'AGREES' : 'DISAGREES';
  equal(response.judgment.evaluation, expectedJudgment);
  const previous = response.match.status === 'duplicate';
  const awarded = found && !previous && expectedJudgment === 'AGREES';
  equal(response.achievement.awarded_now, awarded, 'Reward must follow match and judgment/publication rules');
  equal(response.achievement.previously_recognized, previous);
  equal(response.achievement.status, previous ? 'ALREADY_RECOGNIZED' : awarded ? 'RECOGNIZED' : 'NOT_RECOGNIZED');
  equal(response.publication.state, disposition === 'UNCONFIRMED' ? 'UNPUBLISHED' : 'NOT_ELIGIBLE');
  if (response.progress.stage === 'COMPLETED') assert(!response.available_actions.includes('NEXT_CURVE'));
  if (response.match.status === 'matched_harmonic') {
    const correction = response.match.correction;
    close(correction.canonical_period_days, request.selection.period_days * correction.period_multiplier);
  }
  if (request.submission_kind === 'no_candidate') equal(response.opinion_result, 'none_wrong');
  if (request.submission_kind === 'skipped') equal(response.progress.completion_reason, 'skipped');
}

function checkSummary(summary) {
  assert(Number.isFinite(Date.parse(summary.as_of)));
  let total = 0;
  for (const type of ['CONFIRMED', 'FP', 'UNCONFIRMED']) {
    const { recognized_count: count, grade } = summary.by_type[type];
    assert(Number.isInteger(count) && count >= 0);
    equal(grade, count === 0 ? null : type === 'FP' ? 'A' : ['A', 'S', 'SS', 'SSS'][Math.min(count, 4) - 1]);
    total += count;
  }
  equal(summary.recognized_total, total);
}

function checkStatistics(scenario) {
  const records = clone(scenario.setup.records);
  for (const exchange of scenario.exchanges) {
    const event = exchange.server_event;
    if (event?.type === 'APPEND') records.push(clone(event.record));
    else if (event?.type === 'PATCH') {
      const record = records.find(r => r.fixture_record_id === event.id);
      assert(record, 'Unknown statistics event target');
      Object.assign(record, event.changes);
    } else if (event?.type === 'WITHDRAW_ALL') records.forEach(r => { r.author_public = false; });
    else assert(!event, 'Unknown statistics event');
    const body = exchange.response.body;
    const eligible = records.filter(r => r.candidate_id === body.candidate_id && r.author_public &&
      !r.moderation_hidden && !r.thread_hidden && r.published_at !== null);
    const byUser = new Map();
    // Sort by server receipt time and server sequence, never by publication time.
    eligible.sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at) ||
      a.submission_sequence - b.submission_sequence).forEach(r => byUser.set(r.user_id, r));
    const counts = Object.fromEntries(judgments.map(j => [j, 0]));
    for (const record of byUser.values()) counts[record.user_judgment]++;
    equal(body.counts, counts, 'Public statistics must use latest eligible record per user');
    equal(body.participant_count, byUser.size);
    for (const judgment of judgments) {
      equal(body.percentages[judgment], byUser.size ? Math.round(counts[judgment] * 1000 / byUser.size) / 10 : null);
    }
    assert(!('records' in body) && !('users' in body), 'Aggregate endpoint must not return private records');
    equal(body.empty_message === null, byUser.size > 0);
  }
}

function checkPublication(scenario) {
  const histories = new Map(scenario.setup.histories.map(h => [h.history_id, h]));
  const reviews = new Map(), seenRequests = new Map(), credited = new Set(), publicIds = new Map(), creditedAt = new Map();
  const sameInput = new Map();
  for (const history of histories.values()) {
    const inputKey = JSON.stringify([history.curve_context, history.original_selection]);
    if (sameInput.has(inputKey)) equal(history.candidate_id, sameInput.get(inputKey), 'Identical input cannot match different signals');
    sameInput.set(inputKey, history.candidate_id);
  }
  for (const { request, response } of scenario.exchanges) {
    const req = request.body, body = response.body;
    if (body.kind === 'analysis_session') { checkSummary(body.achievement_summary); continue; }
    if (body.kind === 'publication_review') {
      setEqual(body.items.map(item => item.history_id), req.history_ids);
      for (const item of body.items) {
        const history = histories.get(item.history_id);
        assert(history && item.eligible && history.tic_id === req.tic_id);
        equal(item.candidate_id, history.candidate_id);
        equal(item.preview.submitted_at, history.submitted_at);
        equal(item.preview.user_judgment, history.user_judgment);
        equal(item.preview.selection, history.original_selection);
        equal(item.preview.curve_context, history.curve_context);
      }
      reviews.set(body.review_id, body);
      continue;
    }
    equal(body.kind, 'publication_batch');
    const previous = seenRequests.get(req.request_id);
    if (previous) {
      equal({ request, response }, previous, 'Same publication request must replay stored outcome');
      continue;
    }
    seenRequests.set(req.request_id, { request, response });
    const review = reviews.get(req.review_id);
    assert(review, 'Publication requires an earlier review in this scenario');
    setEqual(body.items.map(item => item.history_id), req.history_ids);
    for (const item of body.items) {
      assert(review.items.some(r => r.history_id === item.history_id && r.eligible));
      const history = histories.get(item.history_id);
      equal(history.disposition, 'UNCONFIRMED');
      assert(matched.includes(history.match_status) && judgments.includes(history.user_judgment));
      equal(item.candidate_id, history.candidate_id);
      if (item.status === 'FAILED') {
        equal(item.public_analysis_id, null);
        equal(item.achievement.awarded_now, false);
        equal(item.thread_created, false);
        assert(item.failure.code && typeof item.failure.retryable === 'boolean');
      } else {
        equal(item.status, 'PUBLIC');
        assert(item.public_analysis_id && item.official_thread_id);
        assert(Date.parse(item.published_at) >= Date.parse(history.submitted_at), 'Cannot publish before submission');
        assert(item.author_public && !item.moderation_hidden && !item.thread_hidden);
        const key = history.author_id + ':' + history.candidate_id;
        const previousCredit = credited.has(key) || history.already_credited;
        if (history.match_status === 'duplicate' && creditedAt.has(key)) {
          assert(Date.parse(history.submitted_at) >= creditedAt.get(key), 'Duplicate cannot precede first recognition');
        }
        equal(item.achievement.awarded_now, !previousCredit);
        equal(item.achievement.previously_recognized, previousCredit);
        credited.add(key);
        if (!previousCredit) creditedAt.set(key, Date.parse(item.published_at));
        if (publicIds.has(history.history_id)) equal(item.public_analysis_id, publicIds.get(history.history_id));
        publicIds.set(history.history_id, item.public_analysis_id);
        equal(item.failure, null);
      }
    }
    equal(body.outcome, body.items.every(i => i.status === 'PUBLIC') ? 'SUCCESS' : 'PARTIAL_SUCCESS');
  }
  const partial = scenario.exchanges.find(e => e.name === 'partial');
  const retry = scenario.exchanges.find(e => e.name === 'retry-failed-only');
  setEqual(retry.request.body.history_ids, partial.response.body.items.filter(i => i.status === 'FAILED').map(i => i.history_id));
  assert(retry.request.body.request_id !== partial.request.body.request_id);
  const latest = scenario.exchanges.find(e => e.name === 'refresh-current-summary').response.body.achievement_summary;
  equal(latest.recognized_total, credited.size);
}

function validate(scenarios) {
  const curve = scenarios[0].exchanges.find(e => e.response.body.kind === 'curve').response.body;
  const n = curve.time_btjd.length;
  equal(curve.normalized_flux.length, n);
  equal(curve.quality_valid.length, n);
  const times = curve.time_btjd.filter((_, i) => curve.quality_valid[i]).sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  close(curve.fold_reference_time_btjd, times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2);
  equal(curve.periodogram.period_days.length, curve.periodogram.power.length);
  assert(!('candidates' in curve) && !('candidate_models' in curve));
  const srs = fs.readFileSync(path.join(__dirname, '../../requirements/planetory-requirements-spec.md'), 'utf8');
  const ids = new Set([...srs.matchAll(/^\| ([A-Z]+-\d+) \|/gm)].map(m => m[1]));
  let exchangeCount = 0;
  for (const scenario of scenarios) {
    equal(scenario.schema_version, '0.1-draft');
    assert(scenario.exchanges.length > 0);
    scenario.source_requirements.forEach(id => assert(ids.has(id), 'Unknown requirement: ' + id));
    const submissions = new Map(), jobs = new Map();
    for (const { request, response } of scenario.exchanges) {
      exchangeCount++;
      assert(['GET', 'POST', 'PUT'].includes(request.method) && request.path.startsWith('/api/'));
      assert(Number.isInteger(response.status) && response.status >= 200 && response.status < 600);
      const body = response.body;
      assert(typeof body.kind === 'string');
      if (body.kind === 'error') {
        assert(response.status >= 400 && body.code && typeof body.retryable === 'boolean');
        equal(Object.keys(body).sort(), ['code', 'kind', 'message', 'retryable']);
        continue;
      }
      assert(response.status < 300);
      if (body.curve_context) checkContext(body.curve_context);
      if (body.progress) checkProgress(body.progress);
      if (body.achievement_summary) checkSummary(body.achievement_summary);
      if (body.kind === 'judgment_statistics') {
        equal(Object.keys(body.counts).sort(), [...judgments].sort());
        equal(body.participant_count, Object.values(body.counts).reduce((sum, n) => sum + n, 0));
        for (const judgment of judgments) {
          assert(Number.isInteger(body.counts[judgment]) && body.counts[judgment] >= 0);
          equal(body.percentages[judgment], body.participant_count ? Math.round(body.counts[judgment] * 1000 / body.participant_count) / 10 : null);
        }
      }
      if (body.kind === 'submission_result') {
        checkResult(request.body, body, curve);
        const previous = submissions.get(request.body.request_id);
        if (previous) equal({ request, response }, previous, 'Same request must not create new history');
        else submissions.set(request.body.request_id, { request, response });
      } else if (body.kind === 'retry_draft') {
        const original = [...submissions.values()].find(e => e.response.body.submission_id === body.source_submission_id);
        assert(original);
        const expected = clone(original.request.body);
        delete expected.request_id;
        expected.retry_of_submission_id = body.source_submission_id;
        equal(body.input, expected, 'Retry must restore original input and curve');
        equal(body.creates_submission, false);
        equal(body.progress, original.response.body.progress);
      } else if (body.kind === 'residual_job') {
        const source = [...submissions.values()].find(e => e.response.body.submission_id === body.source_submission_id);
        assert(source);
        equal(body.source_curve_context, source.request.body.curve_context, 'Residual must pin source Bundle');
        const validStates = ['QUEUED', 'RESIDUAL_CALCULATING', 'RESIDUAL_READY', 'PERIODOGRAM_CALCULATING', 'COMPLETED', 'FAILED'];
        assert(validStates.includes(body.status));
        if (jobs.has(body.job_id)) {
          const old = jobs.get(body.job_id);
          assert(!['COMPLETED', 'FAILED'].includes(old.status) || old.status === body.status);
          assert(validStates.indexOf(body.status) >= validStates.indexOf(old.status));
          equal(body.removed_candidate_ids, old.removed_candidate_ids);
        }
        jobs.set(body.job_id, body);
        unique(body.removed_candidate_ids);
        assert(body.removed_candidate_ids.every(id => source.response.body.progress.matched_candidate_ids.includes(id)));
        assert(!('progress' in body) && !('achievement' in body), 'Job failure must not overwrite saved progress');
        if (body.status === 'COMPLETED') {
          checkContext(body.result_curve_context);
          for (const key of contextKeys.filter(k => !['curve_id', 'curve_step', 'removed_candidate_ids'].includes(k))) {
            equal(body.result_curve_context[key], body.source_curve_context[key]);
          }
          setEqual(body.result_curve_context.removed_candidate_ids, body.removed_candidate_ids);
        } else equal(body.result_curve_context, null);
        equal(body.failure !== null, body.status === 'FAILED');
      } else if (body.kind === 'public_analysis_visibility') {
        equal(body.effective_public, body.author_public && !body.moderation_hidden && !body.thread_hidden);
        equal(body.achievement_retained, true);
      }
    }
    if (scenario.setup.records) checkStatistics(scenario);
    if (scenario.setup.histories) checkPublication(scenario);
  }
  return exchangeCount;
}

function checkLinks() {
  for (const file of ['README.md', 'state-model.md', 'examples/README.md']) {
    const full = path.join(__dirname, file), md = fs.readFileSync(full, 'utf8');
    for (const match of md.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/.test(match[1])) continue;
      assert(fs.existsSync(path.resolve(path.dirname(full), match[1].split('#')[0])), 'Broken link in ' + file + ': ' + match[1]);
    }
  }
}

try {
  const manifest = read('manifest.json');
  equal(manifest.synthetic, true);
  unique(manifest.files.map(f => f.file));
  setEqual(fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'manifest.json'), manifest.files.map(f => f.file));
  const scenarios = manifest.files.map(file => {
    assert(path.basename(file.file) === file.file, 'Manifest path must remain in examples');
    const scenario = read(file.file);
    equal(scenario.exchanges.length, file.exchanges);
    equal(scenario.scenario_id, file.file.replace(/\.json$/, ''));
    return scenario;
  });
  const count = validate(scenarios);
  checkLinks();
  const mutations = [
    ['wrong-judgment reward', s => { s[1].exchanges[2].response.body.achievement.awarded_now = true; }],
    ['incorrect derived epoch', s => { s[9].exchanges[0].response.body.server_derived.epoch_btjd = 1009; }],
    ['new history on replay', s => { s[2].exchanges[3].response.body.history_id = 'bad-new-history'; }],
    ['mixed residual Bundle', s => { s[4].exchanges.at(-1).response.body.result_curve_context.publication_bundle_id = 'other-bundle'; }],
    ['counting a private record', s => { s[6].exchanges[1].response.body.counts.UNLIKELY_PLANET++; }],
    ['double publication reward', s => { s[5].exchanges.find(e => e.name === 'new-duplicate-analysis').response.body.items[0].achievement.awarded_now = true; }]
  ];
  for (const [name, mutate] of mutations) {
    const damaged = clone(scenarios);
    mutate(damaged);
    assert(!isDeepStrictEqual(scenarios, damaged), 'Self-test did not mutate ' + name);
    assert.throws(() => validate(damaged), undefined, 'Validator missed ' + name);
  }
  console.log('PASS: ' + scenarios.length + ' synthetic scenarios / ' + count + ' HTTP examples; document links; ' + mutations.length + ' invalid mutations rejected.');
  console.log('Scope: static draft consistency only; no API, browser, DB, BLS, AI or performance tests executed.');
} catch (error) {
  console.error('FAIL: ' + error.message);
  process.exitCode = 1;
}
