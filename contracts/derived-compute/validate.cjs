const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'examples', name), 'utf8'));
const valid = read('derived-compute.valid.json');
const invalid = read('derived-compute.invalid.json');
const clone = value => structuredClone(value);

// README 3.4절 표. 버전이 격자 간격을 고정한다.
const PERIODOGRAM_CONFIGS = {'pg-log5000-v1': {spacing: 'log'}};

const fail = code => {
  const error = new Error(code);
  error.code = code;
  throw error;
};

const candidateIdNumber = value => {
  const match = typeof value === 'string' && /^c-([1-9]\d*)$/.exec(value);
  if (!match) fail('invalid_candidate_id');
  return BigInt(match[1]);
};

const isSortedUnique = values => {
  const numbers = values.map(candidateIdNumber);
  return numbers.every((value, index) => index === 0 || numbers[index - 1] < value);
};

function assertFiniteNumbers(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) fail('non_finite_number');
  if (Array.isArray(value)) value.forEach(assertFiniteNumbers);
  else if (value && typeof value === 'object') Object.values(value).forEach(assertFiniteNumbers);
}

function validateFluxSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) fail('invalid_operation_payload');
  for (const segment of segments) {
    if (!/^seg-[1-9]\d*$/.test(segment.segment_id)) fail('invalid_segment_id');
    if (!Number.isInteger(segment.n_points) || segment.n_points <= 0
        || !Array.isArray(segment.flux) || segment.flux.length !== segment.n_points) {
      fail('flux_length_mismatch');
    }
    if (!segment.flux.every(value => value === null || Number.isFinite(value))) fail('invalid_flux_value');
  }
}

function validateCommon(message) {
  if (message.schema_version !== '1.0') fail('unsupported_schema_version');
  if (!['residual', 'periodogram'].includes(message.operation)) fail('unsupported_operation');
  if (!/^rj-[1-9]\d*$/.test(message.job_id)) fail('invalid_job_id');
  if (!Number.isInteger(message.attempt) || message.attempt < 1) fail('invalid_attempt');
  if (!/^b-[1-9]\d*$/.test(message.publication_bundle_id)) fail('invalid_bundle_id');
  if (!/^[1-9]\d*$/.test(message.tic_id)) fail('invalid_tic_id');
}

function validateRequestCommon(request) {
  validateCommon(request);
  if (!Number.isFinite(request.fold_reference_time_btjd)) fail('invalid_fold_reference_time');
  if (typeof request.residual_model_version !== 'string' || request.residual_model_version.length === 0
      || typeof request.periodogram_config_version !== 'string'
      || request.periodogram_config_version.length === 0) fail('missing_calculation_version');
  if (!Object.hasOwn(PERIODOGRAM_CONFIGS, request.periodogram_config_version)) {
    fail('unsupported_periodogram_config_version');
  }
}

function validateRuntime(response) {
  const runtime = response.runtime;
  if (!runtime || !['worker_image', 'python', 'numpy', 'astropy', 'astro_kernel']
    .every(key => typeof runtime[key] === 'string' && runtime[key].length > 0)) fail('invalid_runtime');
}

function validateInputSegments(segments) {
  validateFluxSegments(segments);
  for (const segment of segments) {
    if (!Number.isInteger(segment.sector) || segment.sector <= 0
        || typeof segment.binning_revision !== 'string' || segment.binning_revision.length === 0
        || !Number.isFinite(segment.start_btjd) || !(segment.bin_minutes > 0)) fail('invalid_segment_metadata');
  }
}

function removedCandidateIds(request) {
  if (request.operation === 'residual') {
    // 빈 목록은 허용한다(README 3.2절). 잔차는 입력 flux와 같다.
    if (!Array.isArray(request.removed_candidates)) fail('invalid_operation_payload');
    const ids = request.removed_candidates.map(candidate => candidate.candidate_id);
    if (new Set(ids).size !== ids.length) fail('duplicate_candidate_id');
    if (!isSortedUnique(ids)) fail('invalid_removed_candidate_order');
    for (const candidate of request.removed_candidates) {
      if (!/^c-[1-9]\d*$/.test(candidate.candidate_id)
          || candidate.transit_model?.candidate_id !== candidate.candidate_id) fail('invalid_candidate_id');
      if (candidate.transit_model.residual_model_version !== request.residual_model_version) {
        fail('version_mismatch');
      }
    }
    return ids;
  }

  const ids = request.removed_candidate_ids;
  if (!Array.isArray(ids)) fail('invalid_operation_payload');
  if (new Set(ids).size !== ids.length) fail('duplicate_candidate_id');
  if (!isSortedUnique(ids)) fail('invalid_removed_candidate_order');
  return ids;
}

function validateRequest(request) {
  validateRequestCommon(request);
  assertFiniteNumbers(request);
  const ids = removedCandidateIds(request);

  if (request.operation === 'residual') {
    if ('residual_segments' in request || 'period_grid' in request) fail('invalid_operation_payload');
    validateInputSegments(request.curve_segments);
  } else {
    if ('curve_segments' in request || 'removed_candidates' in request) fail('invalid_operation_payload');
    validateInputSegments(request.residual_segments);
    const grid = request.period_grid;
    if (!grid || !(grid.min_days > 0) || !(grid.max_days > grid.min_days)
        || !Number.isInteger(grid.count) || grid.count <= 0
        || grid.spacing !== PERIODOGRAM_CONFIGS[request.periodogram_config_version].spacing) {
      fail('invalid_period_grid');
    }
  }
  return ids;
}

