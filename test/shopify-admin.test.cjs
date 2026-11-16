const test = require('node:test');
const assert = require('node:assert/strict');
const { configuration, createShopifyClient, checkConnection } = require('../lib/shopify-admin.cjs');

const env = {
  SHOPIFY_SHOP: 'example.myshopify.com', SHOPIFY_CLIENT_ID: 'test-client',
  SHOPIFY_CLIENT_SECRET: 'test-secret-do-not-expose', SHOPIFY_CATALOG_ID: '123',
};
const result = (data, status = 200) => new Response(JSON.stringify(data), { status });
const scopes = ['read_products', 'read_publications', 'read_companies', 'write_draft_orders'];
const connected = {
  currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
  catalogs: { nodes: [{ id: 'gid://shopify/MarketCatalog/123', title: 'Toptan Katalog', status: 'ACTIVE', publication: { id: 'publication' }, priceList: { id: 'prices', currency: 'TRY' } }] },
};

test('requires complete server settings and rejects foreign/URL shop hosts', () => {
  assert.throws(() => configuration({}), { code: 'configuration_missing' });
  for (const host of ['https://example.myshopify.com', 'example.com', 'example.myshopify.com@evil.test', 'example.myshopify.com/path']) {
    assert.throws(() => configuration({ ...env, SHOPIFY_SHOP: host }), { code: 'configuration_invalid' });
  }
  assert.equal(configuration(env).catalogId, '123');
});

test('coalesces authentication, reuses tokens and refreshes them before expiry', async () => {
  let time = 0; let authCalls = 0; const headers = [];
  const client = createShopifyClient(configuration(env), { now: () => time, fetchImpl: async (url, init) => {
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/access_token')) {
      authCalls++;
      assert.equal(init.body.get('grant_type'), 'client_credentials');
      assert.equal(init.body.get('client_secret'), env.SHOPIFY_CLIENT_SECRET);
      return result({ access_token: `token-${authCalls}`, expires_in: 120 });
    }
    assert.equal(url, 'https://example.myshopify.com/admin/api/2026-10/graphql.json');
    headers.push(init.headers['X-Shopify-Access-Token']);
    return result({ data: connected });
  } });
  await Promise.all([checkConnection(client, '123'), checkConnection(client, '123')]);
  assert.equal(authCalls, 1);
  time = 61000;
  await checkConnection(client, '123');
  assert.equal(authCalls, 2);
  assert.deepEqual(headers, ['token-1', 'token-1', 'token-2']);
});

test('checks the exact catalog id and returns capabilities without credentials or company records', async () => {
  const client = { query: async (document, variables) => {
    assert.match(document, /^query CatalogConnectionCheck/);
    assert.deepEqual(variables, { query: 'id:123' });
    return connected;
  } };
  const status = await checkConnection(client, '123');
  assert.equal(status.catalog.title, 'Toptan Katalog');
  assert.equal(status.capabilities.createDraftOrder, true);
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.equal(JSON.stringify(status).includes('accessScopes'), false);
  await assert.rejects(checkConnection({ query: async () => connected }, '124'), { code: 'catalog_not_found' });
  const inactive = structuredClone(connected); inactive.catalogs.nodes[0].status = 'DRAFT';
  await assert.rejects(checkConnection({ query: async () => inactive }, '123'), { code: 'catalog_inactive' });
  const missing = structuredClone(connected); missing.currentAppInstallation.accessScopes = [];
  await assert.rejects(checkConnection({ query: async () => missing }, '123'), { code: 'access_denied' });
});

test('refreshes an invalidated token once for reads', async () => {
  let authCalls = 0; let queries = 0;
  const client = createShopifyClient(configuration(env), { fetchImpl: async (url) => {
    if (url.endsWith('/access_token')) return result({ access_token: `t${++authCalls}`, expires_in: 3600 });
    if (++queries === 1) return result({}, 401);
    return result({ data: connected });
  } });
  assert.equal((await checkConnection(client, '123')).connected, true);
  assert.equal(authCalls, 2);
  assert.equal(queries, 2);
  await assert.rejects(client.query('mutation { draftOrderCreate {} }'), { code: 'query_invalid' });
});

test('rejects partial GraphQL data and never echoes raw upstream secrets', async () => {
  const client = createShopifyClient(configuration(env), { fetchImpl: async (url) =>
    url.endsWith('/access_token') ? result({ access_token: 'secret-token', expires_in: 3600 })
      : result({ data: connected, errors: [{ message: env.SHOPIFY_CLIENT_SECRET, extensions: { code: 'ACCESS_DENIED' } }] }),
  });
  await assert.rejects(checkConnection(client, '123'), (error) => {
    assert.equal(error.code, 'access_denied');
    assert.equal(error.message.includes(env.SHOPIFY_CLIENT_SECRET), false);
    return true;
  });
  const authFailure = createShopifyClient(configuration(env), { fetchImpl: async () => result({ error_description: env.SHOPIFY_CLIENT_SECRET }, 400) });
  await assert.rejects(checkConnection(authFailure, '123'), { code: 'authentication_failed' });
});

test('status endpoint fails closed with absent settings, does not accept writes', async () => {
  const endpoint = require('../api/shopify-status.js');
  const previous = process.env.SHOPIFY_SHOP;
  delete process.env.SHOPIFY_SHOP;
  const response = () => ({ headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } });
  try {
    const res = response(); await endpoint({ method: 'GET' }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).connected, false);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    const denied = response(); await endpoint({ method: 'POST' }, denied);
    assert.equal(denied.statusCode, 405);
    const head = response(); await endpoint({ method: 'HEAD' }, head);
    assert.equal(head.body, undefined);
  } finally {
    if (previous === undefined) delete process.env.SHOPIFY_SHOP;
    else process.env.SHOPIFY_SHOP = previous;
  }
});
