import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Import a verified export without recomputing observations or changing the catalogue.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({
  options: {
    'source-dir': { type: 'string' },
    check: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});
if (values.help) {
  console.log('Usage: node scripts/import-observations.mjs [--source-dir <directory>] [--check]');
  console.log('Input: the original analysis-ui manifest.json and toi270.json, l98-59.json, cm-dra.json.');
  console.log('Default input: the sibling analysis-ui/public/observations directory.');
  console.log('A single positional directory is also supported. --check writes no files.');
  process.exit(0);
}
assert(positionals.length <= 1 && !(positionals.length && values['source-dir']), 'Use one input directory.');
const inputDirectory = values['source-dir'] ?? positionals[0];
const source = inputDirectory ? path.resolve(inputDirectory) : path.resolve(root, '../analysis-ui/public/observations');
const destination = path.join(root, 'public/observations');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function readInput(name) {
  try {
    return fs.readFileSync(path.join(source, name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error(`Missing input ${name} in ${source}. Prepare the analysis-ui export first or pass --source-dir <directory>; see README.md.`);
  }
}

const manifest = JSON.parse(readInput('manifest.json').toString('utf8'));
assert.equal(manifest.schema_version, 'analysis-observations-v1', 'Use the original analysis-ui manifest.');
assert(Array.isArray(manifest.targets), 'The input manifest must contain targets.');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/catalog.json'), 'utf8'));
const inputs = [];
const records = [];
for (const id of ['toi270', 'l98-59', 'cm-dra']) {
  const entries = manifest.targets.filter((target) => target.id === id);
  assert.equal(entries.length, 1, `${id}: expected one manifest entry.`);
  const entry = entries[0];
  const filename = `${id}.json`;
  assert.equal(entry.file, filename, `${id}: unexpected manifest filename.`);
  const bytes = readInput(filename);
  assert.equal(sha256(bytes), entry.sha256, `${id}: source checksum differs from its manifest.`);
  assert.equal(bytes.length, entry.size_bytes, `${id}: source size differs from its manifest.`);
  const data = JSON.parse(bytes.toString('utf8'));
  assert.equal(data.schema_version, 'analysis-observations-v1');
  assert.equal(data.id, id);
  assert.equal(data.tic_id, entry.tic_id);
  assert.equal(data.bundle_id, entry.bundle_id);
  assert.equal(data.point_count, entry.point_count);
  assert.deepEqual(data.sectors, entry.sectors);
  assert.equal(data.time_btjd.length, data.point_count);
  assert.equal(data.normalized_flux.length, data.point_count);
  assert(data.time_btjd.every(Number.isFinite) && data.normalized_flux.every(Number.isFinite), `${id}: non-finite observations.`);
  assert(data.time_btjd.every((time, index, all) => index === 0 || time >= all[index - 1]), `${id}: unordered observation times.`);
  const star = catalog.find((item) => item.id === id);
  assert(star, `${id}: missing committed catalogue entry.`);
  assert.equal(star.tic, data.tic_id);
  assert.equal(star.pointCount, data.point_count, `${id}: this export differs from the committed prototype catalogue.`);
  assert.deepEqual(star.sectors, data.sectors);
  inputs.push({ filename, bytes });
  records.push({ file: filename, sha256: sha256(bytes), bytes: bytes.length, pointCount: data.point_count, bundleId: data.bundle_id });
}
const outputManifest = Buffer.from(JSON.stringify({
  source: 'Existing Planetory analysis-observations-v1 exports, byte-for-byte copies; no FITS reread or BLS recomputation.',
  mapPositions: 'Schematic visual arrangement. Marker positions are not a celestial projection.',
  records,
}, null, 2) + '\n');
const outputs = [...inputs, { filename: 'manifest.json', bytes: outputManifest }];

// Every source is validated before writing any destination file.
if (values.check) {
  for (const { filename, bytes } of outputs) {
    assert(fs.existsSync(path.join(destination, filename)), `Missing prepared ${filename}; run pnpm data:prepare first.`);
    assert(fs.readFileSync(path.join(destination, filename)).equals(bytes), `${filename}: prepared file differs from the verified input.`);
  }
} else {
  fs.mkdirSync(destination, { recursive: true });
  for (const { filename, bytes } of outputs) fs.writeFileSync(path.join(destination, filename), bytes);
}
console.log(`${values.check ? 'Checked without writing' : 'Prepared'} ${records.length} observation files; catalogue unchanged.`);
console.log(records.map((item) => `${item.file}: ${item.pointCount} points, ${item.sha256}`).join('\n'));
