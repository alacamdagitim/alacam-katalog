const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { Conflict, snapshotRepository, createSnapshotService, validateSnapshot } = require('../lib/shopify-snapshot.cjs');
const { buildCatalog, synchronize } = require('../lib/shopify-sync.cjs');
const { productPage, pricePage } = require('../lib/shopify-catalog.cjs');
const { createCatalogHandler } = require('../api/catalog.js');
const info = { id: '160658587954', gid: 'gid://shopify/MarketCatalog/160658587954', title: 'Toptan Katalog', currency: 'TRY', publication: 'gid://shopify/Publication/1', priceList: 'gid://shopify/PriceList/2' };
const end = { hasNextPage: false, endCursor: null };
const conn = (nodes, pageInfo = end) => ({ nodes, pageInfo });
const rawProduct = { id: '1', handle: 'fo-vanilya', title: 'FO Vanilya Şurup 700 ml', vendor: 'FO', product_type: 'Şurup', tags: [], body_html: '<p>Vanilya açıklaması</p>', images: [], options: [{ name: 'Title', position: 1 }], variants: [{ id: '10', sku: 'FO10', barcode: '123456789', option1: 'Default Title', available: true, price: 9999, compare_at_price: 9999 }] };
const prices = [{ id: '10', price: 395, compareAt: 439, tiers: [{ quantity: 12, price: 393 }] }];
const rules = [{ id: '10', minimum: 6, increment: 6, maximum: null }];
const snapshot = (time = 1000000) => buildCatalog(info, [rawProduct], prices, rules, new Date(time).toISOString());
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function memoryRepository() {
  const records = new Map(); let revision = 0;
  return { records,
    async read(key, known) { const value = records.get(key); return value?.revision === known && value ? { unchanged: true, revision: known } : value ? structuredClone(value) : null; },
    async write(key, value, expected) {
      if ((records.get(key)?.revision ?? null) !== expected) throw new Conflict();
      records.set(key, { revision: String(++revision), value: structuredClone(value) });
    },
  };
}

test('all prices and rules come from the exact catalog; base product price is ignored', () => {
  const data = snapshot(); const row = data.rows[0];
  assert.equal(row.price, 395); assert.equal(row.compareAtPrice, 439); assert.equal(row.wholesale.minimum, 6);
  assert.equal(row.wholesale.increment, 6); assert.equal(row.wholesale.tiers[0].price, 393);
  assert.equal(row.barcode, '123456789'); assert.equal(data.productCount, 1);
  assert.equal(data.source, 'shopify'); assert.equal(data.schemaVersion, 3);
  assert.throws(() => buildCatalog(info, [rawProduct], [], rules), { code: 'catalog_invalid' });
  assert.throws(() => buildCatalog(info, [rawProduct], prices, []), { code: 'catalog_invalid' });
  assert.throws(() => buildCatalog(info, [rawProduct], [...prices, ...prices], rules));
  assert.throws(() => buildCatalog(info, [rawProduct], prices, [{ id: '10', minimum: 5, increment: 6 }]));
});

test('zero prices, case-only variants, and excluded entries never resurrect retail prices', () => {
  const product = { ...rawProduct, options: [{ name: 'Adet', position: 1 }], variants: [{ ...rawProduct.variants[0], option1: '1 koli (6 adet)' }] };
  const data = buildCatalog(info, [product], [{ id: '10', price: 0, compareAt: null, tiers: [] }, { id: '999', price: 100, tiers: [] }], rules);
  assert.equal(data.rows[0].price, 0); assert.equal(data.rows[0].variants[0].price, 0);
  assert.equal(data.rows.length, 1); assert.equal(data.rows[0].caseSize, 6);
});

