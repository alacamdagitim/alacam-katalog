const { createHash, randomUUID } = require('node:crypto');
const { readFile, writeFile, rename, mkdir } = require('node:fs/promises');
const path = require('node:path');
const { ShopifyError } = require('./shopify-admin.cjs');
const REFRESH_AFTER = 60000;
class Conflict extends Error {}

function snapshotRepository(catalogId, env = process.env) {
  const prefix = `catalog/shopify-v3/${catalogId}`;
  const local = !env.VERCEL && env.SHOPIFY_CACHE_DIRECTORY;
  if (local && !path.isAbsolute(local)) throw new Error('Shopify cache directory must be absolute');
  const options = env.BLOB_READ_WRITE_TOKEN ? { token: env.BLOB_READ_WRITE_TOKEN }
    : env.BLOB_STORE_ID ? { storeId: env.BLOB_STORE_ID } : null;
  if (!local && !options) throw new ShopifyError('storage_missing', 'Shopify katalog kaydı için sunucu deposu bulunamadı.');
  async function read(key, knownRevision) {
    if (local) {
      try {
        const text = await readFile(path.join(local, `${catalogId}-${key}.json`), 'utf8');
        const revision = createHash('sha256').update(text).digest('hex');
        return knownRevision === revision ? { unchanged: true, revision } : { value: JSON.parse(text), revision };
      } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    const { head, get, list, BlobNotFoundError } = await import('@vercel/blob');
    const args = { ...options, abortSignal: AbortSignal.timeout(10000) };
    const name = `${prefix}/${key}.json`;
    for (let attempt = 0; attempt < 3; attempt++) {
      let before;
      try { before = await head(name, args); } catch (error) {
        if (!(error instanceof BlobNotFoundError)) throw error;
        const found = await list({ ...args, prefix: name, limit: 1 });
        if (found.blobs.some(item => item.pathname === name)) continue;
        return null;
      }
      if (!before.etag) throw new Error('Snapshot revision missing');
      if (before.etag === knownRevision) return { unchanged: true, revision: before.etag };
      const body = await get(name, { ...args, access: 'private', useCache: false });
      if (!body || body.statusCode !== 200 || !body.stream) throw new Error('Snapshot unreadable');
      const text = await new Response(body.stream).text();
      const after = await head(name, args);
      if (after.etag === before.etag) return { value: JSON.parse(text), revision: before.etag };
    }
    throw new Error('Snapshot changed while reading');
  }
  let writing = false;
  async function write(key, value, expected) {
    const text = JSON.stringify(value);
    if (local) {
      if (writing) throw new Conflict();
      writing = true;
      try {
        const current = await read(key);
        if ((current?.revision ?? null) !== expected) throw new Conflict();
        await mkdir(local, { recursive: true });
        const file = path.join(local, `${catalogId}-${key}.json`);
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 }); await rename(temporary, file);
      } finally { writing = false; }
      return;
    }
    const { put, BlobError, BlobNotFoundError, BlobPreconditionFailedError } = await import('@vercel/blob');
    try {
      await put(`${prefix}/${key}.json`, text, { ...options, access: 'private', addRandomSuffix: false,
        contentType: 'application/json', cacheControlMaxAge: 60, allowOverwrite: expected !== null,
        ifMatch: expected ?? undefined, abortSignal: AbortSignal.timeout(15000) });
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError || (expected !== null && error instanceof BlobNotFoundError)
        || (expected === null && error instanceof BlobError && /already exists/i.test(error.message))) throw new Conflict();
      throw error;
    }
  }
  return { read, write };
}

function validateSnapshot(data, catalogId) {
  if (data?.schemaVersion !== 3 || data.source !== 'shopify' || data.wholesale !== true || data.catalogId !== catalogId
    || data.currency !== 'TRY' || !Array.isArray(data.rows) || !Number.isFinite(Date.parse(data.syncedAt))) {
    throw new ShopifyError('snapshot_invalid', 'Kayıtlı Shopify kataloğu doğrulanamadı.');
  }
  for (const row of data.rows) {
    for (const item of [row, ...(row.variants ?? [])]) {
      if (!Number.isFinite(item.price) || item.price < 0 || !item.wholesale
        || !Number.isInteger(item.wholesale.minimum) || !Number.isInteger(item.wholesale.increment)
        || item.wholesale.minimum < 1 || item.wholesale.increment < 1) {
        throw new ShopifyError('snapshot_invalid', 'Kayıtlı Shopify fiyat veya miktar kuralı doğrulanamadı.');
      }
    }
  }
  return data;
}

function createSnapshotService({ repository, catalogId, synchronize, now = Date.now }) {
  let cached; let checking; let refreshing;
  function accept(saved) {
    const data = validateSnapshot(saved.value, catalogId); const body = JSON.stringify(data);
    cached = { data, body, revision: saved.revision, checkedAt: now(), etag: `"${createHash('sha256').update(body).digest('hex')}"` };
    return cached;
  }
  async function read(force = false) {
    if (!force && cached && now() - cached.checkedAt < 5000) return cached;
    if (!checking) checking = repository.read('snapshot', cached?.revision).then(saved => {
      if (!saved) { cached = null; return null; }
      if (saved.unchanged && cached) { cached.checkedAt = now(); return cached; }
      return accept(saved);
    }).finally(() => { checking = null; });
    return checking;
  }
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const lease = await repository.read('lease');
      if (lease?.value?.until > now()) return false;
      const owner = randomUUID();
      try { await repository.write('lease', { owner, until: now() + 270000 }, lease?.revision ?? null); }
      catch (error) { if (error instanceof Conflict) return false; throw error; }
      let success = false;
      try {
        const previous = await repository.read('snapshot');
        if (previous && now() - Date.parse(previous.value.syncedAt) < REFRESH_AFTER) { accept(previous); success = true; return true; }
        const data = validateSnapshot(await synchronize(), catalogId);
        if (Buffer.byteLength(JSON.stringify(data)) > 4_000_000) throw new ShopifyError('snapshot_large', 'Katalog yanıtı boyut sınırını aşıyor.');
        await repository.write('snapshot', data, previous?.revision ?? null);
        await read(true); success = true; return true;
      } finally {
        const current = await repository.read('lease');
        if (current?.value?.owner === owner) await repository.write('lease', { owner, until: now() + (success ? REFRESH_AFTER : 20000) }, current.revision)
          .catch(error => { if (!(error instanceof Conflict)) throw error; });
      }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  return { read, refresh, stale: snapshot => !snapshot || now() - Date.parse(snapshot.data.syncedAt) >= REFRESH_AFTER };
}
module.exports = { Conflict, snapshotRepository, createSnapshotService, validateSnapshot };
