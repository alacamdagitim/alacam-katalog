const { checkConnection, shopifyClient, ShopifyError } = require('../lib/shopify-admin.cjs');

let cached;
let pending;

module.exports = async (request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const send = (status, body) => {
    response.statusCode = status;
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body));
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    return send(405, { error: 'Bu istek yöntemi desteklenmiyor.' });
  }
  try {
    const { client, catalogId } = shopifyClient();
    if (!cached || cached.client !== client || cached.catalogId !== catalogId || Date.now() - cached.at > 60000) {
      if (!pending || pending.client !== client || pending.catalogId !== catalogId) {
        const entry = { client, catalogId };
        entry.promise = checkConnection(client, catalogId).then((body) => {
          cached = { client, catalogId, at: Date.now(), body };
          return body;
        }).finally(() => { if (pending === entry) pending = undefined; });
        pending = entry;
      }
      return send(200, await pending.promise);
    }
    return send(200, cached.body);
  } catch (error) {
    return send(503, {
      connected: false,
      code: error instanceof ShopifyError ? error.code : 'shopify_unavailable',
      error: error instanceof ShopifyError ? error.message : 'Shopify bağlantısı kontrol edilemedi.',
    });
  }
};
