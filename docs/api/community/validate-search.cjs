// 합성 표본의 기대 결과 검증. 운영 API·권한 검사·DB 실행 계획을 대체하지 않는다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const frontendDirectory = path.resolve(__dirname, '../../../apps/frontend');
const frontendHint = 'apps/frontend에서 node --import tsx ../../docs/api/community/validate-search.cjs --frontend 를 실행하세요.';
if (process.argv.includes('--frontend') && process.cwd() !== frontendDirectory) {
  console.error(frontendHint);
  process.exit(1);
}
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'search-cases.json'), 'utf8'));
const fold = (s) => s.replace(/[A-Z]/g, c => c.toLowerCase());
function newestFirst(a, b) {
  const time = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  assert.ok(Number.isFinite(time), '표본 createdAt은 유효한 ISO 시각이어야 한다');
  const left = BigInt(a.id.split('-')[1]), right = BigInt(b.id.split('-')[1]);
  return time || (right > left ? 1 : right < left ? -1 : 0);
}
function select(query) {
  const params = new URLSearchParams(query);
  const invalid = () => { throw new Error('VALIDATION_FAILED'); };
  for (const [key, value] of params)
    if (!['q', 'searchIn', 'author', 'ticId', 'board', 'tag', 'size', 'cursor'].includes(key) || !value.trim()) invalid();
  // 성공 커서 직렬화·DB 페이지 경계는 실제 HTTP 테스트에서 검증한다.
  if (params.has('cursor')) invalid();
  if (params.has('size') && (!/^[1-9]\d{0,2}$/.test(params.get('size')) || Number(params.get('size')) > 100)) invalid();
  for (const key of ['q', 'searchIn', 'author', 'ticId', 'board', 'tag', 'size', 'cursor'])
    if (params.getAll(key).length > 1) invalid();
  const q = params.get('q')?.trim();
  const scope = params.get('searchIn') ?? 'TITLE_BODY';
  if ((params.has('q') && (!q || [...q].length > 100)) ||
      (params.has('searchIn') && !params.has('q')) ||
      !['TITLE_BODY', 'TITLE', 'BODY'].includes(scope)) invalid();
  const tic = params.get('ticId');
  if (tic !== null && (!/^[1-9]\d{0,18}$/.test(tic) || BigInt(tic) > 9223372036854775807n)) invalid();
  if (params.has('board') && !['STAR', 'FREE'].includes(params.get('board'))) invalid();
  if (params.has('tag') && !['ANALYSIS','QUESTION','DISCUSSION','INFORMATION','GENERAL'].includes(params.get('tag'))) invalid();
  return data.posts.filter(p => {
    if (p.status !== 'visible') return false;
    if (q && !(scope !== 'BODY' && fold(p.title).includes(fold(q))) &&
        !(scope !== 'TITLE' && fold(p.body).includes(fold(q)))) return false;
    if (params.has('author')) {
      const member = data.members.find(m => m.id === p.memberId);
      if (!member || fold(member.nickname) !== fold(params.get('author').trim())) return false;
    }
    return ['ticId', 'board', 'tag'].every(k => !params.has(k) || p[k] === params.get(k));
  }).sort(newestFirst).map(p => p.id);
}
assert.equal(new Set(data.posts.map(p => p.id)).size, data.posts.length);
assert.equal(new Set(data.cases.map(c => c.id)).size, data.cases.length);
for (const c of data.cases) {
  if (c.expectedError) assert.throws(() => select(c.query), {message: c.expectedError}, c.id);
  else assert.deepEqual(select(c.query), c.expectedIds, c.id);
  assert.deepEqual([...new URLSearchParams(new URLSearchParams(c.query).toString())], c.query, c.id);
}
assert.equal(newestFirst({id:'p-1', createdAt:'2026-09-21T09:00:00+09:00'},
  {id:'p-1', createdAt:'2026-09-21T00:00:00.000Z'}), 0);
assert.ok(newestFirst({id:'p-1', createdAt:'2026-09-21T00:00:00.100Z'},
  {id:'p-2', createdAt:'2026-09-21T00:00:00Z'}) < 0);
assert.ok(newestFirst({id:'st-103', createdAt:'2026-09-21T09:00:00+09:00'},
  {id:'p-102', createdAt:'2026-09-21T00:00:00Z'}) < 0);
for (const p of data.pages) {
  const ids = select(data.cases.find(c => c.id === p.caseId).query);
  const pages = [];
  for (let i = 0; i < ids.length; i += p.size) pages.push(ids.slice(i, i + p.size));
  assert.deepEqual(pages, p.expectedPages, p.id);
}
for (const c of data.hotTopics) assert.equal(c.parentVisible && c.participants >= 10, c.expectedEligible, c.id);
assert.deepEqual(select([['q', '🪐'.repeat(100)]]), []);
assert.throws(() => select([['q', '🪐'.repeat(101)]]), {message:'VALIDATION_FAILED'});
console.log(`PASS: ${data.cases.length} search cases, ${data.pages.length} page example, ${data.hotTopics.length} hot-topic boundaries, 2 Unicode boundaries`);
console.log('PASS: 3 timestamp ordering checks');
if (process.argv.includes('--frontend')) {
  const { pathToFileURL } = require('node:url');
  import(pathToFileURL(path.resolve(__dirname, '../../../apps/frontend/src/features/community/feedSearch.ts')).href)
    .then(({ readFeedSearch }) => {
      // opaque 커서의 구조는 서버가 검증한다. FE는 비어 있지 않은 커서를 그대로 전달한다.
      for (const c of data.cases.filter(c => c.id !== 'invalid-cursor'))
        assert.equal(Boolean(readFeedSearch(new URLSearchParams(c.query)).error), Boolean(c.expectedError), c.id);
      console.log(`PASS: ${data.cases.length - 1} shared input cases against frontend; opaque cursor validated by server`);
    }).catch(error => { console.error(error.message); console.error(frontendHint); process.exitCode = 1; });
}
