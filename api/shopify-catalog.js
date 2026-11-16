const { shopifyClient, ShopifyError } = require('../lib/shopify-admin.cjs');
const { catalogInfo, productPage, pricePage, rulePage } = require('../lib/shopify-catalog.cjs');
const TTL = 60000;
const cache = new Map();
let cacheClient;

async function memo(key, fetcher) {
  const previous = cache.get(key);
  if (previous && Date.now() - previous.at < TTL) return previous.promise;
  const entry = { at: Date.now() };
  entry.promise = fetcher().catch((error) => { if (cache.get(key) === entry) cache.delete(key); throw error; });
  cache.set(key, entry);
  // Bound warm-instance memory. CDN caching handles pages no longer held here.
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  return entry.promise;
}

module.exports = async (request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const send = (status, body) => { response.statusCode = status; response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body)); };
  if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); return send(405, { error: 'Bu istek yöntemi desteklenmiyor.' }); }
  const params = new URL(request.url, 'https://localhost').searchParams;
  const part = params.get('part') ?? 'info';
  const after = params.get('after');
  const productIds = params.has('products') ? params.get('products').split(',') : [];
  if (!['info', 'products', 'prices', 'rules'].includes(part) || [...params.keys()].some((key) => !['part', 'after', 'products'].includes(key))
      || params.getAll('part').length > 1 || params.getAll('after').length > 1 || params.getAll('products').length > 1 || (after && after.length > 2048)
      || (params.has('products') && (part !== 'prices' || productIds.length > 60 || productIds.some((id) => !/^[1-9]\d{0,19}$/.test(id))))) {
    return send(400, { error: 'Katalog sayfası isteği geçersiz.' });
  }
  try {
    // No settings means legacy local preview; partially configured production fails closed.
    if (!['SHOPIFY_SHOP', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_CATALOG_ID'].some((key) => process.env[key])) {
      if (process.env.VERCEL) throw new ShopifyError('configuration_missing', 'Shopify bağlantı ayarları eksik.');
      return send(200, { enabled: false });
    }
    const { client, catalogId } = shopifyClient();
    if (cacheClient !== client) { cache.clear(); cacheClient = client; }
    const info = await memo(`info:${catalogId}`, () => catalogInfo(client, catalogId));
    if (part === 'info') return send(200, { enabled: true, catalog: { id: info.id, title: info.title, currency: info.currency, adjustment: info.adjustment } });
    const fetcher = { products: productPage, prices: pricePage, rules: rulePage }[part];
    const body = await memo(JSON.stringify([catalogId, info.publication, info.priceList, part, after, productIds]), () => fetcher(client, info, after, productIds));
    response.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=60');
    return send(200, { enabled: true, catalogId, ...body });
  } catch (error) {
    const code = error instanceof ShopifyError ? error.code : 'shopify_unavailable';
    if (code === 'rate_limited') response.setHeader('Retry-After', '2');
    return send(code === 'rate_limited' ? 429 : 503, { enabled: true, code,
      error: error instanceof ShopifyError ? error.message : 'Toptan katalog şu anda okunamıyor.' });
  }
};
