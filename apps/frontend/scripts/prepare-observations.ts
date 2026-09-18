import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  convertObservation,
  OBSERVATION_TARGETS,
  CONVERSION_VERSION,
} from "../dev/observation-data.ts";

const args = process.argv.slice(2);
assert(
  args.length === 2 && args[0] === "--source-dir",
  "Usage: npm run data:prepare -- --source-dir <prototype observations directory>",
);
const source = resolve(args[1]);
const output = resolve("dev/observations");
assert(source !== output, "Source and output must differ");
const manifest = JSON.parse(
  await readFile(join(source, "manifest.json"), "utf8"),
);
assert.equal(manifest.schema_version, "analysis-observations-v1");
assert.equal(manifest.targets.length, OBSERVATION_TARGETS.length);
const outputs = [];
for (const target of OBSERVATION_TARGETS) {
  const entry = manifest.targets.find(
    (item: { id: string }) => item.id === target.id,
  );
  assert(
    entry &&
      entry.file === `${target.id}.json` &&
      entry.tic_id === target.ticId,
  );
  const bytes = await readFile(join(source, entry.file));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256, entry.sha256, `${entry.file}: SHA-256 mismatch`);
  assert.equal(bytes.length, entry.size_bytes);
  const input = JSON.parse(bytes.toString("utf8"));
  assert.equal(input.bundle_id, entry.bundle_id);
  assert.equal(input.point_count, entry.point_count);
  const converted = convertObservation(input, sha256);
  const body = JSON.stringify(converted);
  const total = converted.curve.segments.reduce(
    (sum, item) => sum + item.nPoints,
    0,
  );
  const valid = converted.curve.segments.reduce(
    (sum, item) => sum + item.flux.filter((v) => v !== null).length,
    0,
  );
  outputs.push({
    file: `${target.ticId}.json`,
    body,
    summary: {
      ...target,
      sourcePoints: input.point_count,
      total,
      valid,
      missing: total - valid,
      bundleId: converted.context.bundle.bundleId,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: Buffer.byteLength(body),
    },
  });
}
// Validate all three before writing any output; source files are read-only.
await mkdir(output, { recursive: true });
for (const item of outputs) await writeFile(join(output, item.file), item.body);
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      conversion: CONVERSION_VERSION,
      targets: outputs.map((item) => item.summary),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    outputs.map((item) => item.summary),
    null,
    2,
  ),
);
