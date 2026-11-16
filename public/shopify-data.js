import { applyWholesale } from './wholesale.js';

function fail() { throw new Error('Toptan katalog verisi doğrulanamadı.'); }
const quantity = (value) => Number.isInteger(value) && value >= 1 && value <= 2147483647;
const price = (value) => Number.isFinite(value) && value >= 0;

function adjusted(value, adjustment) {
  if (value == null) return null;
  if (!price(value) || !adjustment) fail();
  const rate = Number(adjustment.value);
  if (!Number.isFinite(rate) || rate < 0) fail();
  const direction = { PERCENTAGE_DECREASE: -1, PERCENTAGE_INCREASE: 1 }[adjustment.type];
  if (!direction) fail();
  const result = Math.round((value * (1 + direction * rate / 100) + Number.EPSILON) * 100) / 100;
  if (!price(result)) fail();
  return result;
}

export function assembleShopifyCatalog(info, pages, prices, rules) {
  if (!info || info.currency !== 'TRY' || !Array.isArray(pages)) fail();
  const byPrice = new Map(); const byRule = new Map();
  for (const entry of prices) {
    if (byPrice.has(entry.id) || !price(entry.price) || (entry.compareAt != null && !price(entry.compareAt)) || !Array.isArray(entry.tiers)) fail();
    const thresholds = new Set();
    for (const tier of entry.tiers) {
      if (!quantity(tier.quantity) || !price(tier.price) || thresholds.has(tier.quantity)) fail();
      thresholds.add(tier.quantity);
    }
    byPrice.set(entry.id, entry);
  }
  for (const entry of rules) {
    if (byRule.has(entry.id) || !quantity(entry.minimum) || !quantity(entry.increment) || entry.minimum % entry.increment !== 0
        || (entry.maximum != null && (!quantity(entry.maximum) || entry.maximum < entry.minimum))) fail();
    byRule.set(entry.id, entry);
  }
  const data = { rows: [], galleries: {}, descriptions: {}, syncedAt: new Date().toISOString() };
  const ids = new Set(); const overlay = { active: true, products: Object.create(null) };
  for (const page of pages) {
    if (!page || !Array.isArray(page.rows)) fail();
    data.rows.push(...page.rows);
    Object.assign(data.galleries, page.galleries);
    Object.assign(data.descriptions, page.descriptions);
    for (const row of page.rows) {
      const product = overlay.products[row.handle] ??= { variants: Object.create(null) };
      for (const variant of row.variants?.length ? row.variants : [row]) {
        const id = String(variant.id);
        if (ids.has(id)) fail();
        ids.add(id);
        const entry = byPrice.get(id);
        const rule = byRule.get(id) ?? { minimum: 1, increment: 1, maximum: null };
        const amount = entry ? entry.price : adjusted(variant.price, info.adjustment);
        if (!price(amount)) fail();
        const tiers = (entry?.tiers ?? []).toSorted((a, b) => a.quantity - b.quantity);
        if (tiers.some((tier) => tier.quantity < rule.minimum || tier.quantity % rule.increment !== 0
          || (rule.maximum != null && tier.quantity > rule.maximum))) fail();
        product.variants[id] = { price: amount,
          compareAt: entry ? entry.compareAt : adjusted(variant.compareAtPrice, info.adjustment),
          minimum: rule.minimum, increment: rule.increment,
          ...(rule.maximum == null ? {} : { maximum: rule.maximum }),
          ...(tiers.length ? { tiers } : {}),
        };
      }
    }
  }
  return { ...applyWholesale(data, overlay), source: 'shopify', catalogId: info.id, catalogTitle: info.title };
}

export async function readShopifyCatalog(info, read, progress = () => {}) {
  async function collect(part, productIds = []) {
    let after = null; const seen = new Set(); const result = [];
    for (let page = 0; page < 2000; page++) {
      const params = new URLSearchParams({ part });
      if (productIds.length) params.set('products', productIds.join(','));
      if (after) params.set('after', after);
      const body = await read(`/api/shopify-catalog?${params}`);
      if (body.enabled !== true || body.catalogId !== info.id || typeof body.pageInfo?.hasNextPage !== 'boolean') fail();
      if (part === 'products') {
        result.push(body.data);
        progress(result.reduce((count, data) => count + (data?.productCount ?? 0), 0));
      } else {
        if (!Array.isArray(body[part])) fail();
        result.push(...body[part]);
      }
      if (!body.pageInfo.hasNextPage) return result;
      after = body.pageInfo.endCursor;
      if (typeof after !== 'string' || !after || seen.has(after)) fail();
      seen.add(after);
    }
    fail();
  }
  // Every stream must finish before any prices become visible.
  const [pages, rules] = await Promise.all([collect('products'), collect('rules')]);
  const productIds = [...new Set(pages.flatMap((page) => page.productIds ?? []))];
  // Only request prices for the selected catalog's published active products.
  // Older fixtures without product IDs retain the complete price stream.
  let prices = [];
  if (!productIds.length && pages.some((page) => page.rows.length)) {
    prices = await collect('prices');
  } else {
    let index = 0;
    const batches = [];
    while (index < productIds.length) { batches.push(productIds.slice(index, index + 60)); index += 60; }
    let next = 0;
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        prices.push(...await collect('prices', batch));
      }
    }));
  }
  return assembleShopifyCatalog(info, pages, prices, rules);
}
