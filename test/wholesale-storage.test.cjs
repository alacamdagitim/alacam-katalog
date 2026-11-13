const assert = require('node:assert/strict');
const test = require('node:test');
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require('undici');
const serveWholesale = require('../api/wholesale.js');
const { readWholesaleSnapshot, resetWholesale, writeWholesale, WholesaleWriteConflict } = require('../lib/wholesale.cjs');

const storage = { token: 'vercel_blob_rw_catalogtest_test' };
const blobPath = 'catalog/wholesale-v1.json';
const publishedAt = '2026-11-13T12:00:00.000Z';

function mockStorage(context) {
  const previousDispatcher = getGlobalDispatcher();
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  process.env.BLOB_READ_WRITE_TOKEN = storage.token;
  context.after(async () => {
    setGlobalDispatcher(previousDispatcher);
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    await agent.close();
  });
  const state = {
    revision: '"origin-1"',
    reads: 0,
    matches: [],
    deletes: [],
    beforeDelete: () => {},
    afterRead: () => {},
    publication: { schemaVersion: 1, publishedAt, products: {} },
  };
  const metadata = () => ({
    pathname: blobPath,
    url: `https://catalogtest.private.blob.vercel-storage.com/${blobPath}`,
    uploadedAt: publishedAt,
    etag: state.revision,
  });
  const api = agent.get('https://vercel.com');
  api.intercept({ path: /^\/api\/blob/, method: 'GET' }).reply((options) => {
    if (options.path.includes('prefix=')) {
      return { statusCode: 200, data: { blobs: state.publication ? [metadata()] : [], hasMore: false } };
    }
    return state.publication ? { statusCode: 200, data: metadata() }
      : { statusCode: 404, data: { error: { code: 'not_found' } } };
  }).persist();
  agent.get('https://catalogtest.private.blob.vercel-storage.com')
    .intercept({ path: `/${blobPath}?cache=0`, method: 'GET' }).reply(() => {
      if (!state.publication) return { statusCode: 404, data: '' };
      const body = JSON.stringify(state.publication);
      state.reads += 1;
      state.afterRead();
      return { statusCode: 200, data: body, responseOptions: { headers: { etag: 'W/"delivery-1"' } } };
    }).persist();
  api.intercept({ path: /^\/api\/blob/, method: 'PUT' }).reply((options) => {
    const match = new Headers(options.headers).get('x-if-match');
    state.matches.push(match);
    if (match !== state.revision) {
      return { statusCode: 412, data: { error: { code: 'precondition_failed' } } };
    }
    state.revision = '"origin-2"';
    return { statusCode: 200, data: metadata() };
  }).persist();
  api.intercept({ path: '/api/blob/delete', method: 'POST' }).reply((options) => {
    state.beforeDelete();
    const match = new Headers(options.headers).get('x-if-match');
    state.deletes.push(match);
    if (state.publication && match !== state.revision) {
      return { statusCode: 412, data: { error: { code: 'precondition_failed' } } };
    }
    state.publication = null;
    state.revision = null;
    return { statusCode: 200, data: {} };
  }).persist();
  return state;
}

async function upload(csv, mode, token) {
  let body;
  const response = { setHeader() {}, end(value) { body = JSON.parse(value); } };
  await serveWholesale({
    method: 'POST',
    url: `/api/wholesale?mode=${mode}${token ? '' : '&preview=1'}`,
    headers: { 'content-type': 'text/csv', 'x-catalog-preview': token },
    readableEnded: true,
    body: csv,
  }, response);
  return { status: response.statusCode, body };
}

async function reset(headers = { 'x-catalog-confirmation': 'sapanca' }) {
  let body;
  const response = { setHeader() {}, end(value) { body = JSON.parse(value); } };
  await serveWholesale({ method: 'DELETE', url: '/api/wholesale', headers }, response);
  return { status: response.statusCode, body };
}

