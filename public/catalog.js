import { initRequest, addToRequest, hydrateRequest, requestCount } from './request.js';
import { initColumnReorder } from './column-reorder.js';
import { initColumnWidths } from './column-widths.js';
import { initBackdropDismiss } from './dialog-dismiss.js';

const get = (id) => document.getElementById(id);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const number = new Intl.NumberFormat('tr-TR');
const currency = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const collator = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });
const syncTime = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul',
});
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const fold = (value) => value.toLocaleLowerCase('tr').replaceAll('ı', 'i')
  .normalize('NFD').replace(/\p{M}/gu, '');
const formatNumber = (value) => value == null ? '' : number.format(value);
const money = (value) => value == null ? '' : `<span class="money">${currency.format(value)} ₺</span>`;
const stockLabels = { in: 'Stokta', case: 'Yalnız koli', other: 'Diğer adet stokta', out: 'Tükendi', unknown: 'Belirtilmemiş' };
const availableStocks = new Set(['in', 'case', 'other']);
const optionFields = ['sku', 'barcode', 'caseBarcode', 'quantity'];
const advancedIds = ['stock', 'min-price', 'max-price', 'min-case', 'case-only'];
const filterIds = ['search', ...advancedIds];
const defaults = Object.fromEntries(filterIds.map((id) => [id, '']));
const rowVariantKeys = ['variant1', 'variant2', 'quantity'];
const columns = [
  { key: 'name', label: 'Ürün' },
  { key: 'type', label: 'Tür' },
  { key: 'brand', label: 'Marka', optional: true },
  { key: 'variant1', label: 'Varyasyon 1', sortable: false },
  { key: 'variant2', label: 'Varyasyon 2', sortable: false },
  { key: 'quantity', label: 'Adet' },
  { key: 'price', label: 'Fiyat', numeric: true },
  { key: 'sku', label: 'Ürün kodu', optional: true },
  { key: 'barcode', label: 'Barkod' },
  { key: 'caseBarcode', label: 'Koli barkodu', optional: true },
  { key: 'caseSize', label: 'Koli içi', numeric: true },
];
const mobileLayout = matchMedia('(max-width: 740px), (orientation: landscape) and (max-height: 500px) and (max-width: 1024px)');
const columnsByKey = new Map(columns.map((column) => [column.key, column]));
const defaultColumnOrder = columns.map(({ key }) => key);
const mobileLeadingColumns = ['name', 'price', ...rowVariantKeys];
const mobileColumnOrder = [...mobileLeadingColumns, ...defaultColumnOrder.filter((key) => !mobileLeadingColumns.includes(key))];
const columnSettingsKey = 'alacam-katalog-sutunlar-v3';
const viewStorageKey = 'alacam-katalog-gorunum-v1';
const pinnedColumnKey = 'name';
const tableScroll = get('table-scroll');
const tableBody = get('table-body');
const cardScroll = get('card-scroll');
const cardGrid = get('card-grid');
const cardOptionsDialog = get('card-options-dialog');
const cardOptionsFields = get('card-options-fields');
const viewControl = get('catalog-view');
let catalogView = 'list';
let cardOptionsHandle = null;

try {
  if (localStorage.getItem(viewStorageKey) === 'grid') catalogView = 'grid';
} catch {
  // The current view remains usable if browser storage is unavailable.
}

let catalog;
let familiesByHandle = new Map();
let familiesOnPage = new Map();
const rowVariantSelections = new Map();
let state = 'loading';
let page = 1;
let toastTimeout;
let columnSettings;
let columnSettingsVersion = 3;
try {
  for (const version of [3, 2, 1]) {
    const saved = localStorage.getItem(`alacam-katalog-sutunlar-v${version}`);
    if (saved == null) continue;
    columnSettings = JSON.parse(saved);
    columnSettingsVersion = version;
    break;
  }
} catch {
  columnSettings = null;
}
const savedOrder = columnSettings?.order;
let customColumnOrder = normalizeColumnOrder(savedOrder);
const hiddenColumns = new Set(Array.isArray(columnSettings?.hidden)
  ? columnSettings.hidden.filter((key) => columnsByKey.has(key) && key !== pinnedColumnKey
    && !(columnSettingsVersion < 3 && key === 'price')
    && !(columnSettingsVersion === 1 && rowVariantKeys.includes(key)))
  : columns.filter(({ optional }) => optional).map(({ key }) => key));

const valueOf = (id) => get(id).value;
const getFilters = () => Object.fromEntries(filterIds.map((id) => [id, valueOf(id)]));

function menuCheckbox(value, label = value) {
  const item = document.createElement('label');
  item.className = 'menu-option';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.value = value;
  const indicator = document.createElement('span');
  indicator.className = 'menu-check';
  indicator.setAttribute('aria-hidden', 'true');
  item.append(input, indicator, label);
  return { item, input };
}

function createPicker(id, label) {
  const root = get(`${id}-picker`);
  root.innerHTML = `
    <button class="button picker-trigger" type="button" aria-expanded="false" aria-controls="${id}-panel" disabled>
      <span>${label}</span><span class="filter-badge" aria-hidden="true" hidden></span>${icon('down')}
    </button>
    <div class="catalog-menu picker-panel" id="${id}-panel" role="group" aria-labelledby="${id}-picker-title" hidden>
      <header class="catalog-menu-heading picker-panel-heading">
        <h2 id="${id}-picker-title">${label}</h2>
        <button class="text-button picker-clear" type="button" data-clear-picker hidden>Seçimi temizle</button>
        <button class="button icon-button catalog-menu-close" type="button" data-close-picker aria-label="${label} filtresini kapat">${icon('close')}</button>
      </header>
      <div class="picker-panel-body">
        <label class="picker-search">${icon('search')}
          <input type="search" aria-label="${label} ara" placeholder="${label} ara" autocomplete="off">
        </label>
        <div class="catalog-menu-options picker-options"></div>
        <p class="picker-empty" role="status" hidden>Sonuç bulunamadı</p>
      </div>
    </div>`;
  const trigger = root.querySelector('.picker-trigger');
  const panel = root.querySelector('.picker-panel');
  const search = root.querySelector('input');
  const options = root.querySelector('.picker-options');
  const empty = root.querySelector('.picker-empty');
  const badge = trigger.querySelector('.filter-badge');
  const clear = root.querySelector('[data-clear-picker]');
  const selection = new Set();
  let choices = [];
  let available;

  function filterOptions() {
    const words = fold(search.value.trim()).split(/\s+/).filter(Boolean);
    let hasMatch = false;
    for (const choice of choices) {
      const offered = !available || available.has(choice.input.value) || selection.has(choice.input.value);
      const matches = offered && words.every((word) => choice.searchText.includes(word));
      if (!matches && document.activeElement === choice.input) search.focus({ preventScroll: true });
      choice.item.hidden = !matches;
      hasMatch ||= matches;
    }
    empty.hidden = hasMatch;
  }

  function setAvailable(values) {
    available = values;
    filterOptions();
  }

  function update() {
    for (const { input } of choices) input.checked = selection.has(input.value);
    const count = selection.size;
    badge.textContent = count;
    badge.hidden = !count;
    clear.hidden = !count;
    trigger.setAttribute('aria-label', count ? `${label}, ${count} seçili` : label);
  }

  function setOptions(values) {
    values = [...new Set([...values, ...selection])];
    if (values.length === choices.length && values.every((value, index) => value === choices[index].input.value)) return;
    const focusedValue = options.contains(document.activeElement) ? document.activeElement.value : null;
    choices = values.map((value) => ({ ...menuCheckbox(value), searchText: fold(value) }));
    options.replaceChildren(...choices.map(({ item }) => item));
    trigger.disabled = !choices.length;
    filterOptions();
    update();
    if (focusedValue !== null) {
      const choice = choices.find(({ input, item }) => input.value === focusedValue && !item.hidden);
      (choice?.input ?? search).focus({ preventScroll: true });
    }
  }

  function close(restoreFocus = false) {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }

  trigger.addEventListener('click', (event) => {
    if (!panel.hidden) return close();
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    search.value = '';
    filterOptions();
    options.scrollTop = 0;
    if (!event.detail || !matchMedia('(pointer: coarse)').matches) search.focus();
  });
  search.addEventListener('input', () => {
    filterOptions();
    options.scrollTop = 0;
  });
  options.addEventListener('change', ({ target }) => {
    if (target.checked) selection.add(target.value);
    else selection.delete(target.value);
    update();
    resetPage();
  });
  clear.addEventListener('click', () => {
    selection.clear();
    update();
    resetPage();
    search.focus();
  });
  root.querySelector('[data-close-picker]').addEventListener('click', () => close(true));
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || panel.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  });
  root.addEventListener('focusout', (event) => {
    if (event.relatedTarget && !root.contains(event.relatedTarget)) close();
  });
  return { selection, trigger, root, panel, setOptions, setAvailable, update, close };
}

const pickers = {
  type: createPicker('type', 'Tür'),
  brand: createPicker('brand', 'Marka'),
  tags: createPicker('tags', 'Etiket'),
};

function normalizeColumnOrder(order) {
  const valid = Array.isArray(order)
    ? order.flatMap((key) => key === 'traits' ? ['variant1', 'variant2'] : key).filter((key) => columnsByKey.has(key))
    : [];
  return valid.length ? [...new Set([pinnedColumnKey, ...valid, ...defaultColumnOrder])] : null;
}

