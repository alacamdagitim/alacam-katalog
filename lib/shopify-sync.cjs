const { normalizeCatalog } = require('./catalog.cjs');
const { ShopifyError } = require('./shopify-admin.cjs');
const { catalogInfo, productPage, pricePage, rulePage } = require('./shopify-catalog.cjs');

function invalid(message) { throw new ShopifyError('catalog_invalid', message); }
const validQuantity = (n) => Number.isInteger(n) && n > 0 && n <= 2147483647;

function buildCatalog(info, products, prices, rules, syncedAt = new Date().toISOString()) {
  const byPrice = new Map(); const byRule = new Map(); const ids = new Set();
  for (const item of prices) {
    if (byPrice.has(item.id) || !Number.isFinite(item.price) || item.price < 0) invalid('Yinelenen veya geçersiz katalog fiyatı.');
    byPrice.set(item.id, item);
  }
  for (const item of rules) {
    if (byRule.has(item.id) || !validQuantity(item.minimum) || !validQuantity(item.increment) || item.minimum % item.increment
      || (item.maximum != null && (!validQuantity(item.maximum) || item.maximum < item.minimum))) invalid('Katalog miktar kuralı doğrulanamadı.');
    byRule.set(item.id, item);
  }
  const offers = new Map();
  const pricedProducts = products.map((product) => ({ ...product, variants: product.variants.map((variant) => {
    const id = String(variant.id); const amount = byPrice.get(id); const rule = byRule.get(id);
    // Every displayed price and order rule must be explicitly returned by this
    // price list. There is no fallback to product.price, CSV, or retail snapshots.
    if (ids.has(id) || !amount || !rule) invalid('Katalogdaki bir varyantın fiyatı veya miktar kuralı eksik.');
    ids.add(id);
    const tiers = [...amount.tiers].sort((a, b) => a.quantity - b.quantity);
    const thresholds = new Set();
    for (const tier of tiers) {
      if (!validQuantity(tier.quantity) || tier.quantity < rule.minimum || tier.quantity % rule.increment
        || (rule.maximum != null && tier.quantity > rule.maximum) || thresholds.has(tier.quantity)
        || !Number.isFinite(tier.price) || tier.price < 0) invalid('Katalog fiyat kademesi doğrulanamadı.');
      thresholds.add(tier.quantity);
    }
    offers.set(id, { price: amount.price, minimum: rule.minimum, increment: rule.increment,
      ...(rule.maximum == null ? {} : { maximum: rule.maximum }), ...(tiers.length ? { tiers } : {}) });
    return { ...variant, price: amount.price, compare_at_price: amount.compareAt };
  }) }));
  const data = normalizeCatalog(pricedProducts);
  for (const row of data.rows) {
    row.wholesale = offers.get(String(row.id));
    row.price = row.wholesale?.price;
    row.compareAtPrice = byPrice.get(String(row.id))?.compareAt ?? null;
    for (const variant of row.variants) {
      variant.wholesale = offers.get(String(variant.id));
      variant.price = variant.wholesale?.price;
    }
  }
  if (data.rows.some(row => !row.wholesale || row.variants.some(variant => !variant.wholesale))) invalid('Katalog satırı doğrulanamadı.');
  return { ...data, schemaVersion: 3, source: 'shopify', wholesale: true,
    catalogId: info.id, catalogTitle: info.title, currency: info.currency, syncedAt };
}

async function synchronize(client, catalogId, { now = Date.now, pause = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const deadline = now() + 240000;
  const read = async (operation) => {
    for (let attempt = 0; ; attempt++) {
      if (now() > deadline) throw new ShopifyError('sync_timeout', 'Katalog eşitleme süresi aşıldı.');
      try { return await operation(); } catch (error) {
        if (error.code !== 'rate_limited' || attempt >= 7) throw error;
        await pause(Math.min(8000, 1500 * (attempt + 1)));
      }
    }
  };
  const info = await read(() => catalogInfo(client, catalogId));
  async function collect(fetcher, property, extra) {
    let cursor = null; const seen = new Set(); const results = [];
    for (let n = 0; n < 2000; n++) {
      const page = await read(() => fetcher(client, info, cursor, extra));
      if (!Array.isArray(page[property])) invalid('Katalog veri sayfası doğrulanamadı.');
      results.push(...page[property]);
      if (!page.pageInfo.hasNextPage) return results;
      cursor = page.pageInfo.endCursor;
      if (!cursor || seen.has(cursor)) invalid('Katalog sayfaları tekrarlandı.');
      seen.add(cursor);
    }
    invalid('Katalog sayfa sınırı aşıldı.');
  }
  const [products, rules] = await Promise.all([collect(productPage, 'products'), collect(rulePage, 'rules')]);
  const productIds = products.map(({ id }) => id);
  if (new Set(productIds).size !== productIds.length) invalid('Yinelenen katalog ürünü.');
  let next = 0; const prices = [];
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (next < productIds.length) {
      const batch = productIds.slice(next, next + 60); next += 60;
      prices.push(...await collect(pricePage, 'prices', batch));
    }
  }));
  const after = await read(() => catalogInfo(client, catalogId));
  if (after.gid !== info.gid || after.priceList !== info.priceList || after.publication !== info.publication) invalid('Katalog eşitleme sırasında değişti; yeniden denenecek.');
  return buildCatalog(info, products, prices, rules, new Date(now()).toISOString());
}

module.exports = { buildCatalog, synchronize };
