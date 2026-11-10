const SOURCE = 'https://alacamdagitim.com';
const PAGE_SIZE = 250;
const FEATURED = [
  'guri-cay-yumusak-i̇cim-demlik-suzen-poset-3-kg',
  'kirmizi-parti-bardak-beer-pong',
  'fo-vanilya-aromali-surup-sekerli-700-ml',
  'rubikap-premium-polikarbonat-bardak',
  'unicomix-ananas-meyveli-pure-1150-gr',
  'siyah-kil-pipet',
  'karton-bardak-tasiyici-2li-100-adet',
  'kurukahveci-mehmet-efendi-espresso-no-3',
  'astra-edt-cop-torbasi',
  '8oz-9oz-12oz-siyah-karton-bardak-kilifi',
];

// The storefront explicitly labels the 500-piece variant of this product as one case.
const VERIFIED_CASE_SIZES = new Map([['kirmizi-parti-bardak-beer-pong', 500]]);

const collator = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });
const fold = (value) => value.toLocaleLowerCase('tr').replaceAll('ı', 'i')
  .normalize('NFD').replace(/\p{M}/gu, '');

function decodeEntities(text) {
  const entities = {
    amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>',
    rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', bull: '•',
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, key) => {
    if (key[0] !== '#') return entities[key.toLowerCase()] || entity;
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function plainText(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function productDescription(html, title) {
  if (!html || html.trimStart().startsWith('TRANSLATE with x English')) return '';
  const blocks = decodeEntities(html).replace(/\s+/g, ' ')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(table|script|style|template|iframe|svg|noscript|object)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '\n\n')
    .replace(/(?:<\/p\s*>\s*)?<\/li\s*>\s*<li\b[^>]*>\s*(?:<p\b[^>]*>)?/gi, '\n• ')
    .replace(/<li\b[^>]*>\s*(?:<p\b[^>]*>)?/gi, '\n• ')
    .replace(/(?:<\/p\s*>\s*)?<\/li\s*>/gi, '\n')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/?(?:p|div|ul|ol|h[1-6]|section|blockquote)\b[^>]*>/gi, '\n\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
    .replace(/^;\s*font-weight:\s*bold;["']>\s*/i, '')
    .split(/\n{2,}/);

  const normalized = (text) => fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (normalized(blocks[0]) === normalized(title)) blocks.shift();
  if (/^(?:urun secenekleri ve teknik bilgiler|teknik (?:bilgiler|ozellikler))$/.test(normalized(blocks.at(-1) || ''))) blocks.pop();
  const text = blocks.join('\n\n').trim();
  const maxLength = 3000;
  if (text.length <= maxLength) return text;
  const excerpt = text.slice(0, maxLength);
  const wordEnd = excerpt.search(/\s+\S*$/);
  return `${(wordEnd > maxLength - 100 ? excerpt.slice(0, wordEnd) : excerpt).trimEnd()}…`;
}

function amount(value) {
  const digits = String(value ?? '').trim().replace(/[.\s]/g, '');
  return /^\d{1,7}$/.test(digits) && Number(digits) > 0 ? Number(digits) : null;
}

function optionAmount(value) {
  return amount(value) ?? amount(String(value ?? '').match(/^([\d.]+)\s*(?:adet|paket|rulo|kutu)\b/i)?.[1]);
}

function price(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function imageURL(value, width = '180') {
  if (!value) return null;
  try {
    const url = new URL(value, SOURCE);
    if (url.protocol !== 'https:' || !['cdn.shopify.com', 'alacamdagitim.com'].includes(url.hostname)) return null;
    url.searchParams.set('width', width);
    return url.toString();
  } catch {
    return null;
  }
}

const UNIT_LABELS = {
  item: 'adet', each: 'adet', piece: 'adet', m2: 'm²', ft2: 'ft²',
};
const UNIT_SCALES = {
  mg: ['g', 0.001], g: ['g', 1], kg: ['g', 1000],
  ml: ['ml', 1], cl: ['ml', 10], l: ['ml', 1000],
  mm: ['m', 0.001], cm: ['m', 0.01], m: ['m', 1],
};
const FOOD_TYPES = new Set([
  'bar sos', 'baz', 'dekor sos', 'kahve', 'milkshake', 'pastacilik',
  'pure', 'salep', 'sicak cikolata', 'siyah cay', 'slush (buzlas)',
  'sos', 'surup', 'topping sos', 'toz dondurma',
]);
const FOOD_UNITS = {
  kg: ['kg', 1], g: ['kg', 0.001], gr: ['kg', 0.001], gram: ['kg', 0.001],
  ml: ['l', 0.001], cl: ['l', 0.01], l: ['l', 1], lt: ['l', 1], litre: ['l', 1],
};

function unitMeasurement(variant) {
  const measurement = variant.unit_price_measurement;
  const unitPrice = price(variant.unit_price);
  const regularPrice = price(variant.price);
  if (!measurement || !unitPrice || !regularPrice) return null;

  const referenceValue = price(measurement.reference_value);
  const quantityValue = price(measurement.quantity_value);
  const referenceUnit = measurement.reference_unit;
  const quantityUnit = measurement.quantity_unit;
  if (!referenceValue || !quantityValue || typeof referenceUnit !== 'string' || !referenceUnit) return null;

  const referenceScale = UNIT_SCALES[referenceUnit];
  const quantityScale = UNIT_SCALES[quantityUnit];
  let ratio = null;
  if (referenceUnit === quantityUnit) {
    ratio = referenceValue / quantityValue;
  } else if (referenceScale && quantityScale && referenceScale[0] === quantityScale[0]) {
    ratio = referenceValue * referenceScale[1] / (quantityValue * quantityScale[1]);
  }

  const label = UNIT_LABELS[referenceUnit] || referenceUnit;
  return {
    price: regularPrice / 100,
    unitPrice: unitPrice / 100,
    unitPriceUnit: referenceValue === 1 ? label : `${referenceValue} ${label}`,
    ...(ratio ? { ratio } : {}),
  };
}

function mergeProductDetails(products, refreshed, previous = {}) {
  const byProduct = new Map(refreshed.map((product) => [String(product.id), product]));
  const details = { variants: {}, products: {} };
  for (const product of products) {
    const current = byProduct.get(String(product.id));
    if (!current) {
      if (previous.products?.[product.id]) details.products[product.id] = previous.products[product.id];
      for (const { id } of product.variants) {
        if (previous.variants?.[id]) details.variants[id] = previous.variants[id];
      }
      continue;
    }
    details.products[product.id] = product.updated_at;
    const ids = new Set(product.variants.map(({ id }) => String(id)));
    for (const variant of current.variants) {
      if (!ids.has(String(variant.id))) continue;
      const barcode = String(variant.barcode ?? '').trim();
      const unit = unitMeasurement(variant);
      if (barcode || unit) details.variants[variant.id] = { ...(barcode ? { barcode } : {}), ...unit };
    }
  }
  return details;
}

function foodQuantity(product, traits) {
  const productType = fold(product.product_type || '');
  const title = fold(product.title);
  if (!FOOD_TYPES.has(productType) || /\b\d+\s*adet\b/.test(title)) return null;
  const measures = (text) => Array.from(fold(text).matchAll(
    /(?:\b(\d+)\s*[x×]\s*)?\b(\d+(?:[.,]\d+)?)\s*(kg|gr|gram|g|ml|cl|l|lt|litre)\b(?:\s*[x×]\s*(\d+)\b)?/g,
  ));
  const titleMatches = measures(title);
  const optionMatches = traits.flatMap(measures);
  const toQuantity = (matches) => {
    if (matches.length !== 1) return null;
    const [, before, value, key, after] = matches[0];
    if (before && after) return null;
    const [unit, scale] = FOOD_UNITS[key];
    const each = Number(value.replace(',', '.')) * scale;
    const quantity = each * Number(before || after || 1);
    return quantity > 0 ? { quantity, unit, each } : null;
  };
  const pack = toQuantity(titleMatches);
  const option = toQuantity(optionMatches);
  if (titleMatches.length > 1 || optionMatches.length > 1) return null;
  if (!pack) return option;
  if (!option || (productType === 'siyah cay' && /\bposet\b/.test(title))) return pack;
  if (pack.unit === option.unit && (pack.quantity === option.quantity || pack.quantity === option.each)) return option;
  return null;
}

function unitPricing(value, detail, count, food) {
  if (value == null) return {};
  if (detail?.unitPrice && detail.price === value) {
    return { unitPrice: detail.unitPrice, unitPriceUnit: detail.unitPriceUnit };
  }
  if (detail?.ratio) {
    return { unitPrice: value * detail.ratio, unitPriceUnit: detail.unitPriceUnit };
  }
  if (count > 1) return { unitPrice: value / count, unitPriceUnit: 'adet' };
  if (food) return { unitPrice: value / food.quantity, unitPriceUnit: food.unit };
  return {};
}

function productTags(value) {
  const tags = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim()).filter(Boolean))];
}

function barcodeColumns(rows) {
  const byLabel = new Map(rows.map(([label, ...values]) => [fold(label || '').replace(/\s*:\s*$/, ''), values]));
  const skus = byLabel.get('stok kodu') || [];
  const barcode = byLabel.get('urun barkodu') || [];
  const caseBarcode = byLabel.get('koli barkodu') || [];
  const digits = (value) => /^\d{8,14}$/.test(value || '') ? value : null;
  const results = new Map();
  for (const [index, sku] of skus.entries()) {
    if (!sku || skus.indexOf(sku) !== skus.lastIndexOf(sku)) continue;
    const regular = barcode.length === skus.length ? digits(barcode[index]) : null;
    const box = caseBarcode.length === skus.length ? digits(caseBarcode[index]) : null;
    if (regular || box) results.set(sku, { regular, box });
  }
  return results;
}

function packagingInfo(product) {
  const sizes = new Set();
  const barcodes = new Map();
  let unit = 'adet';
  const html = product.body_html || '';
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = Array.from(table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi), (row) =>
      Array.from(row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi), (cell) => plainText(cell[1])));
    for (const [sku, codes] of barcodeColumns(rows)) {
      barcodes.set(sku, barcodes.has(sku) ? null : codes);
    }
    for (const [label, ...values] of rows) {
      const heading = fold(label || '');
      if (!/^koli(?: ici(?: (?:adet|satis birimi|miktar))?)?\s*:?$/.test(heading)) continue;
      if (heading.includes('satis birimi')) unit = 'birim';
      for (const value of values) {
        const size = optionAmount(value);
        if (size) sizes.add(size);
      }
    }
  }
  const description = fold(plainText(html));
  const textMatch = description.match(/\bkoli ici(?:\s+adet)?\s*[:=]?\s*([\d.]+)\s*(?:adet|paket|rulo|kutu)\b/);
  if (textMatch && amount(textMatch[1])) sizes.add(amount(textMatch[1]));
  const verifiedSize = VERIFIED_CASE_SIZES.get(product.handle);
  if (verifiedSize) sizes.add(verifiedSize);
  return { sizes, unit, barcodes };
}