function currentColumnOrder() {
  return customColumnOrder ?? (mobileLayout.matches ? mobileColumnOrder : defaultColumnOrder);
}

function saveColumnSettings() {
  try {
    localStorage.setItem(columnSettingsKey, JSON.stringify({ order: customColumnOrder, hidden: [...hiddenColumns] }));
  } catch {
    // Keep the current layout usable if browser storage is unavailable.
  }
}

function selectedColumns() {
  return currentColumnOrder().filter((key) => !hiddenColumns.has(key)).map((key) => columnsByKey.get(key));
}
function stockBadge(value) {
  const label = stockLabels[value] || stockLabels.unknown;
  return `<span class="stock ${escape(value)}" title="${label}">${label}</span>`;
}
const caseAmount = (row) => row.caseSize == null ? ''
  : `<span class="case-amount">${formatNumber(row.caseSize)} <span class="unit">${escape(row.caseUnit)}</span></span>`;

function thumbnail(row) {
  return `<span class="thumb">${row.image
    ? `<img src="${escape(row.image)}" alt="" loading="lazy" decoding="async">`
    : icon('box')}</span>`;
}

function productLink(row, id = row.id) {
  return `https://alacamdagitim.com/products/${encodeURIComponent(row.handle)}?variant=${encodeURIComponent(id)}`;
}

function productName(row) {
  return `<button class="product" type="button" data-product="${escape(row.handle)}" aria-haspopup="dialog">
    ${thumbnail(row)}
    <span class="product-copy">
      <span class="product-title" title="${escape(row.name)}">${escape(row.name)}</span>
      ${row.offerCount > 1 ? `<span class="product-variants">${number.format(row.offerCount)} varyasyon</span>` : ''}
    </span>
  </button>`;
}

function tableLabel(value, className = '') {
  if (!value) return '';
  const label = escape(value);
  return `<span${className ? ` class="${className}"` : ''} title="${label}">${label}</span>`;
}

function cell(row, key) {
  if (row.varying?.has(key)) return '<span class="variant-value">Seçeneğe göre</span>';
  switch (key) {
    case 'type': return tableLabel(row.type, 'type-name');
    case 'brand': return tableLabel(row.brand);
    case 'sku': case 'barcode': case 'caseBarcode': return tableLabel(row[key], 'code');
    case 'caseSize': return row.rangeEnds?.caseSize > row.caseSize
      ? `<span class="case-amount">${formatNumber(row.caseSize)}–${formatNumber(row.rangeEnds.caseSize)} <span class="unit">${escape(row.caseUnit)}</span></span>`
      : caseAmount(row);
    case 'price': return money(row.price);
    default: return '';
  }
}

function variantsInPriceRange(offer, low, high) {
  const variants = offer.variants?.length ? offer.variants : [null];
  if (!low && !high) return variants;
  const searched = findSearchedOffer([offer]);
  const searchedId = searched && String(searched.variantId ?? offer.id);
  return variants.filter((variant) => {
    if (searchedId && String(variant?.id ?? offer.id) !== searchedId) return false;
    const price = productPrice(offer, variant);
    return Number.isFinite(price) && (!low || price >= Number(low)) && (!high || price <= Number(high));
  });
}

function rowVariantModel(offers) {
  const axesByPosition = new Map();
  for (const offer of offers) {
    for (const { position, name } of offer.traitOptions ?? []) {
      axesByPosition.set(position, name);
    }
  }
  const axes = [...axesByPosition].sort(([left], [right]) => left - right);
  const axisGroups = [axes.slice(0, 1), axes.slice(1)];
  const labels = [
    axisGroups[0][0]?.[1] || 'Varyasyon 1',
    axisGroups[1].map(([, name]) => name).join(' / ') || 'Varyasyon 2',
    'Adet',
  ];
  const low = valueOf('min-price');
  const high = valueOf('max-price');
  const candidates = offers.flatMap((offer) => {
    const traitValues = new Map((offer.traitOptions ?? []).map(({ position, value }) => [position, value]));
    const traits = axisGroups.map((group) => {
      const parts = group.map(([position]) => traitValues.get(position) || '');
      const label = parts.filter(Boolean).join(' · ');
      return { value: label ? (parts.length > 1 ? JSON.stringify(parts) : label) : '', label };
    });
    if (!axes.length && offer.traits) traits[0] = { value: offer.traits, label: offer.traits };
    return variantsInPriceRange(offer, low, high).map((variant) => {
      const value = variant ? variant.optionValue || variant.label : offer.saleOptionValue;
      const label = variant ? saleOptionLabel(offer, variant) : value || '';
      return { offer, variant, options: [...traits, { value: value || '', label }] };
    });
  });
  return { labels, candidates };
}

function selectedVariantFields({ offer, variant }) {
  if (!variant) return offer;
  const primary = String(variant.id) === String(offer.id);
  const [, amount] = /^(?:1 koli · )?(\d+) (?:adet|birim)$/.exec(variant.label) ?? [];
  return {
    ...offer,
    quantity: amount ? Number(amount) : (primary ? offer.quantity : null),
    barcode: variant.barcode ?? (primary ? offer.barcode : null),
    sku: variant.sku ?? (primary ? offer.sku : null),
    image: variant.image || offer.image,
  };
}

function currentRowVariantSelection(summary) {
  const saved = rowVariantSelections.get(summary.handle);
  if (saved && (saved.search === valueOf('search').trim() || !findSearchedOffer(summary.offers))) return saved.values;
}

function rowVariantState(summary, selection = currentRowVariantSelection(summary)) {
  const { labels, candidates } = rowVariantModel(summary.offers);
  const selected = {};
  let matches = candidates;
  const fields = rowVariantKeys.map((key, index) => {
    const choices = new Map();
    for (const { options } of matches) {
      const { value, label } = options[index];
      if (!value) continue;
      // A package with the same store value can represent a case for only some offers.
      const previous = choices.get(value);
      choices.set(value, previous && previous !== label ? value : label);
    }
    const value = selection?.[key];
    if (choices.has(value)) {
      selected[key] = value;
      matches = matches.filter(({ options }) => options[index].value === value);
    }
    return { key, label: labels[index], choices, selected: selected[key] };
  });
  const searched = Object.keys(selected).length ? null : findSearchedOffer(summary.offers);
  const exact = (searched && matches.find(({ offer, variant }) =>
    offer === searched.offer && String(variant?.id ?? offer.id) === String(searched.variantId ?? offer.id)))
    ?? (matches.length === 1 ? matches[0] : null);
  const cases = !selected.quantity && valueOf('case-only') === 'yes'
    ? matches.filter(({ variant }) => isCaseOption(variant))
    : [];
  const hasPrice = ({ offer, variant }) => Number.isFinite(productPrice(offer, variant));
  const fallback = cases.length ? cases : matches;
  const chosen = exact ?? cases.find(hasPrice) ?? matches.find(hasPrice)
    ?? fallback.find(({ offer, variant }) => variant ? variant.available === true : availableStocks.has(offer.stock))
    ?? fallback[0];
  const price = chosen ? productPrice(chosen.offer, chosen.variant) : null;
  const resolved = exact ? [exact] : matches;
  const matchingOffers = [...new Set(resolved.map(({ offer }) => offer))];
  const projected = exact || selected.quantity
    ? summarizeFamily(resolved.map(selectedVariantFields))
    : matchingOffers.length !== summary.offers.length ? summarizeFamily(matchingOffers) : summary;
  return { fields, selected, row: { ...projected, price: Number.isFinite(price) ? price : null }, chosen };
}

function rowVariantCell(field, row, card = false) {
  const { key, label, choices, selected } = field;
  if (!choices.size) {
    const amount = key === 'quantity' ? formatNumber(row.quantity) : '';
    return card && amount ? tableLabel(`${amount} adet`, 'card-variant-value') : amount;
  }
  if (choices.size === 1 && !selected) {
    return tableLabel(choices.values().next().value, card ? 'card-variant-value' : '');
  }
  const options = [...choices].map(([value, text]) =>
    `<option value="${escape(value)}" ${value === selected ? 'selected' : ''}>${escape(text)}</option>`).join('');
  return `<span class="row-variant-control${selected ? '' : ' is-unselected'}">
    <select class="row-variant-select" data-row-variant="${key}" aria-label="${escape(label)} · ${escape(row.name)}"
      title="${escape(choices.get(selected) || label)}"><option value="">${escape(label)}</option>${options}</select>
    ${icon('down')}
  </span>`;
}

function rowCell(state, key) {
  if (key === 'name') return productName(state.row);
  const field = state.fields.find((field) => field.key === key);
  return field ? rowVariantCell(field, state.row) : cell(state.row, key);
}

function renderTableRow(summary, shown) {
  const state = rowVariantState(summary);
  return `<tr data-row-handle="${escape(summary.handle)}">${shown.map((column) => {
    const content = rowCell(state, column.key);
    return column.key === 'name' ? `<th class="product-cell" scope="row">${content}</th>`
      : `<td class="${columnClass(column)}">${content}</td>`;
  }).join('')}</tr>`;
}

function cardImageSource({ chosen, row }) {
  const source = chosen?.variant?.image || chosen?.offer.image || row.image;
  return source ? imageAtWidth(source, 360) : '';
}