function validateErrorResponse(call, response) {
  const ids = removedCandidateIds(call.request);
  validateCommon(response);
  assert.equal(response.ok, false);
  for (const field of ['schema_version', 'operation', 'job_id', 'attempt', 'publication_bundle_id', 'tic_id']) {
    if (response[field] !== call.request[field]) fail('response_correlation_mismatch');
  }
  assert.deepEqual(response.removed_candidate_ids, ids);
  validateRuntime(response);
  if (!['RESIDUAL', 'PERIODOGRAM'].includes(response.error?.stage)
      || typeof response.error.code !== 'string' || response.error.code.length === 0
      || typeof response.error.retryable !== 'boolean'
      || typeof response.error.message !== 'string' || response.error.message.length === 0) {
    fail('invalid_error_response');
  }
}

function validateSuccess(call) {
  const ids = validateRequest(call.request);
  const response = call.response;
  validateCommon(response);
  assert.equal(response.ok, true);
  for (const field of ['schema_version', 'operation', 'job_id', 'attempt', 'publication_bundle_id', 'tic_id']) {
    if (response[field] !== call.request[field]) fail('response_correlation_mismatch');
  }
  assert.deepEqual(response.removed_candidate_ids, ids);
  validateRuntime(response);

  if (response.operation === 'residual') {
    validateFluxSegments(response.result?.residual_segments);
    if (ids.length === 0) {
      assert.deepEqual(response.result.residual_segments.map(segment => segment.flux),
        call.request.curve_segments.map(segment => segment.flux), 'empty removal must preserve flux');
    }
    if (response.result.residual_model_version !== call.request.residual_model_version) fail('version_mismatch');
    const nPoints = call.request.curve_segments.reduce((sum, segment) => sum + segment.n_points, 0);
    const nValid = call.request.curve_segments.reduce(
      (sum, segment) => sum + segment.flux.filter(value => value !== null).length, 0);
    assert.equal(response.result.n_input_points, nPoints);
    assert.equal(response.result.n_valid_input, nValid);
    assert.equal(response.result.n_finite_residual, nValid);
  } else {
    const result = response.result;
    if (result.periodogram_config_version !== call.request.periodogram_config_version) fail('version_mismatch');
    if (!Number.isInteger(result.n_periods) || result.n_periods !== result.period_days.length
        || result.n_periods !== result.power.length) fail('periodogram_length_mismatch');
    if (!result.period_days.every(Number.isFinite) || !result.power.every(Number.isFinite)) {
      fail('non_finite_number');
    }
  }
}

function resolvePath(root, pathValue) {
  const parts = pathValue.split('.');
  const last = parts.pop();
  return {parent: parts.reduce((value, part) => value[part], root), last};
}

function mutate(call, mutation) {
  const {parent, last} = resolvePath(call, mutation.path);
  if (mutation.operation === 'set') parent[last] = mutation.value;
  else if (mutation.operation === 'delete') delete parent[last];
  else if (mutation.operation === 'reverse') parent[last].reverse();
  else if (mutation.operation === 'append-clone-first') parent[last].push(clone(parent[last][0]));
  else throw new Error(`unknown mutation operation: ${mutation.operation}`);
}

assert.equal(valid.contract_version, '1.0');
assert.equal(valid.fixture_kind, 'synthetic-contract-only');
assert.equal(valid.endpoint, 'POST /internal/v1/derived-compute');
assert.deepEqual(JSON.parse(JSON.stringify(valid)), valid);
assert.deepEqual(valid.initial_limits, {
  status: 'pre-measurement-assumption',
  service_concurrency: 2,
  instance_concurrency: 1,
  cpu_per_job: 1,
  memory_mib_per_job: 2048,
  queue_capacity: 20,
  member_active_jobs: 1,
  operation_timeout_seconds: 120,
  recalibration_ticket: 'S15P21C206-104'
});

assert.equal(new Set(valid.calls.map(call => call.id)).size, valid.calls.length);
valid.calls.forEach(validateSuccess);

assert.equal(invalid.contract_version, valid.contract_version);
assert.equal(invalid.fixture_kind, 'synthetic-contract-only');
assert.equal(new Set(invalid.request_cases.map(testCase => testCase.id)).size, invalid.request_cases.length);

for (const testCase of invalid.request_cases) {
  const baseCall = valid.calls.find(call => call.id === (testCase.base_call ?? invalid.base_call));
  assert.ok(baseCall, `${testCase.id} base call must exist`);
  const call = clone(baseCall);
  mutate(call, testCase.mutation);
  assert.throws(
    () => validateRequest(call.request),
    error => error.code === testCase.expected_error,
    `${testCase.id} must fail with ${testCase.expected_error}`
  );
}

assert.equal(new Set(invalid.error_responses.map(example => example.id)).size, invalid.error_responses.length);
for (const example of invalid.error_responses) {
  const call = valid.calls.find(candidate => candidate.id === example.base_call);
  assert.ok(call, `${example.id} base call must exist`);
  validateErrorResponse(call, example.response);
}

assert.deepEqual(invalid.transport_cases, [{
  id: 'periodogram-timeout',
  operation: 'periodogram',
  elapsed_seconds: valid.initial_limits.operation_timeout_seconds,
  partial_result_accepted: false,
  expected_backend_failure: {
    stage: 'PERIODOGRAM',
    code: 'compute_timeout',
    retryable: true
  }
}]);

console.log(`PASS: ${valid.calls.length} derived compute calls, ${invalid.request_cases.length} invalid requests, ${invalid.error_responses.length} error response, ${invalid.transport_cases.length} timeout scenario`);
