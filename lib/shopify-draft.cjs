const { createHash } = require('node:crypto');
const { ShopifyError } = require('./shopify-admin.cjs');
const { Conflict } = require('./shopify-snapshot.cjs');
const { catalogInfo, pricePage, rulePage } = require('./shopify-catalog.cjs');

const { createRequestGuard, RequestError } = require('./request-guard.cjs');
const fail = (status, code, message) => { throw new RequestError(status, code, message); };
const digest = value => createHash('sha256').update(value).digest('hex');
function text(value, max, required = true) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(400, 'invalid_request', 'Firma ve iletişim bilgilerini kontrol edin.');
  const result = value.trim();
  if (required && !result) fail(400, 'invalid_request', 'Firma ve iletişim bilgilerini doldurun.');
  return result;
}
function normalizeRequest(body) {
  if (!body || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) fail(400, 'invalid_request', 'Talep kodu geçersiz.');
  if (body.website != null && (typeof body.website !== 'string' || body.website.trim())) fail(400, 'invalid_request', 'Talep gönderilemedi. Sayfayı yenileyip tekrar deneyin.');
  const contact = body.contact ?? {};
  const fullName = contact.firstName != null || contact.lastName != null
    ? `${text(contact.firstName, 80)} ${text(contact.lastName, 80)}` : text(contact.name, 120);
  const person = { company: text(contact.company, 160), name: fullName, email: text(contact.email, 254), phone: text(contact.phone ?? '', 40, false) };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email) || /[\r\n]/.test(Object.values(person).join(''))) fail(400, 'invalid_request', 'Geçerli firma ve e-posta bilgileri girin.');
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) fail(400, 'invalid_request', 'Bir talebe 1–50 farklı ürün ekleyebilirsiniz.');
  const ids = new Set();
  const items = body.items.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[1-9]\d{0,19}$/.test(item.id) || ids.has(item.id)
      || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 2147483647
      || !Number.isSafeInteger(item.unitCents) || item.unitCents < 0) fail(400, 'invalid_request', 'Ürün veya miktar bilgileri geçersiz.');
    ids.add(item.id);
    return { id: item.id, quantity: item.quantity, unitCents: item.unitCents };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { requestId: body.requestId.toLowerCase(), contact: person, note: text(body.note ?? '', 500, false), items };
}

// Only selected variants are read again on submission; no full product scan.
async function liveOffers(client, catalogId, items) {
  const info = await catalogInfo(client, catalogId, { requireDraftAccess: true });
  const ids = items.map(item => item.id);
  const selected = new Set(ids);
  const variantsTask = client.query(`query RequestVariants($ids: [ID!]!, $publication: ID!) {
    nodes(ids: $ids) { ... on ProductVariant { id availableForSale
      publishedOnPublication(publicationId: $publication) product { status } } }
  }`, { ids: ids.map(id => `gid://shopify/ProductVariant/${id}`), publication: info.publication });
  const pricesTask = (async () => {
    const prices = new Map(); let after = null; const seen = new Set();
    do {
      const page = await pricePage(client, info, after, [], ids);
      for (const entry of page.prices) {
        if (!selected.has(entry.id)) continue;
        if (prices.has(entry.id)) throw new Error('Duplicate price');
        prices.set(entry.id, entry);
      }
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
      if (seen.has(after) || seen.size > 100) throw new Error('Invalid price pagination');
      seen.add(after);
    } while (true);
    return prices;
  })();
  const rulesTask = (async () => {
    const rules = new Map(); let after = null; const seen = new Set();
    do {
      const page = await rulePage(client, info, after);
      for (const rule of page.rules) {
        if (!selected.has(rule.id)) continue;
        if (rules.has(rule.id)) throw new Error('Duplicate rule');
        rules.set(rule.id, rule);
      }
      if (!page.pageInfo.hasNextPage || rules.size === ids.length) break;
      after = page.pageInfo.endCursor;
      if (seen.has(after) || seen.size > 2000) throw new Error('Invalid rule pagination');
      seen.add(after);
    } while (true);
    return rules;
  })();
  const [data, prices, rules] = await Promise.all([variantsTask, pricesTask, rulesTask]);
  const variants = new Map((data.nodes ?? []).filter(Boolean).map(v => [v.id.split('/').at(-1), v]));
  return { info, prices, rules, variants };
}

