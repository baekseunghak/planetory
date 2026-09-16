const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'examples', name), 'utf8'));
const valid = read('publication-bundle.valid.json');
const invalidCases = read('publication-bundle.invalid.json');
const publicationLoad = read('publication-load-scenarios.json');
const clone = value => structuredClone(value);
const sha256 = value => `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

const fail = code => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const requiredManifestFields = [
  'segment_ids',
  'array_checksums',
  'residual_model_version',
  'periodogram_config_version',
  'binning',
  'period_grid',
  'fine_tune',
  'curve_steps'
];

function assertFiniteNumbers(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) fail('NON_FINITE_NUMBER');
  if (Array.isArray(value)) value.forEach(assertFiniteNumbers);
  else if (value && typeof value === 'object') Object.values(value).forEach(assertFiniteNumbers);
}

function assertNoPublishedQualityMask(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['quality_mask', 'qualityMask', 'mask_path', 'maskPath'].includes(key)) fail('QUALITY_MASK_MUST_NOT_BE_PUBLISHED');
    assertNoPublishedQualityMask(child);
  }
}

function validate(fixture) {
  assert.equal(fixture.contractVersion, '1.0');
  assert.equal(fixture.fixtureKind, 'synthetic-contract-only');
  assertFiniteNumbers(fixture);

  const rows = fixture.publisherRows;
  const bundle = rows.publication_bundles;
  if (!['staging', 'current', 'archived'].includes(bundle.status)) fail('INVALID_BUNDLE_STATUS');
  if (!(bundle.base_days > 0)) fail('INVALID_BASE_DAYS');
  if (!Number.isFinite(bundle.fold_reference_time_btjd)) fail('INVALID_FOLD_REFERENCE_TIME');
  if (!Number.isFinite(Date.parse(bundle.published_at))) fail('INVALID_PUBLISHED_AT');

  for (const field of requiredManifestFields) {
    if (!(field in bundle.manifest)) fail('MISSING_MANIFEST_FIELD');
  }
  if (!Array.isArray(bundle.manifest.segment_ids) || bundle.manifest.segment_ids.length === 0) fail('INVALID_SEGMENT_IDS');
  if (!(bundle.manifest.binning.minutes > 0)) fail('INVALID_BIN_MINUTES');

  for (const segment of rows.light_curve_segments) {
    if (!Number.isInteger(segment.n_points) || segment.n_points <= 0) fail('INVALID_N_POINTS');
    if (segment.n_points !== segment.flux.length) fail('FLUX_LENGTH_MISMATCH');
    if (!(segment.bin_minutes > 0)) fail('INVALID_BIN_MINUTES');
    if (!segment.flux.every(value => value === null || Number.isFinite(value))) fail('INVALID_FLUX_VALUE');
    for (const gap of segment.gaps) {
      if (!Array.isArray(gap) || gap.length !== 2 || !Number.isInteger(gap[0]) || !Number.isInteger(gap[1])
          || gap[0] < 0 || gap[0] > gap[1] || gap[1] >= segment.n_points) fail('INVALID_GAP_RANGE');
    }
  }

  const periodogram = rows.periodograms;
  if (!(periodogram.period_min_days > 0 && periodogram.period_max_days > periodogram.period_min_days)) fail('INVALID_PERIOD_RANGE');
  if (periodogram.n_periods !== periodogram.power.length) fail('POWER_LENGTH_MISMATCH');
  if (!periodogram.power.every(Number.isFinite)) fail('INVALID_POWER_VALUE');

  for (const candidate of rows.candidates) {
    if (!(candidate.period_days > 0)) fail('INVALID_CANDIDATE_PERIOD');
    if (!(candidate.duration_hours > 0)) fail('INVALID_CANDIDATE_DURATION');
    if (!(candidate.depth_ppm >= 0)) fail('INVALID_CANDIDATE_DEPTH');
    if (!candidate.transit_model || typeof candidate.transit_model !== 'object'
        || Array.isArray(candidate.transit_model) || Object.keys(candidate.transit_model).length === 0) fail('INVALID_TRANSIT_MODEL');
  }

  assertNoPublishedQualityMask(rows);

  const scenario = fixture.scenario;
  if (bundle.id !== scenario.afterCommit.currentBundleId) fail('PUBLISHER_NOT_CURRENT_BUNDLE');
  if (!scenario.afterCommit.archivedBundleIds.includes(scenario.before.currentBundleId)) fail('OLD_BUNDLE_NOT_ARCHIVED');
  if (!scenario.afterCommit.deletedPeriodogramBundleIds.includes(scenario.before.currentBundleId)) fail('ARCHIVED_PERIODOGRAM_NOT_DELETED');
  if (!scenario.afterCommit.evictedRedisBundleIds.includes(scenario.before.currentBundleId)) fail('ARCHIVED_REDIS_NOT_EVICTED');
  if (scenario.afterCommit.notification.bundleId !== bundle.id) fail('INVALID_BUNDLE_NOTIFICATION');

  const backend = fixture.backendReadModel;
  if (backend.publicationBundle.id !== bundle.id || backend.publicationBundle.ticId !== bundle.tic_id
      || backend.publicationBundle.bundleVersion !== bundle.bundle_version) fail('BACKEND_BUNDLE_MAPPING_MISMATCH');
  if (backend.publicationBundle.status !== bundle.status.toUpperCase()) fail('BACKEND_BUNDLE_STATUS_MISMATCH');
  if (backend.publicationBundle.foldReferenceTimeBtjd !== bundle.fold_reference_time_btjd) fail('BACKEND_UNIT_MAPPING_MISMATCH');
  if (backend.publicationBundle.residualModelVersion !== bundle.manifest.residual_model_version
      || backend.publicationBundle.periodogramConfigVersion !== bundle.manifest.periodogram_config_version) fail('BACKEND_VERSION_MAPPING_MISMATCH');
  const segment = rows.light_curve_segments[0];
  assert.deepEqual(backend.lightCurveSegments[0], {
    id: segment.id,
    ticId: segment.tic_id,
    sector: segment.sector,
    binningRevision: segment.binning_revision,
    startBtjd: segment.start_btjd,
    binMinutes: segment.bin_minutes,
    nPoints: segment.n_points,
    flux: segment.flux,
    fluxScatter: segment.flux_scatter,
    gaps: segment.gaps
  });
  assert.deepEqual(backend.periodogram, {
    bundleId: periodogram.bundle_id,
    periodMinDays: periodogram.period_min_days,
    periodMaxDays: periodogram.period_max_days,
    nPeriods: periodogram.n_periods,
    power: periodogram.power
  });

  const frontend = fixture.frontendResponses;
  const expectedBundleId = `b-${scenario.afterCommit.currentBundleId}`;
  if (frontend.analysisContext.bundle.bundleId !== expectedBundleId
      || frontend.curve.bundleId !== expectedBundleId
      || frontend.periodogram.bundleId !== expectedBundleId) fail('FRONTEND_NOT_CURRENT_BUNDLE');
  if (frontend.analysisContext.bundle.foldReferenceTimeBtjd !== bundle.fold_reference_time_btjd
      || frontend.curve.foldReferenceTimeBtjd !== bundle.fold_reference_time_btjd) fail('FRONTEND_UNIT_MAPPING_MISMATCH');
  if (frontend.analysisContext.ticId !== String(bundle.tic_id)
      || frontend.curve.ticId !== String(bundle.tic_id)) fail('FRONTEND_TIC_MAPPING_MISMATCH');
  assert.equal(frontend.curve.fluxUnit, 'normalized');
  if (frontend.analysisContext.bundle.bundleVersion !== bundle.bundle_version) fail('FRONTEND_VERSION_MAPPING_MISMATCH');
  assert.deepEqual(frontend.curve.segments[0], {
    segmentId: `seg-${segment.id}`,
    sector: segment.sector,
    binningRevision: segment.binning_revision,
    startBtjd: segment.start_btjd,
    binMinutes: segment.bin_minutes,
    nPoints: segment.n_points,
    flux: segment.flux,
    fluxScatter: segment.flux_scatter,
    gaps: segment.gaps
  });
  assert.deepEqual(frontend.periodogram, {
    bundleId: expectedBundleId,
    periodMinDays: periodogram.period_min_days,
    periodMaxDays: periodogram.period_max_days,
    nPeriods: periodogram.n_periods,
    gridRule: bundle.manifest.period_grid.spacing,
    power: periodogram.power
  });

  const checksums = bundle.manifest.array_checksums;
  if (checksums['segment:1001:flux'] !== sha256(rows.light_curve_segments[0].flux)
      || checksums['periodogram:101:power'] !== sha256(periodogram.power)) fail('CHECKSUM_MISMATCH');
}

function mutate(fixture, testCase) {
  const parts = testCase.path.split('.');
  const last = parts.pop();
  const parent = parts.reduce((value, key) => value[key], fixture);
  if (testCase.operation === 'delete') delete parent[last];
  else parent[last] = testCase.value;
}

const requiredCalculationVersions = [
  'preprocessing',
  'bls_config',
  'residual_model',
  'periodogram_config',
  'candidate_quality',
  'ai_model',
  'ai_threshold',
  'external_matching'
];

function normalizeSemanticPayload(payload) {
  const value = clone(payload);
  value.input_snapshot_ids.sort();
  value.segments.sort((left, right) =>
    [left.tic_id, left.sector, left.binning_revision]
      .join(':')
      .localeCompare([right.tic_id, right.sector, right.binning_revision].join(':')));
  return value;
}

function expectedBundleVersion(payload) {
  const lines = [
    ...payload.input_snapshot_ids.map(id => `input_snapshot:${id}`),
    ...payload.segments.map(segment =>
      `segment:${segment.tic_id}:${segment.sector}:${segment.binning_revision}`),
    ...Object.entries(payload.calculation_versions)
      .map(([name, version]) => `version:${name}:${version}`)
  ].sort();
  return `pv1-${crypto.createHash('sha256').update(`${lines.join('\n')}\n`, 'utf8').digest('hex')}`;
}

function resolvePayload(contract, name) {
  const payload = contract.payloads[name];
  assert.ok(payload, `unknown payload reference: ${name}`);
  return payload;
}

function emptyResult(scenario, code, retryable, bundleId = null) {
  return {
    code,
    retryable,
    bundleId,
    currentBundleId: scenario.before.currentBundleId,
    archivedBundleIds: [],
    persistedStagingBundleIds: [],
    notificationBundleId: null
  };
}

function simulatePublication(contract, scenario) {
  const request = resolvePayload(contract, scenario.requestPayload);
  const existing = scenario.before.existingBundle;
  if (existing) {
    const stored = resolvePayload(contract, existing.payload);
    assert.equal(stored.tic_id, request.tic_id, `${scenario.id} existing bundle must use the request TIC`);
    assert.equal(stored.bundle_version, request.bundle_version,
      `${scenario.id} existing bundle must use the request version`);
    if (!isDeepStrictEqual(
      normalizeSemanticPayload(stored.semantic_payload),
      normalizeSemanticPayload(request.semantic_payload)
    )) return emptyResult(scenario, 'IDEMPOTENCY_CONFLICT', false);

    if (existing.status === 'archived') {
      return emptyResult(scenario, 'BUNDLE_SUPERSEDED', false, existing.id);
    }
    assert.equal(existing.status, 'current', `${scenario.id} existing status must be current or archived`);
    return {
      ...emptyResult(scenario, 'ALREADY_PUBLISHED', false, existing.id),
      currentBundleId: existing.id,
      notificationBundleId: existing.id
    };
  }

  if (scenario.failure?.category === 'validation') {
    return emptyResult(scenario, 'PUBLISH_REJECTED', false);
  }
  if (scenario.failure?.category === 'transient') {
    return emptyResult(scenario, 'PUBLISH_ROLLED_BACK', true);
  }

  return {
    code: 'PUBLISHED',
    retryable: false,
    bundleId: scenario.before.nextGeneratedBundleId,
    currentBundleId: scenario.before.nextGeneratedBundleId,
    archivedBundleIds: [scenario.before.currentBundleId],
    persistedStagingBundleIds: [],
    notificationBundleId: scenario.before.nextGeneratedBundleId
  };
}

function validatePublicationLoad(contract) {
  assert.equal(contract.contractVersion, '1.1');
  assert.equal(contract.fixtureKind, 'synthetic-contract-only');
  assert.deepEqual(contract.idempotency.keyFields, ['tic_id', 'bundle_version']);
  assert.equal(contract.idempotency.databaseInvariant, 'unique-tic-id-bundle-version');
  assert.equal(contract.idempotency.bundleVersionScheme, 'pv1-sha256-sorted-lf-utf8');
  assert.deepEqual(contract.idempotency.bundleVersionInputs,
    ['input_snapshot_ids', 'segment_natural_keys', 'calculation_versions']);
  assert.deepEqual(contract.idempotency.inputSnapshotKinds,
    ['light-curve-source', 'external-reference']);
  assert.deepEqual(contract.idempotency.bundleVersionExcludes, ['execution_time', 'run_id']);
  assert.deepEqual(contract.idempotency.calculationVersionCoverage, {
    bls_config: ['iterative-bls', 'removal-order', 'termination-rule'],
    candidate_quality: [
      'candidate-merge',
      'harmonic-alias',
      'original-curve-revalidation',
      'discoverable-rule'
    ]
  });
  assert.deepEqual(contract.idempotency.payloadEqualityFields, [
    'input_snapshot_ids',
    'segments',
    'periodogram_power_checksum',
    'candidates_checksum',
    'ai_results_checksum',
    'external_statuses_checksum',
    'calculation_versions',
    'fold_reference_time_btjd',
    'base_days'
  ]);
  assert.deepEqual(contract.idempotency.payloadEqualityExcludes, [
    'publication_bundles.id',
    'light_curve_segments.id',
    'periodograms.bundle_id',
    'manifest.segment_ids'
  ]);
  assert.equal(contract.idempotency.arrayOrder, 'input_snapshot_ids-and-segments-sorted-before-compare');
  assert.equal(contract.idempotency.floatRule, 'exact-float64-after-json-17-significant-digits');
  assert.equal(contract.idempotency.serialization, 'pg_advisory_xact_lock(tic_id)');
  assert.equal(contract.idempotency.databaseId, 'generated-result-only');
  assert.equal(contract.transaction.owner, 'publisher');
  assert.equal(contract.transaction.retryOwner, 'airflow');
  assert.deepEqual(contract.transaction.stages,
    ['load', 'validate', 'switch-current', 'cleanup-archived-periodogram']);
  assert.deepEqual(contract.transaction.switchCurrentOrder,
    ['archive-current', 'promote-staging']);
  assert.equal(contract.transaction.commitAfter, 'cleanup-archived-periodogram');
  assert.equal(contract.transaction.committedStagingAllowed, false);
  assert.equal(contract.transaction.sameKeyConcurrency, 'wait-for-lock-then-observe-commit-or-rollback');

  for (const payload of Object.values(contract.payloads)) {
    assert.equal(payload.bundle_version, expectedBundleVersion(payload.semantic_payload));
    assert.ok(payload.semantic_payload.base_days > 0);
    assert.ok(Number.isFinite(payload.semantic_payload.fold_reference_time_btjd));
    assert.deepEqual(Object.keys(payload.semantic_payload.calculation_versions).sort(),
      [...requiredCalculationVersions].sort());
    for (const segment of payload.semantic_payload.segments) {
      assert.equal(segment.tic_id, payload.tic_id);
    }
  }

  assert.equal(new Set(contract.scenarios.map(scenario => scenario.id)).size, contract.scenarios.length);
  for (const scenario of contract.scenarios) {
    resolvePayload(contract, scenario.requestPayload);
    assert.deepEqual(simulatePublication(contract, scenario), scenario.expected, scenario.id);
  }
}

validate(valid);
assert.equal(new Set(invalidCases.map(testCase => testCase.id)).size, invalidCases.length);

for (const testCase of invalidCases) {
  const fixture = clone(valid);
  mutate(fixture, testCase);
  assert.throws(
    () => validate(fixture),
    error => error.code === testCase.expectedError,
    `${testCase.id} must fail with ${testCase.expectedError}`
  );
}

validatePublicationLoad(publicationLoad);

console.log(`PASS: 1 synthetic Gold fixture, ${invalidCases.length} invalid contract cases, and ${publicationLoad.scenarios.length} publication load scenarios`);
