import { initBackdropDismiss } from './dialog-dismiss.js';
import { deliverDraft } from './submit-request.js';
import { salePrice, stepQuantity, validQuantity, wholesaleLimits, wholesaleMoney, wholesaleRule, wholesaleUnitCents } from './wholesale.js';

const STORAGE_KEY = 'alacam-katalog-talep-v1';
const NOTE_STORAGE_KEY = 'alacam-katalog-talep-notu-v1';
const PENDING_KEY = 'alacam-katalog-bekleyen-talep-v1';
let pendingRequest = null;
let submitting = false;
let submissionMessage = '';
const MAX_STORED_QUANTITY = 2147483647;
const formatQuantity = new Intl.NumberFormat('tr-TR');
const IMAGE_HOSTS = new Set(['alacamdagitim.com', 'cdn.shopify.com']);
const EMPTY_THUMBNAIL = '<svg class="icon" aria-hidden="true"><use href="#i-box"/></svg>';

let items = [];
let ui;
let catalogReady = false;
const offersById = new Map();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function isQuantity(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_STORED_QUANTITY;
}

function stockOf(row, variant) {
  if (variant?.available === true) return 'in';
  if (variant?.available === false) return 'out';
  return row.stock;
}

export function requestStock(row, variant) {
  const current = offersById.get(String(variant?.id ?? row.id));
  return current ? stockOf(current.row, current.variant) : stockOf(row, variant);
}

export function requestAvailability(row, variant) {
  if (catalogReady && !offersById.has(String(variant?.id ?? row.id))) return 'missing';
  return requestStock(row, variant) === 'out' ? 'out' : null;
}

export function requestOrder(row, variant) {
  const id = String(variant?.id ?? row.id);
  const current = offersById.get(id) ?? { row, variant };
  const rule = wholesaleRule(current.row, current.variant);
  return {
    rule,
    price: salePrice(current.row, current.variant),
    quantity: items.find((item) => item.id === id)?.quantity,
    ...wholesaleLimits(rule),
  };
}

function lineState(item) {
  const current = offersById.get(item.id);
  const { row, variant } = current ?? {};
  const unavailable = row ? requestAvailability(row, variant) : catalogReady ? 'missing' : null;
  const rule = row ? wholesaleRule(row, variant) : null;
  const unitCents = rule ? wholesaleUnitCents(rule, salePrice(row, variant), item.quantity) : null;
  const limits = wholesaleLimits(rule);
  return {
    unavailable,
    ...limits,
    valid: validQuantity(item.quantity, limits),
    unitCents,
    subtotal: unitCents == null ? null : BigInt(unitCents) * BigInt(item.quantity),
  };
}

function requestTotal(states) {
  return states.length && states.every(({ subtotal }) => subtotal != null)
    ? states.reduce((total, { subtotal }) => total + subtotal, 0n) : null;
}

function linePrice({ unitCents, subtotal, unavailable, valid }) {
  if (unavailable || !valid || subtotal == null) return '';
  return `${wholesaleMoney(unitCents)} / birim · ${wholesaleMoney(subtotal)}`;
}

function trustedImageURL(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && IMAGE_HOSTS.has(url.hostname)
      && !url.username && !url.password && !url.port) return url.href;
  } catch {
    // Older lists can be missing a usable image URL.
  }
  return null;
}

function thumbnailContent(value) {
  const image = trustedImageURL(value);
  return image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async">` : EMPTY_THUMBNAIL;
}

function readItems() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(stored) ? stored.filter((item) => item
      && typeof item.id === 'string' && typeof item.name === 'string' && isQuantity(item.quantity)) : [];
  } catch {
    return [];
  }
}

function readNote() {
  try {
    return (localStorage.getItem(NOTE_STORAGE_KEY) ?? '').slice(0, ui.note.maxLength);
  } catch {
    return '';
  }
}

function saveValue(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Keep the current list usable if browser storage is unavailable.
  }
}

