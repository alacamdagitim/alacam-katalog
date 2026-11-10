const collator = new Intl.Collator('tr', { sensitivity: 'base' });

const integer = new Intl.NumberFormat('tr-TR');
export const wholesaleMoney = (cents) => {
  const amount = BigInt(cents);
  return `${integer.format(amount / 100n)},${String(amount % 100n).padStart(2, '0')} ₺`;
};
export const wholesaleRule = (row, variant) => variant?.wholesale ?? row.wholesale;

export function salePrice(row, variant) {
  return !variant || String(variant.id) === String(row.id) ? row.price ?? variant?.price : variant.price;
}

export function wholesaleLimits(rule, defaultMaximum = 999999) {
  const increment = rule?.increment ?? 1;
  const minimum = rule?.minimum ?? increment;
  const ceiling = rule?.maximum ?? (rule ? 2147483647 : defaultMaximum);
  return { minimum, increment, maximum: minimum + Math.floor((ceiling - minimum) / increment) * increment };
}

export function wholesaleUnitCents(rule, price, quantity) {
  const tier = rule?.tiers?.findLast((entry) => entry.quantity <= quantity);
  const unit = tier?.price ?? price;
  return Number.isFinite(unit) ? Math.round(unit * 100) : null;
}

function applyPrices(item, rule) {
  return {
    ...item,
    sku: rule.sku || item.sku,
    price: rule.price ?? item.price,
    compareAtPrice: rule.compareAt ?? null,
    wholesale: rule,
  };
}

function applyRow(row, rules) {
  if (!rules) return null;
  if (!row.variants?.length) {
    return Object.hasOwn(rules, row.id) ? applyPrices(row, rules[row.id]) : null;
  }
  const variants = row.variants.filter(({ id }) => Object.hasOwn(rules, id))
    .map((variant) => applyPrices({
      ...variant,
      sku: variant.sku ?? (String(variant.id) === String(row.id) ? row.sku : null),
    }, rules[variant.id]));
  if (!variants.length) return null;

  const primary = variants.find(({ id }) => String(id) === String(row.id)) ?? variants[0];
  const keepPrimary = String(primary.id) === String(row.id);
  const box = variants.find(({ label }) => label?.startsWith('1 koli'));
  const available = variants.some((variant) => variant.available === true);
  const stock = primary.available === true ? (primary === box ? 'case' : 'in')
    : available ? (box?.available ? 'case' : 'other')
      : variants.every((variant) => variant.available === false) ? 'out' : 'unknown';
  const [, amount] = /^(?:1 koli · )?(\d+) (?:adet|birim)$/.exec(primary.label) ?? [];

  return {
    ...row,
    id: primary.id,
    price: primary.price ?? (keepPrimary ? row.price : null),
    compareAtPrice: primary.compareAtPrice,
    barcode: primary.barcode ?? (keepPrimary ? row.barcode : null),
    sku: primary.sku,
    saleOptionValue: primary.optionValue,
    quantity: amount ? Number(amount) : keepPrimary ? row.quantity : null,
    stock,
    variants,
    caseBarcode: box?.barcode ?? null,
    hadCaseOption: row.variants.some(({ label }) => label?.startsWith('1 koli')),
  };
}

export function applyWholesale(data, overlay) {
  if (!overlay.active) return data;
  const rows = data.rows.flatMap((row) => {
    const handle = row.handle.trim().normalize('NFC');
    const result = Object.hasOwn(overlay.products, handle)
      ? applyRow(row, overlay.products[handle].variants) : null;
    return result ? [result] : [];
  });
  const values = (key) => [...new Set(rows.flatMap((row) => row[key] ?? []))].sort(collator.compare);
  return {
    ...data,
    rows,
    productCount: new Set(rows.map(({ handle }) => handle)).size,
    types: values('type'),
    brands: values('brand'),
    tags: values('tags'),
    wholesale: true,
  };
}