function cardImageContent(source) {
  return source ? `<img src="${escape(source)}" alt="" loading="lazy" decoding="async">` : icon('box');
}

const hasVariantControl = ({ choices, selected }) => choices.size > 1 || Boolean(selected);

function cardOptionsLabel(fields) {
  const controls = fields.filter(hasVariantControl);
  if (controls.length < 2) return '';
  const selected = controls.map((field) => field.choices.get(field.selected)).filter(Boolean);
  return selected.join(' · ') || 'Seçenekler';
}

function renderProductCard(summary) {
  const state = rowVariantState(summary);
  const { row, fields } = state;
  const name = escape(row.name);
  const source = cardImageSource(state);
  const optionsLabel = escape(cardOptionsLabel(fields));
  return `<li class="product-card" data-row-handle="${escape(summary.handle)}">
    <button class="card-product" type="button" data-product="${escape(summary.handle)}" aria-haspopup="dialog">
      <span class="card-image" data-image-source="${escape(source)}">${cardImageContent(source)}</span>
      <span class="card-title" title="${name}">${name}</span>
    </button>
    <div class="card-variants${optionsLabel ? ' has-card-options' : ''}">${fields.map((field) => {
      const content = rowVariantCell(field, row, true);
      return `<div class="card-variant" data-card-variant="${field.key}"${content ? '' : ' hidden'}>${content}</div>`;
    }).join('')}</div>
    <button class="card-options-trigger" type="button" aria-haspopup="dialog" aria-controls="card-options-dialog"
      aria-label="${name} seçenekleri · ${optionsLabel}"${optionsLabel ? '' : ' hidden'}>
      <span class="card-options-label">${optionsLabel}</span>${icon('down')}
    </button>
    <div class="card-price" aria-live="polite" aria-atomic="true">${money(row.price)}</div>
  </li>`;
}

function updateProductCard(card, state, activeKey) {
  const image = card.querySelector('.card-image');
  const source = cardImageSource(state);
  if (image.dataset.imageSource !== source) {
    image.dataset.imageSource = source;
    image.innerHTML = cardImageContent(source);
  }
  for (const field of state.fields) {
    if (field.key === activeKey) continue;
    const slot = card.querySelector(`[data-card-variant="${field.key}"]`);
    const content = rowVariantCell(field, state.row, true);
    slot.innerHTML = content;
    slot.hidden = !content;
  }
  const optionsLabel = cardOptionsLabel(state.fields);
  const trigger = card.querySelector('.card-options-trigger');
  trigger.hidden = !optionsLabel;
  trigger.setAttribute('aria-label', `${state.row.name} seçenekleri · ${optionsLabel}`);
  trigger.querySelector('.card-options-label').textContent = optionsLabel;
  card.querySelector('.card-variants').classList.toggle('has-card-options', Boolean(optionsLabel));
  card.querySelector('.card-price').innerHTML = money(state.row.price);
}

function cardForHandle(handle) {
  return cardGrid.querySelector(`[data-row-handle="${CSS.escape(handle)}"]`);
}

function updateCardOptions(state, activeKey) {
  get('card-options-title').textContent = state.row.name;
  for (const field of state.fields) {
    if (field.key === activeKey) continue;
    const slot = cardOptionsFields.querySelector(`[data-card-option="${field.key}"]`);
    const content = rowVariantCell(field, state.row, true);
    slot.innerHTML = content ? `<span>${escape(field.label)}</span>${content}` : '';
    slot.hidden = !content;
  }
  get('card-options-price').innerHTML = money(state.row.price);
}

function openCardOptions(card) {
  const handle = card.dataset.rowHandle;
  const summary = familiesOnPage.get(handle);
  if (!summary || cardOptionsDialog.open) return;
  cardOptionsHandle = handle;
  cardOptionsFields.innerHTML = rowVariantKeys.map((key) =>
    `<div class="card-options-field" data-card-option="${key}" hidden></div>`).join('');
  updateCardOptions(rowVariantState(summary));
  cardOptionsDialog.showModal();
}

function syncOpenCardOptions() {
  const summary = familiesOnPage.get(cardOptionsHandle);
  if (catalogView !== 'grid' || !mobileLayout.matches || !summary) {
    cardOptionsDialog.close();
    return;
  }
  const active = document.activeElement;
  const activeKey = cardOptionsFields.contains(active) ? active.dataset.rowVariant : null;
  updateCardOptions(rowVariantState(summary));
  if (activeKey) {
    const control = cardOptionsFields.querySelector(`[data-row-variant="${activeKey}"]`);
    (control ?? get('card-options-done')).focus({ preventScroll: true });
  }
}

function compareRows(a, b, key, descending) {
  const left = (descending ? a.rangeEnds?.[key] : null) ?? a[key];
  const right = (descending ? b.rangeEnds?.[key] : null) ?? b[key];
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  const delta = typeof left === 'number' ? left - right : collator.compare(left, right);
  return descending ? -delta : delta;
}

function summarizeFamily(offers) {
  const first = offers[0];
  const family = familiesByHandle.get(first.handle);
  const summary = {
    ...first,
    offers,
    offerCount: family.length,
  };
  if (offers.length === 1) return summary;

  summary.varying = new Set();
  summary.rangeEnds = {};
  for (const key of optionFields) {
    if (offers.every((offer) => offer[key] === first[key])) continue;
    summary[key] = null;
    summary.varying.add(key);
  }
  const cases = offers.filter((offer) => Number.isFinite(offer.caseSize));
  if (cases.length && (cases.length !== offers.length || cases.some((offer) => offer.caseUnit !== cases[0].caseUnit))) {
    summary.caseSize = null;
    summary.varying.add('caseSize');
  } else if (cases.length) {
    const sizes = cases.map((offer) => offer.caseSize);
    summary.caseSize = Math.min(...sizes);
    summary.rangeEnds.caseSize = Math.max(...sizes);
  }
  return summary;
}

function visibleRows(filters, badRange) {
  if (!catalog) return [];
  const words = fold(filters.search.trim()).split(/\s+/).filter(Boolean);
  const { 'min-price': low, 'max-price': high, 'min-case': minCase, 'case-only': hasCase } = filters;
  const eligibleRows = badRange ? [] : catalog.rows.filter((row) => {
    if (words.length && !words.every((word) => row.searchText.includes(word))) return false;
    if (filters.stock === 'in' && !availableStocks.has(row.stock)) return false;
    if (filters.stock && filters.stock !== 'in' && filters.stock !== row.stock) return false;
    if (hasCase && Boolean(caseOption(row)) !== (hasCase === 'yes')) return false;
    if (minCase && (row.caseSize == null || row.caseSize < Number(minCase))) return false;
    return (!low && !high) || variantsInPriceRange(row, low, high).length > 0;
  });
  const { type, brand, tags } = pickers;
  const availableTypes = new Set();
  const availableBrands = new Set();
  const availableTags = new Set();
  const matchingFamilies = new Map();
  for (const row of eligibleRows) {
    const matchesType = !type.selection.size || type.selection.has(row.type);
    const matchesBrand = !brand.selection.size || brand.selection.has(row.brand);
    const matchesTags = !tags.selection.size || row.tags?.some((tag) => tags.selection.has(tag));
    // A facet offers values from rows matching the other two facets.
    if (matchesBrand && matchesTags && row.type) availableTypes.add(row.type);
    if (matchesType && matchesTags && row.brand) availableBrands.add(row.brand);
    if (matchesType && matchesBrand) for (const tag of row.tags ?? []) availableTags.add(tag);
    if (matchesType && matchesBrand && matchesTags) {
      if (!matchingFamilies.has(row.handle)) matchingFamilies.set(row.handle, []);
      matchingFamilies.get(row.handle).push(row);
    }
  }
  type.setAvailable(availableTypes);
  brand.setAvailable(availableBrands);
  tags.setAvailable(availableTags);
  const results = [...matchingFamilies.values()].map(summarizeFamily);
  const [key, direction] = valueOf('sort').split(':');
  if (key !== 'featured') {
    const selectedRows = new Map();
    for (const row of results) {
      if (key === 'price' || rowVariantSelections.has(row.handle)) selectedRows.set(row.handle, rowVariantState(row).row);
    }
    results.sort((a, b) => compareRows(selectedRows.get(a.handle) ?? a, selectedRows.get(b.handle) ?? b,
      key, direction === 'desc'));
  }
  return results;
}

function applySort(sort) {
  const select = get('sort');
  for (const option of select.querySelectorAll('[data-temporary]')) option.remove();
  if (![...select.options].some((option) => option.value === sort)) {
    const [key, direction] = sort.split(':');
    const label = columns.find((column) => column.key === key).label;
    const option = new Option(`${label} ${direction === 'desc' ? 'azalan' : 'artan'}`, sort);
    option.dataset.temporary = '';
    select.add(option);
  }
  select.value = sort;
}

