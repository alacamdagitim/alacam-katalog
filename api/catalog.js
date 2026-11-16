const { waitUntil } = require('@vercel/functions');
const { shopifyClient, ShopifyError } = require('../lib/shopify-admin.cjs');
const { synchronize } = require('../lib/shopify-sync.cjs');
const { snapshotRepository, createSnapshotService } = require('../lib/shopify-snapshot.cjs');
let shared;

function service() {
  const { client, catalogId } = shopifyClient();
  const storageKey = [process.env.BLOB_STORE_ID, process.env.BLOB_READ_WRITE_TOKEN, process.env.SHOPIFY_CACHE_DIRECTORY].join('|');
  if (!shared || shared.client !== client || shared.storageKey !== storageKey) shared = { client, storageKey,
    service: createSnapshotService({ catalogId, repository: snapshotRepository(catalogId), synchronize: () => synchronize(client, catalogId) }) };
  return shared.service;
}

function createCatalogHandler({ getService = service, schedule = task => { if (process.env.VERCEL) waitUntil(task); } } = {}) {
return async (request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    response.statusCode = 405;
    return response.end();
  }
  try {
    const catalog = getService();
    const snapshot = await catalog.read();
    const refresh = () => {
      const task = catalog.refresh().catch(error => { console.error('Shopify katalog yenilemesi tamamlanamadı:', error instanceof ShopifyError ? error.code : 'storage_or_sync_error'); });
      schedule(task);
    };
    if (!snapshot) {
      refresh();
      response.statusCode = 202; response.setHeader('Retry-After', '3');
      return response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ pending: true }));
    }
    const stale = catalog.stale(snapshot);
    response.setHeader('X-Catalog-Refreshing', stale ? '1' : '0');
    response.setHeader('X-Catalog-Synced-At', snapshot.data.syncedAt);
    response.setHeader('ETag', snapshot.etag);
    if (stale) {
      refresh();
    }
    if (request.headers['if-none-match'] === snapshot.etag) { response.statusCode = 304; return response.end(); }
    response.statusCode = 200;
    return response.end(request.method === 'HEAD' ? undefined : snapshot.body);
  } catch (error) {
    response.setHeader('Cache-Control', 'no-store');
    response.statusCode = 503;
    return response.end(request.method === 'HEAD' ? undefined : JSON.stringify({ error: error instanceof ShopifyError ? error.message : 'Toptan katalog kaydına ulaşılamıyor.' }));
  }
};
}
module.exports = createCatalogHandler();
module.exports.createCatalogHandler = createCatalogHandler;
