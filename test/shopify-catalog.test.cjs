const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { catalogInfo, productPage, pricePage, rulePage } = require('../lib/shopify-catalog.cjs');
const end = { hasNextPage: false, endCursor: null };
const conn = (nodes, pageInfo = end) => ({ nodes, pageInfo });
const info = { id: '123', title: 'Toptan Katalog', publication: 'gid://shopify/Publication/5', priceList: 'gid://shopify/PriceList/6', currency: 'TRY', adjustment: { type: 'PERCENTAGE_DECREASE', value: 10 } };
const variant = (id, visible = true) => ({ id: `gid://shopify/ProductVariant/${id}`, sku: `SKU${id}`, barcode: `CODE${id}`, price: '500.00', compareAtPrice: '600.00', availableForSale: true, publishedOnPublication: visible, selectedOptions: [{ name: 'Title', value: 'Default Title' }], image: null });
const product = { id: 'gid://shopify/Product/1', title: 'FO Şurup 700 ml', handle: 'fo-surup', status: 'ACTIVE', descriptionHtml: '<p>Açıklama</p>', productType: 'Şurup', vendor: 'FO', tags: [], options: [{ name: 'Title', position: 1 }], images: conn([]) };

async function frontend() {
  const wholesale = await readFile('public/wholesale.js', 'utf8');
  const source = (await readFile('public/shopify-data.js', 'utf8')).replace("'./wholesale.js'", JSON.stringify(`data:text/javascript;base64,${Buffer.from(wholesale).toString('base64')}`));
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('selects exact active catalog, never a similarly named retail catalog', async () => {
  const query = async (_, variables) => {
    assert.deepEqual(variables, { query: 'id:123' });
    return { shop: { currencyCode: 'TRY' }, catalogs: conn([{ ...info, id: 'gid://shopify/MarketCatalog/124', status: 'ACTIVE' }, { id: 'gid://shopify/MarketCatalog/123', title: info.title, status: 'ACTIVE', publication: { id: info.publication }, priceList: { id: info.priceList, currency: 'TRY', parent: { adjustment: info.adjustment } } }]) };
  };
  assert.equal((await catalogInfo({ query }, '123')).priceList, info.priceList);
  await assert.rejects(catalogInfo({ query: async () => ({ shop: { currencyCode: 'TRY' }, catalogs: conn([]) }) }, '123'), { code: 'catalog_invalid' });
});

test('reads all variant pages and excludes unpublished variants, draft products', async () => {
  const calls = [];
  const client = { query: async (document, variables) => {
    calls.push(variables);
    if (document.includes('WholesaleProducts')) return { publication: { products: conn([
      { ...product, variants: conn([variant(10)], { hasNextPage: true, endCursor: 'v1' }) },
      { ...product, id: 'gid://shopify/Product/2', status: 'DRAFT', variants: conn([variant(20)]) },
    ]) } };
    assert.equal(variables.after, 'v1');
    assert.equal(variables.publication, info.publication);
    return { product: { variants: conn([variant(11, false)]) } };
  } };
  const page = await productPage(client, info);
  assert.equal(calls.length, 2);
  assert.equal(page.data.rows.length, 1);
  assert.equal(page.data.rows[0].id, '10');
  assert.equal(page.data.rows[0].barcode, 'CODE10');
  assert.equal(page.data.descriptions['fo-surup'], 'Açıklama');
});

test('reads every tier page and rejects wrong-currency prices', async () => {
  const m = (amount) => ({ amount, currencyCode: 'TRY' });
  const client = { query: async (document) => document.includes('WholesalePrices(')
    ? { priceList: { prices: conn([{ variant: { id: variant(10).id }, price: m('395.00'), compareAtPrice: null, quantityPriceBreaks: conn([{ minimumQuantity: 12, price: m('380.00') }], { hasNextPage: true, endCursor: 'tier1' }) }]) } }
    : { priceList: { prices: conn([{ variant: { id: variant(10).id }, quantityPriceBreaks: conn([{ minimumQuantity: 24, price: m('370.00') }]) }]) } },
  };
  const page = await pricePage(client, info);
  assert.deepEqual(page.prices[0], { id: '10', price: 395, compareAt: null, tiers: [{ quantity: 12, price: 380 }, { quantity: 24, price: 370 }] });
  await assert.rejects(pricePage(client, { ...info, currency: 'USD' }), { code: 'catalog_invalid' });
  const rules = await rulePage({ query: async () => ({ priceList: { quantityRules: conn([{ productVariant: { id: variant(10).id }, minimum: 6, increment: 6, maximum: null }]) } }) }, info);
  assert.deepEqual(rules.rules[0], { id: '10', minimum: 6, increment: 6, maximum: null });
});

test('limits a price request to a bounded list of published product IDs', async () => {
  await pricePage({ query: async (document, variables) => {
    assert.equal(variables.query, 'product_id:1 OR product_id:2');
    assert.match(document, /query: \$query/);
    return { priceList: { prices: conn([]) } };
  } }, info, null, ['1', '2']);
});

test('uses exact wholesale prices, tiers and case rules; applies catalog adjustment only without fixed price', async () => {
  const { assembleShopifyCatalog } = await frontend();
  const base = { rows: [{ id: '10', handle: 'fo-surup', name: 'FO Şurup', price: 500, unitPrice: 1000, compareAtPrice: 600, brand: 'FO', type: 'Şurup', stock: 'in', tags: [], variants: [] }], galleries: {}, descriptions: {} };
  const prices = [{ id: '10', price: 395, compareAt: null, tiers: [{ quantity: 12, price: 380 }] }];
  const rules = [{ id: '10', minimum: 6, increment: 6, maximum: 60 }];
  const data = assembleShopifyCatalog(info, [base], prices, rules);
  assert.equal(data.source, 'shopify'); assert.equal(data.catalogId, '123');
  assert.equal(data.rows[0].price, 395); assert.equal(data.rows[0].unitPrice, 790);
  assert.equal(data.rows[0].wholesale.minimum, 6); assert.equal(data.rows[0].wholesale.increment, 6);
  assert.equal(data.rows[0].wholesale.tiers[0].price, 380);
  assert.equal(assembleShopifyCatalog(info, [base], [], []).rows[0].price, 450);
  assert.throws(() => assembleShopifyCatalog({ ...info, adjustment: null }, [base], [], []));
  assert.throws(() => assembleShopifyCatalog(info, [base, base], prices, rules));
  assert.throws(() => assembleShopifyCatalog(info, [base], prices, [{ id: '10', minimum: 5, increment: 6 }]));
  const cases = { ...base, rows: [{ ...base.rows[0], variants: [
    { id: '10', price: 500, label: '1 adet', unitPrice: 1000, available: true },
    { id: '11', price: 1000, label: '1 koli · 6 adet', unitPrice: 1000 / 6, available: true },
  ] }] };
  const byCase = assembleShopifyCatalog(info, [cases], [...prices, { id: '11', price: 2000, compareAt: null, tiers: [] }], rules);
  assert.equal(byCase.rows[0].casePrice, 2000);
  assert.equal(byCase.rows[0].unitPrice, 790);
  assert.equal(byCase.rows[0].wholesale.minimum, 6);
});

test('follows all stream cursors, rejects loops, wrong catalog and a failed stream', async () => {
  const { readShopifyCatalog } = await frontend();
  const row = (id) => ({ id, handle: `product-${id}`, name: 'Ürün', price: 100, stock: 'in', tags: [], variants: [] });
  const seen = [];
  const read = async (url) => {
    const params = new URL(url, 'https://localhost').searchParams; const part = params.get('part'); seen.push(url);
    const pageInfo = part === 'products' && !params.get('after') ? { hasNextPage: true, endCursor: 'second' } : end;
    return { enabled: true, catalogId: '123', pageInfo,
      ...(part === 'products' ? { data: { rows: [row(params.has('after') ? '11' : '10')], productCount: 1 } } : { [part]: [] }),
    };
  };
  assert.equal((await readShopifyCatalog(info, read)).rows.length, 2);
  assert.ok(seen.some((url) => url.includes('after=second')));
  await assert.rejects(readShopifyCatalog(info, async () => ({ enabled: true, catalogId: '999', pageInfo: end })));
  await assert.rejects(readShopifyCatalog(info, async () => { throw new Error('source failed'); }));
  await assert.rejects(readShopifyCatalog(info, async (url) => ({ enabled: true, catalogId: '123', pageInfo: { hasNextPage: true, endCursor: 'same' }, ...(url.includes('products') ? { data: { rows: [] } } : url.includes('prices') ? { prices: [] } : { rules: [] }) })));
});