test('catalog reader follows variant and price-tier pagination, excludes drafts and unpublished variants', async () => {
  const v = id => ({ id: `gid://shopify/ProductVariant/${id}`, sku: 'FO', barcode: '123', availableForSale: true, publishedOnPublication: id === 10, selectedOptions: [{ name: 'Title', value: 'Default Title' }], image: null });
  const product = { id: 'gid://shopify/Product/1', handle: rawProduct.handle, title: rawProduct.title, status: 'ACTIVE', options: rawProduct.options, images: conn([]), variants: conn([v(10)], { hasNextPage: true, endCursor: 'v2' }) };
  const page = await productPage({ query: async (document, variables) => {
    assert.ok(!document.includes('compareAtPrice')); // No default product prices requested.
    if (document.includes('WholesaleProducts')) return { publication: { products: conn([product, { ...product, status: 'DRAFT' }]) } };
    assert.equal(variables.after, 'v2'); return { product: { variants: conn([v(11)]) } };
  } }, info);
  assert.equal(page.products.length, 1); assert.equal(page.products[0].variants.length, 1);
  assert.equal(page.products[0].variants[0].price, undefined);
  const m = amount => ({ amount, currencyCode: 'TRY' });
  const result = await pricePage({ query: async (document, vars) => {
    if (document.includes('WholesalePrices(')) {
      assert.equal(vars.query, 'product_id:1');
      return { priceList: { prices: conn([{ variant: v(10), price: m('395'), compareAtPrice: m('439'), quantityPriceBreaks: conn([], { hasNextPage: true, endCursor: 't2' }) }]) } };
    }
    return { priceList: { prices: conn([{ variant: v(10), quantityPriceBreaks: conn([{ minimumQuantity: 12, price: m('393') }]) }]) } };
  } }, info, null, ['1']);
  assert.equal(result.prices[0].tiers[0].price, 393);
});

test('snapshot read is instant during a slow refresh and concurrent visitors share one job', async () => {
  let time = 1000000; const repository = memoryRepository(); await repository.write('snapshot', snapshot(time), null);
  const pending = gate(); let syncs = 0;
  const service = createSnapshotService({ catalogId: info.id, repository, now: () => time, synchronize: async () => { syncs++; await pending.promise; return snapshot(time); } });
  const old = await service.read(); time += 61000;
  assert.equal(service.stale(old), true);
  const first = service.refresh(); const second = service.refresh();
  const current = await service.read(); assert.equal(current.data.syncedAt, old.data.syncedAt);
  await new Promise(r => setImmediate(r)); assert.equal(syncs, 1);
  pending.resolve(); await Promise.all([first, second]);
  assert.equal((await service.read(true)).data.syncedAt, new Date(time).toISOString());
});

test('distributed refresh lease prevents two server instances scanning the catalog', async () => {
  const repository = memoryRepository(); const pending = gate(); let syncs = 0;
  const options = { catalogId: info.id, repository, now: () => 1000000, synchronize: async () => { syncs++; await pending.promise; return snapshot(); } };
  const a = createSnapshotService(options); const b = createSnapshotService(options);
  const jobs = [a.refresh(), b.refresh()]; await new Promise(r => setImmediate(r));
  assert.equal(syncs, 1); pending.resolve(); await Promise.all(jobs);
  assert.equal((await b.read()).data.rows[0].price, 395);
});

test('failed or incomplete refresh preserves the last complete snapshot', async () => {
  const repository = memoryRepository(); await repository.write('snapshot', snapshot(), null);
  const previous = await repository.read('snapshot');
  const service = createSnapshotService({ catalogId: info.id, repository, now: () => 2000000, synchronize: async () => { throw new Error('source failed'); } });
  await assert.rejects(service.refresh());
  assert.deepEqual(await repository.read('snapshot'), previous);
  assert.equal((await service.read()).data.rows[0].price, 395);
  const other = createSnapshotService({ catalogId: info.id, repository, now: () => 2300000, synchronize: async () => ({ ...snapshot(), source: 'retail' }) });
  await assert.rejects(other.refresh(), { code: 'snapshot_invalid' });
  assert.deepEqual(await repository.read('snapshot'), previous);
});

test('snapshot validation rejects wrong-catalog, legacy and unpriced records', () => {
  assert.throws(() => validateSnapshot({ ...snapshot(), catalogId: '999' }, info.id));
  assert.throws(() => validateSnapshot({ ...snapshot(), source: 'retail' }, info.id));
  const broken = snapshot(); broken.rows[0].price = null; assert.throws(() => validateSnapshot(broken, info.id));
});

