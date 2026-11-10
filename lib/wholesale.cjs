const { createHash, randomUUID } = require('node:crypto');
const { readFile, rename, unlink, writeFile } = require('node:fs/promises');
const { isAbsolute } = require('node:path');

const blobPath = 'catalog/wholesale-v1.json';
const storageTimeout = 8000;
let snapshotIndex;
let localWritePending = false;

function indexSnapshot({ wholesaleHandle, wholesaleOptionKey }) {
  if (snapshotIndex) return snapshotIndex;
  const { rows } = require('../public/catalog-data.json');
  const handles = new Map();
  const allVariants = new Set();
  for (const row of rows) {
    const handle = wholesaleHandle(row.handle);
    if (!handles.has(handle)) handles.set(handle, { byOption: new Map(), ids: new Set() });
    const { byOption, ids } = handles.get(handle);
    for (const variant of row.variants?.length ? row.variants : [null]) {
      const id = String(variant?.id ?? row.id);
      allVariants.add(id);
      ids.add(id);
      const options = (row.traitOptions ?? []).map(({ name, value, position }) => ({ name, value, position }));
      const saleValue = variant?.optionValue ?? (id === String(row.id) ? row.saleOptionValue : null);
      if (row.saleOptionName && !saleValue) continue;
      if (row.saleOptionName) options.push({ name: row.saleOptionName, value: saleValue, position: row.saleOptionPosition });
      const pairs = options.sort((left, right) => left.position - right.position)
        .map(({ name, value }) => [name, value]);
      const key = wholesaleOptionKey(pairs.length ? pairs : [['Title', 'Default Title']]);
      // A tuple with different IDs must not be guessed, even if one is currently in stock.
      if (!byOption.has(key)) byOption.set(key, id);
      else if (byOption.get(key) !== id) byOption.set(key, null);
    }
  }
  snapshotIndex = { handles, totalVariants: allVariants.size };
  return snapshotIndex;
}

function variantFields({ sku, price, compareAt, minimum, increment, maximum, tiers }) {
  return { sku, price, compareAt, minimum, increment, maximum, tiers: tiers?.map(({ quantity, price }) => ({ quantity, price })) };
}

function comparableVariant(variant) {
  const fields = variantFields(variant);
  fields.tiers = fields.tiers?.length ? fields.tiers.sort((left, right) => left.quantity - right.quantity) : undefined;
  return JSON.stringify(fields);
}

function publicationChanges(previousProducts, products) {
  const changes = { added: 0, updated: 0, preserved: 0, removed: 0 };
  for (const [handle, { variants }] of Object.entries(products)) {
    const previous = Object.hasOwn(previousProducts, handle) ? previousProducts[handle].variants : null;
    for (const [id, variant] of Object.entries(variants)) {
      if (!previous || !Object.hasOwn(previous, id)) changes.added += 1;
      else if (previous[id] === variant || comparableVariant(previous[id]) === comparableVariant(variant)) changes.preserved += 1;
      else changes.updated += 1;
    }
  }
  for (const [handle, { variants }] of Object.entries(previousProducts)) {
    const current = products[handle]?.variants;
    for (const id of Object.keys(variants)) {
      if (!current || !Object.hasOwn(current, id)) changes.removed += 1;
    }
  }
  return changes;
}

function matchWholesaleCatalog(catalog, parser, { mode = 'replace', previousProducts = null } = {}) {
  if (mode !== 'replace' && mode !== 'merge') throw new Error('Invalid wholesale publication mode');
  const { handles, totalVariants } = indexSnapshot(parser);
  const previous = previousProducts ?? {};
  const products = Object.create(null);
  if (mode === 'merge') {
    for (const [handle, { variants }] of Object.entries(previous)) {
      if (Object.keys(variants).length) products[handle] = { variants: Object.assign(Object.create(null), variants) };
    }
  }
  const stats = {
    matchedProducts: 0, matchedVariants: 0, unmatchedProducts: 0, unmatchedVariants: 0,
    hiddenProducts: 0, hiddenVariants: 0, visibleProducts: 0, visibleVariants: 0,
  };
  for (const [handle, product] of Object.entries(catalog.products)) {
    const known = handles.get(handle)?.byOption;
    const entries = Object.entries(product.variants);
    if (!known) {
      stats.unmatchedProducts += 1;
      stats.unmatchedVariants += entries.length;
      continue;
    }
    const variants = products[handle]?.variants ?? Object.create(null);
    let matched = false;
    for (const [key, variant] of entries) {
      const id = known.get(key);
      if (!id) {
        stats.unmatchedVariants += 1;
        continue;
      }
      matched = true;
      stats.matchedVariants += 1;
      if (product.published === false) continue;
      if (variant.published === false) delete variants[id];
      else variants[id] = variantFields(variant);
    }
    if (matched) stats.matchedProducts += 1;
    else stats.unmatchedProducts += 1;
    if ((matched && product.published === false) || !Object.keys(variants).length) delete products[handle];
    else products[handle] = { variants };
  }

  const visibleIds = new Set();
  for (const [handle, { variants }] of Object.entries(products)) {
    const knownIds = handles.get(handle)?.ids;
    if (!knownIds) continue;
    const ids = Object.keys(variants).filter((id) => knownIds.has(id));
    if (ids.length) stats.visibleProducts += 1;
    for (const id of ids) visibleIds.add(id);
  }
  stats.visibleVariants = visibleIds.size;
  stats.hiddenProducts = handles.size - stats.visibleProducts;
  stats.hiddenVariants = totalVariants - stats.visibleVariants;
  return { products, stats, changes: publicationChanges(previous, products) };
}