function saveItems() {
  saveValue(STORAGE_KEY, JSON.stringify(items));
}

function lineDescription(item) {
  return [item.traits, item.option].filter(Boolean).join(' · ');
}

export function requestCount() {
  return items.reduce((count, item) => count + item.quantity, 0);
}

function updateActions() {
  const count = requestCount();
  const states = items.map(lineState);
  const blocked = states.some(({ unavailable, valid }) => unavailable || !valid);
  const enabled = catalogReady && Boolean(items.length) && !blocked;
  const total = enabled ? requestTotal(states) : null;
  ui.count.textContent = formatQuantity.format(count);
  ui.count.hidden = count === 0;
  ui.empty.hidden = items.length > 0 || !ui.result.hidden;
  ui.form.hidden = !items.length && !pendingRequest;
  ui.dialog.dataset.empty = String(!items.length && !pendingRequest);
  ui.send.disabled = submitting || Boolean(pendingRequest) || !enabled;
  ui.send.setAttribute('aria-disabled', String(ui.send.disabled));
  ui.send.textContent = submitting ? 'Gönderiliyor…' : 'Talep oluştur';
  ui.fields.disabled = submitting || Boolean(pendingRequest);
  ui.dialog.dataset.submitting = String(submitting || Boolean(pendingRequest));
  for (const control of ui.list.querySelectorAll('input, button')) {
    if (submitting || pendingRequest) control.disabled = true;
  }
  ui.total.hidden = total == null;
  ui.totalAmount.textContent = total == null ? '' : wholesaleMoney(total);
  ui.status.textContent = submissionMessage || (blocked ? 'Devam etmek için işaretli ürünleri veya miktarları kontrol edin.'
    : !catalogReady && items.length ? 'Katalog ve talep fiyatları doğrulanıyor…' : '');
  if (ui.note) ui.note.disabled = !items.length || submitting || Boolean(pendingRequest);
}

function render() {
  if (!ui) return;
  ui.list.innerHTML = items.map((item) => {
    const description = lineDescription(item);
    const label = escapeHtml([item.name, description].filter(Boolean).join(' · '));
    const state = lineState(item);
    const { unavailable, valid, minimum, maximum, increment } = state;
    const disabled = Boolean(unavailable);
    const price = linePrice(state);
    const message = unavailable === 'out' ? 'Tükendi' : unavailable ? 'Katalog dışı'
      : !valid ? `Miktarı güncelle · En az ${formatQuantity.format(minimum)} · Adım ${formatQuantity.format(increment)}` : '';
    return `
      <li class="request-item" data-request-item="${escapeHtml(item.id)}">
        <span class="request-item-thumb" aria-hidden="true">${thumbnailContent(item.image)}</span>
        <div class="request-item-info">
          <strong class="request-item-title" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
          ${description ? `<span class="request-item-option" title="${escapeHtml(description)}">${escapeHtml(description)}</span>` : ''}
          <span class="request-item-stock stock out" ${message ? '' : 'hidden'}>${message}</span>
          <span class="request-item-price" ${price ? '' : 'hidden'}>${price}</span>
          <div class="request-quantity quantity-stepper">
            <button type="button" data-quantity-step="-1" aria-label="${label} miktarını azalt" aria-disabled="${disabled || stepQuantity(item.quantity, state, -1) == null}">
              <svg class="icon" aria-hidden="true"><use href="#i-minus"/></svg>
            </button>
            <input type="number" inputmode="numeric" min="${minimum}" max="${maximum}" step="${increment}"
              value="${item.quantity}" aria-label="${label} miktarı" aria-invalid="${!valid}" ${disabled ? 'disabled' : ''}>
            <button type="button" data-quantity-step="1" aria-label="${label} miktarını artır" aria-disabled="${disabled || stepQuantity(item.quantity, state, 1) == null}">
              <svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>
            </button>
          </div>
        </div>
        <button class="request-remove" type="button" title="Talepten kaldır" aria-label="${label} ürününü talepten kaldır">
          <svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>
        </button>
      </li>`;
  }).join('');
  updateActions();
}

