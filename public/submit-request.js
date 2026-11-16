// A retry always carries the same ID. The server reconciles it without creating
// another draft, so interrupted connections never need a separate customer action.
export async function deliverDraft(payload, { fetchImpl = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 4, now = Date.now } = {}) {
  const deadline = now() + 120000;
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl('/api/draft-request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(Math.max(1, Math.min(100000, deadline - now()))),
      });
      const result = await response.json();
      if (response.ok && result.created === true && typeof result.name === 'string' && result.requestId === payload.requestId) return result;
      if (result.safeToEdit === true) return result;
      last = result;
    } catch { /* Automatically recover the same submission after a lost response. */ }
    const wait = 2000 * (attempt + 1);
    if (now() + wait + 1000 >= deadline) break;
    if (attempt + 1 < attempts) await pause(wait);
  }
  return { code: last?.code ?? 'connection_lost', safeToEdit: false,
    error: 'Talebin sonucu henüz doğrulanamadı. Talep kodunu ileterek bizimle iletişime geçebilirsiniz.', requestId: payload.requestId };
}
