import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Repackage a previously verified observation export. Do not recalculate,
// downsample, round, or replace any observation or periodogram value.
const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  check: { type: 'boolean', default: false },
  'source-dir': { type: 'string' },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: node scripts/prepare-observations.mjs [--source-dir <directory>] [--check]');
  console.log('Input: toi270.json and its original manifest.json from the analysis-ui export.');
  console.log('Default input: ../analysis-ui/public/observations, relative to analysis-lab.');
  process.exit(0);
}
const sourceDirectory = values['source-dir']
  ? resolve(values['source-dir'])
  : resolve(here, '../../analysis-ui/public/observations');
const sourcePath = resolve(sourceDirectory, 'toi270.json');
const manifestPath = resolve(sourceDirectory, 'manifest.json');
const destinationPath = resolve(here, '../public/observations/toi270.json');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
async function readInput(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.error(`Missing observation input: ${path}`);
    console.error('Prepare analysis-ui observations first, or pass --source-dir <directory> containing toi270.json and manifest.json.');
    console.error('See OBSERVATION-SOURCE.md and ../analysis-ui/scripts/README-observations.md.');
    process.exit(1);
  }
}
const sourceBytes = await readInput(sourcePath);
const manifestBytes = await readInput(manifestPath);
const originalHash = sha256(sourceBytes);
const input = JSON.parse(sourceBytes.toString('utf8'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const entry = manifest.targets.find((target) => target.id === 'toi270');
assert(entry, 'The original manifest must contain TOI-270.');
assert.equal(originalHash, entry.sha256, 'The source must match its manifest.');
assert.equal(sourceBytes.length, entry.size_bytes);
assert.equal(input.id, 'toi270');
assert.equal(input.point_count, entry.point_count);
assert.equal(input.time_btjd.length, input.point_count);
assert.equal(input.normalized_flux.length, input.point_count);
assert.equal(input.periodogram.period_days.length, 8000);
assert.equal(input.periodogram.power.length, 8000);

for (const values of [input.time_btjd, input.normalized_flux,
  input.periodogram.period_days, input.periodogram.power]) {
  assert(values.every(Number.isFinite), 'All chart values must be finite.');
}
assert(input.time_btjd.every((value, index, values) => index === 0 || value >= values[index - 1]));
assert(Number.isFinite(input.fold_reference_time_btjd));

const firstPeak = input.peaks.find((peak) => peak.rank === 1);
assert(firstPeak, 'An observation-derived rank-one BLS peak is required.');
const strongestIndex = input.periodogram.power.reduce(
  (best, value, index, values) => value > values[best] ? index : best, 0,
);
assert.equal(firstPeak.period_days, input.periodogram.period_days[strongestIndex]);

const output = {
  schemaVersion: 'analysis-lab-observations-v1',
  id: input.id,
  label: input.label,
  tic: input.tic_id,
  pointCount: input.point_count,
  sectors: input.sectors,
  time: input.time_btjd,
  flux: input.normalized_flux,
  referenceTime: input.fold_reference_time_btjd,
  seedPeriod: firstPeak.period_days,
  periodogram: {
    periods: input.periodogram.period_days,
    powers: input.periodogram.power,
  },
  source: {
    mission: 'TESS',
    fluxColumn: input.provenance.processing.flux_column,
    timeUnit: 'BTJD (BJD_TDB - 2457000), days',
    fluxUnit: 'normalized relative flux',
    file: 'experiments/analysis-ui/public/observations/toi270.json',
    sha256: originalHash,
    bundleId: input.bundle_id,
    originalExportedAt: input.provenance.generated_at,
    qualityCounts: input.provenance.quality_counts,
    referenceRule: input.provenance.processing.reference_rule,
    normalization: input.provenance.processing.normalization,
    sampling: 'All existing exported points retained; no additional sampling, cleaning or rounding.',
    seedRule: 'Rank-one peak from the existing observation-derived BLS periodogram; not a catalog answer.',
    bls: {
      periodMin: input.provenance.processing.bls.period_min,
      periodMax: input.provenance.processing.bls.period_max,
      pointCount: input.provenance.processing.bls.n_periods,
      weighted: input.provenance.processing.bls.weighted,
    },
    pipelineSha256: input.provenance.pipeline_sha256,
    files: input.provenance.sources.map((file) => ({
      file: file.relative_path,
      sha256: file.sha256,
      sector: file.sector,
      rawPointCount: file.raw_point_count,
      eligiblePointCount: file.eligible_point_count,
      retainedPointCount: file.retained_point_count,
    })),
  },
};

// Explicit construction above intentionally excludes catalog dispositions,
// candidate names, answer epochs/durations and any adjudication fields.
const encoded = `${JSON.stringify(output)}\n`;
const roundTrip = JSON.parse(encoded);
assert.deepEqual(roundTrip.time, input.time_btjd);
assert.deepEqual(roundTrip.flux, input.normalized_flux);
assert.deepEqual(roundTrip.periodogram.periods, input.periodogram.period_days);
assert.deepEqual(roundTrip.periodogram.powers, input.periodogram.power);
assert.equal(roundTrip.referenceTime, input.fold_reference_time_btjd);
assert.equal(roundTrip.seedPeriod, firstPeak.period_days);

if (values.check) {
  assert.deepEqual(JSON.parse(await readFile(destinationPath, 'utf8')), output);
} else {
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, encoded, 'utf8');
}
assert.equal(sha256(await readFile(sourcePath)), originalHash, 'Original data changed.');
assert.equal(sha256(await readFile(manifestPath)), sha256(manifestBytes), 'Original manifest changed.');

const range = (values) => values.reduce(
  ([min, max], value) => [Math.min(min, value), Math.max(max, value)],
  [Infinity, -Infinity],
);
console.log(JSON.stringify({
  checkedOnly: values.check,
  file: destinationPath,
  sizeBytes: Buffer.byteLength(encoded),
  sha256: sha256(encoded),
  pointCount: output.pointCount,
  timeRange: range(output.time),
  fluxRange: range(output.flux),
  periodogramPoints: output.periodogram.periods.length,
  periodRange: range(output.periodogram.periods),
  powerRange: range(output.periodogram.powers),
  referenceTime: output.referenceTime,
  seedPeriod: output.seedPeriod,
}, null, 2));
