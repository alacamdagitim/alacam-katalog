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

export function validQuantity(quantity, { minimum, increment, maximum }) {
  return Number.isSafeInteger(quantity) && quantity >= minimum && quantity <= maximum
    && (quantity - minimum) % increment === 0;
}

export function stepQuantity(quantity, { minimum, increment, maximum }, direction) {
  if (quantity < minimum) return direction > 0 ? minimum : null;
  if (quantity > maximum) return direction < 0 ? maximum : null;
  const offset = (quantity - minimum) / increment;
  const step = direction > 0 ? Math.floor(offset) + 1 : Math.ceil(offset) - 1;
  const next = minimum + step * increment;
  return next >= minimum && next <= maximum ? next : null;
}

export function wholesaleUnitCents(rule, price, quantity) {
  const tier = rule?.tiers?.findLast((entry) => entry.quantity <= quantity);
  const unit = tier?.price ?? price;
  return Number.isFinite(unit) ? Math.round(unit * 100) : null;
}
