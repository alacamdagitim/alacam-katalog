import { initBackdropDismiss } from './dialog-dismiss.js';

const STORAGE_KEY = 'alacam-katalog-talep-v1';
const NOTE_STORAGE_KEY = 'alacam-katalog-talep-notu-v1';
const WHATSAPP_URL = 'https://wa.me/905301480040';
const MAX_QUANTITY = 999999;
const formatQuantity = new Intl.NumberFormat('tr-TR');
const IMAGE_HOSTS = new Set(['alacamdagitim.com', 'cdn.shopify.com']);
const EMPTY_THUMBNAIL = '<svg class="icon" aria-hidden="true"><use href="#i-box"/></svg>';

let items = [];
let ui;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function isQuantity(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_QUANTITY;
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

function requestText() {
  const lines = items.map((item, index) => {
    const name = [item.name, lineDescription(item)].filter(Boolean).join(' · ');
    const identifiers = [
      item.sku && `Ürün kodu ${item.sku}`,
      item.barcode && `Barkod ${item.barcode}`,
      `Varyant no ${item.id}`,
    ].filter(Boolean);
    return `${index + 1}. ${formatQuantity.format(item.quantity)} × ${name}\n   ${identifiers.join(' · ')}`;
  });
  const note = ui.note?.value.trim();
  return [
    'Merhaba, aşağıdaki ürünler için teklif rica ederim.',
    lines.join('\n'),
    note && `Not: ${note}`,
  ].filter(Boolean).join('\n\n');
}

export function requestCount() {
  return items.reduce((count, item) => count + item.quantity, 0);
}

function updateActions() {
  const count = requestCount();
  ui.count.textContent = formatQuantity.format(count);
  ui.count.hidden = count === 0;
  ui.empty.hidden = items.length > 0;
  ui.copy.disabled = !items.length;
  ui.send.setAttribute('aria-disabled', String(!items.length));
  ui.status.textContent = '';
  ui.preview.hidden = true;
  if (items.length) {
    const url = new URL(WHATSAPP_URL);
    url.searchParams.set('text', requestText());
    ui.send.href = url.href;
  } else {
    ui.send.removeAttribute('href');
  }
  if (ui.note) ui.note.disabled = !items.length;
}

function render() {
  if (!ui) return;
  ui.list.innerHTML = items.map((item) => {
    const description = lineDescription(item);
    const label = escapeHtml([item.name, description].filter(Boolean).join(' · '));
    return `
      <li class="request-item" data-request-item="${escapeHtml(item.id)}">
        <span class="request-item-thumb" aria-hidden="true">${thumbnailContent(item.image)}</span>
        <div class="request-item-info">
          <strong class="request-item-title" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
          ${description ? `<span class="request-item-option" title="${escapeHtml(description)}">${escapeHtml(description)}</span>` : ''}
          <div class="request-quantity">
            <button type="button" data-quantity-step="-1" aria-label="${label} miktarını azalt" aria-disabled="${item.quantity === 1}">
              <svg class="icon" aria-hidden="true"><use href="#i-minus"/></svg>
            </button>
            <input type="number" inputmode="numeric" min="1" max="${MAX_QUANTITY}" step="1"
              value="${item.quantity}" aria-label="${label} miktarı">
            <button type="button" data-quantity-step="1" aria-label="${label} miktarını artır" aria-disabled="${item.quantity === MAX_QUANTITY}">
              <svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>
            </button>
          </div>
        </div>
        <button class="request-remove" type="button" title="Sepetten kaldır" aria-label="${label} ürününü sepetten kaldır">
          <svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>
        </button>
      </li>`;
  }).join('');
  updateActions();
}

function updateQuantity(item, input, quantity) {
  item.quantity = quantity;
  const controls = input.closest('.request-quantity');
  controls.querySelector('[data-quantity-step="-1"]').setAttribute('aria-disabled', String(quantity === 1));
  controls.querySelector('[data-quantity-step="1"]').setAttribute('aria-disabled', String(quantity === MAX_QUANTITY));
  saveItems();
  updateActions();
}

export function addToRequest(row, variant) {
  if (row?.id == null || !row.name) return false;
  const selected = variant ?? row.variants?.find((option) => String(option.id) === String(row.id));
  const id = String(selected?.id ?? row.id);
  const existing = items.find((item) => item.id === id);
  const quantity = (existing?.quantity ?? 0) + 1;
  if (!isQuantity(quantity)) return false;

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
  const pending = new Map(items.filter((item) => !trustedImageURL(item.image)).map((item) => [item.id, item]));
  if (!pending.size) return;

  const images = new Map();
  for (const row of rows) {
    for (const variant of [...(row.variants ?? []), row]) {
      const item = pending.get(String(variant.id));
      if (!item) continue;
      const image = trustedImageURL(variant.image) || trustedImageURL(row.image);
      if (!image) continue;
      item.image = image;
      images.set(item.id, image);
      pending.delete(item.id);
    }
    if (!pending.size) break;
  }
  if (!images.size) return;

  saveItems();
  for (const thumb of ui?.list.querySelectorAll('.request-item-thumb') ?? []) {
    const image = images.get(thumb.parentElement.dataset.requestItem);
    if (image) thumb.innerHTML = thumbnailContent(image);
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
    copy: get('request-copy'),
    send: get('request-send'),
    status: get('request-status'),
    preview: document.createElement('textarea'),
  };
  ui.preview.className = 'request-copy-preview';
  ui.preview.setAttribute('aria-label', 'Talep metni');
  ui.preview.readOnly = true;
  ui.preview.hidden = true;
  ui.status.after(ui.preview);
  items = readItems();
  if (ui.note) ui.note.value = readNote();
  render();

  ui.open.addEventListener('click', () => {
    if (!ui.dialog.open) ui.dialog.showModal();
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
    if (!item || !isQuantity(quantity)) return;
    const normalized = String(quantity);
    if (input.value !== normalized) input.value = normalized;
    updateQuantity(item, input, quantity);
  });
  function finishQuantityEdit(event) {
    const input = event.target;
    if (!input.matches('.request-quantity input')) return;
    const item = items.find((entry) => entry.id === input.closest('[data-request-item]').dataset.requestItem);
    if (item && input.value !== String(item.quantity)) input.value = String(item.quantity);
  }
  ui.list.addEventListener('change', finishQuantityEdit);
  ui.list.addEventListener('focusout', finishQuantityEdit);
  ui.list.addEventListener('click', (event) => {
    const button = event.target.closest('.request-remove, [data-quantity-step]');
    if (!button) return;
    const row = button.closest('[data-request-item]');
    const id = row.dataset.requestItem;
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return;
    if (button.dataset.quantityStep) {
      const item = items[index];
      const quantity = item.quantity + Number(button.dataset.quantityStep);
      if (!isQuantity(quantity)) return;
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
    saveValue(NOTE_STORAGE_KEY, ui.note.value.slice(0, ui.note.maxLength));
    updateActions();
  });
  ui.send.addEventListener('click', (event) => {
    if (!items.length) event.preventDefault();
  });
  ui.copy.addEventListener('click', async () => {
    const draft = requestText();
    try {
      await navigator.clipboard.writeText(draft);
      ui.status.textContent = 'Talep metni kopyalandı.';
    } catch {
      ui.preview.value = draft;
      ui.preview.hidden = false;
      ui.preview.focus();
      ui.preview.select();
      ui.status.textContent = 'Talep metnini kopyalayabilirsiniz.';
    }
  });
  window.addEventListener('storage', (event) => {
    const noteChanged = ui.note && (event.key === NOTE_STORAGE_KEY || event.key === null);
    if (noteChanged) ui.note.value = readNote();
    if (event.key === STORAGE_KEY || event.key === null) {
      items = readItems();
      render();
    } else if (noteChanged) {
      updateActions();
    }
  });
}
