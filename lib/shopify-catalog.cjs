const { normalizeCatalog } = require('./catalog.cjs');
const { ShopifyError } = require('./shopify-admin.cjs');

const PAGE = 'pageInfo { hasNextPage endCursor }';
const VARIANT = `id sku barcode price compareAtPrice availableForSale
  selectedOptions { name value } image { url }
  publishedOnPublication(publicationId: $publication)`;
const META = `query WholesaleCatalog($query: String!) {
  shop { currencyCode }
  catalogs(first: 2, query: $query) { nodes {
    id title status publication { id }
    priceList { id currency parent { adjustment { type value } } }
  } }
}`;

function failure(message) { throw new ShopifyError('catalog_invalid', message); }
function shortId(id) {
  const value = String(id).split('/').at(-1);
  if (!/^[1-9]\d*$/.test(value)) failure('Shopify ürün kimliği doğrulanamadı.');
  return value;
}
function connection(value) {
  if (!value || !Array.isArray(value.nodes) || typeof value.pageInfo?.hasNextPage !== 'boolean'
      || (value.pageInfo.hasNextPage && !value.pageInfo.endCursor)) failure('Shopify sayfalama yanıtı doğrulanamadı.');
  return value;
}
function money(value, currency) {
  if (!value || value.currencyCode !== currency || !/^\d+(?:\.\d+)?$/.test(value.amount)) failure('Katalog fiyatı veya para birimi doğrulanamadı.');
  const amount = Number(value.amount);
  if (!Number.isFinite(amount) || amount < 0) failure('Katalog fiyatı doğrulanamadı.');
  return amount;
}

async function catalogInfo(client, id) {
  const result = await client.query(META, { query: `id:${id}` });
  const catalog = result.catalogs?.nodes?.find((item) => shortId(item.id) === id);
  if (!catalog || catalog.status !== 'ACTIVE') failure('Seçilen toptan katalog bulunamadı veya etkin değil.');
  if (!catalog.publication || !catalog.priceList) failure('Toptan kataloğun ürün yayını veya fiyat listesi bulunamadı.');
  if (catalog.priceList.currency !== 'TRY' || result.shop?.currencyCode !== 'TRY') failure('Bu katalog için Türk lirası fiyatları gereklidir.');
  return { id, gid: catalog.id, title: catalog.title, publication: catalog.publication.id,
    priceList: catalog.priceList.id, currency: catalog.priceList.currency,
    adjustment: catalog.priceList.parent?.adjustment ?? null };
}

async function productPage(client, info, after = null) {
  const query = `query WholesaleProducts($publication: ID!, $after: String) {
    publication(id: $publication) { products(first: 60, after: $after, query: "status:active") {
      ${PAGE} nodes { id handle title status descriptionHtml productType vendor tags
        options { name position }
        images(first: 4) { nodes { url } }
        variants(first: 5) { ${PAGE} nodes { ${VARIANT} } }
      }
    } }
  }`;
  const data = await client.query(query, { publication: info.publication, after });
  const page = connection(data.publication?.products);
  const products = [];
  for (const product of page.nodes) {
    if (product.status !== 'ACTIVE') continue;
    let variants = connection(product.variants);
    const all = [...variants.nodes];
    const seen = new Set();
    while (variants.pageInfo.hasNextPage) {
      const cursor = variants.pageInfo.endCursor;
      if (seen.has(cursor)) failure('Shopify varyant sayfaları tekrarlandı.');
      seen.add(cursor);
      const more = await client.query(`query WholesaleVariants($id: ID!, $publication: ID!, $after: String) {
        product(id: $id) { variants(first: 100, after: $after) { ${PAGE} nodes { ${VARIANT} } } }
      }`, { id: product.id, publication: info.publication, after: cursor });
      variants = connection(more.product?.variants);
      all.push(...variants.nodes);
    }
    const ids = new Set();
    const visible = all.filter((variant) => {
      if (ids.has(variant.id)) failure('Shopify yinelenen varyant döndürdü.');
      ids.add(variant.id);
      return variant.publishedOnPublication === true;
    });
    if (!visible.length) continue;
    products.push({
      id: shortId(product.id), handle: product.handle, title: product.title, body_html: product.descriptionHtml,
      product_type: product.productType, vendor: product.vendor, tags: product.tags,
      options: product.options, images: product.images.nodes.map(({ url }) => ({ src: url })),
      variants: visible.map((variant) => ({
        id: shortId(variant.id), sku: variant.sku, barcode: variant.barcode,
        price: variant.price, compare_at_price: variant.compareAtPrice, available: variant.availableForSale,
        featured_image: variant.image ? { src: variant.image.url } : null,
        ...Object.fromEntries([1, 2, 3].map((index) => [`option${index}`, variant.selectedOptions[index - 1]?.value])),
      })),
    });
  }
  return { data: { ...normalizeCatalog(products), productIds: products.map(({ id }) => id) }, pageInfo: page.pageInfo };
}

