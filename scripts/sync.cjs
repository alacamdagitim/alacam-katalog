const { readFile, writeFile, rename } = require('node:fs/promises');
const { join } = require('node:path');
const { fetchProducts, fetchProductDetails, mergeProductDetails, normalizeCatalog } = require('../lib/catalog.cjs');
const detailsFile = join(__dirname, '../lib/catalog-details.json');

async function writeJSON(file, data) {
  const temporaryFile = `${file}.${process.pid}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(data));
  await rename(temporaryFile, file);
}

async function sync() {
  const files = process.argv.slice(2);
  const detailsInput = files[0] === '--details' ? files.splice(0, 2)[1] : null;
  const products = files.length
    ? (await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, 'utf8')).products))).flat()
    : await fetchProducts();
  const previous = JSON.parse(await readFile(detailsFile, 'utf8'));
  let refreshed = [];
  if (detailsInput) {
    refreshed = JSON.parse(await readFile(detailsInput, 'utf8'));
  } else if (!files.length) {
    const checked = previous.products || {};
    const unseen = products.filter(({ id }) => !Object.hasOwn(checked, id));
    const changed = products.filter(({ id, updated_at }) => Object.hasOwn(checked, id) && checked[id] !== updated_at);
    const result = await fetchProductDetails([...unseen, ...changed]);
    refreshed = result.details;
    if (result.limited) console.warn('Mağaza istek sınırına ulaşıldı. Sonraki eşitleme eksik ürünlerden devam eder.');
  }
  const details = mergeProductDetails(products, refreshed, previous);
  const catalog = normalizeCatalog(products, details.variants);
  if (!catalog.rows.length) throw new Error('Ürün kaynağında satır bulunamadı.');
  await writeJSON(detailsFile, details);
  await writeJSON(join(__dirname, '../public/catalog-data.json'), catalog);
  if (refreshed.length) console.log(`${refreshed.length}/${catalog.productCount} ürünün barkod ve ölçü bilgisi yenilendi.`);
  console.log(`${catalog.productCount} ürün, ${catalog.rows.length} katalog satırı kaydedildi.`);
}

sync().catch((error) => { console.error(error.message); process.exitCode = 1; });
