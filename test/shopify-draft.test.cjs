const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createDraftService, draftInput, normalizeRequest, liveOffers } = require('../lib/shopify-draft.cjs');
const { createDraftHandler } = require('../api/draft-request.js');
const { Conflict } = require('../lib/shopify-snapshot.cjs');
const { ShopifyError, createShopifyClient } = require('../lib/shopify-admin.cjs');
function repository() {
  const records = new Map(); let revision = 0;
  return { records, async read(key) { return structuredClone(records.get(key) ?? null); }, async write(key, value, expected) {
    if ((records.get(key)?.revision ?? null) !== expected) throw new Conflict();
    records.set(key, { revision: String(++revision), value: structuredClone(value) });
  } };
}
const request = () => ({ requestId: randomUUID(), contact: { company: 'Örnek Firma', name: 'Test Yetkili', email: 'test@example.com', phone: '0530 000 0000' }, note: 'Cuma teslim', items: [{ id: '10', quantity: 12, unitCents: 39300 }] });
function offers() {
  return { info: { id: '123', title: 'Toptan Katalog' }, prices: new Map([['10', { price: 395, tiers: [{ quantity: 12, price: 393 }] }]]),
    rules: new Map([['10', { minimum: 6, increment: 6, maximum: 24 }]]), variants: new Map([['10', { id: 'gid://shopify/ProductVariant/10', product: { status: 'ACTIVE' }, publishedOnPublication: true, availableForSale: true }]]) };
}
function service(options = {}) {
  return createDraftService({ catalogId: '123', repository: repository(), client: { createDraftOrder: async () => ({ id: 'gid://shopify/DraftOrder/99', name: '#D99' }) }, getOffers: async () => offers(), ...options });
}

test('draft uses only fresh catalog tier prices, actual variant IDs and contact notes', () => {
  const input = draftInput(normalizeRequest(request()), offers());
  assert.deepEqual(input.lineItems, [{ variantId: 'gid://shopify/ProductVariant/10', quantity: 12, priceOverride: { amount: '393.00', currencyCode: 'TRY' } }]);
  assert.equal(input.acceptAutomaticDiscounts, false);
  assert.equal(input.email, 'test@example.com'); assert.match(input.note, /Örnek Firma/); assert.match(input.note, /Cuma teslim/);
  assert.equal(input.purchasingEntity, undefined); assert.equal(input.taxExempt, undefined); assert.equal(input.reserveInventoryUntil, undefined);
  assert.ok(input.tags.includes('Sipariş Talebi'));
  const zero = offers(); zero.prices.get('10').price = 0; zero.prices.get('10').tiers = [];
  assert.equal(draftInput({ ...request(), items: [{ id: '10', quantity: 6, unitCents: 0 }] }, zero).lineItems[0].priceOverride.amount, '0.00');
});

test('rejects tampered prices, invalid box sizes, excluded and unavailable products before writing', async () => {
  let writes = 0;
  const submit = service({ client: { createDraftOrder: async () => { writes++; } } });
  for (const [change, code] of [[{ unitCents: 1 }, 'price_changed'], [{ quantity: 7 }, 'quantity_changed'], [{ quantity: 30 }, 'quantity_changed'], [{ id: '999' }, 'catalog_changed']]) {
    const body = request(); body.contact.email = code + '@example.com'; Object.assign(body.items[0], change);
    await assert.rejects(submit.submit(body, 'ip'), { code });
  }
  const unavailable = offers(); unavailable.variants.get('10').availableForSale = false;
  assert.throws(() => draftInput(request(), unavailable), { code: 'unavailable' });
  unavailable.variants.get('10').product.status = 'DRAFT';
  assert.throws(() => draftInput(request(), unavailable), { code: 'catalog_changed' });
  const duplicate = request(); duplicate.items.push(duplicate.items[0]);
  assert.throws(() => normalizeRequest(duplicate), { code: 'invalid_request' });
  const identity = request(); identity.contact.email = 'invalid';
  assert.throws(() => normalizeRequest(identity), { code: 'invalid_request' });
  assert.equal(writes, 0);
});

