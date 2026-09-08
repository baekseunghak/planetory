const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const M=require('../proposal/sky-math.js');
const context={window:{}};vm.createContext(context);
vm.runInContext(fs.readFileSync(__dirname+'/../shared/data.js','utf8'),context);
vm.runInContext(fs.readFileSync(__dirname+'/../shared/sectors.js','utf8'),context);
const stars=context.window.PLANETORY_DATA;
let checks=0;
for(const s of stars){
  const size={w:1440,h:603},view={ra:s.ra,dec:s.dec,fov:55};
  const p=M.project(M.vector(s.ra,s.dec),view,size);
  assert(Math.abs(p.x-size.w/2)<1e-8);assert(Math.abs(p.y-size.h*.4)<1e-8);checks++;
  const opposite=M.project(M.vector(s.ra+180,-s.dec),view,size);assert(!opposite.visible);checks++;
  assert(M.project(M.vector(s.ra+.01,s.dec),view,size).x<p.x);checks++;
  assert(M.project(M.vector(s.ra,s.dec+.01),view,size).y<p.y);checks++;
  for(const [x,y]of [[0,0],[720,241.2],[1439,602],[400,350]]){
    const d=M.unproject(x,y,view,size),q=M.project(M.vector(d.ra,d.dec),view,size);
    assert(Math.hypot(q.x-x,q.y-y)<1e-7);checks++;
  }
}
const seam=M.interpolate({ra:359,dec:0},{ra:1,dec:0},.5);assert(Math.min(seam.ra,360-seam.ra)<1e-8);checks++;
for(const target of stars.slice(1)){
  const start=stars[0],distance=M.separation(start,target);
  for(const t of [0,.2,.5,.8,1]){
    const p=M.interpolate(start,target,t);assert(Math.abs(M.separation(start,p)-distance*t)<1e-5);checks++;
  }
}
assert.equal(context.window.PLANETORY_SECTORS.length,6);
assert(context.window.PLANETORY_SECTORS.every(s=>s.ccds.length===16&&s.ccds.every(c=>c.boundary.length===128)));checks++;
const validations=JSON.parse(fs.readFileSync(__dirname+'/../shared/sector-validation.json','utf8'));
assert.equal(validations.checks.length,7);assert(validations.checks.every(c=>c.inside));checks++;
console.log(`PASS: ${checks} projection, orientation, wrap, interpolation and sector-fixture checks.`);
console.log('Target separations from tutorial:',stars.slice(1).map(s=>`${s.tic}: ${M.separation(stars[0],s).toFixed(3)} deg`).join('; '));
