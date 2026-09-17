<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { api, type Upstream } from './api';
import Modal from './Modal.vue';
const props = defineProps<{ account: Upstream }>();
const emit = defineEmits<{ updated: [] }>();
const open = ref(false); const cookie = ref(''); const confirmed = ref(false); const pending = ref(false); const error = ref('');
let timer: ReturnType<typeof setInterval> | undefined;
let alive = true;
const money = (n: number | null | undefined) => n == null ? '未提供' : new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(n);
const date = (n?: number | null) => n ? new Date(n).toLocaleString('zh-CN', { hour12: false }) : '未提供';
function close() { if (pending.value) return; open.value = false; cookie.value = ''; confirmed.value = false; error.value = ''; }
async function refresh() {
  if (pending.value) return;
  pending.value = true; error.value = '';
  try { await api(`/upstreams/${props.account.id}/billing/refresh`, 'POST', {}); }
  catch (e) { error.value = (e as Error).message; }
  finally { pending.value = false; if (alive) emit('updated'); }
}
async function authorize() {
  pending.value = true; error.value = '';
  try {
    await api(`/upstreams/${props.account.id}/billing/session`, 'PUT', { cookie: cookie.value, confirm_account: confirmed.value });
    cookie.value = ''; pending.value = false; close(); await refresh();
  } catch (e) { error.value = (e as Error).message; }
  finally { pending.value = false; }
}
async function revoke() {
  pending.value = true; error.value = '';
  try { await api(`/upstreams/${props.account.id}/billing/session`, 'DELETE'); pending.value = false; close(); emit('updated'); }
  catch (e) { error.value = (e as Error).message; }
  finally { pending.value = false; }
}
function autoRefresh() {
  if (document.visibilityState === 'visible' && props.account.billing_authorized && Date.now() - (props.account.billing_checked_at || 0) > 300000) void refresh();
}
onMounted(() => { autoRefresh(); timer = setInterval(autoRefresh, 60000); });
onBeforeUnmount(() => { alive = false; clearInterval(timer); cookie.value = ''; });
</script>
<template>
  <section class="usage-box" :aria-label="`${account.name} 用量与额度`">
    <div class="usage-heading"><strong>{{ account.name }} · 用量与额度</strong><div><button class="text-button" :disabled="pending || !account.billing_authorized" @click="refresh">{{ pending ? '更新中…' : '刷新额度' }}</button><button class="text-button" :disabled="pending" @click="open = true">{{ account.billing_authorized ? '管理授权' : '用量授权' }}</button></div></div>
    <p v-if="!account.billing_authorized">尚未授权，需登录此账号的 CommandCode 官网。</p>
    <p v-else-if="!account.billing">尚未获取官方用量，请刷新或更新授权。</p>
    <p v-if="error || account.billing_error" class="usage-error" role="alert">{{ error || account.billing_error }}{{ account.billing ? '（以下为上次成功结果）' : '' }}</p>
    <template v-if="account.billing">
      <div class="usage-values"><div><span>月度余额</span><strong>{{ money(account.billing.monthly_remaining) }}</strong></div><div><span>充值余额</span><strong>{{ money(account.billing.purchased_remaining) }}</strong></div></div>
      <div v-for="entry in [{ label: '5 小时', value: account.billing.five_hour }, { label: '每周', value: account.billing.weekly }]" :key="entry.label" class="usage-window">
        <div><span>{{ entry.label }}</span><span v-if="entry.value">已用 {{ money(entry.value.used) }} / {{ money(entry.value.limit) }}</span><span v-else>官方未提供</span></div>
        <template v-if="entry.value"><progress :value="Math.min(entry.value.used, entry.value.limit)" :max="entry.value.limit" :aria-label="`${entry.label}已用额度`" /><small>剩余 {{ money(entry.value.remaining) }} · 重置 {{ date(entry.value.resets_at) }}</small></template>
      </div>
      <details><summary>额度明细与更新时间</summary><p>高级模型余额：{{ money(account.billing.premium_remaining) }}<br />开源模型余额：{{ money(account.billing.opensource_remaining) }}<br />账期结束：{{ date(account.billing.period_end) }}<br />更新于：{{ date(account.billing.updated_at) }}</p><p>各额度池可能重叠，不相加。月度总配额未确认，暂不推算月度已用金额。</p></details>
    </template>
    <Modal v-if="open" :title="`${account.name} · 用量授权`" @close="close">
      <form class="form-stack" @submit.prevent="authorize">
        <p>先<a href="https://commandcode.ai/" target="_blank" rel="noopener noreferrer">登录 CommandCode 官网</a>，进入用量或账单页。登录不会自动连接本控制台。</p>
        <p>在浏览器开发者工具的 Network 中找到 billing/credits 请求，复制 Request Headers 中的 Cookie 值并填入下方。只会加密保存其中的登录会话；会话过期后需重新授权。</p>
        <div v-if="error" class="notice error" role="alert">{{ error }}</div>
        <label>Cookie 请求头值<input v-model="cookie" type="password" autocomplete="new-password" maxlength="8192" required placeholder="better-auth.session_token=…" :disabled="pending" /></label>
        <label class="check-label"><input v-model="confirmed" type="checkbox" required :disabled="pending" /><span>我确认此登录会话属于 {{ account.name }}。控制台无法自动核对官网会话与上游凭据的账号归属。</span></label>
        <footer class="modal-footer"><button v-if="account.billing_authorized" class="button secondary" type="button" :disabled="pending" @click="revoke">移除授权</button><button class="button secondary" type="button" :disabled="pending" @click="close">取消</button><button class="button primary" :disabled="pending || !confirmed">保存并获取用量</button></footer>
      </form>
    </Modal>
  </section>
</template>
<style scoped>
.usage-box { margin-top: 16px; padding: 16px; border: 1px solid var(--border, #e1e5e3); border-radius: 12px; font-size: 12px; }
.usage-heading, .usage-heading > div, .usage-window > div, .usage-values { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.usage-values { margin: 14px 0; }
.usage-values > div { display: grid; gap: 5px; }
.usage-values strong { font-size: 18px; }
.usage-window { margin-top: 12px; }
progress { width: 100%; height: 8px; accent-color: #28735a; }
.usage-error { color: #a83232; }
details { margin-top: 12px; line-height: 1.7; } summary { cursor: pointer; }
</style>