test('concurrent submissions and retries across instances create exactly one draft', async () => {
  const store = repository(); let writes = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = { createDraftOrder: async () => { writes++; await gate; return { name: '#D1' }; } };
  const a = service({ repository: store, client }); const b = service({ repository: store, client }); const body = request();
  const first = a.submit(body, 'ip');
  await new Promise(r => setImmediate(r));
  assert.equal((await b.submit(body, 'ip')).status, 202);
  release(); const created = await first;
  assert.equal(created.name, '#D1'); assert.equal((await b.submit(body, 'ip')).name, '#D1'); assert.equal(writes, 1);
  const changed = structuredClone(body); changed.note = 'Changed';
  await assert.rejects(b.submit(changed, 'ip'), { code: 'request_conflict' });
  assert.equal(JSON.stringify([...store.records.values()]).includes('test@example.com'), false);
});

test('ambiguous Shopify failure never retries mutation; lost result can be reconciled by unique tag', async () => {
  let writes = 0; let recover = false;
  const body = request();
  const client = { createDraftOrder: async () => { writes++; throw new ShopifyError('mutation_uncertain', 'unknown'); }, query: async (_, vars) => {
    assert.equal(vars.query, `tag:talep-${body.requestId}`);
    return { draftOrders: { nodes: recover ? [{ name: '#D2', customAttributes: [{ key: 'talep_kodu', value: body.requestId }] }] : [] } };
  } };
  const submit = service({ client });
  assert.equal((await submit.submit(body, 'ip')).code, 'outcome_unknown');
  assert.equal((await submit.submit(body, 'ip')).code, 'outcome_unknown'); assert.equal(writes, 1);
  recover = true;
  assert.equal((await submit.submit(body, 'ip')).name, '#D2'); assert.equal(writes, 1);
});

test('known rejected drafts may be edited; source/API errors and read failures cannot reset an uncertain request', async () => {
  const submit = service({ client: { createDraftOrder: async () => { throw new ShopifyError('access_denied', 'no scope'); } } });
  const body = request(); const result = await submit.submit(body, 'ip');
  assert.equal(result.safeToEdit, true); assert.equal((await submit.submit(body, 'ip')).safeToEdit, true);
  const endpoint = createDraftHandler({ getService: () => ({ submit: async () => { throw new Error('storage failure with private data'); } }) });
  const res = response(); await endpoint(httpRequest(body), res);
  assert.equal(res.statusCode, 503); assert.equal(JSON.parse(res.body).safeToEdit, false);
  assert.ok(!res.body.includes('private data'));
});

function response() { return { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = body; } }; }
function httpRequest(body) { return { method: 'POST', headers: { host: 'catalog.example', origin: 'https://catalog.example', 'content-type': 'application/json' }, body, socket: { remoteAddress: 'ip' } }; }
test('HTTP endpoint blocks foreign origins, writes through GET, oversized input and unbounded attempts', async () => {
  let calls = 0;
  const endpoint = createDraftHandler({ getService: () => ({ submit: async () => { calls++; return { status: 201, created: true }; } }) });
  for (const [req, status] of [[{ ...httpRequest(request()), method: 'GET' }, 405], [{ ...httpRequest(request()), headers: { ...httpRequest().headers, origin: 'https://evil.example' } }, 403], [httpRequest({ padding: 'x'.repeat(21000) }), 413]]) {
    const res = response(); await endpoint(req, res); assert.equal(res.statusCode, status);
  }
  assert.equal(calls, 0); const res = response(); await endpoint(httpRequest(request()), res); assert.equal(res.statusCode, 201);
  const submit = service();
  for (let i = 0; i < 3; i++) await submit.submit(request(), 'ip');
  await assert.rejects(submit.submit(request(), 'ip'), { status: 429 });
});

