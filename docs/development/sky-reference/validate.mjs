import fs from 'node:fs';
import assert from 'node:assert/strict';
import {layout,appearance,project,exampleAccount,LAYOUT_VERSION,PRESENTATION_VERSION} from './reference.mjs';
const json=name=>JSON.parse(fs.readFileSync(new URL(name,import.meta.url),'utf8'));
const v=json('vectors.json'), c=json('contracts.json');
const near=(a,b,t)=>assert.ok(Number.isFinite(a)&&Math.abs(a-b)<=t,`${a} != ${b}`);
assert.equal(v.layoutVersion,LAYOUT_VERSION);assert.equal(c.presentationVersion,PRESENTATION_VERSION);
for(const x of v.vectors){
 const p=layout(x.layoutOrdinal),a=appearance(p),s=project(p,v.camera,v.canvas.width,v.canvas.height);
 near(p.x,x.x,v.tolerance.position);near(p.y,x.y,v.tolerance.position);near(p.depthZ,x.depthZ,v.tolerance.depth);
 a.rgb.forEach((n,i)=>near(n,x.rgb[i],v.tolerance.presentation));near(a.baseSize,x.baseSize,v.tolerance.presentation);
 near(s.x,x.screen.x,v.tolerance.screenPixels);near(s.y,x.screen.y,v.tolerance.screenPixels);
}
for(const bad of [-1,1.5,NaN,Infinity,2147483648])assert.throws(()=>layout(bad));
for(const n of [1,10,100,1000,100000]){
 const stars=exampleAccount(n); assert.equal(new Set(stars.map(x=>x.ticId)).size,n);
 for(const s of stars){assert.ok([s.x,s.y,s.depthZ].every(Number.isFinite));assert.ok(Math.abs(s.depthZ)<=1);}
 assert.deepEqual(stars.slice(0,10),exampleAccount(n<10?1:10));
 if(n<=1000)for(const s of stars){assert.deepEqual(appearance({...s,planetCount:5,completedWithoutPlanets:true}),appearance(s));assert.deepEqual(layout(s.layoutOrdinal),{x:s.x,y:s.y,depthZ:s.depthZ,layoutOrdinal:s.layoutOrdinal});}
}
const named=name=>{const x=c.cases.find(t=>t.name===name);assert.ok(x,name);return x;};
const first=named('first-page').response,last=named('last-page').response;
const all=[...first.stars,...last.stars];assert.equal(new Set(all.map(x=>x.ticId)).size,first.rangeStarCount);assert.equal(last.nextCursor,null);
for(const t of c.cases){
 if(t.response?.stars&&!t.response.versionChanged){
  for(const s of t.response.stars){assert.equal(typeof s.ticId,'string');assert.ok(Number.isInteger(s.layoutOrdinal));assert.ok(Math.abs(s.depthZ)<=1);for(const k of ['colorLevel','sizeLevel','orbits'])assert.ok(!(k in s));}
 }
 if(t.status>=400){assert.ok(['VALIDATION_FAILED','DEPENDENCY_UNAVAILABLE'].includes(t.response.code));assert.ok(Array.isArray(t.response.fieldErrors));}
}
assert.equal(named('version-changed').expect.wholeAccountEmpty,false);
assert.equal(named('page-failed').expect.rangeComplete,false);
assert.equal(named('logout-or-other-member').expect.discardMemberCaches,true);
assert.equal(named('logout-or-other-member').expect.discardLateResponses,true);
for(const n of [0,1,2,5]){
 const t=named('selected-planets-'+n),r=t.response;
 assert.equal(r.planets.count,n);assert.equal(r.planets.items.length,n);assert.equal(t.expect.overviewOrbitCount,0);assert.equal(t.expect.selectedOrbitCount,n);
 assert.deepEqual(r.unlock.position,{...layout(7),layoutVersion:LAYOUT_VERSION});
 const ids=r.planets.items.map(x=>x.candidateId);assert.equal(new Set(ids).size,n);assert.deepEqual(ids,[...ids].sort());
}
// Invalid detail examples must remain invalid: guard fixtures against accidental normalization.
const count=named('count-mismatch').response;assert.notEqual(count.planets.count,count.planets.items.length);
const dup=named('duplicate-candidate').response.planets.items.map(x=>x.candidateId);assert.ok(new Set(dup).size<dup.length);
const root=new URL('../../../',import.meta.url);
const api=fs.readFileSync(new URL('apps/backend/docs/exploration-api-spec.md',root),'utf8');
const samples=[...api.matchAll(/```json\s*\n([\s\S]*?)```/g)].map(x=>JSON.parse(x[1]));
const coords=[];function walk(o){if(!o||typeof o!=='object')return;if(o.ticId==='123456789'&&typeof o.x==='number')coords.push(o);if(o.ticId==='123456789'&&o.unlock?.position)coords.push(o.unlock.position);for(const v of Object.values(o))walk(v);}samples.forEach(walk);
assert.ok(coords.length>=2);for(const p of coords){near(p.x,layout(7).x,1e-6);near(p.y,layout(7).y,1e-6);near(p.depthZ,layout(7).depthZ,1e-9);assert.equal(p.layoutOrdinal,7);}
console.log(JSON.stringify({result:'PASS',vectors:v.vectors.length,cases:c.cases.length,layoutCounts:[1,10,100,1000,100000],apiJsonBlocks:samples.length,matchingTicPositions:coords.length,scope:'Reference data consistency only; no DB/HTTP/render/performance implementation validation'},null,2));