function parseProduct(product, details) {
  const options = product.options || [];
  const quantityIndex = options.findIndex((option) => /^(adet|miktar|paket secimi)$/.test(fold(option.name)));
  const quantityOption = options[quantityIndex];
  const groups = new Map();
  const cases = packagingInfo(product);
  const tags = productTags(product.tags);

  for (const variant of product.variants || []) {
    const values = [variant.option1, variant.option2, variant.option3];
    const quantity = quantityIndex < 0 ? null : values[quantityIndex];
    const count = optionAmount(quantity);
    const pieceCount = amount(fold(quantity || '').match(/^([\d.]+)\s*adet$/)?.[1])
      ?? (cases.unit === 'adet' && quantityOption && fold(quantityOption.name) === 'adet' ? amount(quantity) : null);
    const explicitCase = fold(quantity || '').match(/^(\d+)\s*koli(?:\s*\(\s*([\d.]+)\s*adet\s*\))?$/);
    const optionValue = quantity && (count || explicitCase) ? quantity : undefined;
    const traits = [];
    const traitOptions = [];
    for (const [index, value] of values.entries()) {
      if (!value || value === 'Default Title' || (index === quantityIndex && optionValue)) continue;
      traits.push(value);
      const option = options[index];
      if (option?.name) traitOptions.push({ name: option.name, value, position: option.position ?? index + 1 });
    }
    const key = JSON.stringify(traits);
    if (!groups.has(key)) groups.set(key, { traits, traitOptions, variants: [] });
    groups.get(key).variants.push({
      id: String(variant.id),
      label: optionValue || 'Standart',
      optionValue,
      count,
      pieceCount,
      explicitCases: explicitCase ? amount(explicitCase[1]) : null,
      explicitPieces: explicitCase ? amount(explicitCase[2]) : null,
      price: price(variant.price),
      compareAtPrice: price(variant.compare_at_price),
      barcode: details[variant.id]?.barcode || String(variant.barcode ?? '').trim() || null,
      detail: details[variant.id],
      available: typeof variant.available === 'boolean' ? variant.available : null,
      sku: variant.sku || null,
      image: variant.featured_image?.src,
    });
  }

  return Array.from(groups.values(), ({ traits, traitOptions, variants }) => {
    variants.sort((a, b) => (a.count ?? Infinity) - (b.count ?? Infinity));
    const box = variants.find((variant) => variant.explicitCases === 1)
      || variants.find((variant, index) => variant.count > 1 && cases.sizes.has(variant.count)
        && (variants.length === 1 || index > 0));
    const base = variants.find((variant) => !variant.explicitCases && variant !== box);
    const primary = base || box || variants[0];
    const caseSize = box?.explicitPieces ?? box?.count ?? (groups.size === 1 && cases.sizes.size === 1 ? [...cases.sizes][0] : null);
    const stock = primary.available === true ? (primary === box ? 'case' : 'in')
      : variants.some((variant) => variant.available === true) ? (box?.available ? 'case' : 'other')
      : variants.every((variant) => variant.available === false) ? 'out' : 'unknown';
    const titleCount = amount(product.title.match(/\b([\d.]+)\s*adet\b/i)?.[1]);
    const food = base && (base.count == null || base.count === 1) ? foodQuantity(product, traits) : null;
    const unitCount = (variant) => {
      if (variant === box && cases.unit === 'adet') return variant.explicitPieces ?? variant.pieceCount;
      return variant.pieceCount > 1 ? variant.pieceCount : variant === base ? titleCount : null;
    };
    const getBarcode = (variant) => {
      const codes = cases.barcodes.get(variant.sku);
      const descriptionCode = variant === box ? codes?.box : variant === base ? codes?.regular : null;
      return variant.barcode || descriptionCode || null;
    };
    const pricing = base ? unitPricing(base.price, base.detail, unitCount(base), food) : {};
    return {
      id: primary.id,
      handle: product.handle,
      name: product.title,
      traits: traits.join(' · '),
      traitOptions,
      ...(primary.optionValue ? {
        saleOptionName: quantityOption.name,
        saleOptionPosition: quantityOption.position ?? quantityIndex + 1,
        saleOptionValue: primary.optionValue,
      } : {}),
      type: product.product_type?.trim() || null,
      brand: product.vendor?.trim() || null,
      sku: primary.sku,
      barcode: getBarcode(primary),
      caseBarcode: box ? getBarcode(box) : null,
      tags,
      image: imageURL(primary.image || product.images?.[0]?.src),
      quantity: base ? (base.count ?? titleCount ?? 1) : null,
      caseSize,
      caseUnit: caseSize ? cases.unit : null,
      price: base?.price ?? null,
      compareAtPrice: base?.compareAtPrice ?? null,
      casePrice: box?.price ?? null,
      caseCompareAtPrice: box?.compareAtPrice ?? null,
      unitPrice: pricing.unitPrice ?? null,
      unitPriceUnit: pricing.unitPriceUnit ?? null,
      stock,
      variants: variants.length > 1 || !base ? variants.map((variant) => ({
        id: variant.id,
        label: variant === box ? (caseSize ? `1 koli · ${caseSize} ${cases.unit}` : '1 koli')
          : variant.count ? `${variant.count} ${cases.unit}` : variant.label,
        ...(variant.optionValue ? { optionValue: variant.optionValue } : {}),
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        barcode: getBarcode(variant),
        ...unitPricing(variant.price, variant.detail, unitCount(variant), variant === base ? food : null),
        available: variant.available,
      })) : [],
    };
  });
}