function renderHeaders(shown) {
  const [key, direction] = valueOf('sort').split(':');
  get('table-head').innerHTML = shown.map((column) => {
    const sorted = column.key === key;
    const split = column.label.lastIndexOf(' ');
    const words = split < 0 ? column.label
      : `<span class="column-label-start">${column.label.slice(0, split)}</span> <span class="column-label-end">${column.label.slice(split + 1)}</span>`;
    const label = `<span class="column-label">${words}</span>`;
    return `<th scope="col" class="${columnClass(column)}" ${sorted ? `aria-sort="${direction === 'desc' ? 'descending' : 'ascending'}"` : ''}>
      <div class="column-heading">
        ${column.sortable === false ? label
          : `<button class="column-sort" type="button" data-sort="${column.key}">${label}${icon(sorted && direction === 'desc' ? 'down' : 'sort')}</button>`}
        <button class="column-resize" type="button" data-resize-column="${column.key}"
          aria-label="${column.label} sütununun genişliğini ayarla" aria-describedby="column-resize-help"></button>
      </div>
    </th>`;
  }).join('');
}

function columnClass(column) {
  if (column.key === 'name') return 'product-cell';
  if (column.numeric) return 'number';
  return '';
}

function renderChips(filters) {
  const active = [];
  const push = (id, label) => active.push([id, label]);
  for (const [id, { selection }] of Object.entries(pickers)) {
    for (const value of selection) active.push([id, value, value]);
  }
  if (filters.stock) push('stock', stockLabels[filters.stock]);
  if (filters['min-price']) push('min-price', `En az ${number.format(filters['min-price'])} ₺`);
  if (filters['max-price']) push('max-price', `En çok ${number.format(filters['max-price'])} ₺`);
  if (filters['min-case']) push('min-case', `Koli içi ≥ ${number.format(filters['min-case'])}`);
  if (filters['case-only']) push('case-only', filters['case-only'] === 'yes' ? 'Koli satışı var' : 'Koli satışı belirtilmemiş');
  const element = get('active-filters');
  element.hidden = active.length === 0;
  element.innerHTML = active.map(([id, label, value]) => `<button class="chip" type="button" data-clear="${id}" data-value="${escape(value)}" aria-label="${escape(label)} filtresini kaldır">${escape(label)}${icon('close')}</button>`).join('');
  get('filter-summary').hidden = active.length === 0;
  const count = active.filter(([id]) => advancedIds.includes(id)).length;
  get('advanced-count').hidden = count === 0;
  get('advanced-count').textContent = count;
  return active.length > 0 || Boolean(filters.search.trim());
}

function render(focusChoice) {
  const filters = getFilters();
  get('search-clear').hidden = !filters.search;
  const hasSearch = Boolean(filters.search.trim());
  searchToggle.classList.toggle('is-searching', hasSearch);
  searchToggle.setAttribute('aria-label', hasSearch ? 'Aramayı düzenle, arama filtresi etkin' : 'Ürün ara');
  const badRange = filters['min-price'] && filters['max-price']
    && Number(filters['min-price']) > Number(filters['max-price']);
  get('filter-error').hidden = !badRange;
  const rows = visibleRows(filters, badRange);
  const size = Number(valueOf('page-size'));
  const lastPage = Math.max(1, Math.ceil(rows.length / size));
  if (focusChoice) {
    const index = rows.findIndex(({ handle }) => handle === focusChoice.handle);
    if (index >= 0) page = Math.floor(index / size) + 1;
  }
  page = Math.min(page, lastPage);
  const start = (page - 1) * size;
  const pageRows = rows.slice(start, start + size);
  familiesOnPage = new Map(pageRows.map((row) => [row.handle, row]));
  const hasFilters = renderChips(filters);
  const showCards = catalogView === 'grid';
  tableScroll.hidden = showCards || !rows.length;
  cardScroll.hidden = !showCards || !rows.length;
  if (showCards) {
    tableBody.replaceChildren();
    cardGrid.innerHTML = pageRows.map(renderProductCard).join('');
    updateScrollHint();
  } else {
    cardGrid.replaceChildren();
    const shown = selectedColumns();
    renderHeaders(shown);
    tableBody.innerHTML = pageRows.map((row) => renderTableRow(row, shown)).join('');
    layoutColumns(shown);
  }
  if (cardOptionsDialog.open && !focusChoice) syncOpenCardOptions();
  if (focusChoice && !cardOptionsDialog.open) {
    const results = showCards ? cardGrid : tableBody;
    const row = results.querySelector(`[data-row-handle="${CSS.escape(focusChoice.handle)}"]`);
    const control = row?.querySelector(`[data-row-variant="${focusChoice.key}"]`);
    (control ?? row?.querySelector('[data-product]'))?.focus();
  }
  get('empty').hidden = rows.length > 0;
  get('pagination').hidden = rows.length === 0;
  let resultLabel = '';
  if (!catalog) resultLabel = state === 'error' ? 'Ürünler yüklenemedi' : 'Ürünler yükleniyor…';
  else if (hasFilters) resultLabel = `${number.format(rows.length)} ürün bulundu`;
  const resultCount = get('result-count');
  if (resultCount.textContent !== resultLabel) resultCount.textContent = resultLabel;

  if (rows.length) {
    get('page-label').textContent = `${page} / ${lastPage}`;
    get('previous').disabled = page === 1;
    get('next').disabled = page === lastPage;
  } else {
    get('empty-title').textContent = catalog ? 'Eşleşen ürün bulunamadı'
      : state === 'error' ? 'Katalog yüklenemedi' : 'Katalog yükleniyor';
    get('empty-description').hidden = !badRange && state !== 'error';
    get('empty-description').textContent = badRange
      ? 'Fiyat aralığını kontrol edin.'
      : 'Ürün kaynağına şu anda ulaşılamıyor.';
    get('empty-action').hidden = !catalog && state !== 'error';
    get('empty-action').textContent = catalog ? 'Filtreleri temizle' : 'Tekrar dene';
  }
}

function updateScrollHint() {
  document.querySelector('.mobile-hint').hidden = tableScroll.hidden || tableScroll.scrollWidth <= tableScroll.clientWidth;
}

const layoutColumns = initColumnWidths({
  table: get('table'),
  scroller: tableScroll,
  colgroup: get('table-columns'),
  head: get('table-head'),
  mobileLayout,
  onResize: updateScrollHint,
});

function activeCatalogScroll() {
  return catalogView === 'grid' ? cardScroll : tableScroll;
}

function resetPage() {
  page = 1;
  activeCatalogScroll().scrollTop = 0;
  render();
}

function resetFilters() {
  for (const [id, value] of Object.entries(defaults)) get(id).value = value;
  for (const { selection, update } of Object.values(pickers)) {
    selection.clear();
    update();
  }
  resetPage();
  openSearch();
}

function displayCatalog(data, source) {
  catalog = data;
  familiesByHandle = new Map();
  for (const row of catalog.rows) {
    row.searchText = fold([row.name, row.handle, row.traits, row.type, row.brand, row.sku, row.barcode,
      row.caseBarcode, row.saleOptionValue, ...(row.tags ?? []),
      ...(row.variants ?? []).flatMap(({ barcode, sku, label, optionValue }) => [barcode, sku, label, optionValue])].filter(Boolean).join(' '));
    if (!familiesByHandle.has(row.handle)) familiesByHandle.set(row.handle, []);
    familiesByHandle.get(row.handle).push(row);
  }
  hydrateRequest(data.rows);
  get('product-total').textContent = number.format(data.productCount);
  get('type-total').textContent = number.format(data.types.length);
  get('brand-total').textContent = number.format(data.brands.length);
  pickers.type.setOptions(data.types);
  pickers.brand.setOptions(data.brands);
  pickers.tags.setOptions(data.tags ?? []);
  setStatus(source);
  render();
}

function setStatus(source) {
  state = source;
  const status = get('sync');
  status.hidden = source !== 'saved';
  status.textContent = status.hidden ? '' : `Kayıtlı katalog · ${syncTime.format(new Date(catalog.syncedAt))}`;
}

