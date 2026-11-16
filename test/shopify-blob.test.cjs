const test = require('node:test');
const assert = require('node:assert/strict');
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require('undici');
const { snapshotRepository, Conflict } = require('../lib/shopify-snapshot.cjs');

test('private Blob snapshots use origin revisions and reject concurrent overwrites', async t => {
  const previous = getGlobalDispatcher(); const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  t.after(async () => { setGlobalDispatcher(previous); await agent.close(); });
  const name = 'catalog/shopify-v3/123/snapshot.json';
  const url = `https://catalogtest.private.blob.vercel-storage.com/${name}`;
  const state = { value: { version: 1 }, revision: '"origin-1"', reads: 0, matches: [] };
  const meta = () => ({ pathname: name, url, uploadedAt: '2026-11-16T17:00:00.000Z', etag: state.revision });
  const api = agent.get('https://vercel.com');
  api.intercept({ path: /^\/api\/blob/, method: 'GET' }).reply(options => options.path.includes('prefix=')
    ? { statusCode: 200, data: { blobs: [meta()], hasMore: false } }
    : { statusCode: 200, data: meta() }).persist();
  agent.get('https://catalogtest.private.blob.vercel-storage.com')
    .intercept({ path: `/${name}?cache=0`, method: 'GET' }).reply(() => {
      state.reads++;
      return { statusCode: 200, data: JSON.stringify(state.value), responseOptions: { headers: { etag: 'W/"delivery-not-origin"' } } };
    }).persist();
  api.intercept({ path: /^\/api\/blob/, method: 'PUT' }).reply(options => {
    const match = new Headers(options.headers).get('x-if-match'); state.matches.push(match);
    if (match !== state.revision) return { statusCode: 412, data: { error: { code: 'precondition_failed' } } };
    state.revision = '"origin-2"'; state.value = { version: 2 };
    return { statusCode: 200, data: meta() };
  }).persist();
  const repository = snapshotRepository('123', { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_catalogtest_test' });
  const first = await repository.read('snapshot'); assert.equal(first.revision, '"origin-1"');
  assert.equal((await repository.read('snapshot', first.revision)).unchanged, true); assert.equal(state.reads, 1);
  await repository.write('snapshot', { version: 2 }, first.revision);
  await assert.rejects(repository.write('snapshot', { version: 3 }, first.revision), Conflict);
  assert.deepEqual(state.matches, ['"origin-1"', '"origin-1"']);
  assert.deepEqual((await repository.read('snapshot')).value, { version: 2 });
});
