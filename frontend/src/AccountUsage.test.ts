// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AccountUsage from './AccountUsage.vue';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => ({ api: mocks.api }));

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'account-1', name: '测试账号', notes: '', enabled: true, whitelist: [], priority: 0,
    load_factor: 1, max_concurrency: 1, credential_prefix: 'user_test…', health: 'healthy',
    scheduling: 'ready', inflight: 0, cooldown_until: 0, models: [], models_refreshed_at: null,
    models_error: null, last_test_at: null, latency_ms: null, last_error: null, requests: 0,
    successes: 0, errors: 0, billing_authorized: false, billing: null, billing_error: null,
    billing_checked_at: null, ...overrides,
  };
}

const billing = {
  monthly_remaining: 0, purchased_remaining: 2.5, premium_remaining: 1,
  opensource_remaining: null,
  five_hour: { used: 2, limit: 10, remaining: 8, resets_at: 1_800_000_000_000 },
  weekly: { used: 10, limit: 20, remaining: 10, resets_at: null },
  period_end: null, updated_at: 1_800_000_000_000,
};

afterEach(() => {
  mocks.api.mockReset();
  vi.useRealTimers();
});

describe('AccountUsage', () => {
  it('shows the unauthorised state without requesting billing data', () => {
    const wrapper = mount(AccountUsage, { props: { account: account() as never } });
    expect(wrapper.text()).toContain('尚未授权');
    expect(wrapper.text()).toContain('用量授权');
    expect(mocks.api).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('renders balances, zero balance, usage windows, and reset information', () => {
    const wrapper = mount(AccountUsage, { props: { account: account({ billing_authorized: true, billing, billing_checked_at: Date.now() }) as never } });
    expect(wrapper.text()).toContain('月度余额');
    expect(wrapper.text()).toContain('充值余额');
    expect(wrapper.text()).toContain('5 小时');
    expect(wrapper.text()).toContain('每周');
    expect(wrapper.text()).toContain('剩余');
    expect(wrapper.findAll('progress')).toHaveLength(2);
    expect(wrapper.findAll('progress')[0].attributes('max')).toBe('10');
    expect(wrapper.findAll('progress')[0].attributes('value')).toBe('2');
    wrapper.unmount();
  });

  it('keeps showing the previous value while reporting a refresh error', () => {
    const wrapper = mount(AccountUsage, {
      props: { account: account({ billing_authorized: true, billing, billing_error: '授权已失效', billing_checked_at: Date.now() }) as never },
    });
    expect(wrapper.text()).toContain('授权已失效');
    expect(wrapper.text()).toContain('以下为上次成功结果');
    expect(wrapper.findAll('progress')).toHaveLength(2);
    wrapper.unmount();
  });

  it('saves authorised cookies, refreshes, and clears the secret from the dialog', async () => {
    mocks.api.mockResolvedValue({});
    const wrapper = mount(AccountUsage, { props: { account: account() as never } });
    await wrapper.findAll('button')[1].trigger('click');
    const secret = 'better-auth.session_token=ui-secret';
    await wrapper.find('input[type="password"]').setValue(secret);
    await wrapper.find('input[type="checkbox"]').setValue(true);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(mocks.api).toHaveBeenNthCalledWith(1, '/upstreams/account-1/billing/session', 'PUT', { cookie: secret, confirm_account: true });
    expect(mocks.api).toHaveBeenNthCalledWith(2, '/upstreams/account-1/billing/refresh', 'POST', {});
    expect(document.body.textContent).not.toContain(secret);
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('revokes authorisation and clears entered secrets on cancel/unmount', async () => {
    mocks.api.mockResolvedValue({});
    const wrapper = mount(AccountUsage, { props: { account: account({ billing_authorized: true, billing_checked_at: Date.now() }) as never } });
    await wrapper.findAll('button')[1].trigger('click');
    await wrapper.find('input[type="password"]').setValue('better-auth.session_token=cancelled-secret');
    await wrapper.findAll('button').find(button => button.text() === '取消')!.trigger('click');
    expect(document.body.textContent).not.toContain('cancelled-secret');
    await wrapper.findAll('button')[1].trigger('click');
    const revoke = wrapper.findAll('button').find(button => button.text() === '移除授权');
    expect(revoke).toBeTruthy();
    await revoke!.trigger('click');
    await flushPromises();
    expect(mocks.api).toHaveBeenCalledWith('/upstreams/account-1/billing/session', 'DELETE');
    expect(wrapper.emitted('updated')).toBeTruthy();
    wrapper.unmount();
  });
});
