import test from 'node:test';
import assert from 'node:assert/strict';
import {readPublicMeta,readPublicSystem} from '../../src/features/public-sky/contracts';
import {meta} from './sky-support';
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
