'use strict';
// Versioned proposal validator. Passing this does not activate an operation_settings row.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('./matching-v0.cjs');
const rules = require('./matching-rules.v1.json');
const oldRules = require('./matching-rules.v0.json');

function checkContract(c) {
  const policy = structuredClone(rules);
  for (const [key, value] of Object.entries(c.overrides ?? {})) {
    const parts = key.split('.');
    const leaf = parts.pop();
    let current = policy;
    for (const part of parts) {
      if (!Object.hasOwn(current, part)) throw new Error(`unknown override: ${key}`);
      current = current[part];
    }
    if (!Object.hasOwn(current, leaf)) throw new Error(`unknown override: ${key}`);
    current[leaf] = value;
  }
  let actual;
  if (c.mode === 'validate') actual = engine.validate(c.bundle, policy, c.selection, c.peaks);
  else if (c.mode === 'evaluate') actual = engine.evaluate(c.bundle, policy, c.derived, c.candidate, c.multiplier);
  else if (c.mode === 'match') actual = engine.match(c.bundle, policy, c.derived, c.candidates, c.removedCandidateIds);
  else throw new Error(`unknown mode ${c.mode}`);
  assert.ok(Object.keys(c.expectedSubset).length > 0, 'empty expectation');
  for (const [key, expected] of Object.entries(c.expectedSubset)) {
    assert.ok(Object.hasOwn(actual, key), `${c.id}: missing ${key}`);
    assert.deepEqual(actual[key], expected, `${c.id}: ${key}`);
  }
}

function main() {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'matching-cases.v1.json'), 'utf8'));
  assert.equal(fx.ruleVersion, rules.ruleVersion);
  assert.equal(rules.ruleVersion, 'rule-1');
  assert.equal(fx.contractStatus, rules.status);
  // Shared engine uses the fixed tie epsilon. Changing it requires its own implementation work.
  assert.equal(rules.numerics.epsilon.value, oldRules.numerics.epsilon.value);
  const ids = new Set();
  for (const c of [...fx.cases, ...fx.contractChecks]) {
    assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
    ids.add(c.id);
  }
  for (const c of fx.cases) assert.deepEqual(engine.runCase(fx, c, rules), c.expected, c.id);
  for (const c of fx.contractChecks) checkContract(c);
  console.log(`PASS: ${fx.cases.length} complete fixtures + ${fx.contractChecks.length} contract projections; ${rules.ruleVersion} (${rules.status})`);
}
if (require.main === module) main();
module.exports = { checkContract };
