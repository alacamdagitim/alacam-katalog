initWholesaleAdmin();

function initWholesaleAdmin() {
  const get = (name) => document.getElementById(`wholesale-admin-${name}`);
  const trigger = get('open');
  const dialog = get('dialog');
  const form = get('form');
  const file = get('file');
  const modeField = get('mode');
  const modeOptions = [...modeField.querySelectorAll('input')];
  const modeLabels = { merge: 'Mevcut kataloğu güncelle', replace: 'Sıfırdan oluştur' };
  const catalog = get('catalog');
  const catalogField = get('catalog-field');
  const previewButton = get('preview');
  const publishButton = get('publish');
  const doneButton = get('done');
  const summary = get('summary');
  const status = get('status');
  const resetToggle = get('reset-toggle');
  const resetPanel = get('reset-panel');
  const resetWord = get('reset-word');
  const resetStatus = get('reset-status');
  const number = new Intl.NumberFormat('tr-TR');
  const date = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Istanbul' });
  let busy = false;
  let previewToken = '';
  let published = false;

  function setStatus(message, error = false) {
    status.classList.toggle('is-error', error);
    status.textContent = message;
  }

  function updateControls() {
    file.disabled = modeField.disabled = busy || published;
    catalog.disabled = catalogField.hidden || busy || published;
    get('close').disabled = busy;
    previewButton.disabled = publishButton.disabled = busy;
    previewButton.hidden = published;
    publishButton.hidden = !previewToken || published;
    doneButton.hidden = !published;
    doneButton.disabled = busy;
    resetToggle.disabled = resetWord.disabled = busy;
  }

  function setCatalogs(titles = [], selected = '') {
    catalog.replaceChildren(new Option('Katalog seçin', ''), ...titles.map((title) => new Option(title, title)));
    catalogField.hidden = titles.length < 2;
    catalog.required = !catalogField.hidden;
    catalog.value = selected;
  }

  function clearPreview() {
    previewToken = '';
    summary.hidden = true;
    setStatus('');
    updateControls();
  }

  function closeReset() {
    resetPanel.hidden = true;
    resetToggle.setAttribute('aria-expanded', 'false');
    resetWord.value = '';
    resetWord.setCustomValidity('');
  }

  async function resetCatalog() {
    if (busy) return;
    if (resetWord.value !== 'sapanca') {
      resetWord.setCustomValidity('Sıfırlamak için sapanca yazıp Enter’a basın.');
      resetWord.reportValidity();
      return;
    }
    busy = true;
    updateControls();
    resetStatus.classList.remove('is-error');
    resetStatus.textContent = 'Toptan katalog sıfırlanıyor…';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('/api/wholesale', {
        method: 'DELETE',
        headers: { 'X-Catalog-Confirmation': resetWord.value },
        signal: controller.signal,
        redirect: 'error',
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        resetStatus.classList.add('is-error');
        resetStatus.textContent = result?.error || 'Katalog sıfırlanamadı. Tekrar deneyin.';
        return;
      }
      if (result?.reset !== true || result.active !== false) throw new Error('Unexpected reset response');
      published = false;
      form.reset();
      setCatalogs();
      clearPreview();
      closeReset();
      resetStatus.textContent = 'Toptan katalog sıfırlandı. Mağaza ürünleri ve fiyatları gösteriliyor.';
      window.dispatchEvent(new CustomEvent('wholesale:published'));
    } catch {
      resetStatus.classList.add('is-error');
      resetStatus.textContent = 'Sıfırlama onayı alınamadı. Tekrar deneyin.';
    } finally {
      clearTimeout(timeout);
      busy = false;
      updateControls();
      (resetPanel.hidden ? resetToggle : resetWord).focus();
    }
  }

  function showSummary(result, mode) {
    get('summary-title').textContent = result.catalog;
    const timestamp = new Date(result.publishedAt ?? Date.now());
    get('summary-date').textContent = Number.isNaN(timestamp.getTime()) ? ''
      : `${published ? 'Yayın' : 'Önizleme'} · ${date.format(timestamp)}`;
    const firstPublication = result.hasActive === false ? ' · İlk katalog bu dosyadan oluşturulur.' : '';
    get('summary-mode').textContent = `${modeLabels[mode]}${firstPublication}`;
    for (const key of ['visible', 'hidden', 'unmatched']) {
      const products = number.format(result.stats[`${key}Products`]);
      const variants = number.format(result.stats[`${key}Variants`]);
      get(key).textContent = `${products} ürün · ${variants} varyant`;
    }
    for (const key of ['added', 'updated', 'preserved', 'removed']) {
      get(key).textContent = number.format(result.changes[key]);
    }
    summary.hidden = false;
  }

  async function submit(publish) {
    if (busy || published || (publish && !previewToken) || !form.reportValidity()) return;
    const mode = modeOptions.find((option) => option.checked)?.value;
    if (!mode) return;
    if (!publish) clearPreview();
    busy = true;
    updateControls();
    setStatus(publish ? 'Katalog yayımlanıyor…' : 'Dosya kontrol ediliyor…');
    const params = new URLSearchParams({ mode });
    if (!publish) params.set('preview', '1');
    if (!catalogField.hidden && catalog.value) params.set('catalog', catalog.value);
    const headers = { 'Content-Type': 'text/csv' };
    if (publish) headers['X-Catalog-Preview'] = previewToken;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`/api/wholesale?${params}`, {
        method: 'POST',
        headers,
        body: file.files[0],
        signal: controller.signal,
        redirect: 'error',
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409 && result?.code === 'preview_expired') {
          clearPreview();
          setStatus('Önizleme artık geçerli değil. Yayımlamak için yeniden önizleyin.', true);
          return;
        }
        if (response.status === 409 && Array.isArray(result?.catalogs)) {
          clearPreview();
          setCatalogs(result.catalogs);
        }
        const fallback = response.status === 413 ? 'CSV dosyası çok büyük.' : 'Katalog işlenemedi. Lütfen tekrar deneyin.';
        setStatus(result?.error || fallback, true);
        return;
      }
      if (!result?.stats || !result.changes || result.preview !== !publish
        || result.mode !== mode || typeof result.catalog !== 'string') {
        throw new Error('Unexpected catalog response');
      }
      if (Array.isArray(result.catalogs)) setCatalogs(result.catalogs, result.catalog);
      previewToken = !publish && typeof result.previewToken === 'string' ? result.previewToken.trim() : '';
      published = publish;
      showSummary(result, mode);
      if (publish) setStatus('Katalog yayımlandı.');
      else if (previewToken) setStatus('Önizleme hazır. Yayımladığınızda paylaşılan katalog güncellenir.');
      else setStatus(result.stats.matchedVariants === 0 ? 'Dosyadaki varyantlar eşleşmedi. CSV dosyasını güncelleyin.'
        : 'Son katalogda görünür varyant bulunmadı. CSV dosyasını güncelleyin.', true);
      if (publish) window.dispatchEvent(new CustomEvent('wholesale:published', { detail: { publishedAt: result.publishedAt } }));
    } catch {
      setStatus(publish ? 'Yayın onayı alınamadı. Lütfen tekrar deneyin.'
        : 'Önizleme alınamadı. Lütfen tekrar deneyin.', true);
    } finally {
      clearTimeout(timeout);
      busy = false;
      updateControls();
      if (published) doneButton.focus();
      else if (!catalogField.hidden && !catalog.value) catalog.focus();
      else if (!dialog.contains(document.activeElement)) previewButton.focus();
    }
  }

  trigger.addEventListener('click', () => dialog.showModal());
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    published = false;
    form.reset();
    setCatalogs();
    clearPreview();
    closeReset();
    resetStatus.textContent = '';
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(false);
  });
  file.addEventListener('change', () => {
    for (const option of modeOptions) option.checked = false;
    setCatalogs();
    clearPreview();
  });
  modeField.addEventListener('change', clearPreview);
  catalog.addEventListener('change', clearPreview);
  publishButton.addEventListener('click', () => submit(true));
  doneButton.addEventListener('click', () => dialog.close());
  resetToggle.addEventListener('click', () => {
    if (!resetPanel.hidden) return closeReset();
    resetStatus.textContent = '';
    resetPanel.hidden = false;
    resetToggle.setAttribute('aria-expanded', 'true');
    resetWord.focus();
  });
  resetWord.addEventListener('input', () => resetWord.setCustomValidity(''));
  resetWord.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    if (event.repeat) return;
    resetCatalog();
  });
}
