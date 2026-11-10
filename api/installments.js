const bundledConfig = require('../lib/paytr-widget-config.json');

const storefrontPage = 'https://alacamdagitim.com/products/rubikap-premium-polikarbonat-bardak?variant=67990896279858';
const paytrWidget = 'https://www.paytr.com/odeme/taksit-tablosu/v2';
const quoteLifetime = 5 * 60 * 1000;
const upstreamTimeout = 4250;
const rateLimitCooldown = 20_000;
const maxCachedQuotes = 128;
const maxPendingQuotes = 8;
const cardNames = {
  advantage: 'Advantage',
  axess: 'Axess',
  bonus: 'Bonus',
  cardfinans: 'CardFinans',
  combo: 'Combo',
  maximum: 'Maximum',
  paraf: 'Paraf',
  saglamkart: 'Sağlam Kart',
  world: 'World',
};

function credentials(token, merchant) {
  return typeof token === 'string' && /^[0-9a-f]{32,128}$/i.test(token)
    && typeof merchant === 'string' && /^\d{1,12}$/.test(merchant) ? { token, merchant } : undefined;
}

let lastKnownConfig = credentials(bundledConfig.token, bundledConfig.merchant);
let config = credentials(process.env.PAYTR_INSTALLMENT_TOKEN?.trim(), process.env.PAYTR_MERCHANT_ID?.trim()) ?? lastKnownConfig;
let pendingConfig;
let storefrontRetryAt = 0;
let widgetRetryAt = 0;
const quotes = new Map();
const pendingQuotes = new Map();

class UpstreamError extends Error {
  constructor(status, retryAt = 0) {
    super('Kaynak yanıtı alınamadı.');
    this.status = status;
    this.retryAt = retryAt;
  }
}

class InvalidWidgetError extends Error {}

function cooldownUntil(retryAfter) {
  const now = Date.now();
  const wait = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
  const delay = Number.isFinite(wait) ? Math.min(120_000, Math.max(rateLimitCooldown, wait)) : rateLimitCooldown;
  return now + delay;
}

async function fetchText(url, maxBytes) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(upstreamTimeout),
  });
  if (!response.ok) {
    const retryAt = response.status === 429 ? cooldownUntil(response.headers.get('Retry-After')) : 0;
    response.body?.cancel().catch(() => {});
    throw new UpstreamError(response.status, retryAt);
  }
  if (!response.body) throw new Error('Kaynak yanıtı alınamadı.');

  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error('Kaynak yanıtı çok büyük.');
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

