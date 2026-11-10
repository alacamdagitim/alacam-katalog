const storageKey = 'alacam-katalog-sutun-genislikleri-v1';
const handleSelector = 'button.column-resize[data-resize-column]';
const middleGutter = 94;
const dragThreshold = 3;
const touchDragThreshold = 5;
const defaultSize = [68, 108, 300];
const columnSizes = new Map(Object.entries({
  // Minimum, default and maximum widths in pixels.
  name: [105, 250, 720],
  type: [68, 100, 320],
  brand: [80, 124, 360],
  variant1: [83, 126, 440],
  variant2: [83, 126, 440],
  sku: [82, 108, 280],
  barcode: [88, 112, 260],
  caseBarcode: [88, 118, 260],
  quantity: [75, 116, 300],
  caseSize: [64, 78, 200],
  price: [82, 108, 270],
}));

const clamp = (value, min, max) => Math.min(max, Math.max(min, Math.round(value)));
const sizeFor = (key) => columnSizes.get(key) ?? defaultSize;

function readWidths() {
  const widths = new Map();
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return widths;
    for (const [savedKey, value] of Object.entries(saved)) {
      const key = savedKey === 'traits' && !Object.hasOwn(saved, 'variant1') ? 'variant1' : savedKey;
      if (!columnSizes.has(key) || !Number.isFinite(value)) continue;
      const [min, , max] = sizeFor(key);
      widths.set(key, clamp(value, min, max));
    }
  } catch {
    // Default widths remain available when browser storage is unavailable.
  }
  return widths;
}

