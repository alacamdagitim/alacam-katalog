initWholesaleAdmin();

function initWholesaleAdmin() {
  const get = (name) => document.getElementById(`wholesale-admin-${name}`);
  const trigger = get('open');
  const dialog = get('dialog');
  const form = get('form');
  const file = get('file');
  const catalog = get('catalog');
  const catalogField = get('catalog-field');
  const previewButton = get('preview');
  const publishButton = get('publish');
  const doneButton = get('done');
  const summary = get('summary');
  const status = get('status');
  const number = new Intl.NumberFormat('tr-TR');
  const date = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Istanbul' });
  let busy = false;
  let previewed = false;
  let published = false;

  function setStatus(message, error = false) {
    status.classList.toggle('is-error', error);
    status.textContent = message;
  }

  function updateControls() {
    file.disabled = busy || published;
    catalog.disabled = catalogField.hidden || busy || published;
    get('close').disabled = busy;
    previewButton.disabled = publishButton.disabled = busy;
    previewButton.hidden = published;
    publishButton.hidden = !previewed || published;
    doneButton.hidden = !published;
  }

  function setCatalogs(titles = [], selected = '') {
    catalog.replaceChildren(new Option('Katalog seçin', ''), ...titles.map((title) => new Option(title, title)));
    catalogField.hidden = titles.length < 2;
    catalog.required = !catalogField.hidden;
    catalog.value = selected;
  }

  function clearPreview() {
    previewed = false;
    summary.hidden = true;
    setStatus('');
    updateControls();
  }

  function showSummary(result) {
    get('summary-title').textContent = result.catalog;
    const timestamp = new Date(result.publishedAt ?? Date.now());
    get('summary-date').textContent = Number.isNaN(timestamp.getTime()) ? ''
      : `${published ? 'Yayın' : 'Önizleme'} · ${date.format(timestamp)}`;
    for (const key of ['visible', 'hidden', 'unmatched']) {
      const products = number.format(result.stats[`${key}Products`]);
      const variants = number.format(result.stats[`${key}Variants`]);
      get(key).textContent = `${products} ürün · ${variants} varyant`;
    }
    summary.hidden = false;
  }

  async function submit(publish) {
    if (busy || published || (publish && !previewed) || !form.reportValidity()) return;
    if (!publish) clearPreview();
    busy = true;
    updateControls();
    setStatus(publish ? 'Katalog yayımlanıyor…' : 'Dosya kontrol ediliyor…');
    const params = new URLSearchParams();
    if (!publish) params.set('preview', '1');
    if (!catalogField.hidden && catalog.value) params.set('catalog', catalog.value);
    const query = params.toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`/api/wholesale${query ? `?${query}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: file.files[0],
        signal: controller.signal,
        redirect: 'error',
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409 && Array.isArray(result?.catalogs)) {
          clearPreview();
          setCatalogs(result.catalogs);
        }
        const fallback = response.status === 413 ? 'CSV dosyası çok büyük.' : 'Katalog işlenemedi. Lütfen tekrar deneyin.';
        setStatus(result?.error || fallback, true);
        return;
      }
      if (!result?.stats || result.preview !== !publish || typeof result.catalog !== 'string') {
        throw new Error('Unexpected catalog response');
      }
      if (Array.isArray(result.catalogs)) setCatalogs(result.catalogs, result.catalog);
      previewed = !publish && result.stats.visibleVariants > 0;
      published = publish;
      showSummary(result);
      const previewStatus = previewed ? 'Önizleme hazır. Yayımladığınızda paylaşılan katalog güncellenir.'
        : 'Görünür varyant bulunmadı. Yayımlamak için CSV dosyasını güncelleyin.';
      setStatus(publish ? 'Katalog yayımlandı.' : previewStatus, !publish && !previewed);
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
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit(false);
  });
  file.addEventListener('change', () => {
    setCatalogs();
    clearPreview();
  });
  catalog.addEventListener('change', clearPreview);
  publishButton.addEventListener('click', () => submit(true));
  doneButton.addEventListener('click', () => dialog.close());
}
