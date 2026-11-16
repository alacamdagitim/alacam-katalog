const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequestGuard, clientAddress, DEFAULT_LIMITS } = require('../lib/request-guard.cjs');
const { Conflict } = require('../lib/shopify-snapshot.cjs');
function store() {
  let saved; let revision = 0;
  return { async read() { return structuredClone(saved ?? null); }, async write(_, value, expected) {
    if ((saved?.revision ?? null) !== expected) throw new Conflict();
    saved = { revision: String(++revision), value: structuredClone(value) };
  } };
}
const setup = (options = {}) => createRequestGuard({ secret: 'server-only-test-secret', pause: async () => {}, ...options });

test('IP and email quotas use sliding windows and cannot reset at a clock boundary or by changing email case', async () => {
  const repository = store(); let time = 599999;
  const guard = setup({ repository, now: () => time });
  for (let i = 0; i < 5; i++) await guard.take('203.0.113.1', `person-${i}@example.com`);
  time += 2;
  await assert.rejects(guard.take('203.0.113.1', 'next@example.com'), error => error.status === 429 && error.retryAfter > 500);
  time += 600001;
  await guard.take('203.0.113.1', 'next@example.com');
  const emailGuard = setup({ repository: store() });
  for (let i = 0; i < 3; i++) await emailGuard.take(`ip-${i}`, 'Buyer@Example.com');
  await assert.rejects(emailGuard.take('another-ip', 'buyer@example.COM'), { status: 429 });
});

test('two server instances share atomic quotas; simultaneous requests cannot exceed the limit', async () => {
  const repository = store();
  const options = { repository, limits: { ...DEFAULT_LIMITS, globalMinute: 2 } };
  const a = setup(options), b = setup(options);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).take(`ip-${i}`, `buyer-${i}@example.com`)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.status === 429));
});

test('rotating IPs and emails cannot bypass hourly/daily site limits, and storage remains bounded', async () => {
  const repository = store(); let time = 0;
  const guard = setup({ repository, now: () => time });
  for (let i = 0; i < 300; i++) { time = i * 60000; await guard.take(`ip-${i}`, `buyer-${i}@example.com`); }
  time += 60000;
  await assert.rejects(guard.take('rotated', 'rotated@example.com'), { status: 429 });
  assert.equal((await repository.read()).value.events.length, 300);
  time = 86400000 + 1;
  await guard.take('rotated', 'rotated@example.com');
  assert.equal((await repository.read()).value.events.length, 300);
  const hourly = setup({ repository: store(), limits: { ...DEFAULT_LIMITS, globalMinute: 100 } });
  for (let i = 0; i < 60; i++) await hourly.take(`ip-${i}`, `buyer-${i}@example.com`);
  await assert.rejects(hourly.take('different', 'different@example.com'), { status: 429 });
});

test('raw contact/IP data are not stored; corrupt quota data cannot silently disable protection', async () => {
  const repository = store(); const guard = setup({ repository });
  await guard.take('203.0.113.123', 'buyer@example.com');
  const serialized = JSON.stringify((await repository.read()).value);
  assert.ok(!serialized.includes('203.0.113.123')); assert.ok(!serialized.includes('buyer@example.com'));
  const bad = setup({ repository: { read: async () => ({ value: { version: 1, events: [{}] } }) } });
  await assert.rejects(bad.take('ip', 'buyer@example.com'), { status: 503 });
});

test('trusted Vercel IP cannot be overridden by an ordinary forwarded header or address rotation within IPv6 /64', () => {
  const request = { headers: { 'x-vercel-forwarded-for': '203.0.113.1', 'x-forwarded-for': '198.51.100.1' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientAddress(request, true), '203.0.113.1');
  request.headers['x-forwarded-for'] = '198.51.100.2'; assert.equal(clientAddress(request, true), '203.0.113.1');
  delete request.headers['x-vercel-forwarded-for']; assert.equal(clientAddress(request, true), 'unknown');
  assert.equal(clientAddress(request, false), '127.0.0.1');
  request.headers['x-vercel-forwarded-for'] = '2001:db8:abcd:1234::1'; const subnet = clientAddress(request, true);
  request.headers['x-vercel-forwarded-for'] = '2001:db8:abcd:1234:ffff:ffff:ffff:ffff'; assert.equal(clientAddress(request, true), subnet);
});
