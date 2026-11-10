const tapSlop = 8;

export function initBackdropDismiss(dialog) {
  const pointers = new Set();
  let press;

  function reset() {
    pointers.clear();
    press = null;
  }

  function onBackdrop(event) {
    if (event.target !== dialog) return false;
    const { left, right, top, bottom } = dialog.getBoundingClientRect();
    return event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom;
  }

  function moved(event) {
    return Math.hypot(event.clientX - press.x, event.clientY - press.y) > tapSlop;
  }

  dialog.addEventListener('pointerdown', (event) => {
    if (!dialog.open) return;
    pointers.add(event.pointerId);
    press = pointers.size === 1 && event.isPrimary && event.button === 0 && onBackdrop(event)
      ? { id: event.pointerId, x: event.clientX, y: event.clientY, released: false }
      : null;
  }, true);

  window.addEventListener('pointermove', (event) => {
    if (press?.id === event.pointerId && !press.released && moved(event)) press = null;
  }, true);

  window.addEventListener('pointerup', (event) => {
    if (!pointers.delete(event.pointerId) || press?.id !== event.pointerId) return;
    if (!pointers.size && onBackdrop(event) && !moved(event)) press.released = true;
    else press = null;
  }, true);

  window.addEventListener('pointercancel', (event) => {
    if (pointers.delete(event.pointerId)) press = null;
  }, true);

  dialog.addEventListener('click', (event) => {
    const tapped = dialog.open && press?.released && event.detail > 0 && onBackdrop(event)
      && (event.pointerId == null || event.pointerId === press.id);
    press = null;
    if (!tapped) return;
    event.stopPropagation();
    dialog.close();
  });

  dialog.addEventListener('close', reset);
  window.addEventListener('blur', reset);
}