async function getData(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error('Katalog yanıtı alınamadı');
    const data = await response.json();
    if (!Array.isArray(data.rows) || !data.rows.length) throw new Error('Katalog verisi boş');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function load() {
  setStatus('loading');
  const live = getData('/api/catalog', 29000).catch(() => null);
  if (!catalog) {
    const snapshot = await getData('/catalog-data.json', 10000).catch(() => null);
    if (snapshot) displayCatalog(snapshot, 'snapshot');
  }
  const data = await live;
  if (data) {
    displayCatalog(data, 'live');
  } else {
    setStatus(catalog ? 'saved' : 'error');
    render();
  }
}

initBackdropDismiss(get('product-dialog'));
initBackdropDismiss(cardOptionsDialog);

function imageAtWidth(source, width) {
  return source.replace(/([?&]width=)\d+/, `$1${width}`);
}

function productGallery(row, variant) {
  const images = [...new Set([variant?.image, row.image, ...(catalog.galleries?.[row.handle] ?? [])]
    .filter((source) => typeof source === 'string' && source).map((source) => imageAtWidth(source, 800)))];
  if (!images.length) return `<div class="gallery-stage gallery-placeholder" aria-label="Görsel bulunamadı">${icon('box')}</div>`;
  return `<div class="product-gallery">
    <div class="gallery-stage" data-gallery-primary="${escape(images[0])}">
      <img id="detail-image" src="${escape(imageAtWidth(images[0], 180))}" alt="${escape(row.name)}" decoding="async">
    </div>
    ${images.length > 1 ? `<div class="gallery-thumbs" role="group" aria-label="Ürün görselleri">
      ${images.map((source, index) => `<button class="gallery-thumb" type="button" data-gallery-source="${escape(source)}"
        aria-label="${index + 1}. görseli göster" aria-pressed="${index === 0}">
        <img src="${escape(imageAtWidth(source, 104))}" alt="" loading="lazy" decoding="async">
      </button>`).join('')}
    </div>` : ''}
  </div>`;
}

function activateGallery(gallery, dialog) {
  const stage = gallery.querySelector('[data-gallery-primary]');
  if (!stage) return;
  const alt = stage.querySelector('img').alt;
  const thumbnails = [...gallery.querySelectorAll('[data-gallery-source]')];
  const prepared = new Map();
  let revision = 0;

  function prepare(source, width, priority) {
    const url = imageAtWidth(source, width);
    const saved = prepared.get(url);
    if (saved) {
      if (priority === 'high') saved.image.fetchPriority = priority;
      return saved.ready;
    }
    const image = new Image();
    image.alt = alt;
    image.decoding = 'async';
    image.fetchPriority = priority;
    image.src = url;
    const ready = image.decode().then(() => image, () => {
      if (prepared.get(url)?.image === image) prepared.delete(url);
      return null;
    });
    prepared.set(url, { image, ready });
    if (prepared.size > 6) prepared.delete(prepared.keys().next().value);
    return ready;
  }

  async function showImage(source, index, preview) {
    const current = ++revision;
    const needed = stage.clientWidth * Math.min(window.devicePixelRatio || 1, 1.5);
    const width = [360, 480, 640, 800].find((size) => size >= needed) ?? 800;
    const ready = prepare(source, width, 'high');
    if (preview?.complete && preview.naturalWidth) {
      const image = preview.cloneNode(false);
      image.removeAttribute('loading');
      image.id = 'detail-image';
      image.alt = alt;
      stage.replaceChildren(image);
    }
    const sharp = await ready;
    if (current !== revision || !stage.isConnected || !dialog.open) return;
    if (sharp) {
      sharp.id = 'detail-image';
      stage.replaceChildren(sharp);
    }
    for (const neighbor of [thumbnails[index + 1], thumbnails[index - 1]]) {
      if (neighbor) prepare(neighbor.dataset.gallerySource, width, 'low');
    }
  }

  let active = 0;
  for (const [index, button] of thumbnails.entries()) {
    button.addEventListener('click', () => {
      if (index === active) return;
      thumbnails[active].setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
      active = index;
      showImage(button.dataset.gallerySource, index, button.querySelector('img'));
    });
  }
  showImage(stage.dataset.galleryPrimary, active);
}

function preferredVariant(row, variantId) {
  const options = row.variants ?? [];
  if (variantId != null) {
    const match = options.find((option) => String(option.id) === String(variantId));
    if (match) return match;
  }
  if (row.stock === 'case' || row.stock === 'other') {
    const available = options.find((option) => option.available === true);
    if (available) return available;
  }
  return options.find((option) => String(option.id) === String(row.id)) ?? options[0];
}

function productPrice(row, variant) {
  return !variant || String(variant.id) === String(row.id) ? row.price ?? variant?.price : variant.price;
}

const isCaseOption = (variant) => variant?.label?.startsWith('1 koli');
const caseOption = (row) => row.variants?.find(isCaseOption);

function renderProductAttributes(row, variant) {
  const primary = !variant || String(variant.id) === String(row.id);
  const selectedCase = isCaseOption(variant);
  const price = productPrice(row, variant);
  const barcode = variant?.barcode ?? (primary ? row.barcode : null);
  const caseBarcode = selectedCase ? barcode ?? row.caseBarcode : row.caseBarcode;
  const sku = variant?.sku || (primary ? row.sku : null);
  const stock = variant?.available === true ? 'in' : variant?.available === false ? 'out' : row.stock;
  const attributes = [
    ['Fiyat', price == null ? null : money(price)],
    ['Satış adedi', !variant && row.quantity > 1 ? formatNumber(row.quantity) : null],
    ['Koli içi', row.caseSize == null ? null : caseAmount(row)],
    ['Barkod', !selectedCase && barcode ? escape(barcode) : null],
    ['Koli barkodu', caseBarcode ? escape(caseBarcode) : null],
    ['Ürün kodu', sku ? escape(sku) : null],
    ['Stok', stockBadge(stock)],
  ];
  get('detail-attributes').innerHTML = attributes.filter(([, value]) => value != null)
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');
}

const installmentQuotes = new Map();
const installmentRetryStatuses = new Set([408, 429, 500, 502, 503, 504]);

function isInstallmentQuote(quote, amount) {
  return quote?.amount === amount && quote.currency === 'TRY' && Array.isArray(quote.programs)
    && quote.programs.every((program) => typeof program?.name === 'string' && program.name.trim()
      && Array.isArray(program.plans) && program.plans.length > 0
      && program.plans.every((plan) => Number.isSafeInteger(plan?.months) && plan.months >= 2
        && Number.isSafeInteger(plan.monthly) && plan.monthly > 0
        && Number.isSafeInteger(plan.total) && plan.total > 0));
}

async function fetchInstallmentQuote(amount, signal) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal.aborted) throw signal.reason;
    let response;
    try {
      response = await fetch(`/api/installments?amount=${amount}`, { signal });
    } catch (error) {
      if (signal.aborted || attempt) throw error;
    }
    if (response?.ok) {
      const quote = await response.json();
      if (!isInstallmentQuote(quote, amount)) throw new Error('Geçersiz taksit yanıtı.');
      return quote;
    }
    if (attempt || (response && !installmentRetryStatuses.has(response.status))) break;
    const retryAfter = response?.headers.get('Retry-After');
    const requestedDelay = /^\d+$/.test(retryAfter ?? '') ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    if (requestedDelay > 4000) break;
    await new Promise((resolve) => setTimeout(resolve, Math.max(650, requestedDelay || 0)));
  }
  throw new Error('Taksit seçenekleri yüklenemedi.');
}

function renderInstallmentPlans(container, { amount, programs }) {
  container.innerHTML = `
    <div class="installments-controls">
      <label class="select-wrap detail-select">
        <span class="sr-only">Kart programı</span>
        <select class="catalog-select">${programs.map(({ name }, index) => `<option value="${index}">${escape(name)}</option>`).join('')}</select>
        ${icon('down')}
      </label>
      <p>Hesaplanan tutar ${money(amount / 100)}</p>
    </div>
    <table class="installments-table" aria-label="Taksit planı">
      <thead><tr><th scope="col">Taksit</th><th scope="col">Aylık ödeme</th><th scope="col">Toplam</th></tr></thead>
      <tbody></tbody>
    </table>
    <p class="installments-note">Taksit seçenekleri kartınıza göre değişebilir. Nihai tutar ödeme adımında belirlenir.</p>`;
  const select = container.querySelector('select');
  const body = container.querySelector('tbody');
  function showProgram() {
    body.innerHTML = programs[select.value].plans.map(({ months, monthly, total }) =>
      `<tr><td>${number.format(months)}</td><td>${money(monthly / 100)}</td><td>${money(total / 100)}</td></tr>`).join('');
  }
  select.addEventListener('change', showProgram);
  showProgram();
}

const detailSelectCaption = '<button type="button"><selectedcontent></selectedcontent></button>';

function saleOptionLabel(row, variant) {
  const label = variant.label;
  const original = variant.optionValue?.trim();
  const displayLabel = original && !/^\d+(?:\.\d{3})*$/.test(original) ? original : label;
  const { caseSize, caseUnit } = row;
  if (!Number.isSafeInteger(caseSize) || caseSize < 1 || !caseOption(row)) return displayLabel;

  const [, amount, unit] = /^(\d+) (adet|birim)$/.exec(label) ?? [];
  const count = Number(amount);
  if (unit !== caseUnit || !Number.isSafeInteger(count) || count <= caseSize || count % caseSize !== 0) return displayLabel;
  return `${number.format(count / caseSize)} koli · ${number.format(count)} ${unit}`;
}

function saleOptions(row, selected) {
  const variants = row.variants?.length ? row.variants : [{
    id: row.id,
    label: row.saleOptionValue ?? (row.quantity > 1 ? `${number.format(row.quantity)} adet` : 'Standart'),
    optionValue: row.saleOptionValue,
    available: row.stock === 'out' ? false : undefined,
  }];
  const options = variants.map((variant) => {
    const availability = variant.available === false ? ' · Tükendi' : '';
    const active = String(variant.id) === String(selected?.id ?? row.id);
    return `<option value="${escape(variant.id)}" ${active ? 'selected' : ''}>${escape(saleOptionLabel(row, variant))}${availability}</option>`;
  }).join('');
  return detailSelectCaption + options;
}

function productTraitModel(family) {
  const firstOptions = family[0]?.traitOptions;
  if (family.length < 2 || !Array.isArray(firstOptions) || !firstOptions.length) return null;
  if (firstOptions.some((option) => !Number.isInteger(option?.position) || option.position < 1
    || typeof option.name !== 'string' || !option.name.trim())) return null;
  if (new Set(firstOptions.map(({ position }) => position)).size !== firstOptions.length) return null;
  const axes = [...firstOptions].sort((a, b) => a.position - b.position);
  const combinations = [];
  const seen = new Set();
  for (const offer of family) {
    const options = offer.traitOptions;
    if (!Array.isArray(options) || options.length !== axes.length) return null;
    const values = axes.map(({ name, position }) =>
      options.find((option) => option?.position === position && option.name === name)?.value);
    if (values.some((value) => typeof value !== 'string' || !value.trim())) return null;
    const key = JSON.stringify(values);
    if (seen.has(key)) return null;
    seen.add(key);
    combinations.push({ offer, values });
  }
  return { axes, combinations };
}

