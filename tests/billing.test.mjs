import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { BillingService, parseCredits, validateBillingCookie } from '../lib/billing.mjs';
import { createApplication } from '../lib/application.mjs';
import { Repository } from '../lib/repository.mjs';

const MASTER_KEY = Buffer.alloc(32, 0x31);
const ORIGIN = 'https://console.example.test';

function account(repo, name = 'billing test account') {
  return repo.createUpstream({
    name, notes: '', enabled: true, priority: 0, load_factor: 1,
    max_concurrency: 1, whitelist: [],
  }, 'user_upstream_secret').id;
}

function response(status, body) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function validCredits(overrides = {}) {
  return {
    success: true,
    credits: {
      monthlyCredits: 12.5, purchasedCredits: 3, premiumMonthlyCredits: 4,
      opensourceMonthlyCredits: 5,
      windowLimits: {
        fiveHour: { used: 2, cap: 10, resetAt: 1_700_000_000 },
        weekly: { used: 8, cap: 20, resetAt: '2026-09-20T00:00:00Z' },
      },
      ...overrides,
    },
  };
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function cookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers.get('set-cookie');
  return value ? [value] : [];
}

function cookiePair(headers, name) {
  return cookies(headers).find(value => value.startsWith(`${name}=`))?.split(';', 1)[0] || '';
}

async function call(base, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const init = { method: options.method || 'GET', headers };
  if (options.body !== undefined) {
    headers['content-type'] ||= 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  return { res, status: res.status, body, text };
}

test('parseCredits accepts numeric strings, unknown/null fields, zero balances, and clamps overuse', () => {
  const parsed = parseCredits({
    success: true,
    credits: {
      monthlyCredits: '0', purchasedCredits: null, premiumMonthlyCredits: '4.25',
      opensourceMonthlyCredits: 'unknown',
      windowLimits: {
        fiveHour: { used: '12', cap: 10, resetAt: 1_700_000_000 },
        weekly: { used: 0, cap: 20, resetAt: null },
      },
    },
  });
  assert.equal(parsed.monthly_remaining, 0);
  assert.equal(parsed.purchased_remaining, null);
  assert.equal(parsed.premium_remaining, 4.25);
  assert.equal(parsed.opensource_remaining, null);
  assert.deepEqual(parsed.five_hour, { used: 12, limit: 10, remaining: 0, resets_at: 1_700_000_000_000 });
  assert.deepEqual(parsed.weekly, { used: 0, limit: 20, remaining: 20, resets_at: null });
});

test('parseCredits rejects invalid required fields and malformed windows', () => {
  for (const body of [
    {}, { success: false, credits: { monthlyCredits: 1 } },
    { success: true, credits: { monthlyCredits: '' } },
    { success: true, credits: { monthlyCredits: 'Infinity' } },
  ]) assert.throws(() => parseCredits(body), /invalid_billing/);
  const parsed = parseCredits({ success: true, credits: { monthlyCredits: 1, windowLimits: { fiveHour: { used: 1, cap: 0 } } } });
  assert.equal(parsed.five_hour, null);
});

test('validateBillingCookie keeps one CommandCode session cookie and rejects ambiguous input', () => {
  assert.equal(validateBillingCookie('Cookie: unrelated=x; better-auth.session_token=secret'), 'better-auth.session_token=secret');
  assert.equal(validateBillingCookie('__Secure-better-auth.session_token=secret'), '__Secure-better-auth.session_token=secret');
  for (const value of ['', 'better-auth.session_token=a; better-auth.session_token=b', 'session_token=a', 'better-auth.session_token=a\nX: y']) {
    assert.throws(() => validateBillingCookie(value), error => error?.status === 400 && error?.code === 'invalid_input');
  }
});

test('billing requests send only the selected cookie, forbid redirects, and retain credits when subscriptions fail', async t => {
  const repo = new Repository(':memory:', MASTER_KEY); t.after(() => repo.close());
  const id = account(repo); const cookie = 'better-auth.session_token=selected-secret'; repo.setBillingCookie(id, cookie);
  const service = new BillingService(repo, 'https://api.example.test');
  const calls = []; const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Cookie, cookie);
    assert.equal(options.headers.Authorization, undefined);
    return calls.length === 1 ? response(200, validCredits()) : response(503, { error: 'subscription unavailable' });
  };
  const result = await service.refresh(id);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.url), [
    'https://api.example.test/internal/billing/credits',
    'https://api.example.test/internal/billing/subscriptions',
  ]);
  assert.equal(result.billing.monthly_remaining, 12.5);
  assert.equal(result.billing.period_end, null);
});

test('401 and invalid billing responses preserve the previous value while recording an error', async t => {
  const repo = new Repository(':memory:', MASTER_KEY); t.after(() => repo.close());
  const id = account(repo); repo.setBillingCookie(id, 'better-auth.session_token=old-secret');
  const old = { monthly_remaining: 7, purchased_remaining: 1, premium_remaining: null, opensource_remaining: null, five_hour: null, weekly: null, period_end: null, updated_at: 1 };
  repo.save('upstreams', { ...repo.get('upstreams', id), billing: old, billing_checked_at: Date.now() - 120_000 });
  const service = new BillingService(repo, 'https://api.example.test');
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  for (const [status, body, code] of [[401, { success: false }, 'billing_login_required'], [200, { success: true, credits: { monthlyCredits: 'bad' } }, 'billing_unavailable']]) {
    repo.save('upstreams', { ...repo.get('upstreams', id), billing: old, billing_checked_at: Date.now() - 120_000, billing_error: null });
    globalThis.fetch = async () => response(status, body);
    await assert.rejects(service.refresh(id), error => error?.status === 502 && error?.code === code);
    const current = repo.get('upstreams', id);
    assert.deepEqual(current.billing, old);
    assert.equal(typeof current.billing_error, 'string');
  }
});