function syncQuantityControls(item, input) {
  const state = lineState(item);
  const controls = input.closest('.request-quantity');
  const row = input.closest('[data-request-item]');
  const price = row.querySelector('.request-item-price');
  price.textContent = linePrice(state);
  price.hidden = !price.textContent;
  if (state.valid && !state.unavailable) row.querySelector('.request-item-stock').hidden = true;
  input.setAttribute('aria-invalid', String(!state.valid));
  for (const button of controls.querySelectorAll('[data-quantity-step]')) {
    const next = stepQuantity(item.quantity, state, Number(button.dataset.quantityStep));
    button.setAttribute('aria-disabled', String(Boolean(state.unavailable) || next == null));
  }
}

function updateQuantity(item, input, quantity) {
  const state = lineState(item);
  if (submitting || pendingRequest || state.unavailable || !validQuantity(quantity, state)) return;
  item.quantity = quantity;
  syncQuantityControls(item, input);
  saveItems();
  updateActions();
}

export function setRequestQuantity(row, variant, quantity) {
  if (submitting || pendingRequest || row?.id == null || !row.name) return false;
  submissionMessage = '';
  if (ui) ui.result.hidden = true;
  const selected = variant ?? row.variants?.find((option) => String(option.id) === String(row.id));
  if (requestAvailability(row, selected)) return false;
  const id = String(selected?.id ?? row.id);
  const existing = items.find((item) => item.id === id);
  if (!validQuantity(quantity, requestOrder(row, selected))) return false;

  const primary = id === String(row.id);
  let option = selected?.label;
  if (option === 'Standart') option = '';
  if (!option && primary && row.quantity > 1) option = `${formatQuantity.format(row.quantity)} adet`;
  const item = {
    id,
    name: row.name,
    traits: row.traits,
    option,
    sku: selected?.sku ?? (primary ? row.sku : null),
    barcode: selected?.barcode ?? (primary ? row.barcode : null),
    image: trustedImageURL(selected?.image) || trustedImageURL(row.image) || trustedImageURL(existing?.image),
    quantity,
  };
  if (existing) Object.assign(existing, item);
  else items.push(item);
  saveItems();
  render();
  ui?.open.dispatchEvent(new CustomEvent('request:added', {
    bubbles: true,
    detail: { count: requestCount(), quantity },
  }));
  return true;
}

export function hydrateRequest(rows) {
  catalogReady = true;
  offersById.clear();
  for (const row of rows) {
    offersById.set(String(row.id), { row });
    for (const variant of row.variants ?? []) {
      offersById.set(String(variant.id), { row, variant });
    }
  }
  let changed = false;
  for (const item of items) {
    const { row, variant } = offersById.get(item.id) ?? {};
    if (!row || trustedImageURL(item.image)) continue;
    const image = trustedImageURL(variant?.image) || trustedImageURL(row.image);
    if (!image) continue;
    item.image = image;
    changed = true;
  }
  if (changed) saveItems();
  const focused = ui?.list.contains(document.activeElement) ? document.activeElement : null;
  const focusedId = focused?.closest('[data-request-item]')?.dataset.requestItem;
  const controlIndex = focusedId ? [...focused.closest('[data-request-item]').querySelectorAll('button, input')].indexOf(focused) : -1;
  render();
  if (controlIndex >= 0) {
    const row = [...ui.list.children].find((entry) => entry.dataset.requestItem === focusedId);
    const controls = row?.querySelectorAll('button, input');
    const control = controls?.[controlIndex];
    (control?.disabled ? controls[controls.length - 1] : control)?.focus({ preventScroll: true });
  }
}

