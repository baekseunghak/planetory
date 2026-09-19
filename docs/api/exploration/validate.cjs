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
    for (const error of b.fieldErrors) {
      assert.equal(typeof error.field, 'string');
      assert.equal(typeof error.reason, 'string');
      assert.ok(!Object.hasOwn(error, 'message'));
    }
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
assert.equal(s.sourcePeakGridIndex,3311);
near(normal.response.body.serverDerived.durationLimitHours,normal.response.body.serverDerived.sourcePeakSuggestedDurationHours*3);
assert.ok(normal.response.body.serverDerived.durationHours<=normal.response.body.serverDerived.durationLimitHours);
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
assert.equal(byId['invalid-period'].request.body.selection.sourcePeakGridIndex,null);
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
assert.equal(f.storageApproval,'user-approved-2026-09-14');
assert.equal(f.selectedPolicy,'bundle-common');
assert.equal(f.segmentStoresReference,false);
assert.equal(f.duplicatePolicy,'remove-before-median');
assert.equal(f.evenMedianRule,'mean-of-middle-two');
assert.equal(f.emptyValidObservations,'publication-fails');
near(f.epochBtjd, f.oldReferenceBtjd + mod1((f.oldPhaseStart+f.oldPhaseEnd)/2)*f.periodDays);
near(f.durationHours, (f.oldPhaseEnd-f.oldPhaseStart)*f.periodDays*24);
const width=f.durationHours/(24*f.periodDays);
const start=mod1(mod1((f.epochBtjd-f.currentReferenceBtjd)/f.periodDays)-width/2);
near(start,f.expectedPhaseStart); near(start+width,f.expectedPhaseEnd);
near(history.selection.currentPhaseStart,start); near(history.selection.currentPhaseEnd,start+width);
const median = xs => { const a=[...xs].sort((a,b)=>a-b); const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; };
near(median(f.rawSegmentTimes.flat()), f.wholeMedian);
near(f.rawSegmentTimes.map(median).reduce((a,b)=>a+b)/f.rawSegmentTimes.length, f.meanOfSegmentMedians);
assert.notEqual(f.wholeMedian,f.meanOfSegmentMedians);
const r=decisions.retired;
assert.equal(r.approval,'user-approved-2026-09-14');
assert.deepEqual(r.analysisReturn.removed,r.currentProgressRemoved);
assert.deepEqual(r.retryDraft.removed,r.currentProgressRemoved);
r.originalFlux.forEach((v,i)=>{near(v/r.modelA[i]/r.modelC[i],r.analysisReturn.flux[i]);near(v/r.modelA[i]/r.modelC[i],r.retryDraft.flux[i]);});
assert.equal(r.retryDraft.restoredStep,false);
assert.deepEqual(r.historyCurrent.flux,r.originalFlux);
assert.deepEqual(r.historyCurrent.removed,[]);
assert.equal(r.historySubmitted.curve,null);
const sel=decisions.selection;
assert.equal(sel.approval,'user-approved-2026-09-14');
assert.equal(sel.selectedPolicy,'explicit-source-peak');
assert.equal(sel.noSourcePeakPolicy,'bundle-phase-width-max-only');
assert.equal(sel.inferPeakFromPeriod,false);
const inGrid=p=>p>=sel.periodGridDays[0]&&p<=sel.periodGridDays[1];
assert.equal(inGrid(sel.outsideRecommended.periodDays),sel.outsideRecommended.passesPeriodRangeCheck);
assert.ok(sel.outsideRecommended.recommendedRangesDays.every(([lo,hi])=>sel.outsideRecommended.periodDays<lo||sel.outsideRecommended.periodDays>hi));
assert.equal(inGrid(sel.outsideGrid.periodDays),sel.outsideGrid.passesPeriodRangeCheck);
const o=sel.overlap;
near(o.durationHours,o.periodDays*o.phaseWidth*24);
for (const peak of o.peaks) {
  assert.ok(o.periodDays>=peak.fineTuneDays[0]&&o.periodDays<=peak.fineTuneDays[1]);
  near(peak.suggestedDurationHours*o.syntheticMultiplier,peak.capHours);
}
const sourcePeak=o.peaks.find(p=>p.gridIndex===o.sourcePeakGridIndex);
assert.ok(sourcePeak);
near(sourcePeak.capHours,o.expectedCapHours);
assert.equal(o.durationHours<=sourcePeak.capHours,o.expectedAccepted);
const pub=decisions.publicGraph.expected;
assert.deepEqual(pub,{jobsCreated:0,mayRequestRecompute:false,mayReadOwnersPrivateJob:false,residualStatus:null,residualJobId:null});
const p=decisions.participants;
assert.equal(new Set(p.threads.flat()).size,p.expectedStarCount);
assert.equal(new Set(p.afterFirstThreadHidden.flat()).size,p.expectedAfterHidden);
const browser = decisions.browserTools;
assert.equal(browser.calculationOwner, 'browser');
assert.equal(browser.networkRequests, 0);
assert.equal(browser.serverPersistenceWrites, 0);
console.log(`PASS: ${suite.cases.length} HTTP examples and 6 review scenarios; C02-R1/R2/R3 decisions confirmed, MR !32 review pending.`);