function normalizeCatalog(products, details = {}) {
  const unique = [...new Map(products.filter((p) => p.handle && p.title).map((p) => [p.id, p])).values()];
  const rows = unique.flatMap((product) => parseProduct(product, details));
  const galleries = {};
  const descriptions = {};
  for (const product of unique) {
    const images = [
      ...(product.images || []).map((image) => image.src),
      ...(product.variants || []).map((variant) => variant.featured_image?.src),
    ];
    const gallery = [...new Set(images.map((image) => imageURL(image, '800')).filter(Boolean))];
    if (gallery.length) galleries[product.handle] = gallery;
    const description = productDescription(product.body_html, product.title);
    if (description) descriptions[product.handle] = description;
  }
  const featuredRank = new Map(FEATURED.map((handle, index) => [handle, index]));
  const seen = new Set();
  const priority = new Map();
  for (const row of rows) {
    if (!featuredRank.has(row.handle) || seen.has(row.handle)) continue;
    priority.set(row.id, featuredRank.get(row.handle));
    seen.add(row.handle);
  }
  rows.sort((a, b) => (priority.get(a.id) ?? Infinity) - (priority.get(b.id) ?? Infinity));
  const values = (key) => [...new Set(rows.map((row) => row[key]).filter(Boolean))].sort(collator.compare);
  return {
    syncedAt: new Date().toISOString(),
    productCount: new Set(rows.map((row) => row.handle)).size,
    types: values('type'),
    brands: values('brand'),
    tags: [...new Set(rows.flatMap((row) => row.tags))].sort(collator.compare),
    galleries,
    descriptions,
    rows,
  };
}