export function initRequest() {
  if (ui) return;
  const get = (id) => document.getElementById(id);
  ui = {
    open: get('request-open'),
    count: get('request-count'),
    dialog: get('request-dialog'),
    list: get('request-items'),
    empty: get('request-empty'),
    note: get('request-note'),
    send: get('request-send'),
    status: get('request-status'),
    total: get('request-total'),
    totalAmount: get('request-total-amount'),
    form: get('request-contact'), fields: get('request-fields'), result: get('request-result'),
    company: get('request-company'), name: get('request-name'), email: get('request-email'), phone: get('request-phone'), website: get('request-website'),
  };
  items = readItems();
  if (ui.note) ui.note.value = readNote();
  try {
    const saved = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
    if (saved?.requestId && Array.isArray(saved.items) && saved.contact) {
      pendingRequest = saved;
      for (const key of ['company', 'name', 'email', 'phone']) ui[key].value = saved.contact[key] ?? '';
      ui.note.value = saved.note;
      submissionMessage = 'Talebiniz gönderiliyor…';
    }
  } catch { /* Session persistence may be unavailable. */ }
  render();

  ui.open.addEventListener('click', () => {
    if (!ui.dialog.open) ui.dialog.showModal();
  });
  ui.result.addEventListener('click', (event) => {
    if (!event.target.closest('[data-new-request]') || submitting || pendingRequest) return;
    ui.result.hidden = true;
    ui.result.replaceChildren();
    submissionMessage = '';
    render();
    ui.dialog.close();
    ui.open.dispatchEvent(new Event('request:new'));
  });
  initBackdropDismiss(ui.dialog);
  ui.list.addEventListener('error', (event) => {
    const thumb = event.target.parentElement;
    if (event.target.tagName === 'IMG' && thumb?.classList.contains('request-item-thumb')) {
      thumb.innerHTML = EMPTY_THUMBNAIL;
    }
  }, true);
  ui.list.addEventListener('input', (event) => {
    const input = event.target;
    if (!input.matches('.request-quantity input')) return;
    const item = items.find((entry) => entry.id === input.closest('[data-request-item]').dataset.requestItem);
    const quantity = input.valueAsNumber;
    if (!item || !/^\d+$/.test(input.value) || !validQuantity(quantity, lineState(item))) return;
    const normalized = String(quantity);
    if (input.value !== normalized) input.value = normalized;
    updateQuantity(item, input, quantity);
  });
  function finishQuantityEdit(event) {
    const input = event.target;
    if (!input.matches('.request-quantity input')) return;
    const item = items.find((entry) => entry.id === input.closest('[data-request-item]').dataset.requestItem);
    if (!item || input.value === String(item.quantity)) return;
    const { minimum, increment } = lineState(item);
    input.value = String(item.quantity);
    ui.status.textContent = `Önceki miktar korundu. En az ${formatQuantity.format(minimum)} · Adım ${formatQuantity.format(increment)}`;
  }
  ui.list.addEventListener('change', finishQuantityEdit);
  ui.list.addEventListener('focusout', finishQuantityEdit);
  ui.list.addEventListener('click', (event) => {
    if (submitting || pendingRequest) return;
    const button = event.target.closest('.request-remove, [data-quantity-step]');
    if (!button) return;
    const row = button.closest('[data-request-item]');
    const id = row.dataset.requestItem;
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return;
    if (button.dataset.quantityStep) {
      if (button.getAttribute('aria-disabled') === 'true') return;
      const item = items[index];
      const quantity = stepQuantity(item.quantity, lineState(item), Number(button.dataset.quantityStep));
      if (quantity == null) return;
      const input = row.querySelector('.request-quantity input');
      input.value = quantity;
      updateQuantity(item, input, quantity);
      return;
    }
    items = items.filter((item) => item.id !== id);
    saveItems();
    render();
    const nextRow = ui.list.children[Math.min(index, items.length - 1)];
    (nextRow?.querySelector('.request-remove') ?? ui.dialog.querySelector('.request-close'))?.focus();
  });
  ui.note?.addEventListener('input', () => {
    submissionMessage = '';
    saveValue(NOTE_STORAGE_KEY, ui.note.value.slice(0, ui.note.maxLength));
    updateActions();
  });
  async function sendRequest(event) {
    event?.preventDefault();
    if (submitting || (!pendingRequest && ui.send.disabled)) return;
    if (!pendingRequest && !ui.form.reportValidity()) return;
    if (!pendingRequest) {
      pendingRequest = {
        requestId: crypto.randomUUID(),
        contact: Object.fromEntries(['company', 'name', 'email', 'phone'].map(key => [key, ui[key].value.trim()])),
        note: ui.note.value.trim(),
        website: ui.website.value,
        items: items.map(item => ({ id: item.id, quantity: item.quantity, unitCents: lineState(item).unitCents })),
      };
      // Persist before sending: a reload must reuse the same request ID.
      try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pendingRequest)); }
      catch {
        pendingRequest = null;
        submissionMessage = 'Talep göndermek için bu sekmede tarayıcı depolamasına izin verin.';
        updateActions(); return;
      }
    }
    const sent = pendingRequest;
    submitting = true;
    submissionMessage = 'Fiyatlar ve koli adetleri kontrol ediliyor, talebiniz gönderiliyor…';
    updateActions();
    try {
      const result = await deliverDraft(sent);
      if (result.created === true) {
        // Keep any other products added in another tab while this request was sent.
        items = readItems().flatMap(item => {
          const submitted = sent.items.find(line => line.id === item.id);
          const quantity = item.quantity - (submitted?.quantity ?? 0);
          return quantity > 0 ? [{ ...item, quantity }] : [];
        });
        saveItems();
        if (ui.note.value.trim() === sent.note) { ui.note.value = ''; saveValue(NOTE_STORAGE_KEY, ''); }
        pendingRequest = null;
        sessionStorage.removeItem(PENDING_KEY);
        submissionMessage = '';
        ui.website.value = '';
        ui.result.innerHTML = `<strong>${result.duplicate ? 'Bu talep zaten alındı' : 'Talebiniz alındı'} · ${escapeHtml(result.name)}</strong><p>${result.duplicate
          ? 'Aynı içerikli talebiniz zaten kayıtlı. Yeni ürünler veya farklı bir not ile yeni talep oluşturabilirsiniz.'
          : 'Sipariş talebiniz ekibimize iletildi. İletişim bilgileriniz üzerinden size dönüş yapacağız.'}</p><button type="button" class="button button-accent" data-new-request>Yeni talep oluştur</button>`;
        ui.result.hidden = false;
        ui.result.tabIndex = -1;
        ui.result.focus({ preventScroll: true });
        ui.open.dispatchEvent(new Event('request:changed'));
      } else {
        submissionMessage = typeof result.error === 'string' ? result.error : 'Talebin durumu doğrulanamadı.';
        if (result.safeToEdit === true) {
          pendingRequest = null; sessionStorage.removeItem(PENDING_KEY);
          if (['price_changed', 'quantity_changed', 'catalog_changed', 'unavailable'].includes(result.code)) window.dispatchEvent(new Event('catalog:refresh'));
        } else submissionMessage += ' Talep kodu: ' + sent.requestId;
      }
    } catch {
      submissionMessage = 'Talebin sonucu doğrulanamadı. Bizimle iletişime geçebilirsiniz. Talep kodu: ' + sent.requestId;
    } finally {
      submitting = false;
      render();
    }
  }
  ui.form.addEventListener('submit', sendRequest);
  if (pendingRequest) void sendRequest();
  window.addEventListener('storage', (event) => {
    const noteChanged = ui.note && (event.key === NOTE_STORAGE_KEY || event.key === null);
    if (noteChanged) ui.note.value = readNote();
    if (event.key === STORAGE_KEY || event.key === null) {
      items = readItems();
      render();
      ui.open.dispatchEvent(new Event('request:changed'));
    } else if (noteChanged) {
      updateActions();
    }
  });
}