function canRetry(error) {
  if ([408, 500, 502, 503, 504].includes(error.status)) return true;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  return error instanceof TypeError && (!error.cause || [
    'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  ].includes(error.cause.code));
}

function extractConfig(html) {
  for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    if (!script.includes('alacam-paytr-v1') || !script.includes(paytrWidget)) continue;
    const merchant = script.match(/\bconst\s+merchant\s*=\s*['"](\d{1,12})['"]\s*;/)?.[1];
    const token = script.match(/\bconst\s+token\s*=\s*['"]([0-9a-f]{32,128})['"]\s*;/i)?.[1];
    if (token && merchant) return { token, merchant };
  }

  const embed = html.match(/<script\b[^>]*\bsrc\s*=\s*(["'])(https:\/\/www\.paytr\.com\/odeme\/taksit-tablosu\/v2\?[^"']+)\1/i);
  if (!embed) throw new Error('Mağazada taksit tablosu bulunamadı.');
  const url = new URL(embed[2].replaceAll('&amp;', '&'));
  const token = url.searchParams.get('token') || '';
  const merchant = url.searchParams.get('merchant_id') || '';
  const found = credentials(token, merchant);
  if (!found) throw new Error('Mağazadaki taksit tablosu doğrulanamadı.');
  return found;
}

async function fetchStorefrontConfig() {
  let html;
  try {
    html = await fetchText(storefrontPage, 3_000_000);
  } catch (error) {
    if (!canRetry(error)) throw error;
    html = await fetchText(storefrontPage, 3_000_000);
  }
  return extractConfig(html);
}

function configAfterRateLimit() {
  if (lastKnownConfig) {
    config = lastKnownConfig;
    return config;
  }
  throw new UpstreamError(429, storefrontRetryAt);
}

async function getConfig() {
  if (config) return config;
  if (!pendingConfig) {
    if (Date.now() < storefrontRetryAt) return configAfterRateLimit();
    pendingConfig = fetchStorefrontConfig().then((found) => {
      config = found;
      return config;
    }).catch((error) => {
      if (error.status !== 429) throw error;
      storefrontRetryAt = error.retryAt;
      return configAfterRateLimit();
    }).finally(() => { pendingConfig = undefined; });
  }
  return pendingConfig;
}

function moneyInKurus(value) {
  const match = value.replace(/&nbsp;|&#160;|&#xa0;/gi, ' ').trim().match(/^(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})\s*(?:TL|₺)$/i);
  if (!match) return null;
  const amount = Number(match[1].replaceAll('.', '') + match[2]);
  return Number.isSafeInteger(amount) ? amount : null;
}

function parsePrograms(widget) {
  const assignment = widget.match(/^\s*document\.getElementById\(['"]paytr_taksit_tablosu['"]\)\.innerHTML\s*=\s*(['"])([\s\S]*?)\1\s*;?\s*$/);
  if (!assignment) throw new InvalidWidgetError('Taksit tablosu doğrulanamadı.');
  const programs = [];
  let singlePayment = false;
  const groups = assignment[2].split(/<div class="taksit-tablosu-wrapper">/i).slice(1);
  for (const group of groups) {
    const id = group.match(/<img\b[^>]*\balt="([a-z0-9]+)"/i)?.[1].toLowerCase();
    if (!Object.hasOwn(cardNames, id) || programs.some((program) => program.id === id)) continue;

    const plans = [];
    const rows = group.split(/<div class="taksit-tutar-wrapper">/i).slice(1);
    for (const row of rows) {
      const values = Array.from(row.matchAll(/<div class="taksit-tutari(?: [^"]*)?">([^<]*)<\/div>/gi), (match) => match[1]);
      if (values.length !== 2) continue;
      const installment = values[0].trim().match(/^(\d{1,2})\s*[x×]\s*(.+)$/i);
      if (!installment) continue;
      const months = Number(installment[1]);
      const monthly = moneyInKurus(installment[2]);
      const total = moneyInKurus(values[1]);
      if (months < 1 || months > 36 || monthly === null || total === null || monthly <= 0 || total <= 0) continue;
      if (months === 1) {
        singlePayment = true;
        continue;
      }
      if (plans.some((plan) => plan.months === months)) continue;
      plans.push({ months, monthly, total });
    }

    if (plans.length) {
      programs.push({
        id,
        name: cardNames[id],
        plans,
      });
    }
  }
  if (!programs.length && !singlePayment) throw new InvalidWidgetError('Taksit tablosu doğrulanamadı.');
  return programs;
}

function rejectedConfig(error) {
  return error.status === 401 || error.status === 403 || error instanceof InvalidWidgetError;
}

async function fetchPrograms(current, amount) {
  if (Date.now() < widgetRetryAt) throw new UpstreamError(429, widgetRetryAt);
  const url = new URL(paytrWidget);
  url.search = new URLSearchParams({
    token: current.token,
    merchant_id: current.merchant,
    amount: (amount / 100).toFixed(2),
    taksit: '0',
    tumu: '0',
  });
  try {
    const programs = parsePrograms(await fetchText(url, 100_000));
    if (config === current) lastKnownConfig = current;
    return programs;
  } catch (error) {
    if (error.status === 429) widgetRetryAt = Math.max(widgetRetryAt, error.retryAt);
    if (rejectedConfig(error) && config === current) config = undefined;
    if ((error.status === 401 || error.status === 403)
      && lastKnownConfig?.token === current.token && lastKnownConfig.merchant === current.merchant) {
      lastKnownConfig = undefined;
    }
    throw error;
  }
}

async function loadPrograms(amount) {
  const before = config;
  const current = await getConfig();
  try {
    return await fetchPrograms(current, amount);
  } catch (error) {
    if (canRetry(error)) return fetchPrograms(current, amount);
    // A fresh storefront read would yield the same credentials. Only refresh a previously loaded configuration.
    if (rejectedConfig(error) && current === before) return fetchPrograms(await getConfig(), amount);
    throw error;
  }
}

async function getQuote(amount) {
  const saved = quotes.get(amount);
  if (saved && Date.now() < saved.expiresAt) return saved;
  if (pendingQuotes.has(amount)) return pendingQuotes.get(amount);
  if (pendingQuotes.size >= maxPendingQuotes) return null;

  const pending = loadPrograms(amount).then((programs) => {
    const quote = { data: { amount, currency: 'TRY', programs }, expiresAt: Date.now() + quoteLifetime };
    quotes.delete(amount);
    if (quotes.size >= maxCachedQuotes) quotes.delete(quotes.keys().next().value);
    quotes.set(amount, quote);
    return quote;
  }).finally(() => pendingQuotes.delete(amount));
  pendingQuotes.set(amount, pending);
  return pending;
}

module.exports = async (request, response) => {
  const send = (status, data, expiresAt) => {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (status === 200) {
      const freshness = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      response.setHeader('Cache-Control', `public, max-age=${Math.min(60, freshness)}`);
      response.setHeader('Vercel-CDN-Cache-Control', `public, s-maxage=${freshness}`);
    } else {
      response.setHeader('Cache-Control', 'no-store');
    }
    return response.end(JSON.stringify(data));
  };
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return send(405, { error: 'Bu istek yöntemi desteklenmiyor.' });
  }
  const params = new URL(request.url, 'http://localhost').searchParams;
  const amount = params.get('amount') || '';
  if (params.size !== 1 || !/^[1-9]\d{0,8}$/.test(amount)) {
    return send(400, { error: 'Geçerli bir TL tutarı seçin.' });
  }
  try {
    const quote = await getQuote(Number(amount));
    if (!quote) {
      response.setHeader('Retry-After', '1');
      return send(503, { error: 'Taksit tablosu yoğun. Biraz sonra tekrar deneyin.' });
    }
    return send(200, quote.data, quote.expiresAt);
  } catch (error) {
    if (error.status === 429) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000))));
      return send(503, { error: 'Taksit tablosu yoğun. Biraz sonra tekrar deneyin.' });
    }
    return send(502, { error: 'Mağazanın taksit seçenekleri şu anda alınamadı.' });
  }
};
