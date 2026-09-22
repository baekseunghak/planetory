'use strict';
// Saved candidates + reconstructed observation windows. No policy optimization.
const fs = require('node:fs');
const { validate, match } = require('./matching-v0.cjs');
const rules = require('./matching-rules.v0.json');

function replay(dataset, baseRules = rules) {
  if (dataset.schema !== 'planetory.matching-replay-input.v1') throw new Error('unknown schema');
  const rows = [];
  for (const curve of dataset.curves) {
    for (const submission of curve.submissions) {
      const v = validate(curve.bundle, baseRules, submission.selection, []);
      for (const cap of [null, 5, 10, 20, 50]) {
        const policy = structuredClone(baseRules);
        policy.matching.nTransits.cap = cap;
        const derived = { periodDays: submission.selection.periodDays,
          epochBtjd: v.epochBtjd, durationDays: v.durationDays };
        const result = v.ok ? match(curve.bundle, policy, derived, curve.candidates, []) : null;
        rows.push({ curve_id: curve.id, injection_id: submission.injection_id,
          variant: submission.variant, n_cap: cap, reference_candidate_111: submission.reference_candidate_111,
          validation: v.ok ? 'passed' : v.code, status: result?.status ?? 'validation_rejected',
          selected_candidate: result?.candidateId ?? null,
          agrees_with_111_recovery: v.ok && result.candidateId === submission.reference_candidate_111,
          dominance: result?.dominance ?? null,
          evaluations: result?.evaluations ?? [] });
      }
    }
  }
  const summary = {};
  for (const row of rows) {
    const key = `${row.variant}/cap=${row.n_cap ?? 'none'}`;
    const s = summary[key] ??= { submissions: 0, agrees_with_111_recovery: 0, statuses: {} };
    s.submissions++;
    s.agrees_with_111_recovery += Number(row.agrees_with_111_recovery);
    s.statuses[row.status] = (s.statuses[row.status] ?? 0) + 1;
  }
  return { schema: 'planetory.matching-replay-result.v1', rule_version: baseRules.ruleVersion,
    limitation: '111 recovery agreement, not user accuracy; offset probes have no negative truth label', summary, rows };
}
if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('usage: node matching-replay.cjs input.json output.json');
  const result = replay(JSON.parse(fs.readFileSync(input, 'utf8')));
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result.summary));
}
module.exports = { replay };
