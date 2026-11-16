const ASSET_ORIGIN = 'https://alacamdagitim.com';
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
    const url = new URL(value, ASSET_ORIGIN);
    if (url.protocol !== 'https:' || !['cdn.shopify.com', 'alacamdagitim.com'].includes(url.hostname)) return null;
    url.searchParams.set('width', width);
    return url.toString();
  } catch {
    return null;
  }
}

const FOOD_TYPES = new Set([
  'bar sos', 'baz', 'dekor sos', 'kahve', 'milkshake', 'pastacilik',
  'pure', 'salep', 'sicak cikolata', 'siyah cay', 'slush (buzlas)',
  'sos', 'surup', 'topping sos', 'toz dondurma',
]);
const FOOD_UNITS = {
  kg: ['kg', 1], g: ['kg', 0.001], gr: ['kg', 0.001], gram: ['kg', 0.001],
  ml: ['l', 0.001], cl: ['l', 0.01], l: ['l', 1], lt: ['l', 1], litre: ['l', 1],
};

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
        sku: variant.sku,
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

module.exports = { normalizeCatalog };