export function initColumnWidths({ table, scroller, colgroup, head, mobileLayout, onResize }) {
  const preferred = readWidths();
  let keys = [];
  let cols = new Map();
  let rendered = new Map();
  let viewport = scroller.clientWidth || window.innerWidth || 320;
  let drag;
  let lastPointerResize;
  let resizedClick;

  table.style.tableLayout = 'fixed';
  table.style.minWidth = '0';

  function saveWidths() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(preferred)));
    } catch {
      // Continue with the widths in this tab.
    }
  }

  function fitWidth(key, width) {
    const [min, , max] = sizeFor(key);
    if (key !== 'name') return clamp(width, min, max);
    const cap = Math.min(max, Math.max(48, viewport - middleGutter));
    return clamp(width, Math.min(min, cap), cap);
  }

  function defaultWidth(key) {
    const [, width] = sizeFor(key);
    if (key !== 'name') return width;
    return mobileLayout.matches ? clamp(134 + (viewport - 320) * 0.18, 132, 155)
      : clamp(viewport * 0.28, 208, 330);
  }

  function paint(widths) {
    let total = 0;
    for (const [key, width] of widths) {
      const col = cols.get(key);
      const pixels = `${width}px`;
      if (col.style.width !== pixels) col.style.width = pixels;
      total += width;
    }
    table.style.width = `${total}px`;
    rendered = widths;
    onResize?.();
  }

  function paintLayout() {
    const widths = new Map(keys.map((key) => [key, preferred.get(key) ?? defaultWidth(key)]));
    for (const [key, width] of widths) widths.set(key, fitWidth(key, width));

    let extra = viewport - [...widths.values()].reduce((total, width) => total + width, 0);
    const flexible = keys.filter((key) => key !== 'name' && !preferred.has(key));
    for (let index = 0; index < flexible.length && extra > 0; index += 1) {
      const key = flexible[index];
      const width = widths.get(key);
      const share = Math.ceil(extra / (flexible.length - index));
      const expanded = fitWidth(key, width + share);
      widths.set(key, expanded);
      extra -= expanded - width;
    }
    paint(widths);
  }

  function endDrag(commit = false, repaint = true) {
    if (!drag) return;
    const state = drag;
    drag = undefined;
    table.classList.remove('is-resizing-column');
    state.handle.classList.remove('is-resizing');
    if (state.handle.hasPointerCapture(state.pointerId)) state.handle.releasePointerCapture(state.pointerId);
    if (!state.started) return;
    if (commit && state.width !== state.startWidth) {
      preferred.set(state.key, state.width);
      saveWidths();
    }
    if (repaint) {
      viewport = scroller.clientWidth || viewport;
      paintLayout();
    }
  }

  function layout(shown) {
    endDrag(false, false);
    viewport = scroller.clientWidth || viewport;
    const nextKeys = shown.map(({ key }) => key);
    if (nextKeys.length !== keys.length || nextKeys.some((key, index) => key !== keys[index])) {
      keys = nextKeys;
      cols = new Map(keys.map((key) => {
        const col = table.ownerDocument.createElement('col');
        col.dataset.column = key;
        return [key, col];
      }));
      colgroup.replaceChildren(...cols.values());
    }
    paintLayout();
  }

  function findHandle(target) {
    const handle = target.closest?.(handleSelector);
    if (!handle || handle.disabled || !head.contains(handle) || !rendered.has(handle.dataset.resizeColumn)) return null;
    return handle;
  }

  function moveDrag(event) {
    if (drag?.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.startX;
    if (!drag.started) {
      const distance = Math.abs(delta);
      if (distance < (drag.touch ? touchDragThreshold : dragThreshold)) return;
      if (drag.touch && distance <= Math.abs(event.clientY - drag.startY)) return;
      drag.started = true;
      table.classList.add('is-resizing-column');
      drag.handle.classList.add('is-resizing');
    }
    const width = fitWidth(drag.key, drag.startWidth + delta);
    if (width === drag.width) return;
    drag.width = width;
    const widths = new Map(drag.initial);
    widths.set(drag.key, width);
    paint(widths);
  }

  head.addEventListener('pointerdown', (event) => {
    if (drag || !event.isPrimary || event.button !== 0) return;
    const handle = findHandle(event.target);
    if (!handle) return;
    const key = handle.dataset.resizeColumn;
    const width = rendered.get(key);
    const touch = event.pointerType === 'touch';
    event.preventDefault();
    drag = {
      handle, key, width, startWidth: width, initial: rendered,
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, touch, started: false,
    };
    // Touch already captures this button on some browsers. Keep the same target for the whole drag.
    try {
      if (!handle.hasPointerCapture(event.pointerId)) handle.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners still receive pointer events that remain within the page.
    }
  });

  window.addEventListener('pointermove', moveDrag);
  window.addEventListener('pointerup', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    const state = drag;
    moveDrag(event);
    if (drag !== state) return;
    lastPointerResize = state.started ? state.handle : undefined;
    endDrag(true);
  });
  function cancelPointer(event) {
    if (drag?.pointerId === event.pointerId) endDrag();
  }
  window.addEventListener('pointercancel', cancelPointer);
  head.addEventListener('lostpointercapture', (event) => {
    if (event.target === drag?.handle) cancelPointer(event);
  });
  window.addEventListener('blur', () => endDrag());

  window.addEventListener('keydown', (event) => {
    if (drag && event.key === 'Escape') {
      event.preventDefault();
      endDrag();
    }
  }, { capture: true });

  head.addEventListener('keydown', (event) => {
    if (drag || event.altKey || event.ctrlKey || event.metaKey) return;
    const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    const handle = direction && findHandle(event.target);
    if (!handle) return;
    event.preventDefault();
    const key = handle.dataset.resizeColumn;
    const current = rendered.get(key);
    const width = fitWidth(key, current + direction * (event.shiftKey ? 32 : 8));
    if (width === current) return;
    preferred.set(key, width);
    saveWidths();
    paintLayout();
  });

  head.addEventListener('click', (event) => {
    const handle = findHandle(event.target);
    if (!handle || event.detail < 1) return;
    if (event.detail === 1) resizedClick = undefined;
    if (lastPointerResize === handle) resizedClick = handle;
  });

  head.addEventListener('dblclick', (event) => {
    const handle = findHandle(event.target);
    if (!handle || resizedClick === handle) return;
    event.preventDefault();
    if (!preferred.delete(handle.dataset.resizeColumn)) return;
    saveWidths();
    paintLayout();
  });

  function refreshViewport() {
    const width = scroller.clientWidth;
    // A scrollbar appearing mid-drag can change clientWidth without resizing the page.
    if (!width || width === viewport || drag?.started) return;
    viewport = width;
    endDrag(false, false);
    paintLayout();
  }

  new ResizeObserver(refreshViewport).observe(scroller);
  mobileLayout.addEventListener('change', () => {
    viewport = scroller.clientWidth || viewport;
    endDrag(false, false);
    paintLayout();
  });

  return layout;
}