function showProduct(row, family = [row], variantId) {
  if (!row) return;
  let offer = row;
  let selected = preferredVariant(offer, variantId);
  const description = catalog.descriptions?.[row.handle];
  const hasOffers = family.length > 1;
  const hasPackages = family.some((item) => item.variants?.length);
  const familyPackageName = family.find((item) => item.saleOptionName)?.saleOptionName || 'Satış seçeneği';
  const fixedTraits = row.traitOptions?.map(({ name, value }) => `${name}: ${value}`).join(' · ') || row.traits;
  const traits = productTraitModel(family);
  let activeTraits = traits?.combinations.find((item) => String(item.offer.id) === String(offer.id));

  function traitOffers(index) {
    const prefix = activeTraits.values.slice(0, index);
    return traits.combinations.filter(({ values }) => prefix.every((value, axis) => values[axis] === value));
  }

  function traitSelectOptions(index) {
    const values = new Set(traitOffers(index).map((item) => item.values[index]));
    return detailSelectCaption + [...values].map((value) =>
      `<option value="${escape(value)}" ${value === activeTraits.values[index] ? 'selected' : ''}>${escape(value)}</option>`).join('');
  }

  const detail = get('product-detail');
  detail.innerHTML = `
    <div id="detail-gallery">${productGallery(offer, selected)}</div>
    <div class="detail-content">
      <div class="detail-top">
        ${row.brand ? `<span class="section-kicker">${escape(row.brand)}</span>` : ''}
        <h2 id="detail-title">${escape(row.name)}</h2>
        ${row.type ? `<p>${escape(row.type)}</p>` : ''}
        ${!hasOffers && fixedTraits ? `<p>${escape(fixedTraits)}</p>` : ''}
      </div>
      ${activeTraits ? traits.axes.map(({ name, position }, index) => `<div class="detail-variant">
        <label for="detail-trait-${position}">${escape(name)}</label>
        <div class="select-wrap detail-select">
          <select class="catalog-select" id="detail-trait-${position}">${traitSelectOptions(index)}</select>${icon('down')}
        </div>
      </div>`).join('') : hasOffers ? `<div class="detail-variant">
        <label for="detail-offer">Varyasyon</label>
        <div class="select-wrap detail-select">
          <select class="catalog-select" id="detail-offer">${detailSelectCaption}${family.map((item) =>
            `<option value="${escape(item.id)}" ${String(item.id) === String(offer.id) ? 'selected' : ''}>${escape(item.traits || 'Standart')}</option>`
          ).join('')}</select>${icon('down')}
        </div>
      </div>` : ''}
      ${hasPackages ? `<div class="detail-variant">
        <label id="detail-variant-label" for="detail-variant">${escape(offer.saleOptionName || familyPackageName)}</label>
        <div class="select-wrap detail-select"><select class="catalog-select" id="detail-variant" ${offer.variants?.length ? '' : 'disabled'}>${saleOptions(offer, selected)}</select>${icon('down')}</div>
      </div>` : ''}
      <dl class="detail-grid" id="detail-attributes"></dl>
      <div class="detail-actions">
        <button class="button button-accent" id="detail-open-request" type="button" aria-haspopup="dialog" aria-controls="request-dialog" hidden>${icon('check')} Sepeti aç</button>
        <button class="button button-accent" id="detail-add" type="button">Sepete ekle</button>
        <a class="button" id="detail-shop" href="${productLink(offer, selected?.id)}" target="_blank" rel="noopener noreferrer">Mağazada gör ${icon('external')}</a>
      </div>
      <p class="sr-only" id="detail-status" role="status"></p>
      <p class="detail-error" id="detail-error" role="alert" hidden>Ürün eklenemedi.</p>
      ${row.tags?.length ? `<ul class="detail-tags" aria-label="Ürün etiketleri">${row.tags.map((tag) => `<li>${escape(tag)}</li>`).join('')}</ul>` : ''}
    </div>
    <section class="detail-tabs">
      <div class="detail-tab-list" role="tablist" aria-label="Ürün bilgileri">
        <button id="description-tab" type="button" role="tab" aria-selected="true" aria-controls="description-panel">Ürün açıklaması</button>
        <button id="installments-tab" type="button" role="tab" aria-selected="false" aria-controls="installments-panel" tabindex="-1">Taksit seçenekleri</button>
      </div>
      <div class="detail-panel detail-description" id="description-panel" role="tabpanel" aria-labelledby="description-tab" tabindex="0">
        <p>${escape(description || 'Bu ürün için açıklama paylaşılmamış.')}</p>
      </div>
      <div class="detail-panel" id="installments-panel" role="tabpanel" aria-labelledby="installments-tab" tabindex="0" hidden>
        <div id="installments-status" role="status"></div>
        <div id="installments-options"></div>
      </div>
    </section>`;
  renderProductAttributes(offer, selected);
  const dialog = get('product-dialog');
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const installmentTab = get('installments-tab');
  const installmentStatus = get('installments-status');
  const installmentOptions = get('installments-options');
  const detailStatus = get('detail-status');
  const detailError = get('detail-error');
  const addButton = get('detail-add');
  const openRequest = get('detail-open-request');
  const offerSelect = get('detail-offer');
  const traitSelects = activeTraits ? traits.axes.map(({ position }) => get(`detail-trait-${position}`)) : [];
  const packageSelect = get('detail-variant');
  const packageLabel = get('detail-variant-label');
  const gallery = get('detail-gallery');
  const shop = get('detail-shop');
  let galleryLead = selected?.image || offer.image;
  let installmentRequest;
  let installmentAmount;

  const currentInstallmentAmount = () => Math.round(productPrice(offer, selected) * 100);

  function cancelInstallments() {
    installmentRequest?.controller.abort();
    installmentRequest = null;
    installmentOptions.removeAttribute('aria-busy');
  }

  function showInstallmentQuote(quote) {
    if (quote.programs.length) {
      renderInstallmentPlans(installmentOptions, quote);
      installmentStatus.textContent = '';
    } else {
      installmentStatus.textContent = 'Bu tutar için taksit seçeneği bulunamadı.';
    }
  }

  async function loadInstallments(retry = false) {
    const amount = currentInstallmentAmount();
    const saved = installmentQuotes.get(amount);
    const store = installmentOptions.querySelector('[data-installment-store]');
    if (!retry && Object.is(amount, installmentAmount)
      && (installmentRequest || saved?.expiresAt > Date.now() || store)) {
      if (store) store.href = productLink(offer, selected?.id);
      return;
    }
    installmentAmount = amount;
    cancelInstallments();
    installmentOptions.replaceChildren();
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 999999999) {
      installmentStatus.textContent = 'Bu satış seçeneği için taksit bilgisi bulunamadı.';
      return;
    }

    if (saved && saved.expiresAt > Date.now()) {
      showInstallmentQuote(saved.quote);
      return;
    }
    installmentQuotes.delete(amount);
    installmentStatus.textContent = 'Taksit seçenekleri yükleniyor…';
    installmentOptions.setAttribute('aria-busy', 'true');
    const controller = new AbortController();
    const request = { controller };
    installmentRequest = request;
    const isCurrent = () => installmentRequest === request && dialog.open && installmentOptions.isConnected;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 25000);
    try {
      const quote = await fetchInstallmentQuote(amount, controller.signal);
      if (!isCurrent()) return;
      if (installmentQuotes.size >= 40) installmentQuotes.delete(installmentQuotes.keys().next().value);
      installmentQuotes.set(amount, { quote, expiresAt: Date.now() + 60000 });
      showInstallmentQuote(quote);
    } catch {
      if (!isCurrent()) return;
      installmentStatus.textContent = timedOut
        ? 'Taksit seçenekleri zamanında alınamadı.'
        : 'Taksit seçenekleri şu anda yüklenemedi.';
      installmentOptions.innerHTML = `<button type="button" class="text-button installments-retry">Tekrar dene</button>
        <a class="text-button" data-installment-store href="${productLink(offer, selected?.id)}" target="_blank" rel="noopener noreferrer">Mağazada görüntüle</a>`;
      installmentOptions.querySelector('button').addEventListener('click', () => {
        installmentTab.focus({ preventScroll: true });
        loadInstallments(true);
      });
    } finally {
      clearTimeout(deadline);
      if (installmentRequest === request) {
        installmentRequest = null;
        installmentOptions.removeAttribute('aria-busy');
      }
    }
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => {
      for (const item of tabs) {
        const active = item === tab;
        item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
        get(item.getAttribute('aria-controls')).hidden = !active;
      }
      if (tab === installmentTab) loadInstallments();
    });
    tab.addEventListener('keydown', (event) => {
      const offset = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
      const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)
        : offset ? tabs[(index + offset + tabs.length) % tabs.length] : null;
      if (target) {
        event.preventDefault();
        target.focus();
      }
    });
  }

  function showRequestAction(added) {
    openRequest.hidden = !added;
    addButton.hidden = added;
  }

  function updateSelection() {
    renderProductAttributes(offer, selected);
    const image = selected?.image || offer.image;
    if (image !== galleryLead) {
      galleryLead = image;
      gallery.innerHTML = productGallery(offer, selected);
      activateGallery(gallery, dialog);
    }
    shop.href = productLink(offer, selected?.id);
    detailStatus.textContent = '';
    detailError.hidden = true;
    showRequestAction(false);
    if (installmentTab.getAttribute('aria-selected') === 'true') loadInstallments();
    else if (installmentRequest && !Object.is(installmentAmount, currentInstallmentAmount())) {
      cancelInstallments();
      installmentAmount = undefined;
    }
  }

  function selectOffer(next, preferredId) {
    offer = next;
    selected = preferredVariant(offer, preferredId);
    if (packageSelect) {
      packageSelect.innerHTML = saleOptions(offer, selected);
      packageSelect.disabled = !offer.variants?.length;
      packageLabel.textContent = offer.saleOptionName || familyPackageName;
    }
    updateSelection();
  }

  offerSelect?.addEventListener('change', ({ target }) => {
    const next = family.find((item) => String(item.id) === target.value);
    if (next) selectOffer(next);
  });
  for (const [index, select] of traitSelects.entries()) {
    select.addEventListener('change', () => {
      let matches = traitOffers(index).filter(({ values }) => values[index] === select.value);
      if (!matches.length) return;
      for (let axis = index + 1; axis < traitSelects.length; axis += 1) {
        const preserved = matches.filter(({ values }) => values[axis] === activeTraits.values[axis]);
        if (preserved.length) matches = preserved;
      }
      activeTraits = matches[0];
      for (let axis = index + 1; axis < traitSelects.length; axis += 1) {
        traitSelects[axis].innerHTML = traitSelectOptions(axis);
      }
      const next = activeTraits.offer;
      const packageId = selected?.optionValue != null && offer.saleOptionName === next.saleOptionName
        ? next.variants?.find(({ optionValue }) => optionValue === selected.optionValue)?.id : undefined;
      selectOffer(next, packageId);
    });
  }
  packageSelect?.addEventListener('change', ({ target }) => {
    const next = offer.variants?.find((variant) => String(variant.id) === target.value);
    if (!next) return;
    selected = next;
    updateSelection();
  });
  addButton.addEventListener('click', () => {
    const option = selected && { ...selected, label: saleOptionLabel(offer, selected) };
    const added = addToRequest(offer, option);
    detailError.hidden = added;
    if (!added) return;
    detailStatus.textContent = `Sepete eklendi. Toplam miktar ${number.format(requestCount())}.`;
    if (openRequest.hidden) {
      showRequestAction(true);
      openRequest.focus({ preventScroll: true });
    }
  });
  openRequest.addEventListener('click', () => {
    dialog.close();
    get('request-open').click();
  });
  dialog.addEventListener('close', cancelInstallments, { once: true });
  dialog.showModal();
  dialog.scrollTop = 0;
  detail.scrollTop = 0;
  activateGallery(gallery, dialog);
}