function wholesaleStorage() {
  const localPath = !process.env.VERCEL && process.env.WHOLESALE_LOCAL_FILE;
  if (localPath) {
    if (!isAbsolute(localPath)) throw new Error('Invalid wholesale storage path');
    return { localPath };
  }
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) return { token };
  const storeId = process.env.BLOB_STORE_ID?.trim();
  if (storeId) return { storeId };
  return null;
}

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPrice = (value) => Number.isFinite(value) && value >= 0;
const validQuantity = (value) => Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;

function validStoredVariant(variant) {
  if (!record(variant)) return false;
  const { sku, price, compareAt, minimum, increment, maximum, tiers } = variant;
  return (sku === undefined || typeof sku === 'string')
    && [price, compareAt].every((value) => value === undefined || validPrice(value))
    && [minimum, increment, maximum].every((value) => value === undefined || validQuantity(value))
    && (tiers === undefined || (Array.isArray(tiers) && tiers.length <= 10
      && tiers.every((tier) => record(tier) && validQuantity(tier.quantity) && validPrice(tier.price))));
}

function validatePublished(text) {
  const data = JSON.parse(text);
  if (!record(data) || data.schemaVersion !== 1 || typeof data.publishedAt !== 'string'
    || !Number.isFinite(Date.parse(data.publishedAt)) || !record(data.products)) {
    throw new Error('Invalid wholesale publication');
  }
  const products = Object.create(null);
  for (const [handle, product] of Object.entries(data.products)) {
    if (!record(product) || !record(product.variants)) throw new Error('Invalid wholesale publication');
    const variants = Object.create(null);
    for (const [id, variant] of Object.entries(product.variants)) {
      if (!/^\d+$/.test(id) || !validStoredVariant(variant)) throw new Error('Invalid wholesale publication');
      variants[id] = variantFields(variant);
    }
    products[handle] = { variants };
  }
  return { publishedAt: data.publishedAt, products };
}

function wholesaleBlobOptions(storage) {
  if (storage?.token) return { token: storage.token };
  // The SDK resolves the OIDC token from trusted Vercel context or the local CLI environment.
  if (storage?.storeId) return { storeId: storage.storeId };
  throw new Error('Wholesale Blob storage is not configured');
}

function blobReadOptions(storage) {
  return { access: 'private', ...wholesaleBlobOptions(storage), useCache: false, abortSignal: AbortSignal.timeout(storageTimeout) };
}

async function readPrivateWholesaleBlob(storage) {
  const { get, list } = await import('@vercel/blob');
  const result = await get(blobPath, blobReadOptions(storage));
  if (!result) {
    // The CDN returns 404 for absent objects. Verify the configured store is still accessible.
    const listing = await list({ prefix: blobPath, limit: 1, ...wholesaleBlobOptions(storage), abortSignal: AbortSignal.timeout(storageTimeout) });
    if (listing.blobs.some(({ pathname }) => pathname === blobPath)) throw new Error('Wholesale Blob cannot be read');
    return null;
  }
  if (result.statusCode !== 200 || !result.stream || !result.blob.etag) {
    await result.stream?.cancel();
    throw new Error('Wholesale storage is unavailable');
  }
  return { text: await new Response(result.stream).text(), revision: result.blob.etag };
}

async function readLocalWholesale(localPath) {
  try {
    const bytes = await readFile(localPath);
    return { text: bytes.toString('utf8'), revision: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readWholesaleSnapshot(storage) {
  const saved = storage?.localPath ? await readLocalWholesale(storage.localPath)
    : storage ? await readPrivateWholesaleBlob(storage) : null;
  return saved ? { publication: validatePublished(saved.text), revision: saved.revision }
    : { publication: null, revision: null };
}

async function readWholesale(storage) {
  return (await readWholesaleSnapshot(storage)).publication;
}

class WholesaleWriteConflict extends Error {}

async function writeLocal(localPath, text, expectedRevision) {
  if (localWritePending) throw new WholesaleWriteConflict();
  localWritePending = true;
  const temporary = `${localPath}.${randomUUID()}.tmp`;
  try {
    const current = await readLocalWholesale(localPath);
    if ((current?.revision ?? null) !== expectedRevision) throw new WholesaleWriteConflict();
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await rename(temporary, localPath);
  } finally {
    await unlink(temporary).catch(() => {});
    localWritePending = false;
  }
}

async function writeWholesale(storage, publication, expectedRevision) {
  if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !expectedRevision)) {
    throw new Error('Missing wholesale publication revision');
  }
  const text = JSON.stringify({ schemaVersion: 1, ...publication });
  if (storage.localPath) return writeLocal(storage.localPath, text, expectedRevision);
  const { put, BlobError, BlobNotFoundError, BlobPreconditionFailedError } = await import('@vercel/blob');
  const replacing = expectedRevision !== null;
  try {
    await put(blobPath, text, {
      access: 'private', ...wholesaleBlobOptions(storage), contentType: 'application/json',
      addRandomSuffix: false, allowOverwrite: replacing, ifMatch: expectedRevision ?? undefined,
      abortSignal: AbortSignal.timeout(storageTimeout),
    });
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError || (replacing && error instanceof BlobNotFoundError)
      || (!replacing && error instanceof BlobError && /already exists/i.test(error.message))) {
      throw new WholesaleWriteConflict();
    }
    throw error;
  }
}

module.exports = { matchWholesaleCatalog, readWholesale, readWholesaleSnapshot, wholesaleStorage, writeWholesale, WholesaleWriteConflict };
