const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
const suite = read('contracts.json');
const decisions = read('decisions.json');
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const mod1 = n => ((n % 1) + 1) % 1;
assert.equal(suite.contractStatus, 'draft-static-only');
assert.equal(decisions.contractStatus, 'review-only');
assert.equal(suite.fixtureVersion, decisions.fixtureVersion);
const byId = Object.fromEntries(suite.cases.map(c => [c.id, c]));
assert.equal(Object.keys(byId).length, suite.cases.length);
for (const c of suite.cases) {
  assert.ok(c.at.length && c.at.every(at => /^AT-\d+$/.test(at)));
  assert.ok(c.sourceSection);
  assert.ok(c.request.path.startsWith('/api/v1/'));
  const b = c.response.body;
  if (c.response.status >= 400) {
    assert.equal(typeof b.code, 'string');
    assert.equal(typeof b.message, 'string');
    assert.ok(Array.isArray(b.fieldErrors));
  }
  if (c.request.method === 'GET') assert.ok(!c.effects || !c.effects.jobsCreated);
}
const normal = byId['normal-harmonic'];
assert.match(normal.request.body.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
assert.equal(normal.response.status, 201);
assert.equal(normal.request.body.requestId, normal.response.body.requestId);
for (const [key, val] of Object.entries(normal.request.body.selection)) near(val, normal.response.body.original[key]);
const s = normal.request.body.selection;
near(normal.response.body.serverDerived.durationHours, (s.phaseEnd - s.phaseStart) * s.periodDays * 24);
assert.deepEqual(byId['same-request-replay'].response.body, normal.response.body);
assert.equal(byId['same-request-replay'].response.status, 200);
assert.equal(byId['idempotency-conflict'].request.body.requestId, normal.request.body.requestId);
assert.notDeepEqual(byId['idempotency-conflict'].request.body, normal.request.body);
for (const [id, status, code] of [
  ['invalid-period',400,'VALIDATION_FAILED'], ['idempotency-conflict',409,'IDEMPOTENCY_CONFLICT'],
  ['request-in-progress',409,'REQUEST_IN_PROGRESS'], ['bundle-changed',409,'BUNDLE_CHANGED'],
  ['retry-target-retired',409,'CANDIDATE_RETIRED'], ['curve-not-computed',202,'CURVE_NOT_READY']
]) { assert.equal(byId[id].response.status,status); assert.equal(byId[id].response.body.code,code); }
assert.equal(byId['invalid-period'].response.body.fieldErrors[0].field, 'selection.periodDays');
assert.notEqual(byId['bundle-changed'].response.body.currentBundleId, byId['bundle-changed'].request.body.curveContext.bundleId);
const missing = byId['curve-not-computed'];
assert.deepEqual(missing.response.body.residual, {status:null,jobId:null});
assert.equal(missing.response.body.segments, null);
assert.equal(missing.effects.jobsCreated, 0);
const history = byId['history-retired-original'].response.body;
assert.equal(history.snapshot, null);
assert.equal(history.curve.curveContext.curveStep, 0);
assert.deepEqual(history.curve.curveContext.removedCandidateIds, []);
assert.equal('residual' in history.curve, false);
assert.equal(history.curve.bundleId, history.reproduction.currentBundleId);
for (const seg of history.curve.segments) assert.equal(seg.nPoints, seg.flux.length);
const item = byId['discovered-unsubmitted'].response.body.items[0];
assert.equal(item.progressStage, 'unexplored');
assert.equal(item.achievementCount, 0);
const publicCurrent = byId['public-current-without-residual'];
assert.equal(publicCurrent.response.status, 200);
assert.equal(publicCurrent.response.body.graph.reproduction.fallbackReason, 'RETIRED_CANDIDATE');
assert.equal(publicCurrent.response.body.graph.curve.curveContext.curveStep, 0);
assert.equal('residual' in publicCurrent.response.body.graph.curve, false);
assert.equal(publicCurrent.effects.jobsCreated, 0);
assert.equal(publicCurrent.effects.recomputeOffered, false);
assert.equal(publicCurrent.effects.privateJobAccessGranted, false);
assert.equal(publicCurrent.effects.publicTextVisible, true);
for (const id of ['onboarding-reject-false','onboarding-reject-null']) {
  assert.equal(byId[id].response.status, 400);
  assert.equal(byId[id].effects.onboardingDone, true);
}
const f = decisions.fold;
near(f.epochBtjd, f.oldReferenceBtjd + mod1((f.oldPhaseStart+f.oldPhaseEnd)/2)*f.periodDays);
near(f.durationHours, (f.oldPhaseEnd-f.oldPhaseStart)*f.periodDays*24);
const width=f.durationHours/(24*f.periodDays);
const start=mod1(mod1((f.epochBtjd-f.currentReferenceBtjd)/f.periodDays)-width/2);
near(start,f.expectedPhaseStart); near(start+width,f.expectedPhaseEnd);
near(history.selection.currentPhaseStart,start); near(history.selection.currentPhaseEnd,start+width);
const median = xs => { const a=[...xs].sort((a,b)=>a-b); const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; };
near(median(f.rawSegmentTimes.flat()), f.wholeMedian);
near(f.rawSegmentTimes.map(median).reduce((a,b)=>a+b)/f.rawSegmentTimes.length, f.meanOfSegmentMedians);
const r=decisions.retired;
assert.equal(r.approval,'pending');
assert.deepEqual(r.submittedRemoved.filter(id=>!r.retiredIds.includes(id)),r.existingApiReturn.removed);
assert.deepEqual(r.srsRetry.removed,r.currentProgressRemoved);
r.originalFlux.forEach((v,i)=>{near(v/r.modelA[i],r.existingApiReturn.flux[i]);near(v/r.modelA[i]/r.modelC[i],r.srsRetry.flux[i]);});
assert.deepEqual(r.srsHistory.flux,r.originalFlux);
const sel=decisions.selection;
const inGrid=p=>p>=sel.periodGridDays[0]&&p<=sel.periodGridDays[1];
assert.equal(inGrid(sel.outsideRecommended.periodDays),sel.outsideRecommended.passesPeriodRangeCheck);
assert.ok(sel.outsideRecommended.recommendedRangesDays.every(([lo,hi])=>sel.outsideRecommended.periodDays<lo||sel.outsideRecommended.periodDays>hi));
assert.equal(inGrid(sel.outsideGrid.periodDays),sel.outsideGrid.passesPeriodRangeCheck);
const o=sel.overlap;
near(o.durationHours,o.periodDays*o.phaseWidth*24);
o.suggestedDurationsHours.forEach((v,i)=>{near(v*o.syntheticMultiplier,o.candidateCapsHours[i]);assert.equal(o.durationHours<=o.candidateCapsHours[i],o.withinEachCap[i]);});
assert.equal(o.selectedPolicy,null);
const pub=decisions.publicGraph.expected;
assert.deepEqual(pub,{jobsCreated:0,mayRequestRecompute:false,mayReadOwnersPrivateJob:false,residualStatus:null,residualJobId:null});
const p=decisions.participants;
assert.equal(new Set(p.threads.flat()).size,p.expectedStarCount);
assert.equal(new Set(p.afterFirstThreadHidden.flat()).size,p.expectedAfterHidden);
const browser = decisions.browserTools;
assert.equal(browser.calculationOwner, 'browser');
assert.equal(browser.networkRequests, 0);
assert.equal(browser.serverPersistenceWrites, 0);
console.log(`PASS: ${suite.cases.length} HTTP examples and 6 review scenarios; static checks only, approvals pending.`);
