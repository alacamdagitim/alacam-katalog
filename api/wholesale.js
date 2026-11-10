const { matchWholesaleCatalog, readWholesale, wholesaleStorage, writeWholesale, WholesaleWriteConflict } = require('../lib/wholesale.cjs');

const maxUploadBytes = 3_500_000;
const storageError = 'Toptan katalog deposuna şu anda erişilemiyor.';

class UploadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readCsv(request) {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'text/csv' && contentType !== 'text/plain') {
    throw new UploadError(415, 'Dosyayı UTF-8 CSV biçiminde gönderin.');
  }
  const tooLarge = () => new UploadError(413, 'CSV dosyası en fazla 3,5 MB olabilir.');
  if (Number(request.headers['content-length']) > maxUploadBytes) throw tooLarge();

  let bytes;
  if (request.readableEnded || typeof request[Symbol.asyncIterator] !== 'function') {
    const body = request.body;
    if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
      throw new UploadError(400, 'CSV dosyası okunamadı.');
    }
    bytes = Buffer.from(body);
    if (bytes.length > maxUploadBytes) throw tooLarge();
  } else {
    const chunks = [];
    let size = 0;
    const stream = request.iterator ? request.iterator({ destroyOnReturn: false }) : request;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxUploadBytes) throw tooLarge();
      chunks.push(buffer);
    }
    bytes = Buffer.concat(chunks, size);
  }
  if (!bytes.length) throw new UploadError(400, 'CSV dosyası boş.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new UploadError(400, 'CSV dosyası UTF-8 biçiminde olmalıdır.');
  }
}

module.exports = async (request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const send = (status, body) => {
    response.statusCode = status;
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(body));
  };

  if (request.method === 'GET' || request.method === 'HEAD') {
    try {
      const published = await readWholesale(wholesaleStorage());
      return send(200, published ? { active: true, ...published } : { active: false });
    } catch {
      return send(503, { error: storageError });
    }
  }
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'GET, HEAD, POST');
    return send(405, { error: 'Bu istek yöntemi desteklenmiyor.' });
  }

  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin') {
    return send(403, { error: 'Dosyayı katalog sayfasından yükleyin.' });
  }

  const params = new URL(request.url, 'http://localhost').searchParams;
  const preview = params.get('preview') === '1';
  const catalogTitle = params.get('catalog');
  if ((params.has('preview') && !preview) || params.getAll('preview').length > 1 || params.getAll('catalog').length > 1) {
    return send(400, { error: 'Katalog yükleme isteği geçersiz.' });
  }
  try {
    const storage = wholesaleStorage();
    if (!storage) return send(503, { error: storageError });
    const csv = await readCsv(request);
    const parser = await import('../lib/wholesale-csv.mjs');
    let parsed;
    try {
      parsed = parser.parseWholesaleCsv(csv);
    } catch (error) {
      const controlled = error instanceof Error && error.message.length < 180
        && /^(?:CSV dosyası|Shopify katalog CSV|\d+\. CSV kaydındaki)/.test(error.message);
      throw new UploadError(400, controlled ? error.message : 'Shopify katalog CSV dosyası doğrulanamadı.');
    }
    const catalogs = parsed.catalogs.map(({ title }) => title);
    const catalog = catalogTitle ? parsed.catalogs.find(({ title }) => title === catalogTitle)
      : parsed.catalogs.length === 1 ? parsed.catalogs[0] : null;
    if (!catalog) {
      return send(409, { error: 'Yayınlanacak kataloğu seçin.', catalogs });
    }
    const { products, stats } = matchWholesaleCatalog(catalog, parser);
    const result = { preview, catalog: catalog.title, catalogs, stats };
    if (preview) return send(200, result);
    if (!stats.matchedVariants) return send(422, { error: 'Hiçbir satış seçeneği mağaza kataloğuyla eşleşmedi.' });
    if (!stats.visibleVariants) return send(422, { error: 'Dosyada yayımlanabilir satış seçeneği bulunamadı.' });

    const publishedAt = new Date().toISOString();
    const publication = { publishedAt, products };
    if (Buffer.byteLength(JSON.stringify(publication)) > maxUploadBytes) {
      throw new UploadError(422, 'Eşleşen katalog verisi 3,5 MB sınırını aşıyor.');
    }
    await writeWholesale(storage, publication);
    return send(200, { ...result, publishedAt });
  } catch (error) {
    if (error instanceof UploadError) return send(error.status, { error: error.message });
    if (error instanceof WholesaleWriteConflict) return send(409, { error: 'Başka bir yayın tamamlandı. Dosyayı yeniden kontrol edin.' });
    return send(503, { error: storageError });
  }
};
