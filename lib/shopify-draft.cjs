const { createHash } = require('node:crypto');
const { ShopifyError } = require('./shopify-admin.cjs');
const { Conflict } = require('./shopify-snapshot.cjs');
const { catalogInfo, pricePage, rulePage } = require('./shopify-catalog.cjs');

class RequestError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
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
  const contact = body.contact ?? {};
  const person = { company: text(contact.company, 160), name: text(contact.name, 120), email: text(contact.email, 254), phone: text(contact.phone ?? '', 40, false) };
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
  const info = await catalogInfo(client, catalogId);
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

function createDraftService({ client, catalogId, repository, getOffers = liveOffers, now = Date.now }) {
  async function previous(record, hash, key) {
    if (record.value.hash !== hash) fail(409, 'request_conflict', 'Bu talep kodu başka bir içerik için kullanılmış.');
    if (record.value.status === 'created') return { status: 200, ...record.value.result };
    if (record.value.status === 'rejected') return { status: 422, error: record.value.message, code: 'draft_rejected', safeToEdit: true };
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
    return { status: 202, code: 'pending', error: 'Talebiniz işleniyor. Biraz sonra durumunu kontrol edin.' };
  }
  async function limit(ip) {
    const key = `request-rate-${digest(ip || 'unknown').slice(0, 24)}-${Math.floor(now() / 600000)}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const record = await repository.read(key); const count = record?.value.count ?? 0;
      if (count >= 10) fail(429, 'rate_limited', 'Çok sayıda talep denemesi yapıldı. Birkaç dakika sonra yeniden deneyin.');
      try { await repository.write(key, { count: count + 1 }, record?.revision ?? null); return; }
      catch (error) { if (!(error instanceof Conflict)) throw error; }
    }
    fail(429, 'rate_limited', 'Biraz sonra yeniden deneyin.');
  }
  return { async submit(body, ip) {
    const request = normalizeRequest(body); const hash = digest(JSON.stringify(request)); const key = `request-${request.requestId}`;
    const existing = await repository.read(key);
    if (existing) return previous(existing, hash, key);
    await limit(ip);
    const input = draftInput(request, await getOffers(client, catalogId, request.items));
    const pending = { hash, status: 'pending', startedAt: now() };
    try { await repository.write(key, pending, null); }
    catch (error) { if (!(error instanceof Conflict)) throw error; return previous(await repository.read(key), hash, key); }
    // Once a durable intent exists, no execution of this request ID may create again.
    let draft;
    try { draft = await client.createDraftOrder(input); }
    catch (error) {
      const safe = error instanceof ShopifyError && ['access_denied', 'authentication_failed', 'shopify_unavailable', 'rate_limited', 'draft_rejected'].includes(error.code);
      try {
        const record = await repository.read(key);
        await repository.write(key, { ...pending, status: safe ? 'rejected' : 'unknown', message: safe ? error.message : undefined }, record.revision);
      } catch { /* The original pending intent still prevents duplicate creation. */ }
      if (safe) return { status: 422, code: 'draft_rejected', error: error.message, safeToEdit: true };
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