function draftInput(request, offers) {
  const { info, prices, rules, variants } = offers;
  const lineItems = request.items.map(item => {
    const variant = variants.get(item.id); const price = prices.get(item.id); const rule = rules.get(item.id);
    if (!variant || variant.product?.status !== 'ACTIVE' || variant.publishedOnPublication !== true || !price || !rule) fail(409, 'catalog_changed', 'Bir ürün artık Toptan Katalog’da bulunmuyor. Kataloğu yenileyip talebi kontrol edin.');
    if (variant.availableForSale !== true) fail(409, 'unavailable', 'Bir ürün tükendi. Talepteki ürünleri kontrol edin.');
    if (!Number.isSafeInteger(rule.minimum) || !Number.isSafeInteger(rule.increment) || rule.minimum < 1 || rule.increment < 1
      || (rule.maximum != null && (!Number.isSafeInteger(rule.maximum) || rule.maximum < rule.minimum))) throw new Error('Invalid quantity rule');
    if (item.quantity < rule.minimum || (item.quantity - rule.minimum) % rule.increment !== 0 || (rule.maximum != null && item.quantity > rule.maximum)) fail(409, 'quantity_changed', `Koli kuralına göre en az ${rule.minimum} adet, ${rule.increment} adetlik artışlarla talep oluşturabilirsiniz.`);
    let unit = price.price;
    for (const tier of [...price.tiers].sort((a, b) => a.quantity - b.quantity)) {
      if (!Number.isSafeInteger(tier.quantity) || tier.quantity < 1 || !Number.isFinite(tier.price) || tier.price < 0) throw new Error('Invalid tier');
      if (tier.quantity <= item.quantity) unit = tier.price;
    }
    const cents = Math.round(unit * 100);
    if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('Invalid price');
    if (cents !== item.unitCents) fail(409, 'price_changed', 'Toptan Katalog fiyatı değişti. Kataloğu yenileyip güncel toplamı kontrol ederek tekrar gönderin.');
    return { variantId: variant.id, quantity: item.quantity,
      priceOverride: { amount: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`, currencyCode: 'TRY' } };
  });
  const { contact, requestId } = request;
  // A public form's email does not authenticate a Shopify customer/company.
  // Keep identity on the draft as supplied contact information only.
  return {
    lineItems, email: contact.email, presentmentCurrencyCode: 'TRY',
    acceptAutomaticDiscounts: false, allowDiscountCodesInCheckout: false,
    tags: ['Dijital Katalog', 'Sipariş Talebi', `talep-${requestId}`],
    note: [`Dijital Katalog sipariş talebi`, `Firma: ${contact.company}`, `Yetkili: ${contact.name}`,
      `E-posta: ${contact.email}`, contact.phone && `Telefon: ${contact.phone}`,
      `Katalog: ${info.title} (${info.id})`, `Talep kodu: ${requestId}`, request.note && `Talep notu: ${request.note}`].filter(Boolean).join('\n'),
    customAttributes: [{ key: 'talep_kodu', value: requestId }, { key: 'katalog_id', value: info.id },
      { key: 'firma', value: contact.company }, { key: 'yetkili', value: contact.name }, { key: 'telefon', value: contact.phone }],
  };
}

function createDraftService({ client, catalogId, repository, getOffers = liveOffers, now = Date.now, guard = createRequestGuard({ repository, now }) }) {
  async function previous(record, hash, key) {
    if (record.value.hash !== hash) fail(409, 'request_conflict', 'Bu talep kodu başka bir içerik için kullanılmış.');
    if (record.value.status === 'created') return { status: 200, ...record.value.result };
    if (record.value.alias) {
      const originalKey = `request-${record.value.alias.id}`;
      const original = await repository.read(originalKey);
      if (!original || original.value.alias) return { status: 202, code: 'pending' };
      const answer = await previous(original, record.value.alias.hash, originalKey);
      if (!answer.created) return answer;
      const result = { created: true, name: answer.name, requestId: key.slice(8), duplicate: true };
      await repository.write(key, { ...record.value, status: 'created', result }, record.revision).catch(() => {});
      return { status: 200, ...result };
    }
    if (record.value.status === 'rejected') return { status: record.value.httpStatus ?? 422, error: record.value.message, code: record.value.code ?? 'draft_rejected', safeToEdit: true };
    // A timeout can occur after Shopify created the draft. Reconcile by its unique tag.
    if (record.value.status === 'unknown' || now() - record.value.startedAt > 30000) {
      let data;
      try { data = await client.query(`query FindCatalogRequest($query: String!) {
        draftOrders(first: 2, query: $query) { nodes { id name customAttributes { key value } } }
      }`, { query: `tag:talep-${key.slice(8)}` }); } catch { data = null; }
      const drafts = data?.draftOrders?.nodes?.filter(draft => draft.customAttributes?.some(a => a.key === 'talep_kodu' && a.value === key.slice(8))) ?? [];
      if (drafts.length === 1) {
        const result = { created: true, name: drafts[0].name, requestId: key.slice(8) };
        await repository.write(key, { ...record.value, status: 'created', result }, record.revision).catch(() => {});
        return { status: 200, ...result };
      }
      return { status: 409, code: 'outcome_unknown', error: 'Talebin sonucu henüz doğrulanamadı. Talep kodunu ileterek bizimle iletişime geçin; tekrar talep oluşturmayın.', requestId: key.slice(8) };
    }
    return { status: 202, code: 'pending', error: 'Talebiniz gönderiliyor…' };
  }
  async function claimContent(key, requestId, hash) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const saved = await repository.read(key);
      if (saved?.value.until > now() && saved.value.id !== requestId) {
        const original = await repository.read(`request-${saved.value.id}`);
        if (original?.value.status !== 'rejected') return saved.value;
      }
      try {
        await repository.write(key, { id: requestId, hash, until: now() + 5 * 60000 }, saved?.revision ?? null);
        return null;
      } catch (error) { if (!(error instanceof Conflict)) throw error; }
    }
    throw new RequestError(429, 'request_rate_limited', 'Talep sistemi yoğun. Biraz sonra yeniden deneyin.', 2);
  }
  return { async submit(body, ip) {
    const request = normalizeRequest(body); const hash = digest(JSON.stringify(request)); const key = `request-${request.requestId}`;
    const existing = await repository.read(key);
    if (existing) return previous(existing, hash, key);
    try { await guard.take(ip, request.contact.email); }
    catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(503, 'guard_unavailable', 'Talep gönderimi geçici olarak kullanılamıyor. Biraz sonra yeniden deneyin.', 30);
    }
    let input;
    try { input = draftInput(request, await getOffers(client, catalogId, request.items)); }
    catch (error) {
      // No durable intent or mutation exists yet. Failure here cannot mean a
      // draft was created, including Shopify throttling during price checks.
      if (error instanceof ShopifyError) return { status: error.code === 'rate_limited' ? 429 : error.code.endsWith('access_denied') ? 403 : 503,
        code: error.code, error: error.message, safeToEdit: true, retryAfter: error.retryAfter };
      if (error instanceof RequestError) throw error;
      return { status: 503, code: 'prepare_failed', error: 'Talep henüz gönderilemedi. Biraz sonra yeniden deneyin.', safeToEdit: true };
    }
    const pending = { hash, status: 'pending', startedAt: now() };
    try { await repository.write(key, pending, null); }
    catch (error) { if (!(error instanceof Conflict)) throw error; return previous(await repository.read(key), hash, key); }
    // Once a durable intent exists, no execution of this request ID may create again.
    let draft; let mutationStarted = false;
    try {
      const contentKey = guard.contentKey(request);
      const original = await claimContent(contentKey, request.requestId, hash);
      if (original) {
        const record = await repository.read(key);
        await repository.write(key, { ...pending, alias: { id: original.id, hash: original.hash } }, record.revision);
        return previous(await repository.read(key), hash, key);
      }
      mutationStarted = true;
      draft = await client.createDraftOrder(input);
    }
    catch (error) {
      const safe = !mutationStarted || error instanceof ShopifyError && ['draft_access_denied', 'access_denied', 'authentication_failed', 'shopify_unavailable', 'rate_limited', 'draft_rejected'].includes(error.code);
      const httpStatus = error instanceof RequestError ? error.status : !mutationStarted ? 503 : error.code === 'rate_limited' ? 429 : error.code?.endsWith('access_denied') ? 403 : 422;
      const message = error instanceof ShopifyError || error instanceof RequestError ? error.message : 'Talep gönderilemedi. Biraz sonra yeniden deneyin.';
      try {
        const record = await repository.read(key);
        await repository.write(key, { ...pending, status: safe ? 'rejected' : 'unknown', message: safe ? message : undefined,
          ...(safe ? { code: error.code ?? 'request_unavailable', httpStatus } : {}) }, record.revision);
      } catch { /* The original pending intent still prevents duplicate creation. */ }
      if (safe) return { status: httpStatus, code: error.code ?? 'request_unavailable', error: message, safeToEdit: true };
      return { status: 409, code: 'outcome_unknown', error: 'Talebin sonucu henüz doğrulanamadı. Durumunu kontrol edin; tekrar talep oluşturmayın.', requestId: request.requestId };
    }
    const result = { created: true, name: draft.name, requestId: request.requestId };
    try {
      const record = await repository.read(key);
      await repository.write(key, { ...pending, status: 'created', result }, record.revision);
    } catch { /* A subsequent retry reconciles using the draft's unique tag. */ }
    return { status: 201, ...result };
  } };
}
module.exports = { RequestError, normalizeRequest, liveOffers, draftInput, createDraftService };