function flash(message, error = false) {
  const toast = get('toast');
  get('toast-icon').innerHTML = icon(error ? 'close' : 'check');
  get('toast-message').textContent = message;
  get('toast-announcement').textContent = message;
  toast.classList.toggle('toast-error', error);
  toast.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.hidden = true;
    get('toast-announcement').textContent = '';
  }, 3200);
}

function findSearchedOffer(offers) {
  const query = fold(valueOf('search').trim());
  if (!query) return null;
  const codes = new Set([query, ...query.split(/\s+/)]);
  const matchesCode = (value) => value && codes.has(fold(value));
  for (const offer of offers) {
    const variant = offer.variants?.find((option) => matchesCode(option.barcode) || matchesCode(option.sku));
    if (variant) return { offer, variantId: variant.id };
    if (matchesCode(offer.barcode) || matchesCode(offer.sku)) return { offer, variantId: offer.id };
    if (matchesCode(offer.caseBarcode)) return { offer, variantId: caseOption(offer)?.id };
  }
  return null;
}

function openFamily(summary) {
  const family = familiesByHandle.get(summary.handle);
  const { chosen } = rowVariantState(summary);
  if (chosen) showProduct(chosen.offer, family, chosen.variant?.id ?? chosen.offer.id);
}

const advancedPanel = get('advanced-panel');
const advancedToggle = get('advanced');

function setAdvancedOpen(open) {
  advancedPanel.hidden = !open;
  advancedToggle.setAttribute('aria-expanded', String(open));
}

function closeAdvanced(restoreFocus = false) {
  setAdvancedOpen(false);
  if (restoreFocus) advancedToggle.focus({ preventScroll: true });
}

const compactSearch = matchMedia('(max-width: 930px), (orientation: landscape) and (max-height: 500px) and (max-width: 1024px)');
const searchInput = get('search');
const searchToggle = get('search-toggle');
const searchDone = get('search-done');
const searchBox = get('catalog-search-box');
const searchRow = searchBox.closest('.filter-row');
let lastSearchFocus;

function updateToolbarMenuSpace() {
  const viewport = window.visualViewport;
  const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
  const available = visibleBottom - searchRow.getBoundingClientRect().bottom - 8;
  searchRow.style.setProperty('--toolbar-menu-space', `${Math.max(0, Math.floor(available))}px`);
}

new ResizeObserver(updateToolbarMenuSpace).observe(searchRow.closest('.topbar'));
window.visualViewport?.addEventListener('resize', updateToolbarMenuSpace);
window.visualViewport?.addEventListener('scroll', updateToolbarMenuSpace);

function setSearchOpen(open) {
  searchRow.classList.toggle('is-search-open', open);
  searchToggle.setAttribute('aria-expanded', String(open));
}

function openSearch(focus = searchInput) {
  if (compactSearch.matches) {
    for (const picker of Object.values(pickers)) picker.close();
    setAdvancedOpen(false);
    if (columnPicker.open) closeColumnPicker(false);
    setSearchOpen(true);
  }
  focus.focus({ preventScroll: true });
}

function closeSearch(restoreFocus = false) {
  if (!searchRow.classList.contains('is-search-open')) return;
  setSearchOpen(false);
  if (restoreFocus) searchToggle.focus({ preventScroll: true });
}

searchToggle.addEventListener('click', () => {
  if (searchRow.classList.contains('is-search-open')) closeSearch(true);
  else openSearch();
});
searchDone.addEventListener('click', () => closeSearch(true));
searchBox.addEventListener('keydown', (event) => {
  if (!searchRow.classList.contains('is-search-open') || event.isComposing) return;
  if (event.key !== 'Escape' && !(event.key === 'Enter' && event.target === searchInput)) return;
  event.preventDefault();
  event.stopPropagation();
  closeSearch(true);
});
searchBox.addEventListener('focusout', ({ relatedTarget }) => {
  if (relatedTarget && relatedTarget !== searchToggle && !searchBox.contains(relatedTarget)) closeSearch();
});
document.addEventListener('focusin', ({ target }) => {
  lastSearchFocus = searchBox.contains(target) || target === searchToggle ? target : null;
});
compactSearch.addEventListener('change', () => {
  const active = document.activeElement;
  // CSS may hide the old control before the media-query event fires.
  const focus = active === document.body && document.hasFocus() ? lastSearchFocus : active;
  if (compactSearch.matches) {
    if (searchBox.contains(focus)) openSearch(focus);
    return;
  }
  setSearchOpen(false);
  if (focus === searchToggle || focus === searchDone || (focus && active !== focus)) {
    searchInput.focus({ preventScroll: true });
  }
});

for (const id of filterIds) get(id).addEventListener('input', resetPage);
get('search-clear').addEventListener('click', () => {
  searchInput.value = '';
  resetPage();
  searchInput.focus({ preventScroll: true });
});
for (const id of ['sort', 'page-size']) get(id).addEventListener('change', resetPage);
get('reset').addEventListener('click', resetFilters);
get('empty-action').addEventListener('click', () => catalog ? resetFilters() : load());
advancedToggle.addEventListener('click', (event) => {
  const open = advancedPanel.hidden;
  setAdvancedOpen(open);
  if (open && event.detail === 0) get('min-price').focus({ preventScroll: true });
});
get('advanced-close').addEventListener('click', () => closeAdvanced(true));
get('active-filters').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-clear]');
  if (!chip) return;
  const { clear: id, value } = chip.dataset;
  const picker = pickers[id];
  if (picker) {
    picker.selection.delete(value);
    picker.update();
    resetPage();
    picker.trigger.focus();
    return;
  }
  get(id).value = defaults[id];
  resetPage();
  (get(id).offsetParent ? get(id) : get('advanced')).focus();
});
get('table-head').addEventListener('click', (event) => {
  const key = event.target.closest('[data-sort]')?.dataset.sort;
  if (!key) return;
  applySort(`${key}:${valueOf('sort') === `${key}:asc` ? 'desc' : 'asc'}`);
  resetPage();
  get('table-head').querySelector(`[data-sort="${key}"]`).focus({ preventScroll: true });
});
function handleProductClick(event) {
  const optionsTrigger = event.target.closest('.card-options-trigger');
  if (optionsTrigger) {
    openCardOptions(optionsTrigger.closest('[data-row-handle]'));
    return;
  }
  const product = event.target.closest('[data-product]');
  const summary = familiesOnPage.get(product?.dataset.product);
  if (summary) openFamily(summary);
}