async function pricePage(client, info, after = null, productIds = []) {
  const data = await client.query(`query WholesalePrices($id: ID!, $after: String, $query: String) {
    priceList(id: $id) { prices(first: 100, after: $after, query: $query) { ${PAGE}
      nodes { variant { id } price { amount currencyCode } compareAtPrice { amount currencyCode }
        quantityPriceBreaks(first: 5) { ${PAGE} nodes { minimumQuantity price { amount currencyCode } } }
      }
    } }
  }`, { id: info.priceList, after, query: productIds.length ? productIds.map((id) => `product_id:${id}`).join(' OR ') : null });
  const page = connection(data.priceList?.prices);
  const prices = [];
  for (const entry of page.nodes) {
    let breaks = connection(entry.quantityPriceBreaks);
    const tiers = [...breaks.nodes];
    const seen = new Set();
    while (breaks.pageInfo.hasNextPage) {
      const cursor = breaks.pageInfo.endCursor;
      if (seen.has(cursor)) failure('Shopify fiyat kademesi sayfaları tekrarlandı.');
      seen.add(cursor);
      const more = await client.query(`query WholesalePriceBreaks($id: ID!, $query: String!, $after: String) {
        priceList(id: $id) { prices(first: 1, query: $query) { nodes {
          variant { id } quantityPriceBreaks(first: 100, after: $after) { ${PAGE} nodes { minimumQuantity price { amount currencyCode } } }
        } } }
      }`, { id: info.priceList, query: `variant_id:${shortId(entry.variant.id)}`, after: cursor });
      const exact = more.priceList?.prices?.nodes?.[0];
      if (exact?.variant.id !== entry.variant.id) failure('Fiyat kademesi varyantı uyuşmuyor.');
      breaks = connection(exact.quantityPriceBreaks);
      tiers.push(...breaks.nodes);
    }
    prices.push({ id: shortId(entry.variant.id), price: money(entry.price, info.currency),
      compareAt: entry.compareAtPrice ? money(entry.compareAtPrice, info.currency) : null,
      tiers: tiers.map((tier) => ({ quantity: tier.minimumQuantity, price: money(tier.price, info.currency) })) });
  }
  return { prices, pageInfo: page.pageInfo };
}

async function rulePage(client, info, after = null) {
  const data = await client.query(`query WholesaleRules($id: ID!, $after: String) {
    priceList(id: $id) { quantityRules(first: 250, after: $after) { ${PAGE}
      nodes { productVariant { id } minimum increment maximum }
    } }
  }`, { id: info.priceList, after });
  const page = connection(data.priceList?.quantityRules);
  return { rules: page.nodes.map(({ productVariant, ...rule }) => ({ id: shortId(productVariant.id), ...rule })), pageInfo: page.pageInfo };
}

module.exports = { catalogInfo, productPage, pricePage, rulePage };
