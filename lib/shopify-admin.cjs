// Server only. Never import this module into public/.
const API_VERSION = '2026-10';
const ENV_KEYS = ['SHOPIFY_SHOP', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET', 'SHOPIFY_CATALOG_ID'];

class ShopifyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function configuration(env = process.env) {
  const missing = ENV_KEYS.filter((key) => !env[key]?.trim());
  if (missing.length) throw new ShopifyError('configuration_missing', 'Shopify bağlantı ayarları eksik.');
  const shop = env.SHOPIFY_SHOP.trim().toLowerCase();
  const catalogId = env.SHOPIFY_CATALOG_ID.trim();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !/^[1-9]\d*$/.test(catalogId)) {
    throw new ShopifyError('configuration_invalid', 'Shopify mağaza adresi veya katalog kimliği geçersiz.');
  }
  return { shop, catalogId, clientId: env.SHOPIFY_CLIENT_ID.trim(), secret: env.SHOPIFY_CLIENT_SECRET.trim() };
}

function createShopifyClient(config, { fetchImpl = fetch, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let token;
  let tokenPending;
  async function authenticate() {
    if (token && now() < token.expiresAt) return token.value;
    if (!tokenPending) {
      tokenPending = (async () => {
        let response;
        try {
          response = await fetchImpl(`https://${config.shop}/admin/oauth/access_token`, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.secret }),
          });
        } catch {
          throw new ShopifyError('shopify_unavailable', 'Shopify bağlantısı kurulamadı.');
        }
        if (!response.ok) {
          // Shopify errors may contain credentials. Do not return or log the raw body.
          throw new ShopifyError('authentication_failed', 'Shopify uygulaması doğrulanamadı. Anahtarları ve mağazaya kurulumu kontrol edin.');
        }
        let body;
        try { body = await response.json(); } catch { /* handled below */ }
        if (typeof body?.access_token !== 'string' || !body.access_token || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
          throw new ShopifyError('authentication_failed', 'Shopify erişim yanıtı doğrulanamadı.');
        }
        const lifetime = Math.max(0, body.expires_in * 1000 - 60000);
        token = { value: body.access_token, expiresAt: now() + lifetime };
        return token.value;
      })().finally(() => { tokenPending = undefined; });
    }
    return tokenPending;
  }

  let queue = Promise.resolve();
  let budget;
  const costs = new Map();
  function serialized(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  function rememberCost(body, document) {
    const cost = body?.extensions?.cost;
    const status = cost?.throttleStatus;
    if (Number.isFinite(cost?.requestedQueryCost)) costs.set(document, cost.requestedQueryCost);
    if (Number.isFinite(status?.currentlyAvailable) && status.currentlyAvailable >= 0
      && Number.isFinite(status.restoreRate) && status.restoreRate > 0 && Number.isFinite(status.maximumAvailable)) {
      budget = { available: status.currentlyAvailable, rate: status.restoreRate, maximum: status.maximumAvailable, at: now() };
    }
  }
  function budgetWait(document) {
    if (!budget) return 0;
    const required = Math.min(budget.maximum, (costs.get(document) ?? 10) + 30);
    const available = Math.min(budget.maximum, budget.available + (now() - budget.at) * budget.rate / 1000);
    return Math.max(0, Math.ceil((required - available) / budget.rate * 1000));
  }
  const limited = () => {
    const error = new ShopifyError('rate_limited', 'Shopify şu anda yoğun. Talep gönderilmedi; kısa bir süre sonra yeniden deneyin.');
    error.retryAfter = 3;
    return error;
  };
  async function execute(document, variables, write) {
    const deadline = now() + 45000;
    let throttles = 0; let renewed = false;
    for (;;) {
      const wait = budgetWait(document);
      if (wait) {
        if (now() + wait > deadline) throw limited();
        await pause(wait + 50);
      }
      const accessToken = await authenticate();
      let response;
      try {
        response = await fetchImpl(`https://${config.shop}/admin/api/${API_VERSION}/graphql.json`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(write ? 25000 : 15000),
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': accessToken },
          body: JSON.stringify({ query: document, variables }),
        });
      } catch {
        throw new ShopifyError(write ? 'mutation_uncertain' : 'shopify_unavailable', write
          ? 'Talebin Shopify sonucu henüz doğrulanamadı.' : 'Shopify bağlantısı kurulamadı.');
      }
      if ((response.status === 401 || (write && response.status === 403)) && !renewed) {
        if (token?.value === accessToken) token = undefined;
        renewed = true; continue;
      }
      if (response.status === 401 || response.status === 403) throw new ShopifyError(write ? 'draft_access_denied' : 'access_denied', write
        ? 'Shopify uygulamasında write_draft_orders yetkisi bulunmuyor veya mağaza izni eksik.' : 'Shopify erişim izni bulunamadı.');
      let body;
      try { body = await response.json(); } catch { /* handled below */ }
      rememberCost(body, document);
      const payload = body?.data?.draftOrderCreate;
      // A created draft wins over partial errors; it must never be written again.
      if (write && payload?.draftOrder?.id && payload.draftOrder.name) return payload.draftOrder;
      const codes = body?.errors?.map(error => error.extensions?.code) ?? [];
      if (response.status === 429 || (codes.includes('THROTTLED') && (!write || !body?.data))) {
        // Shopify explicitly rejected the operation before execution. Only this
        // kind of write failure is safe to retry; never retry a timeout/5xx write.
        const header = response.headers.get('Retry-After');
        const retry = /^\d+(?:\.\d+)?$/.test(header ?? '') ? Number(header) * 1000 : 0;
        const delay = Math.max(500, retry, budgetWait(document), Math.min(5000, 750 * 2 ** throttles)) + 100;
        if (++throttles > 6 || now() + delay > deadline) throw limited();
        await pause(delay); continue;
      }
      if (codes.includes('ACCESS_DENIED')) throw new ShopifyError(write ? 'draft_access_denied' : 'access_denied', write
        ? 'Shopify taslak sipariş veya iletişim verisi erişimi eksik. Uygulama izinlerini kontrol edin.' : 'Shopify katalog okuma izinleri eksik.');
      if (write) {
        if (payload?.userErrors?.length || (response.status === 400 && body?.errors?.length)
          || codes.some(code => ['GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'MAX_COST_EXCEEDED'].includes(code))) {
          throw new ShopifyError('draft_rejected', 'Shopify talebi kabul etmedi. Ürünleri ve iletişim bilgilerini kontrol edin.');
        }
        throw new ShopifyError('mutation_uncertain', 'Talebin Shopify sonucu henüz doğrulanamadı.');
      }
      if (!response.ok) throw new ShopifyError('shopify_unavailable', 'Shopify verisi okunamadı.');
      if (body?.errors?.length || !body?.data) throw new ShopifyError('query_failed', 'Shopify katalog sorgusu tamamlanamadı.');
      return body.data;
    }
  }
  function query(document, variables = {}) {
    if (!/^\s*query\b/.test(document)) return Promise.reject(new ShopifyError('query_invalid', 'Yalnızca okuma sorguları destekleniyor.'));
    return serialized(() => execute(document, variables, false));
  }
  function createDraftOrder(input) {
    const document = `mutation CatalogRequest($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) { draftOrder { id name } userErrors { field message } }
    }`;
    return serialized(() => execute(document, { input }, true));
  }

  return { query, createDraftOrder };
}

const CHECK_QUERY = `query CatalogConnectionCheck($query: String!) {
  currentAppInstallation { accessScopes { handle } }
  catalogs(first: 2, query: $query) {
    nodes {
      id title status
      publication { id }
      priceList { id currency }
    }
  }
}`;

async function checkConnection(client, catalogId) {
  const data = await client.query(CHECK_QUERY, { query: `id:${catalogId}` });
  const candidates = data.catalogs?.nodes;
  const catalog = Array.isArray(candidates)
    ? candidates.find((item) => item.id?.split('/').at(-1) === catalogId) : null;
  if (!catalog) throw new ShopifyError('catalog_not_found', 'Seçilen Shopify kataloğu bulunamadı veya okuma izni yok.');
  if (catalog.status !== 'ACTIVE') throw new ShopifyError('catalog_inactive', 'Seçilen Shopify kataloğu etkin değil.');
  const scopes = new Set(data.currentAppInstallation?.accessScopes?.map(({ handle }) => handle));
  const canRead = (key) => scopes.has(`read_${key}`) || scopes.has(`write_${key}`);
  if (!canRead('products') || !canRead('publications')) {
    throw new ShopifyError('access_denied', 'Shopify ürün ve katalog yayınlarını okuma izinleri eksik.');
  }
  return {
    connected: true,
    catalog: { id: catalogId, title: catalog.title, status: catalog.status, currency: catalog.priceList?.currency ?? null },
    capabilities: {
      prices: Boolean(catalog.priceList),
      publication: Boolean(catalog.publication),
      companies: canRead('companies'),
      createDraftOrder: scopes.has('write_draft_orders'),
    },
  };
}

let shared;
function shopifyClient() {
  const config = configuration();
  if (!shared || ENV_KEYS.some((key) => shared.env[key] !== process.env[key])) {
    shared = { env: Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])), client: createShopifyClient(config) };
  }
  return { client: shared.client, catalogId: config.catalogId };
}

module.exports = { ShopifyError, configuration, createShopifyClient, checkConnection, shopifyClient };
