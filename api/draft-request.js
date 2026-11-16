const { shopifyClient, ShopifyError } = require('../lib/shopify-admin.cjs');
const { snapshotRepository } = require('../lib/shopify-snapshot.cjs');
const { RequestError, createDraftService } = require('../lib/shopify-draft.cjs');
let shared;
function service() {
  const { client, catalogId } = shopifyClient();
  const storageKey = [process.env.BLOB_STORE_ID, process.env.BLOB_READ_WRITE_TOKEN, process.env.SHOPIFY_CACHE_DIRECTORY].join('|');
  if (!shared || shared.client !== client || shared.storageKey !== storageKey) shared = { client, storageKey,
    service: createDraftService({ client, catalogId, repository: snapshotRepository(catalogId) }) };
  return shared.service;
}
async function readBody(request) {
  if (Number(request.headers['content-length']) > 20000) throw new RequestError(413, 'too_large', 'Talep boyutu çok büyük.');
  if (request.body != null) {
    const raw = typeof request.body === 'string' || Buffer.isBuffer(request.body) ? request.body.toString() : JSON.stringify(request.body);
    if (Buffer.byteLength(raw) > 20000) throw new RequestError(413, 'too_large', 'Talep boyutu çok büyük.');
    try { return JSON.parse(raw); } catch { throw new RequestError(400, 'invalid_request', 'Talep bilgileri okunamadı.'); }
  }
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 20000) throw new RequestError(413, 'too_large', 'Talep boyutu çok büyük.');
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch { throw new RequestError(400, 'invalid_request', 'Talep bilgileri okunamadı.'); }
}
function createDraftHandler({ getService = service } = {}) {
  return async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (request.method !== 'POST') { response.statusCode = 405; response.setHeader('Allow', 'POST'); return response.end(); }
    try {
      const origin = request.headers.origin;
      // Browser submissions must originate on this deployment, including local preview.
      if (!origin || new URL(origin).host !== request.headers.host || request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'forbidden', 'Bu adresten talep gönderilemiyor.');
      if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new RequestError(415, 'invalid_request', 'JSON talep bilgileri gerekli.');
      const body = await readBody(request);
      const ip = (process.env.VERCEL ? request.headers['x-vercel-forwarded-for'] : request.socket?.remoteAddress) ?? 'unknown';
      const result = await getService().submit(body, String(ip));
      const { status, ...payload } = result; response.statusCode = status;
      return response.end(JSON.stringify(payload));
    } catch (error) {
      const known = error instanceof RequestError || error instanceof ShopifyError;
      response.statusCode = error instanceof RequestError ? error.status : 503;
      return response.end(JSON.stringify({ code: known ? error.code : 'unavailable', error: known ? error.message : 'Talep gönderilemiyor. Biraz sonra durumunu kontrol edin.', safeToEdit: error instanceof RequestError && error.code !== 'request_conflict' }));
    }
  };
}
module.exports = createDraftHandler();
module.exports.createDraftHandler = createDraftHandler;
