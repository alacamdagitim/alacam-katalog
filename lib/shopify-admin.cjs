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

function createShopifyClient(config, { fetchImpl = fetch, now = Date.now } = {}) {
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

  async function query(document, variables = {}) {
    // This client is deliberately read-only. Draft mutations need a separate,
    // validated submission path, never a browser-supplied GraphQL document.
    if (!/^\s*query\b/.test(document)) throw new ShopifyError('query_invalid', 'Yalnızca okuma sorguları destekleniyor.');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const accessToken = await authenticate();
      let response;
      try {
        response = await fetchImpl(`https://${config.shop}/admin/api/${API_VERSION}/graphql.json`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': accessToken },
          body: JSON.stringify({ query: document, variables }),
        });
      } catch {
        throw new ShopifyError('shopify_unavailable', 'Shopify verisi okunamadı.');
      }
      if (response.status === 401 && attempt === 0) {
        if (token?.value === accessToken) token = undefined;
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new ShopifyError('access_denied', 'Shopify erişim izni bulunamadı.');
      if (response.status === 429) throw new ShopifyError('rate_limited', 'Shopify istek sınırına ulaşıldı. Biraz sonra yeniden deneyin.');
      if (!response.ok) throw new ShopifyError('shopify_unavailable', 'Shopify verisi okunamadı.');
      let body;
      try { body = await response.json(); } catch { /* handled below */ }
      if (body?.errors?.length) {
        const codes = body.errors.map((error) => error.extensions?.code);
        if (codes.includes('ACCESS_DENIED')) throw new ShopifyError('access_denied', 'Shopify katalog okuma izinleri eksik.');
        if (codes.includes('THROTTLED')) throw new ShopifyError('rate_limited', 'Shopify istek sınırına ulaşıldı. Biraz sonra yeniden deneyin.');
        throw new ShopifyError('query_failed', 'Shopify katalog sorgusu tamamlanamadı.');
      }
      if (!body?.data) throw new ShopifyError('query_failed', 'Shopify katalog yanıtı doğrulanamadı.');
      return body.data;
    }
    throw new ShopifyError('access_denied', 'Shopify erişim izni bulunamadı.');
  }
  return { query };
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
