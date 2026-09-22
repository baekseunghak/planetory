import test from 'node:test';
import assert from 'node:assert/strict';
import {readPublicMeta,readPublicSystem,publicStarLabel,publicTiles} from '../../src/features/public-sky/contracts';
import {starLabel} from '../../src/features/sky-renderer/interaction';
import {meta,star,tile} from './sky-support';

test('public completion describes current visibility without claiming no personal discoveries',()=>{
 const completed={...star('123',0,0),progressStage:'completed' as const,completedWithoutPlanets:true};
 const result=publicTiles(tile(meta(),{x:0,y:0,w:256,h:256},0,[completed])).stars[0];
 assert.equal(publicStarLabel(result),'TIC 123 · 공개 행성 0개 · 탐색 완료 · 현재 공개할 행성이 없습니다');
 assert.match(starLabel(completed),/내 행성 없이 완료/);
 assert.doesNotMatch(publicStarLabel({...completed,planetCount:1,completedWithoutPlanets:false}),/현재 공개할 행성이 없습니다/);
});
test('public scope and owner must match; private map data is never treated as an empty galaxy',()=>{
 const v={...meta(),owner:{memberId:'a',nickname:'탐사자'},visibility:'PUBLIC',scope:'all-owned'};
 assert.equal(readPublicMeta(v,'a').owner.memberId,'a');
 for(const invalid of [{...v,visibility:'PRIVATE'},{...v,scope:'submitted'},{...v,owner:{memberId:'b',nickname:'다른 사람'}}])assert.throws(()=>readPublicMeta(invalid,'a'));
});
test('visitor detail uses only the public projection and rejects another owner or wrong planet count',()=>{
 const m=meta(),v={memberId:'a',ticId:'123',version:m.version,presentationVersion:m.presentationVersion,position:{x:0,y:0,depthZ:0,layoutOrdinal:0,layoutVersion:m.layoutVersion},planets:{count:0,items:[]},historyId:'must-not-use',actions:{analysis:'start'}};
 const result=readPublicSystem(v,m,'123','a');
 assert.equal(result.items.length,0);assert.equal('historyId' in result,false);assert.equal('actions' in result,false);
 assert.throws(()=>readPublicSystem(v,m,'123','b'));
 assert.throws(()=>readPublicSystem({...v,planets:{count:1,items:[]}},m,'123','a'));
});
