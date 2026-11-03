// Jellyfin 12's view manager calls this constructor for the actual page instance.
// Avoid document.querySelector here: the SPA can keep other copies of this page mounted.
export default function SubscriptionManagerController(page) {
    'use strict';
    if (!page || page.dataset.smInitialized) return;
    page.dataset.smInitialized = 'true';
    console.info('[Subscription Manager] Admin controller initialized');
    const $ = sel => page.querySelector(sel);
    let state = null;
    let selectedUser = null;
    let tab = 'users';
    const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
    const usd = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents || 0) / 100);
    const cents = value => {
      if (value === '' || !/^[-+]?\d+(?:\.\d{1,2})?$/.test(String(value).trim())) throw new Error('Enter an amount with up to two decimal places.');
      return Math.round(Number(value) * 100);
    };
    const flash = (message, error) => { $('#sm-flash').textContent = message; $('#sm-flash').classList.toggle('sm-error', !!error); };
    // Jellyfin 12 may serialize class instances with PascalCase while anonymous
    // controller DTOs use camelCase. Normalize both (including false/0 values).
    const field = (obj, key) => obj?.[key] ?? obj?.[key[0].toUpperCase() + key.slice(1)];
    const guid = v => typeof v === 'string' ? v.toLowerCase() : (v ?? null);
    const bool = (value, fallback = false) => value === undefined || value === null ? fallback : (value === true || value === 'true');
    function normalizeOverview(raw) {
      const plans = (field(raw, 'plans') || []).map(p => {
        const originalPerms = field(p, 'jellyfinPermissions') || {};
        const keys = ['enableMediaPlayback', 'enableRemoteAccess', 'enableContentDownloading', 'enableLiveTvAccess',
          'enableVideoPlaybackTranscoding', 'enableAudioPlaybackTranscoding', 'enablePlaybackRemuxing'];
        const jellyfinPermissions = Object.fromEntries(keys.map(key => [key, field(originalPerms, key) ?? null]));
        return { id:guid(field(p, 'id')), name:field(p, 'name') ?? '', description:field(p, 'description') ?? '',
          monthlyCents:Number(field(p, 'monthlyCents') ?? 0), enabled:bool(field(p, 'enabled'), true),
          seerrRequestAccess:field(p, 'seerrRequestAccess') ?? 'inherit', jellyfinPermissions };
      });
      const users = (field(raw, 'users') || []).map(u => ({ ...u,
        userId:guid(field(u, 'userId')), name:field(u, 'name') ?? '',
        planId:guid(field(u, 'planId')), included:bool(field(u, 'included')),
        administrator:bool(field(u, 'administrator')), disabled:bool(field(u, 'disabled')),
        balanceCents:Number(field(u, 'balanceCents') ?? 0),
        paidThrough:field(u, 'paidThrough') ?? null, nextChargeOn:field(u, 'nextChargeOn') ?? null,
        status:field(u, 'status') ?? 'unknown'
      }));
      const ledger = (field(raw, 'ledger') || []).map(t => ({ ...t,
        userId:guid(field(t, 'userId')), createdUtc:field(t, 'createdUtc'), kind:field(t, 'kind'),
        amountCents:Number(field(t, 'amountCents') ?? 0),
        balanceAfterCents:Number(field(t, 'balanceAfterCents') ?? 0), note:field(t, 'note') ?? '' }));
      return { users, plans, ledger, activeCount:field(raw, 'activeCount') ?? 0,
        enrolledCount:field(raw, 'enrolledCount') ?? 0,
        totalCollectedCents:field(raw, 'totalCollectedCents') ?? 0,
        totalBalanceCents:field(raw, 'totalBalanceCents') ?? 0,
        timeZoneId:field(raw, 'timeZoneId') ?? 'UTC', banner:field(raw, 'banner') ?? null,
        seerr:field(raw, 'seerr') ?? null };
    }
    const userById = id => state?.users.find(u => u.userId === guid(id));
    const planById = id => state?.plans.find(p => p.id === guid(id));
    const permNames = ['enableMediaPlayback', 'enableRemoteAccess', 'enableContentDownloading',
      'enableLiveTvAccess', 'enableVideoPlaybackTranscoding', 'enableAudioPlaybackTranscoding',
      'enablePlaybackRemuxing'];
    function getPlanPermissions() {
      const result = {};
      page.querySelectorAll('[data-sm-plan-permission]').forEach(sel => {
        result[sel.dataset.smPlanPermission] = sel.value === '' ? null : sel.value === 'true';
      });
      return result;
    }
    function setPlanPermissions(values = {}) {
      page.querySelectorAll('[data-sm-plan-permission]').forEach(sel => {
        const value = values[sel.dataset.smPlanPermission];
        sel.value = value === true ? 'true' : value === false ? 'false' : '';
      });
    }
    function showPlanEditor(p) {
      $('#sm-plan-id').value = p?.id ?? '';
      $('#sm-plan-name').value = p?.name ?? '';
      $('#sm-plan-price').value = p ? (p.monthlyCents / 100).toFixed(2) : '5.00';
      $('#sm-plan-enabled').checked = p ? p.enabled : true;
      $('#sm-plan-desc').value = p?.description ?? '';
      $('#sm-plan-seerr').value = p?.seerrRequestAccess ?? 'inherit';
      setPlanPermissions(p?.jellyfinPermissions);
      $('#sm-plan-editor-title').textContent = p ? 'Configure plan: ' + p.name : 'Create a plan';
      showTab('plans');
      $('#sm-plan-form').scrollIntoView?.({ behavior:'smooth', block:'start' });
    }
    const optionsForPlans = (selected) => '<option value="">Select a plan...</option>' + (state?.plans || [])
      .filter(p => p.enabled || p.id === selected).map(p => `<option value="${p.id}" ${selected === p.id ? 'selected' : ''}>${escapeHtml(p.name)} (${usd(p.monthlyCents)}/mo)</option>`).join('');
    const usersOptions = (selected, includeAll) => (includeAll ? '<option value="">All users</option>' : '<option value="">Select a user...</option>') + state.users
      .filter(u => !u.administrator).map(u => `<option value="${u.userId}" ${u.userId === selected ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('');
    function showTab(next) {
      tab = next;
      page.querySelectorAll('.sm-panel').forEach(p => p.hidden = p.id !== 'sm-panel-' + next);
      page.querySelectorAll('.sm-tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === next)));
    }
    function render() {
      if (!state) return;
      $('#sm-metrics').innerHTML = [
        ['Active subscriptions', state.activeCount], ['Enrolled users', state.enrolledCount],
        ['Payments collected', usd(state.totalCollectedCents)], ['Unspent account credit', usd(state.totalBalanceCents)]
      ].map(([k, v]) => `<div class="sm-metric"><span class="sm-muted">${k}</span><strong>${v}</strong></div>`).join('');
      $('#sm-users').innerHTML = state.users.map(u => `<tr>
        <td><strong>${escapeHtml(u.name)}</strong></td>
        <td><input type="checkbox" data-enroll="${u.userId}" aria-label="Manage ${escapeHtml(u.name)}" ${u.included ? 'checked' : ''} ${u.administrator ? 'disabled' : ''} /></td>
        <td><select aria-label="Plan for ${escapeHtml(u.name)}" data-plan="${u.userId}" ${u.administrator ? 'disabled' : ''}>${optionsForPlans(u.planId)}</select></td>
        <td>${usd(u.balanceCents)}</td><td>${escapeHtml(u.paidThrough || '—')}</td>
        <td><span class="sm-status ${escapeHtml(u.status)}">${escapeHtml(u.status)}</span></td>
        <td>${u.administrator ? '—' : `<button class="sm-button alt" type="button" data-details="${u.userId}">Configure</button>`}</td>
      </tr>`).join('');
      $('#sm-plans').innerHTML = state.plans.map(p => `<tr>
        <td><strong>${escapeHtml(p.name)}</strong><div class="sm-hint sm-plan-description">${escapeHtml(p.description)}</div></td>
        <td>${usd(p.monthlyCents)}</td>
        <td>${p.enabled ? 'Yes' : 'Hidden'}</td>
        <td>${state.users.filter(u => u.included && u.planId === p.id).length}</td>
        <td><button class="sm-button alt" type="button" data-edit-plan="${p.id}">Configure</button></td></tr>`).join('') || '<tr><td colspan="5">No plans yet. Create one above.</td></tr>';
      const payUser = $('#sm-pay-user').value;
      $('#sm-pay-user').innerHTML = usersOptions(payUser, false);
      const ledgerUser = $('#sm-ledger-user').value;
      $('#sm-ledger-user').innerHTML = usersOptions(ledgerUser, true);
      renderLedger();
      updatePayBalance();
      $('#sm-timezone').value = state.timeZoneId;
      if (state.banner) renderBannerSettings(state.banner);
      if (state.seerr) renderSeerrSettings(state.seerr);
      if (selectedUser) showDetails(selectedUser, false);
      showTab(tab);
    }
    function renderLedger() {
      if (!state) return;
      const chosen = $('#sm-ledger-user').value;
      const entries = state.ledger.filter(t => !chosen || t.userId === chosen);
      $('#sm-ledger').innerHTML = entries.map(t => `<tr>
        <td>${escapeHtml(t.createdUtc?.replace('T', ' ').replace('Z', ' UTC').slice(0, 23))}</td>
        <td>${escapeHtml(userById(t.userId)?.name || t.userId)}</td><td>${escapeHtml(t.kind)}</td>
        <td>${usd(t.amountCents)}</td><td>${usd(t.balanceAfterCents)}</td><td>${escapeHtml(t.note)}</td>
      </tr>`).join('') || '<tr><td colspan="6">No transactions found.</td></tr>';
    }
    function updatePayBalance() {
      const u = userById($('#sm-pay-user').value);
      $('#sm-pay-balance').textContent = u ? `${u.name} currently has ${usd(u.balanceCents)} available. ${u.status}.` : '';
    }
    function showDetails(id, scroll = true) {
      const u = userById(id);
      if (!u || u.administrator) { $('#sm-detail').hidden = true; selectedUser = null; return; }
      selectedUser = id;
      $('#sm-detail').hidden = false;
      $('#sm-detail-name').textContent = `${u.name} — subscription settings`;
      $('#sm-detail-summary').textContent = `Status: ${u.status} | Balance: ${usd(u.balanceCents)} | Next charge: ${u.nextChargeOn || 'not scheduled'}`;
      $('#sm-detail-plan').innerHTML = optionsForPlans(u.planId);
      $('#sm-detail-expiry').value = u.paidThrough || '';
      if (scroll) $('#sm-detail').scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
    const bFields = {
      enabled:['sm-b-enabled','checked'], showActive:['sm-b-active','checked'],
      showExpiring:['sm-b-expiring','checked'], showExpired:['sm-b-expired','checked'],
      showUnmanaged:['sm-b-unmanaged','checked'], showAdmins:['sm-b-admins','checked'],
      showUserName:['sm-b-username','checked'], showDaysRemaining:['sm-b-days','checked'],
      showPlan:['sm-b-plan','checked'], showPaidThrough:['sm-b-date','checked'],
      showBalance:['sm-b-balance','checked'], dismissible:['sm-b-dismiss','checked'],
      position:['sm-b-position','value'], warningDays:['sm-b-warning','number'],
      refreshMinutes:['sm-b-refresh','number'], activeText:['sm-b-active-text','value'],
      expiringText:['sm-b-expiring-text','value'], expiredText:['sm-b-expired-text','value'],
      unmanagedText:['sm-b-unmanaged-text','value'], activeColor:['sm-b-active-color','value'],
      expiringColor:['sm-b-expiring-color','value'], expiredColor:['sm-b-expired-color','value'],
      unmanagedColor:['sm-b-unmanaged-color','value']
    };
    function getBannerSettings() {
      const b = {};
      Object.entries(bFields).forEach(([name,[id,kind]]) => {
        const element = $('#' + id);
        b[name] = kind === 'checked' ? element.checked : kind === 'number' ? Number(element.value) : element.value;
      });
      return b;
    }
    function renderBannerSettings(b) {
      Object.entries(bFields).forEach(([name,[id,kind]]) => {
        const element = $('#' + id);
        if (kind === 'checked') element.checked = !!b[name];
        else element.value = b[name] ?? '';
      });
      previewBanner();
    }
    function previewBanner() {
      const b = getBannerSettings();
      const status = $('#sm-b-preview-status').value;
      const color = ({ active:b.activeColor, expiring:b.expiringColor, expired:b.expiredColor, unmanaged:b.unmanagedColor })[status];
      const title = ({ active:b.activeText, expiring:b.expiringText, expired:b.expiredText, unmanaged:b.unmanagedText })[status];
      const el = $('#sm-b-preview');
      el.style.backgroundColor = color;
      el.replaceChildren();
      const strong = document.createElement('strong');
      strong.textContent = (b.showUserName ? 'Example User: ' : '') + title;
      el.appendChild(strong);
      const detail = document.createElement('div');
      detail.style.fontSize = '13px';
      detail.style.marginTop = '5px';
      detail.textContent = [b.showPlan ? 'Plan: Example' : '', b.showPaidThrough ? 'Paid through: 2026-12-15' : '',
        b.showBalance ? 'Credit: $10.00' : ''].filter(Boolean).join(' · ');
      el.appendChild(detail);
    }
    function renderSeerrSettings(settings) {
      $('#sm-seerr-enabled').checked = bool(field(settings, 'enabled'));
      $('#sm-seerr-url').value = field(settings, 'url') ?? '';
      $('#sm-seerr-key').value = ''; // Never request or display the stored API key.
      $('#sm-seerr-import').checked = bool(field(settings, 'autoImportUsers'));
      $('#sm-seerr-clear-key').checked = false;
      $('#sm-seerr-status').textContent = (field(settings, 'hasApiKey') ? 'API key saved. ' : 'No API key saved. ') +
        (field(settings, 'status') || '');
    }
    async function api(path, data) {
      const config = { type: data === undefined ? 'GET' : 'POST', url: ApiClient.getUrl('SubscriptionManager/' + path), dataType: 'json' };
      if (data !== undefined) { config.contentType = 'application/json'; config.data = JSON.stringify(data); }
      return ApiClient.ajax(config);
    }
    async function refresh(message) {
      state = normalizeOverview(await api('overview'));
      render();
      if (message) flash(message, false);
    }
    function getError(e) {
      let detail = e?.responseJSON?.message || e?.message || e?.statusText || 'Request failed';
      if (typeof e?.responseText === 'string') {
        try { const data = JSON.parse(e.responseText); detail = data.message || data.title || detail; }
        catch (_) { /* not JSON */ }
      }
      return detail + (e?.status && !String(detail).includes(String(e.status)) ? ` (HTTP ${e.status})` : '');
    }
    async function invoke(path, payload, message) {
      flash('Saving...', false);
      try { await api(path, payload); await refresh(message || 'Saved successfully.'); }
      catch (e) {
        flash(getError(e), true);
        throw e;
      }
    }
    page.addEventListener('click', async ev => {
      const target = ev.target.closest('button');
      if (!target) return;
      if (target.dataset.tab) return showTab(target.dataset.tab);
      if (target.dataset.details) return showDetails(target.dataset.details);
      if (target.id === 'sm-close-detail') { selectedUser = null; $('#sm-detail').hidden = true; return; }
      if (target.dataset.editPlan) {
        const p = planById(target.dataset.editPlan);
        if (p) showPlanEditor(p);
        else flash('Plan not found. Refresh the page.', true);
        return;
      }
      if (target.id === 'sm-plan-new') { showPlanEditor(null); return; }
      if (target.id === 'sm-refresh' || target.id === 'sm-sync') {
        try { await invoke('sync', {}, 'Users and subscription access synchronized.'); } catch (_) { }
      }
      if (target.id === 'sm-save-plan' && selectedUser) {
        const u = userById(selectedUser);
        const planId = $('#sm-detail-plan').value || null;
        try { await invoke('users/' + selectedUser, { included: u.included, planId }, 'User plan saved.'); } catch (_) { }
      }
      if (target.id === 'sm-export') exportCsv();
      if (target.id === 'sm-seerr-test') {
        try { const result = await api('seerr/test', {}); flash(field(result, 'message') || 'Seerr connection succeeded.'); }
        catch (e) { flash('Seerr connection failed: ' + getError(e), true); }
      }
      if (target.id === 'sm-seerr-sync') {
        try { const result = await api('seerr/sync', {}); await refresh(field(result, 'message') || 'Seerr sync completed.'); }
        catch (e) { flash('Seerr sync failed: ' + getError(e), true); }
      }
    });
    page.addEventListener('change', async ev => {
      const t = ev.target;
      if (t.dataset.enroll) {
        const u = userById(t.dataset.enroll);
        const planId = page.querySelector(`[data-plan="${u.userId}"]`).value || null;
        try { await invoke('users/' + u.userId, { included: t.checked, planId }, 'User subscription updated.'); }
        catch (_) { t.checked = !t.checked; }
      }
      if (t.dataset.plan) {
        const u = userById(t.dataset.plan);
        try { await invoke('users/' + u.userId, { included: u.included, planId: t.value || null }, 'Plan assignment saved.'); }
        catch (_) { t.value = u.planId || ''; }
      }
      if (t.id === 'sm-pay-user') updatePayBalance();
      if (t.id === 'sm-ledger-user') renderLedger();
      if (t.id === 'sm-pay-mode') { $('#sm-pay-amount').min = t.value === 'adjustments' ? '-1000000' : '0.01'; }
    });
    $('#sm-plan-form').addEventListener('submit', async ev => {
      ev.preventDefault();
      try {
        await invoke('plans', { id: $('#sm-plan-id').value || null, name: $('#sm-plan-name').value,
          description: $('#sm-plan-desc').value, jellyfinPermissions: getPlanPermissions(),
          seerrRequestAccess: $('#sm-plan-seerr').value,
          monthlyCents: cents($('#sm-plan-price').value), enabled: $('#sm-plan-enabled').checked }, 'Plan saved.');
        $('#sm-plan-new').click();
      } catch (_) { }
    });
    $('#sm-payment-form').addEventListener('submit', async ev => {
      ev.preventDefault();
      try {
        const userId = $('#sm-pay-user').value;
        if (!userId) throw new Error('Select a Jellyfin user.');
        const mode = $('#sm-pay-mode').value;
        const amountCents = cents($('#sm-pay-amount').value);
        if (mode === 'payments' && amountCents <= 0) throw new Error('Payments must be positive.');
        if (mode === 'adjustments' && !$('#sm-pay-note').value.trim()) throw new Error('A balance correction needs a reason.');
        await invoke(mode, { userId, amountCents, note: $('#sm-pay-note').value }, 'Transaction recorded. Access and balance updated.');
        $('#sm-pay-amount').value = ''; $('#sm-pay-note').value = '';
      } catch (e) { if (!e?.status) flash(e?.message || 'Could not record transaction.', true); }
    });
    $('#sm-detail-form').addEventListener('submit', async ev => {
      ev.preventDefault();
      if (!selectedUser) return;
      const value = $('#sm-detail-expiry').value;
      if (!confirm(`Override this user's paid-through date to ${value || 'none'}?`)) return;
      try { await invoke('users/' + selectedUser + '/expiration', { paidThrough: value || null, note: 'Manual date override from admin UI' }, 'Subscription date saved.'); } catch (_) { }
    });
    $('#sm-settings-form').addEventListener('submit', async ev => {
      ev.preventDefault();
      try { await invoke('settings', { timeZoneId: $('#sm-timezone').value.trim() }, 'Billing time zone saved.'); } catch (_) { }
    });
    $('#sm-seerr-form').addEventListener('submit', async ev => {
      ev.preventDefault();
      try {
        const payload = { enabled: $('#sm-seerr-enabled').checked,
          url: $('#sm-seerr-url').value.trim(), apiKey: $('#sm-seerr-key').value.trim(),
          autoImportUsers: $('#sm-seerr-import').checked,
          clearApiKey: $('#sm-seerr-clear-key').checked };
        await invoke('seerr/settings', payload, 'Seerr settings saved. Run Test connection to verify.');
      } catch (_) { }
    });
    function exportCsv() {
      if (!state) return;
      const chosen = $('#sm-ledger-user').value;
      const records = state.ledger.filter(t => !chosen || t.userId === chosen);
      const csvEscape = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
      const lines = [['DateUTC', 'User', 'Kind', 'AmountUSD', 'BalanceAfterUSD', 'Note'],
        ...records.map(t => [t.createdUtc, userById(t.userId)?.name || t.userId, t.kind,
          (t.amountCents / 100).toFixed(2), (t.balanceAfterCents / 100).toFixed(2), t.note])];
      const blob = new Blob([lines.map(r => r.map(csvEscape).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = 'jellyfin-subscription-transactions.csv'; a.click(); URL.revokeObjectURL(url);
    }
    $('#sm-banner-form').addEventListener('submit', async ev => {
      ev.preventDefault();
      try { await invoke('banner', { banner: getBannerSettings() }, 'Banner settings saved.'); }
      catch (_) { }
    });
    $('#sm-banner-form').addEventListener('input', previewBanner);
    $('#sm-b-preview-status').addEventListener('change', previewBanner);
    // Jellyfin 12 fires viewshow every time a page is presented. The legacy
    // pageshow event may fire immediately afterwards. Coalesce the two events.
    let refreshPromise = null;
    function onPageShown() {
      if (refreshPromise) return;
      flash('Loading subscription data...', false);
      refreshPromise = refresh().catch(e => {
        const detail = e?.responseJSON?.message || e?.message || e?.statusText || 'Unknown error';
        console.error('[Subscription Manager] Unable to load admin overview', e);
        flash('Could not load subscription data (' + detail + '). Check that you are signed in as a Jellyfin administrator, and inspect the browser console.', true);
      }).finally(() => { refreshPromise = null; });
    }
    page.addEventListener('viewshow', onPageShown);
    page.addEventListener('pageshow', onPageShown);
    // Initialize even if the hosting web client doesn't dispatch either event.
    // A microtask runs after the constructor has attached all handlers.
    queueMicrotask(onPageShown);
}