test('billing session cache is encrypted and cleared on revoke, credential replacement, and account deletion', t => {
  const repo = new Repository(':memory:', MASTER_KEY); t.after(() => repo.close());
  const id = account(repo); const cookie = 'better-auth.session_token=stored-secret'; repo.setBillingCookie(id, cookie);
  const raw = repo.db.prepare('SELECT credential FROM billing_sessions WHERE upstream_id=?').get(id).credential;
  assert.notEqual(raw, cookie); assert.doesNotMatch(raw, /stored-secret/); assert.equal(repo.billingCookie(id), cookie);
  repo.save('upstreams', { ...repo.get('upstreams', id), billing: { monthly_remaining: 1 }, billing_error: 'old', billing_checked_at: 123 });
  repo.clearBilling(id);
  assert.equal(repo.billingCookie(id), null);
  assert.equal(repo.get('upstreams', id).billing, null);
  assert.equal(repo.get('upstreams', id).billing_error, null);
  repo.setBillingCookie(id, cookie); repo.replaceCredential(id, 'user_replaced_secret');
  assert.equal(repo.billingCookie(id), null);
  repo.setBillingCookie(id, cookie); repo.remove('upstreams', id);
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS count FROM billing_sessions WHERE upstream_id=?').get(id).count, 0);
});

test('an authorization change rejects an in-flight response from the previous session', async t => {
  const repo = new Repository(':memory:', MASTER_KEY); t.after(() => repo.close());
  const id = account(repo); const oldCookie = 'better-auth.session_token=old-secret'; repo.setBillingCookie(id, oldCookie);
  const service = new BillingService(repo, 'https://api.example.test');
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let release; const waiting = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.Cookie, oldCookie);
    return calls++ === 0 ? waiting : response(200, { success: true, data: { currentPeriodEnd: null } });
  };
  let calls = 0;
  const refresh = service.refresh(id);
  while (calls === 0) await new Promise(resolve => setImmediate(resolve));
  repo.setBillingCookie(id, 'better-auth.session_token=new-secret');
  release(response(200, validCredits()));
  await assert.rejects(refresh, error => error?.status === 409 && error?.code === 'account_changed');
  assert.equal(repo.get('upstreams', id).billing, null);
});

test('billing management routes require authentication and CSRF, and never return the session cookie', async t => {
  const app = await createApplication({ databasePath: ':memory:', masterKey: MASTER_KEY, initialPassword: 'billing-test-password-123', origin: ORIGIN, apiBase: 'https://api.example.test' });
  const managed = await listen(app.management); t.after(async () => { await close(managed.server); app.close(); });
  const unauthenticated = await call(managed.base, '/command/api/upstreams/no-id/billing/session', { method: 'PUT', body: { cookie: 'better-auth.session_token=secret', confirm_account: true } });
  assert.equal(unauthenticated.status, 401);
  const anonymous = await call(managed.base, '/command/api/auth/session');
  const loginCookie = cookiePair(anonymous.res.headers, 'cc_login');
  const login = await call(managed.base, '/command/api/auth/login', {
    method: 'POST', headers: { origin: ORIGIN, cookie: loginCookie, 'x-csrf-token': anonymous.body.csrf },
    body: { email: 'admin@sub.sunmmyapi.xyz', password: 'billing-test-password-123' },
  });
  const sessionCookie = cookiePair(login.res.headers, 'cc_session'); const csrf = login.body.csrf;
  const create = await call(managed.base, '/command/api/upstreams', {
    method: 'POST', headers: { origin: ORIGIN, cookie: sessionCookie, 'x-csrf-token': csrf },
    body: { name: 'billing route account', notes: '', enabled: true, credential: 'user_route_secret', priority: 0, load_factor: 1, max_concurrency: 1, whitelist: [] },
  });
  assert.equal(create.status, 201); const id = create.body.id;
  const csrfFailure = await call(managed.base, `/command/api/upstreams/${id}/billing/session`, {
    method: 'PUT', headers: { origin: ORIGIN, cookie: sessionCookie }, body: { cookie: 'better-auth.session_token=secret', confirm_account: true },
  });
  assert.equal(csrfFailure.status, 403); assert.equal(csrfFailure.body.error.code, 'csrf_invalid');
  const authorized = await call(managed.base, `/command/api/upstreams/${id}/billing/session`, {
    method: 'PUT', headers: { origin: ORIGIN, cookie: sessionCookie, 'x-csrf-token': csrf }, body: { cookie: 'better-auth.session_token=secret', confirm_account: true },
  });
  assert.equal(authorized.status, 200); assert.equal(authorized.body.billing_authorized, true);
  assert.doesNotMatch(authorized.text, /better-auth\.session_token=secret/);
  const detail = await call(managed.base, `/command/api/upstreams/${id}`, { headers: { cookie: sessionCookie } });
  assert.equal(detail.body.billing_authorized, true); assert.doesNotMatch(detail.text, /better-auth\.session_token=secret/);
  const revoked = await call(managed.base, `/command/api/upstreams/${id}/billing/session`, { method: 'DELETE', headers: { origin: ORIGIN, cookie: sessionCookie, 'x-csrf-token': csrf } });
  assert.equal(revoked.status, 200); assert.equal(revoked.body.billing_authorized, false);
});
