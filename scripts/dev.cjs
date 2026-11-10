const http = require('node:http');
const { createReadStream } = require('node:fs');
const { stat } = require('node:fs/promises');
const path = require('node:path');
const serveCatalog = require('../api/catalog.js');
const serveInstallments = require('../api/installments.js');

const root = path.resolve(__dirname, '../public');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const port = Number(process.env.PORT || 4173);
const host = process.env.CATALOG_HOST || '127.0.0.1';

http.createServer(async (request, response) => {
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/catalog') return await serveCatalog(request, response);
    if (url.pathname === '/api/installments') return await serveInstallments(request, response);
    const file = path.resolve(root, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) throw new Error('Dosya bulunamadı');
    response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    if (request.method === 'HEAD') return response.end();
    createReadStream(file).on('error', () => response.destroy()).pipe(response);
  } catch {
    response.statusCode = 404;
    response.end('Sayfa bulunamadı');
  }
}).listen(port, host, () => console.log(`Katalog: http://${host}:${port}`));
