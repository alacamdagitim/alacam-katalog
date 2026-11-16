const { createHmac } = require('node:crypto');
const { isIP } = require('node:net');
const { Conflict } = require('./shopify-snapshot.cjs');
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const DEFAULT_LIMITS = Object.freeze({ ipTenMinutes: 5, ipDaily: 30, emailTenMinutes: 3, emailDaily: 20, globalMinute: 15, globalHour: 60, globalDaily: 300 });
class RequestError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message); this.status = status; this.code = code;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}
function clientAddress(request, deployed = Boolean(process.env.VERCEL)) {
  // On Vercel, use only the platform-overwritten address, never a caller's XFF.
  let value = deployed ? request.headers['x-vercel-forwarded-for'] : request.socket?.remoteAddress;
  value = typeof value === 'string' ? value.split(',')[0].trim() : '';
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) value = value.slice(7);
  if (!isIP(value)) return 'unknown';
  if (isIP(value) === 6) {
    // One IPv6 /64 shares a quota; rotating addresses in that subnet cannot reset it.
    const groups = new URL(`http://[${value}]/`).hostname.slice(1, -1).split('::');
    const left = groups[0] ? groups[0].split(':') : [];
    const right = groups[1] ? groups[1].split(':') : [];
    const full = groups.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    return full.slice(0, 4).map(group => group.padStart(4, '0')).join(':') + '::/64';
  }
  return value;
}
function createRequestGuard({ repository, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  secret = process.env.SHOPIFY_CLIENT_SECRET ?? 'local-development', limits = DEFAULT_LIMITS } = {}) {
  const hash = value => createHmac('sha256', secret).update('request-guard-v1\0' + value).digest('hex');
  const rules = [
    ['ip', 10 * MINUTE, limits.ipTenMinutes], ['ip', DAY, limits.ipDaily],
    ['email', 10 * MINUTE, limits.emailTenMinutes], ['email', DAY, limits.emailDaily],
    ['global', MINUTE, limits.globalMinute], ['global', 60 * MINUTE, limits.globalHour], ['global', DAY, limits.globalDaily],
  ];
  return {
    contentKey(request) {
      const { requestId, ...content } = request;
      content.contact = { ...content.contact, email: content.contact.email.toLowerCase() };
      return `request-content-${hash(JSON.stringify(content))}`;
    },
    async take(ip, email) {
      const identity = { ip: hash(ip), email: hash(email.toLowerCase()) };
      for (let attempt = 0; attempt < 8; attempt++) {
        const saved = await repository.read('request-guard-v1'); const at = now();
        if (saved && (!Array.isArray(saved.value.events) || saved.value.version !== 1
          || !saved.value.events.every(event => Number.isSafeInteger(event.at) && event.at >= 0
            && /^[a-f0-9]{64}$/.test(event.ip) && /^[a-f0-9]{64}$/.test(event.email)))) {
          throw new RequestError(503, 'guard_unavailable', 'Talep gönderimi geçici olarak kullanılamıyor. Biraz sonra yeniden deneyin.', 30);
        }
        const events = (saved?.value.events ?? []).filter(event => event.at > at - DAY);
        for (const [scope, period, maximum] of rules) {
          const recent = events.filter(event => event.at > at - period && (scope === 'global' || event[scope] === identity[scope]));
          if (recent.length >= maximum) {
            const retryAfter = Math.max(1, Math.ceil((Math.min(...recent.map(event => event.at)) + period - at) / 1000));
            const wait = retryAfter >= 3600 ? `${Math.ceil(retryAfter / 3600)} saat` : retryAfter >= 60 ? `${Math.ceil(retryAfter / 60)} dakika` : `${retryAfter} saniye`;
            throw new RequestError(429, 'request_rate_limited', scope === 'global'
              ? `Talep sistemi şu anda yoğun. Yaklaşık ${wait} sonra yeniden deneyin.`
              : `Kısa sürede çok sayıda talep gönderildi. Yaklaşık ${wait} sonra yeniden deneyin.`, retryAfter);
          }
        }
        events.push({ at, ...identity });
        try {
          // One conditional write claims all quotas atomically across instances.
          await repository.write('request-guard-v1', { version: 1, events }, saved?.revision ?? null);
          return;
        } catch (error) {
          if (!(error instanceof Conflict)) throw error;
          await pause(20 * (attempt + 1));
        }
      }
      throw new RequestError(429, 'request_rate_limited', 'Talep sistemi yoğun. Biraz sonra yeniden deneyin.', 2);
    },
  };
}
module.exports = { createRequestGuard, RequestError, clientAddress, DEFAULT_LIMITS };