test('wholesale storage preserves preview and concurrent publication checks', async (context) => {
  for (const mode of ['merge', 'replace']) {
    await context.test(`${mode} preview publishes with the origin revision`, async (scenario) => {
      const state = mockStorage(scenario);
      const csv = [
        'Catalog Title,Handle,Option1 Name,Option1 Value,Published,Fixed Price,Compare At,Quantity Increment,Minimum Order Quantity,Maximum Order Quantity',
        'Toptan Katalog,kirmizi-parti-bardak-beer-pong,Adet,25,true,80,,2,2,10',
      ].join('\n');
      const preview = await upload(csv, mode);
      assert.equal(preview.status, 200);
      assert.equal(preview.body.stats.matchedVariants, 1);
      const repeat = await upload(csv, mode);
      assert.equal(repeat.body.previewToken, preview.body.previewToken);
      const publication = await upload(csv, mode, preview.body.previewToken);
      assert.equal(publication.status, 200);
      assert.deepEqual(state.matches, ['"origin-1"']);
      const stale = await upload(csv, mode, preview.body.previewToken);
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'preview_expired');
      assert.equal(state.matches.length, 1);
    });
  }
  await context.test('an intervening writer is rejected by storage', async (scenario) => {
    const state = mockStorage(scenario);
    const snapshot = await readWholesaleSnapshot(storage);
    state.revision = '"another-writer"';
    await assert.rejects(writeWholesale(storage, snapshot.publication, snapshot.revision), WholesaleWriteConflict);
  });
  await context.test('a publication changed during reading is read again', async (scenario) => {
    const state = mockStorage(scenario);
    state.afterRead = () => {
      state.revision = '"new-origin"';
      state.publication.products = { example: { variants: { 123: { price: 50 } } } };
    };
    const snapshot = await readWholesaleSnapshot(storage);
    assert.equal(state.reads, 2);
    assert.equal(snapshot.revision, '"new-origin"');
    assert.equal(snapshot.publication.products.example.variants[123].price, 50);
  });
  await context.test('continuous changes cannot produce an inconsistent snapshot', async (scenario) => {
    const state = mockStorage(scenario);
    state.afterRead = () => { state.revision = `"origin-${state.reads}"`; };
    state.revision = '"initial"';
    await assert.rejects(readWholesaleSnapshot(storage), /changed while reading/);
    assert.equal(state.reads, 3);
  });
  await context.test('reset rejects missing, incorrect and cross-site confirmation', async (scenario) => {
    const state = mockStorage(scenario);
    for (const word of [undefined, '', 'Sapanca', 'sapanca ', 'wrong']) {
      const response = await reset({ 'x-catalog-confirmation': word });
      assert.equal(response.status, 403);
    }
    const crossSite = await reset({ 'x-catalog-confirmation': 'sapanca', 'sec-fetch-site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    assert.equal(state.reads, 0);
    assert.equal(state.deletes.length, 0);
  });
  await context.test('confirmed reset clears the stored overlay and can be retried', async (scenario) => {
    const state = mockStorage(scenario);
    const response = await reset();
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { reset: true, active: false });
    assert.deepEqual(state.deletes, ['"origin-1"']);
    const snapshot = await readWholesaleSnapshot(storage);
    assert.equal(snapshot.publication, null);
    assert.equal(snapshot.revision, null);
    assert.equal((await reset()).status, 200);
    assert.equal(state.deletes.length, 1);
  });
  await context.test('reset cannot delete a newer publication', async (scenario) => {
    const state = mockStorage(scenario);
    state.beforeDelete = () => { state.revision = '"new-upload"'; };
    const response = await reset();
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'reset_conflict');
    assert.notEqual(state.publication, null);
    assert.equal(state.revision, '"new-upload"');
    assert.equal(state.deletes.length, 1);
  });
  await context.test('reset against verified absence cannot delete a concurrent first upload', async (scenario) => {
    const state = mockStorage(scenario);
    await resetWholesale(storage, null);
    assert.equal(state.deletes.length, 0);
    assert.notEqual(state.publication, null);
  });
  await context.test('reset invalidates an old preview and accepts a fresh upload', async (scenario) => {
    const state = mockStorage(scenario);
    const csv = [
      'Catalog Title,Handle,Option1 Name,Option1 Value,Published,Fixed Price,Compare At,Quantity Increment,Minimum Order Quantity,Maximum Order Quantity',
      'Toptan Katalog,kirmizi-parti-bardak-beer-pong,Adet,25,true,80,,2,2,10',
    ].join('\n');
    const preview = await upload(csv, 'merge');
    assert.equal((await reset()).status, 200);
    assert.equal((await upload(csv, 'merge', preview.body.previewToken)).status, 409);
    const fresh = await upload(csv, 'merge');
    assert.equal(fresh.body.hasActive, false);
    assert.equal((await upload(csv, 'merge', fresh.body.previewToken)).status, 200);
    assert.deepEqual(state.matches, [null]);
  });
});