async function fetchProducts() {
  const products = [];
  const signal = AbortSignal.timeout(24000);
  const seen = new Set();
  for (let page = 1; page <= 80; page += 1) {
    const url = new URL('/products.json', SOURCE);
    url.search = new URLSearchParams({ limit: PAGE_SIZE, page });
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
    if (!response.ok) throw new Error(`Ürün kaynağı HTTP ${response.status} döndürdü.`);
    const result = await response.json();
    if (!Array.isArray(result.products)) throw new Error('Ürün kaynağının biçimi değişti.');
    for (const product of result.products) {
      if (seen.has(product.id)) throw new Error('Ürün sayfaları üst üste bindi.');
      seen.add(product.id);
      products.push(product);
    }
    if (result.products.length < PAGE_SIZE) return products;
  }
  throw new Error('Ürün kaynağı sayfalama sınırını aştı.');
}

async function fetchProductDetails(products) {
  const details = [];
  let next = 0;
  let limited = false;
  async function worker() {
    while (!limited && next < products.length) {
      const product = products[next++];
      const url = new URL(`/products/${encodeURIComponent(product.handle)}.js`, SOURCE);
      try {
        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(10000),
        });
        if (response.status === 429) {
          limited = true;
          return;
        }
        if (!response.ok) continue;
        const detail = await response.json();
        if (String(detail.id) === String(product.id) && Array.isArray(detail.variants)) {
          details.push({ id: detail.id, variants: detail.variants });
        }
      } catch {
        // Keep the previous details when a product request fails.
      }
    }
  }
  await Promise.all(Array.from({ length: 2 }, worker));
  return { details, limited };
}

module.exports = { normalizeCatalog, fetchProducts, fetchProductDetails, mergeProductDetails };
