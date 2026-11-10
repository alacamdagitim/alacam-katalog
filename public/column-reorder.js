const rowSelector = '.column-option[data-column]';
const movableRowSelector = `${rowSelector}:not([data-column-fixed])`;
const handleSelector = '.column-drag';
const dragThreshold = 5;
const scrollEdge = 40;
const dropSlop = 24;

export function initColumnReorder(list, onCommit, announce) {
  let drag;

  function rows(selector = rowSelector) {
    return [...list.children].filter((element) => element.matches(selector));
  }

  function grip(target) {
    const handle = target.closest?.(handleSelector);
    const row = handle?.closest(movableRowSelector);
    return row?.parentElement === list && !handle.disabled ? { handle, row } : null;
  }

  function commit(row) {
    const ordered = rows();
    const position = ordered.indexOf(row) + 1;
    const label = row.dataset.columnLabel || row.querySelector('.menu-option')?.textContent.trim() || row.dataset.column;
    onCommit(ordered.map((item) => item.dataset.column));
    announce?.(`${label} sütunu ${position}. sıraya taşındı.`);
  }

  function focusRow(key, reveal = false) {
    const row = rows().find((item) => item.dataset.column === key);
    row?.querySelector(handleSelector)?.focus({ preventScroll: true });
    if (!row || !reveal) return;
    const bounds = list.getBoundingClientRect();
    const item = row.getBoundingClientRect();
    if (item.top < bounds.top) list.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom;
  }

  function finish(accept) {
    if (!drag) return;
    const state = drag;
    drag = null;
    if (state.frame != null) cancelAnimationFrame(state.frame);
    if (list.hasPointerCapture?.(state.pointerId)) list.releasePointerCapture(state.pointerId);
    if (!state.ghost) return;
    state.ghost.remove();
    state.row.classList.remove('is-dragging');
    list.classList.remove('is-reordering');

    const { row, next } = state;
    if (row.parentElement !== list) return;
    const focused = document.activeElement === state.handle;
    if (row.nextElementSibling !== next) {
      if (accept) commit(row);
      else if (!next || next.parentElement === list) list.insertBefore(row, next);
    }
    if (focused && document.activeElement !== state.handle && list.getClientRects().length) {
      focusRow(row.dataset.column);
    }
  }

  const cancel = () => finish(false);

  function position(state) {
    const top = state.y - state.grabOffset;
    state.ghost.style.transform = `translateY(${top}px)`;
    const middle = top + state.height / 2;
    const before = rows(movableRowSelector).find((row) => {
      if (row === state.row) return false;
      const bounds = row.getBoundingClientRect();
      return middle < bounds.top + bounds.height / 2;
    }) ?? null;
    if (state.row.nextElementSibling !== before) {
      const focused = document.activeElement === state.handle;
      list.insertBefore(state.row, before);
      if (focused) state.handle.focus({ preventScroll: true });
    }
  }

  function tick() {
    const state = drag;
    if (!state?.ghost) return;
    const bounds = list.getBoundingClientRect();
    if (!bounds.height || state.row.parentElement !== list) return cancel();
    const edge = Math.min(scrollEdge, bounds.height / 3);
    const above = bounds.top + edge - state.y;
    const below = state.y - (bounds.bottom - edge);
    const scroll = (distance) => Math.max(1, Math.round(14 * Math.min(distance / edge, 1)));
    if (above > 0) list.scrollTop -= scroll(above);
    else if (below > 0) list.scrollTop += scroll(below);
    if (state.positionY !== state.y || state.scrollTop !== list.scrollTop) {
      position(state);
      state.positionY = state.y;
      state.scrollTop = list.scrollTop;
    }
    state.frame = requestAnimationFrame(tick);
  }

  function lift(state) {
    const bounds = state.row.getBoundingClientRect();
    const ghost = state.row.cloneNode(true);
    ghost.classList.add('column-drag-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.removeAttribute('id');
    for (const child of ghost.querySelectorAll('[id]')) child.removeAttribute('id');
    Object.assign(ghost.style, {
      position: 'fixed', zIndex: '10000', pointerEvents: 'none',
      top: '0', left: `${bounds.left}px`, width: `${bounds.width}px`, height: `${bounds.height}px`, margin: '0',
    });
    state.ghost = ghost;
    state.height = bounds.height;
    state.grabOffset = state.startY - bounds.top;
    state.row.classList.add('is-dragging');
    list.classList.add('is-reordering');
    (list.closest('dialog') || document.body).append(ghost);
  }

  list.addEventListener('pointerdown', (event) => {
    if (drag || !event.isPrimary || event.button !== 0) return;
    const item = grip(event.target);
    if (!item) return;
    event.preventDefault();
    drag = {
      row: item.row, handle: item.handle, next: item.row.nextElementSibling, pointerId: event.pointerId,
      startY: event.clientY, y: event.clientY,
    };
    // The list stays connected while its rows move. Window listeners cover failed capture.
    try {
      list.setPointerCapture?.(event.pointerId);
    } catch {
      // Keep handling the pointer while it remains in the page.
    }
  });

  window.addEventListener('pointermove', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    drag.y = event.clientY;
    if (!drag.ghost && Math.abs(drag.y - drag.startY) >= dragThreshold) {
      lift(drag);
      tick();
    }
  });

  window.addEventListener('pointerup', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    const bounds = list.getBoundingClientRect();
    const inside = bounds.height > 0 && event.clientX >= bounds.left - dropSlop && event.clientX <= bounds.right + dropSlop
      && event.clientY >= bounds.top - dropSlop && event.clientY <= bounds.bottom + dropSlop;
    if (inside && drag.row.parentElement === list) {
      drag.y = event.clientY;
      if (!drag.ghost && Math.abs(drag.y - drag.startY) >= dragThreshold) lift(drag);
      if (drag.ghost) position(drag);
    }
    finish(inside);
  });

  function cancelPointer(event) {
    if (drag?.pointerId === event.pointerId) cancel();
  }
  window.addEventListener('pointercancel', cancelPointer);
  list.addEventListener('lostpointercapture', (event) => {
    if (event.target === list) cancelPointer(event);
  });

  window.addEventListener('keydown', (event) => {
    if (!drag || event.key !== 'Escape') return;
    event.preventDefault();
    cancel();
  }, { capture: true });

  list.addEventListener('keydown', (event) => {
    if (drag || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const item = grip(event.target);
    if (!item) return;
    const ordered = rows(movableRowSelector);
    const index = ordered.indexOf(item.row);
    const target = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: ordered.length - 1 }[event.key];
    if (target == null) return;
    event.preventDefault();
    if (target === index || !ordered[target]) return;
    const before = target < index ? ordered[target] : ordered[target].nextElementSibling;
    list.insertBefore(item.row, before);
    commit(item.row);
    focusRow(item.row.dataset.column, true);
  });

  list.closest('details')?.addEventListener('toggle', () => {
    if (!list.getClientRects().length) cancel();
  });
  window.addEventListener('blur', cancel);
  return cancel;
}
