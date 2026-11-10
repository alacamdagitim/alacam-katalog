const { fetchProducts, normalizeCatalog } = require('../lib/catalog.cjs');
const productDetails = require('../lib/catalog-details.json');

const FRESH_FOR = 15 * 60 * 1000;
let cached;
let pending;

async function getCatalog() {
  if (cached && Date.now() - cached.timestamp < FRESH_FOR) return cached.body;
  if (!pending) {
    pending = fetchProducts().then((products) => {
      const catalog = normalizeCatalog(products, productDetails.variants);
      if (!catalog.rows.length) throw new Error('Ürün kaynağında satır bulunamadı.');
      cached = { body: JSON.stringify(catalog), timestamp: Date.now() };
      return cached.body;
    }).finally(() => { pending = undefined; });
  }
  return pending;
}

module.exports = async (request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    response.statusCode = 405;
    return response.end();
  }
  try {
    const body = await getCatalog();
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
    return response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    console.error('Katalog güncellenemedi:', error.message);
    response.setHeader('Cache-Control', 'no-store');
    response.statusCode = 503;
    return response.end(request.method === 'HEAD' ? undefined : '{"error":"Ürün kaynağına ulaşılamadı."}');
  }
};