test('live verification requests only selected variant prices and checks selected publication, quantities and availability', async () => {
  const page = nodes => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  const client = { query: async (doc, vars) => {
    if (doc.includes('WholesaleCatalog(')) return { currentAppInstallation: { accessScopes: [{ handle: 'write_draft_orders' }] }, catalogs: { nodes: [{ id: 'gid://shopify/MarketCatalog/123', title: 'Toptan Katalog', status: 'ACTIVE', publication: { id: 'pub' }, priceList: { id: 'pl', currency: 'TRY' } }] } };
    if (doc.includes('RequestVariants(')) { assert.deepEqual(vars.ids, ['gid://shopify/ProductVariant/10']); assert.equal(vars.publication, 'pub'); return { nodes: [...offers().variants.values()] }; }
    if (doc.includes('WholesalePrices(')) { assert.equal(vars.query, 'variant_id:10'); assert.match(doc, /prices\(first: 1,/); return { priceList: { prices: page([{ variant: { id: 'gid://shopify/ProductVariant/10' }, price: { amount: '395', currencyCode: 'TRY' }, quantityPriceBreaks: page([]) }]) } }; }
    assert.match(doc, /WholesaleRules/); return { priceList: { quantityRules: page([{ productVariant: { id: 'gid://shopify/ProductVariant/10' }, minimum: 6, increment: 6, maximum: null }]) } };
  } };
  const result = await liveOffers(client, '123', request().items);
  assert.equal(result.prices.get('10').price, 395); assert.equal(result.rules.get('10').increment, 6);
});

test('Shopify write client uses fixed mutation, accepts valid draft from partial data and never retries transport failure', async () => {
  let writes = 0;
  const config = { shop: 'example.myshopify.com', clientId: 'id', secret: 'secret' };
  const client = createShopifyClient(config, { fetchImpl: async (url, init) => {
    if (url.endsWith('/access_token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }));
    writes++; const body = JSON.parse(init.body); assert.match(body.query, /mutation CatalogRequest/); assert.deepEqual(body.variables.input, { lineItems: [] });
    throw new Error('network');
  } });
  await assert.rejects(client.createDraftOrder({ lineItems: [] }), { code: 'mutation_uncertain' }); assert.equal(writes, 1);
  const partial = createShopifyClient(config, { fetchImpl: async url => new Response(JSON.stringify(url.endsWith('/access_token') ? { access_token: 'token', expires_in: 3600 } : { data: { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/1', name: '#D1' } } }, errors: [{ message: 'partial' }] })) });
  assert.equal((await partial.createDraftOrder({})).name, '#D1');
});

test('reported Shopify read throttle never becomes an unknown/pending draft and can be retried normally', async () => {
  const store = repository(); let reads = 0; let creates = 0;
  const submit = service({ repository: store, getOffers: async () => {
    if (++reads === 1) throw new ShopifyError('rate_limited', 'Shopify istek sınırına ulaşıldı.');
    return offers();
  }, client: { createDraftOrder: async () => { creates++; return { name: '#D100' }; } } });
  const body = request();
  const endpoint = createDraftHandler({ getService: () => submit }); const res = response();
  await endpoint(httpRequest(body), res);
  assert.equal(res.statusCode, 429); assert.equal(JSON.parse(res.body).safeToEdit, true);
  assert.equal(await store.read(`request-${body.requestId}`), null); assert.equal(creates, 0);
  const next = response(); await endpoint(httpRequest(body), next);
  assert.equal(JSON.parse(next.body).name, '#D100'); assert.equal(creates, 1);
});

test('missing draft permission is reported distinctly before variant/price scans and before writing', async () => {
  let queries = 0;
  const client = { query: async doc => {
    queries++; assert.match(doc, /currentAppInstallation/);
    return { currentAppInstallation: { accessScopes: [{ handle: 'read_products' }] } };
  } };
  const submit = service({ client, getOffers: liveOffers });
  const result = await submit.submit(request(), 'ip');
  assert.equal(result.status, 403); assert.equal(result.code, 'draft_access_denied');
  assert.equal(result.safeToEdit, true); assert.match(result.error, /write_draft_orders/); assert.equal(queries, 1);
});

async function deliveryModule() {
  const { readFile } = require('node:fs/promises');
  const source = await readFile(require('node:path').join(__dirname, '../public/submit-request.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
test('browser automatically recovers an interrupted/pending submission with the original ID', async () => {
  const { deliverDraft } = await deliveryModule(); let calls = 0; const body = request(); const sent = [];
  const result = await deliverDraft(body, { pause: async () => {}, fetchImpl: async (_, init) => {
    sent.push(JSON.parse(init.body)); calls++;
    if (calls === 1) throw new Error('lost connection');
    return new Response(JSON.stringify(calls === 2 ? { code: 'pending' } : { created: true, name: '#D5', requestId: body.requestId }), { status: calls === 2 ? 202 : 200 });
  } });
  assert.equal(result.name, '#D5'); assert.equal(calls, 3); assert.deepEqual(sent, [body, body, body]);
});
test('browser releases definitely unsent throttled/denied submissions and never displays a manual status action', async () => {
  const { deliverDraft } = await deliveryModule(); let calls = 0;
  const result = await deliverDraft(request(), { pause: async () => {}, fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ code: 'rate_limited', safeToEdit: true, error: 'Busy' }), { status: 429 });
  } });
  assert.equal(result.safeToEdit, true); assert.equal(calls, 1);
  const source = await require('node:fs/promises').readFile(require('node:path').join(__dirname, '../public/request.js'), 'utf8');
  assert.ok(!source.includes('Talep durumunu kontrol et')); assert.ok(!source.includes('request-copy'));
});

test('full browser → HTTP → live-offer verification → Shopify transport recovers price and mutation throttles in one submission', async () => {
  const { deliverDraft } = await deliveryModule();
  let time = 0; let priceReads = 0; let writes = 0; let posts = 0; let created = 0; let input;
  const page = nodes => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  const money = amount => ({ amount, currencyCode: 'TRY' });
  const client = createShopifyClient({ shop: 'test.myshopify.com', clientId: 'id', secret: 'secret' }, {
    now: () => time, pause: async ms => { time += ms; }, fetchImpl: async (url, init) => {
      if (url.endsWith('/access_token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }));
      const { query, variables } = JSON.parse(init.body); let data;
      if (query.includes('WholesaleCatalog(')) data = { currentAppInstallation: { accessScopes: [{ handle: 'write_draft_orders' }] }, catalogs: { nodes: [{ id: 'gid://shopify/MarketCatalog/123', title: 'Toptan Katalog', status: 'ACTIVE', publication: { id: 'pub' }, priceList: { id: 'pl', currency: 'TRY' } }] } };
      else if (query.includes('RequestVariants(')) data = { nodes: [...offers().variants.values()] };
      else if (query.includes('WholesalePrices(')) {
        assert.match(query, /prices\(first: 1,/); assert.equal(variables.query, 'variant_id:10');
        if (++priceReads === 1) return new Response(JSON.stringify({ errors: [{ extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 15, throttleStatus: { currentlyAvailable: 0, maximumAvailable: 1000, restoreRate: 100 } } } }));
        data = { priceList: { prices: page([{ variant: { id: 'gid://shopify/ProductVariant/10' }, price: money('395.00'), quantityPriceBreaks: page([{ minimumQuantity: 12, price: money('393.00') }]) }]) } };
      } else if (query.includes('WholesaleRules(')) data = { priceList: { quantityRules: page([{ productVariant: { id: 'gid://shopify/ProductVariant/10' }, minimum: 6, increment: 6, maximum: 24 }]) } };
      else {
        assert.match(query, /mutation CatalogRequest/); input = variables.input;
        if (++writes === 1) return new Response('{}', { status: 429, headers: { 'Retry-After': '1' } });
        created++; data = { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/501', name: '#D501' }, userErrors: [] } };
      }
      return new Response(JSON.stringify({ data }));
    },
  });
  const endpoint = createDraftHandler({ getService: () => serviceInstance });
  const serviceInstance = service({ client, getOffers: liveOffers }); const body = request();
  const result = await deliverDraft(body, { pause: async () => {}, fetchImpl: async (_, init) => {
    posts++; const res = response(); await endpoint(httpRequest(init.body), res);
    return new Response(res.body, { status: res.statusCode });
  } });
  assert.equal(result.name, '#D501'); assert.equal(posts, 1); assert.equal(priceReads, 2);
  assert.equal(writes, 2); assert.equal(created, 1); assert.equal(input.lineItems[0].priceOverride.amount, '393.00');
});

test('identical content with a different ID reuses the receipt; a genuinely new request creates a second draft', async () => {
  let writes = 0; const submit = service({ client: { createDraftOrder: async () => ({ name: `#D${++writes}` }) } });
  const first = request(); assert.equal((await submit.submit(first, 'ip')).name, '#D1');
  const repeated = { ...first, requestId: randomUUID() };
  const duplicate = await submit.submit(repeated, 'ip');
  assert.equal(duplicate.name, '#D1'); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.requestId, repeated.requestId);
  assert.equal((await submit.submit(repeated, 'ip')).name, '#D1');
  const next = { ...first, requestId: randomUUID(), note: 'İkinci teslimat için ayrı talep' };
  assert.equal((await submit.submit(next, 'ip')).name, '#D2'); assert.equal(writes, 2);
});

test('simultaneous identical requests with different IDs coalesce across instances', async () => {
  const repositoryInstance = repository(); let writes = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = { createDraftOrder: async () => { writes++; await gate; return { name: '#D1' }; } };
  const a = service({ repository: repositoryInstance, client }); const b = service({ repository: repositoryInstance, client });
  const first = request(); const second = { ...first, requestId: randomUUID() };
  const pending = a.submit(first, 'ip'); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await b.submit(second, 'ip')).status, 202);
  release(); await pending;
  assert.equal((await b.submit(second, 'ip')).name, '#D1'); assert.equal(writes, 1);
});

test('bot trap and quotas block before Shopify calls; same-ID receipt recovery still works after quotas fill', async () => {
  let reads = 0; const submit = service({ getOffers: async () => { reads++; return offers(); } });
  const bot = { ...request(), website: 'https://spam.example' };
  await assert.rejects(submit.submit(bot, 'ip'), { status: 400 }); assert.equal(reads, 0);
  const first = request(); await submit.submit(first, 'ip');
  for (let i = 0; i < 2; i++) await submit.submit({ ...request(), note: String(i) }, 'ip');
  await assert.rejects(submit.submit(request(), 'ip'), { status: 429 });
  assert.equal(reads, 3); assert.equal((await submit.submit(first, 'ip')).created, true);
  assert.equal(reads, 3);
});

test('a rejected mutation does not prevent a corrected retry with identical content', async () => {
  let writes = 0;
  const submit = service({ client: { createDraftOrder: async () => {
    if (++writes === 1) throw new ShopifyError('draft_rejected', 'rejected');
    return { name: '#D2' };
  } } });
  const body = request(); assert.equal((await submit.submit(body, 'ip')).safeToEdit, true);
  assert.equal((await submit.submit({ ...body, requestId: randomUUID() }, 'ip')).name, '#D2');
});

test('2000 forged new IDs with rotating IP/email values cannot flood Shopify or grow per-attempt files', async () => {
  const records = repository(); let writes = 0; let reads = 0;
  const submit = service({ repository: records, now: () => 1000000,
    getOffers: async () => { reads++; return offers(); },
    client: { createDraftOrder: async () => ({ name: `#D${++writes}` }) },
  });
  for (let i = 0; i < 2000; i++) {
    const body = request(); body.contact.email = `attacker-${i}@example.com`;
    if (i < 15) assert.equal((await submit.submit(body, `rotating-ip-${i}`)).created, true);
    else await assert.rejects(submit.submit(body, `rotating-ip-${i}`), { status: 429, code: 'request_rate_limited' });
  }
  assert.equal(writes, 15); assert.equal(reads, 15);
  assert.equal(records.records.size, 31);
});