function handleVariantChange({ target, currentTarget }) {
  const key = target.dataset.rowVariant;
  if (!rowVariantKeys.includes(key)) return;
  const inDialog = currentTarget === cardOptionsFields;
  const item = inDialog ? cardForHandle(cardOptionsHandle) : target.closest('[data-row-handle]');
  if (!item) return;
  const handle = item.dataset.rowHandle;
  const summary = familiesOnPage.get(handle);
  if (!summary) return;

  const previous = rowVariantState(summary);
  const selection = previous.selected;
  if (target.value) selection[key] = target.value;
  else delete selection[key];
  const state = rowVariantState(summary, selection);
  if (Object.keys(state.selected).length) {
    rowVariantSelections.set(handle, { values: state.selected, search: valueOf('search').trim() });
  } else {
    rowVariantSelections.delete(handle);
  }

  const [sortKey, direction] = valueOf('sort').split(':');
  const orderChanged = sortKey !== 'featured' && compareRows(previous.row, state.row, sortKey, direction === 'desc') !== 0;
  const field = state.fields.find((field) => field.key === key);
  const keepControl = hasVariantControl(field);
  const wasFocused = target === document.activeElement;
  if (orderChanged) {
    render({ handle, key });
    if (!inDialog) return;
  } else if (catalogView === 'grid') {
    updateProductCard(item, state, !inDialog && keepControl ? key : null);
  } else {
    for (const [index, column] of selectedColumns().entries()) {
      if (column.key !== key || !keepControl) item.cells[index].innerHTML = rowCell(state, column.key);
    }
  }
  if (inDialog) updateCardOptions(state, keepControl ? key : null);
  if (keepControl) {
    target.title = field.choices.get(field.selected) || field.label;
    target.parentElement.classList.toggle('is-unselected', !field.selected);
  } else if (wasFocused) {
    const next = inDialog ? get('card-options-done') : item.querySelector('[data-product]');
    next?.focus({ preventScroll: true });
  }
}

for (const results of [tableBody, cardGrid]) {
  results.addEventListener('click', handleProductClick);
  results.addEventListener('change', handleVariantChange);
}
cardOptionsFields.addEventListener('change', handleVariantChange);
cardOptionsDialog.addEventListener('close', () => {
  if (cardOptionsDialog.open) return;
  const card = cardForHandle(cardOptionsHandle);
  cardOptionsHandle = null;
  const trigger = card?.querySelector('.card-options-trigger');
  const opener = mobileLayout.matches && trigger && !trigger.hidden
    ? trigger : card?.querySelector('[data-row-variant]') ?? card?.querySelector('[data-product]');
  (opener ?? (cardScroll.hidden ? viewControl : cardScroll)).focus();
});

for (const [id, increment] of [['previous', -1], ['next', 1]]) {
  get(id).addEventListener('click', () => {
    page += increment;
    const scroller = activeCatalogScroll();
    scroller.scrollTop = 0;
    render();
    if (get(id).disabled) scroller.focus({ preventScroll: true });
  });
}
const columnOptions = get('column-options');
const columnPicker = columnOptions.closest('.column-picker');
const columnTrigger = columnPicker.querySelector('summary');
const columnRows = new Map();
const columnsReset = get('columns-reset');
const columnOrderStatus = get('column-order-status');
for (const { key, label } of columns) {
  const { item, input } = menuCheckbox(key, label);
  input.checked = !hiddenColumns.has(key);
  input.disabled = key === pinnedColumnKey;
  const row = document.createElement('div');
  row.className = 'column-option';
  row.dataset.column = key;
  row.dataset.columnLabel = label;
  row.append(item);
  if (key === pinnedColumnKey) {
    row.dataset.columnFixed = '';
    input.setAttribute('aria-label', `${label}, ilk sırada sabit`);
    const note = document.createElement('span');
    note.className = 'column-lock-label';
    note.textContent = 'Sabit';
    item.append(note);
    const lock = document.createElement('span');
    lock.className = 'column-lock';
    lock.setAttribute('aria-hidden', 'true');
    lock.innerHTML = icon('lock');
    row.append(lock);
  } else {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'column-drag';
    handle.setAttribute('aria-label', `${label} sütununu taşı`);
    handle.setAttribute('aria-describedby', 'column-order-help');
    handle.innerHTML = icon('grip');
    row.append(handle);
  }
  columnRows.set(key, row);
}

function syncColumnMenu() {
  for (const key of currentColumnOrder()) columnOptions.append(columnRows.get(key));
  columnsReset.hidden = !customColumnOrder;
}

syncColumnMenu();
const migratedOrder = Array.isArray(savedOrder) && (!customColumnOrder || customColumnOrder.length !== savedOrder.length
  || customColumnOrder.some((key, index) => key !== savedOrder[index]));
if ((columnSettingsVersion < 3 && columnSettings) || migratedOrder) saveColumnSettings();
const cancelColumnReorder = initColumnReorder(columnOptions, (order) => {
  customColumnOrder = normalizeColumnOrder(order);
  columnsReset.hidden = false;
  saveColumnSettings();
  render();
}, (message) => { columnOrderStatus.textContent = message; });

columnOptions.addEventListener('change', (event) => {
  if (event.target.type !== 'checkbox' || event.target.value === pinnedColumnKey) return;
  if (event.target.checked) hiddenColumns.delete(event.target.value);
  else hiddenColumns.add(event.target.value);
  saveColumnSettings();
  render();
});
columnsReset.addEventListener('click', () => {
  cancelColumnReorder();
  customColumnOrder = null;
  syncColumnMenu();
  saveColumnSettings();
  render();
  columnOrderStatus.textContent = 'Varsayılan sütun sırası geri yüklendi.';
  get('columns-done').focus({ preventScroll: true });
});
function closeColumnPicker(restoreFocus = true) {
  cancelColumnReorder();
  columnPicker.open = false;
  if (restoreFocus) columnTrigger.focus({ preventScroll: true });
}
function syncCatalogView() {
  const showCards = catalogView === 'grid';
  if (showCards && columnPicker.open) closeColumnPicker(false);
  columnPicker.hidden = showCards;
  get('column-resize-help').hidden = showCards;
  document.documentElement.dataset.catalogView = catalogView;
  viewControl.value = catalogView;
}

syncCatalogView();
viewControl.addEventListener('change', () => {
  catalogView = viewControl.value === 'grid' ? 'grid' : 'list';
  syncCatalogView();
  try {
    localStorage.setItem(viewStorageKey, catalogView);
  } catch {
    // Keep the chosen view in this tab if browser storage is unavailable.
  }
  activeCatalogScroll().scrollTop = 0;
  render();
});

get('columns-done').addEventListener('click', () => closeColumnPicker());
columnPicker.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !columnPicker.open) return;
  event.preventDefault();
  event.stopPropagation();
  closeColumnPicker();
});
columnPicker.addEventListener('focusout', (event) => {
  if (event.relatedTarget && !columnPicker.contains(event.relatedTarget)) {
    cancelColumnReorder();
    columnPicker.open = false;
  }
});
mobileLayout.addEventListener('change', () => {
  cancelColumnReorder();
  if (!customColumnOrder) syncColumnMenu();
  render();
});
const toolbarDismiss = get('toolbar-dismiss');
document.addEventListener('click', ({ target }) => {
  const dismissedFromOutside = target === toolbarDismiss;
  if (!searchBox.contains(target) && !searchToggle.contains(target)) {
    closeSearch(dismissedFromOutside || searchBox.contains(document.activeElement));
    if (document.activeElement === document.body) lastSearchFocus = null;
  }
  for (const picker of Object.values(pickers)) {
    if (!picker.panel.hidden && !picker.root.contains(target)) picker.close(dismissedFromOutside);
  }
  if (!advancedPanel.hidden && !advancedToggle.contains(target) && !advancedPanel.contains(target)) {
    closeAdvanced(dismissedFromOutside);
  }
  if (columnPicker.open && !columnPicker.contains(target)) closeColumnPicker(dismissedFromOutside);
}, { capture: true });
document.addEventListener('focusin', ({ target }) => {
  if (!advancedPanel.hidden && target !== advancedToggle && !advancedPanel.contains(target)) closeAdvanced();
});
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey
    && !event.target.closest('input, select, textarea, [contenteditable], dialog')) {
    event.preventDefault();
    openSearch();
  }
  if (event.key === 'Escape') {
    if (!advancedPanel.hidden && !event.target.closest('dialog')) closeAdvanced(true);
  }
});
document.addEventListener('error', (event) => {
  const element = event.target;
  if (element instanceof HTMLImageElement && element.closest('.thumb, .card-image')) {
    element.parentElement.innerHTML = icon('box');
  }
}, true);
get('share').addEventListener('click', async () => {
  const url = new URL('/', location.href).href;
  try {
    await navigator.clipboard.writeText(url);
    flash('Katalog bağlantısı kopyalandı');
  } catch {
    window.prompt('Katalog bağlantısı', url);
  }
});

initRequest();
load();