test('server synchronization reads the complete catalog and retries throttled reads', async () => {
  let metadataCalls = 0; let pauses = 0;
  const variant = { id: 'gid://shopify/ProductVariant/10', sku: 'FO10', barcode: '123', availableForSale: true,
    publishedOnPublication: true, selectedOptions: [{ name: 'Title', value: 'Default Title' }], image: null };
  const client = { query: async (document, variables) => {
    if (document.includes('query WholesaleCatalog')) {
      if (++metadataCalls === 1) { const error = new Error(); error.code = 'rate_limited'; throw error; }
      return { catalogs: conn([{ id: info.gid, title: info.title, status: 'ACTIVE', publication: { id: info.publication }, priceList: { id: info.priceList, currency: 'TRY' } }]) };
    }
    if (document.includes('query WholesaleProducts')) return { publication: { products: conn([{ id: 'gid://shopify/Product/1', handle: rawProduct.handle, title: rawProduct.title, vendor: 'FO', status: 'ACTIVE', options: rawProduct.options, images: conn([]), variants: conn([variant]) }]) } };
    if (document.includes('query WholesaleRules')) return { priceList: { quantityRules: conn([{ productVariant: variant, minimum: 6, increment: 6, maximum: null }]) } };
    assert.match(document, /query WholesalePrices/); assert.equal(variables.query, 'product_id:1');
    return { priceList: { prices: conn([{ variant, price: { amount: '395', currencyCode: 'TRY' }, compareAtPrice: null, quantityPriceBreaks: conn([]) }]) } };
  } };
  const data = await synchronize(client, info.id, { now: () => 1000000, pause: async () => { pauses++; } });
  assert.equal(pauses, 1); assert.equal(metadataCalls, 3); assert.equal(data.rows[0].price, 395);
  assert.equal(data.rows[0].wholesale.minimum, 6);
});

test('local persistent snapshots survive process recreation and enforce conditional writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shopify-cache-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = snapshotRepository(info.id, { SHOPIFY_CACHE_DIRECTORY: directory });
  await repository.write('snapshot', snapshot(), null);
  const existing = await repository.read('snapshot');
  await assert.rejects(repository.write('snapshot', snapshot(), null), Conflict);
  assert.equal((await repository.read('snapshot', existing.revision)).unchanged, true);
  const another = snapshotRepository(info.id, { SHOPIFY_CACHE_DIRECTORY: directory });
  assert.equal((await another.read('snapshot')).value.rows[0].price, 395);
});

const response = () => ({ headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } });
test('HTTP returns a single cached catalog, 304 for unchanged data, and schedules refresh without blocking', async () => {
  const tasks = []; const pending = gate();
  const stored = { data: snapshot(), body: JSON.stringify(snapshot()), etag: '"rev1"' };
  const handler = createCatalogHandler({ getService: () => ({ read: async () => stored, stale: () => true, refresh: () => pending.promise }), schedule: task => tasks.push(task) });
  const res = response(); await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 200); assert.equal(JSON.parse(res.body).rows[0].price, 395); assert.equal(tasks.length, 1);
  const conditional = response(); await handler({ method: 'GET', headers: { 'if-none-match': '"rev1"' } }, conditional);
  assert.equal(conditional.statusCode, 304); assert.equal(conditional.body, undefined);
  const head = response(); await handler({ method: 'HEAD', headers: {} }, head); assert.equal(head.body, undefined);
  pending.resolve(); await Promise.all(tasks);
});

test('first server initialization is background work, never a browser product-by-product crawl', async () => {
  const tasks = []; const pending = gate();
  const handler = createCatalogHandler({ getService: () => ({ read: async () => null, refresh: () => pending.promise }), schedule: task => tasks.push(task) });
  const res = response(); await handler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 202); assert.deepEqual(JSON.parse(res.body), { pending: true });
  pending.resolve(); await Promise.all(tasks);
});

test('browser and HTML contain no storefront/CSV fallback or per-product loading stream', async () => {
  const source = await readFile('public/catalog.js', 'utf8'); const html = await readFile('public/index.html', 'utf8');
  assert.ok(source.includes("fetch('/api/catalog'"));
  for (const obsolete of ['/api/wholesale', '/api/shopify-catalog', '/catalog-data.json', 'readShopifyCatalog', 'applyWholesale']) assert.equal(source.includes(obsolete), false);
  for (const obsolete of ['wholesale-admin', 'aria-label="Katalog yükle"', 'CSV']) assert.equal(html.includes(obsolete), false);
  const normalizer = await readFile('lib/catalog.cjs', 'utf8'); assert.equal(normalizer.includes('fetch('), false);
  const cacheSource = await readFile('public/catalog-cache.js', 'utf8');
  const { validCatalog } = await import(`data:text/javascript;base64,${Buffer.from(cacheSource).toString('base64')}`);
  assert.equal(validCatalog(snapshot()), true); assert.equal(validCatalog({ ...snapshot(), source: 'retail' }), false);
});
