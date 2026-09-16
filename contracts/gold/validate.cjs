const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'examples', name), 'utf8'));
const valid = read('publication-bundle.valid.json');
const invalidCases = read('publication-bundle.invalid.json');
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

console.log(`PASS: 1 synthetic Gold fixture and ${invalidCases.length} invalid contract cases`);
