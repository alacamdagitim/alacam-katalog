const DATABASE = 'alacam-shopify-catalog-v3';
const KEY = '160658587954';

export function validCatalog(data) {
  return data?.schemaVersion === 3 && data.source === 'shopify' && data.wholesale === true
    && data.catalogId === KEY && data.currency === 'TRY' && Array.isArray(data.rows)
    && Number.isFinite(Date.parse(data.syncedAt));
}

async function database() {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('catalog');
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => reject(new Error('Katalog önbelleği kullanılamıyor.'));
  });
}
export async function readCatalogCache() {
  let db;
  try {
    db = await database();
    const record = await new Promise((resolve, reject) => {
      const request = db.transaction('catalog').objectStore('catalog').get(KEY);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    return validCatalog(record?.data) ? record : null;
  } catch { return null; } finally { db?.close(); }
}
export async function writeCatalogCache(data, etag) {
  if (!validCatalog(data)) return;
  let db;
  try {
    db = await database();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('catalog', 'readwrite');
      transaction.objectStore('catalog').put({ data, etag }, KEY);
      transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    });
  } catch { /* The server snapshot remains available without browser storage. */ }
  finally { db?.close(); }
}
