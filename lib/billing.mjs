import { fail } from './auth.mjs';

const numeric = value => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null;
const timestamp = value => {
  const n = numeric(value);
  const time = n !== null ? (n < 1e11 ? n * 1000 : n) : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 && time <= 8640000000000000 ? time : null;
};
const windowUsage = value => {
  const used = numeric(value?.used); const limit = numeric(value?.cap);
  return used !== null && used >= 0 && limit !== null && limit > 0
    ? { used, limit, remaining: Math.max(0, limit - used), resets_at: timestamp(value.resetAt) } : null;
};
export function parseCredits(body) {
  const credits = body?.credits;
  if (body?.success === false || !credits || numeric(credits.monthlyCredits) === null) throw new Error('invalid_billing');
  const windows = body.windowLimits ?? credits.windowLimits;
  return {
    monthly_remaining: numeric(credits.monthlyCredits), purchased_remaining: numeric(credits.purchasedCredits),
    premium_remaining: numeric(credits.premiumMonthlyCredits), opensource_remaining: numeric(credits.opensourceMonthlyCredits),
    five_hour: windowUsage(windows?.fiveHour), weekly: windowUsage(windows?.weekly),
  };
}
export function validateBillingCookie(value) {
  if (typeof value !== 'string' || value.length > 8192 || !value.trim() || /[^\x20-\x7e]/.test(value)) fail(400, 'invalid_input', '请输入有效的 Cookie 请求头值（单行）');
  const cookies = value.trim().replace(/^Cookie:\s*/i, '').split(';').map(v => v.trim());
  // Store and send only the authentication cookie, never unrelated browser cookies.
  const session = cookies.filter(v => /^(?:__Secure-)?better-auth\.session_token=[^;\s]+$/.test(v));
  if (session.length !== 1) fail(400, 'invalid_input', 'Cookie 中须包含一个 better-auth.session_token 会话');
  return session[0];
}
export class BillingService {
  constructor(repo, apiBase) { this.repo = repo; this.apiBase = apiBase; this.pending = new Map(); }
  async request(path, cookie) {
    const response = await fetch(`${this.apiBase}${path}`, {
      headers: { Cookie: cookie, Accept: 'application/json', Origin: 'https://commandcode.ai', Referer: 'https://commandcode.ai/' },
      redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      fail(502, response.status === 401 || response.status === 403 ? 'billing_login_required' : 'billing_unavailable',
        response.status === 401 || response.status === 403 ? '用量授权已失效，请重新登录 CommandCode 并更新授权' : `官方账单暂不可用（HTTP ${response.status}）`);
    }
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 256 * 1024) throw new Error('billing_too_large'); chunks.push(value); }
    } finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async refresh(id) {
    if (this.pending.has(id)) return this.pending.get(id);
    const task = this.read(id); this.pending.set(id, task);
    try { return await task; } finally { this.pending.delete(id); }
  }
  async read(id) {
    const cookie = this.repo.billingCookie(id);
    if (!cookie) fail(409, 'billing_login_required', '请先为此账号配置用量授权');
    const current = this.repo.get('upstreams', id);
    if (current.billing_checked_at && Date.now() - current.billing_checked_at < 60000) {
      if (current.billing_error) fail(429, 'billing_retry_later', '刚刚刷新失败，请一分钟后重试或更新用量授权');
      return current;
    }
    const sameAccount = () => this.repo.get('upstreams', id) && this.repo.billingCookie(id) === cookie;
    try {
      const billing = parseCredits(await this.request('/internal/billing/credits', cookie));
      billing.period_end = null;
      try {
        const subscription = await this.request('/internal/billing/subscriptions', cookie);
        if (subscription.success === true) billing.period_end = timestamp(subscription.data?.currentPeriodEnd);
      } catch { /* Credits remain useful when subscription enrichment is unavailable. */ }
      if (!sameAccount()) fail(409, 'account_changed', '账号授权已改变，请重新刷新');
      return this.repo.save('upstreams', { ...this.repo.get('upstreams', id), billing: { ...billing, updated_at: Date.now() }, billing_error: null, billing_checked_at: Date.now() });
    } catch (error) {
      if (!sameAccount()) fail(409, 'account_changed', '账号授权已改变，请重新刷新');
      const message = error.code === 'billing_login_required' || error.code === 'billing_unavailable' ? error.message : '官方账单网络异常或响应格式无效';
      this.repo.save('upstreams', { ...this.repo.get('upstreams', id), billing_error: message, billing_checked_at: Date.now() });
      fail(502, error.code === 'billing_login_required' ? error.code : 'billing_unavailable', message);
    }
  }
}
