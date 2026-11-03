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
    const flash = (message, error) => {
      const notice = $('#sm-flash');
      notice.textContent = message;
      notice.classList.toggle('sm-error', !!error);
      if (message && !/^(Loading|Saving)\.*/.test(message)) notice.scrollIntoView?.({behavior:'smooth', block:'start'});
    };
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
        billingCycle:field(u,'billingCycle') ?? 'legacy', openingRecorded:bool(field(u,'openingRecorded')),
        coverageStartsOn:field(u,'coverageStartsOn') ?? null,
        bannerTitle:field(u,'bannerTitle') ?? '', bannerColor:field(u,'bannerColor') ?? '',
        status:field(u, 'status') ?? 'unknown'
      }));
      const ledger = (field(raw, 'ledger') || []).map(t => ({ ...t,
        id:guid(field(t,'id')), userId:guid(field(t, 'userId')),
        refundOf:guid(field(t,'refundOf')), refundable:bool(field(t,'refundable')), refunded:bool(field(t,'refunded')),
        cashAmountCents:Number(field(t,'cashAmountCents') ?? 0),
        createdUtc:field(t, 'createdUtc'), kind:field(t, 'kind'),
        amountCents:Number(field(t, 'amountCents') ?? 0),
        balanceAfterCents:Number(field(t, 'balanceAfterCents') ?? 0), note:field(t, 'note') ?? '' }));
      return { users, plans, ledger, today:field(raw, 'today') ?? '', activeCount:field(raw, 'activeCount') ?? 0,
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
        <td>${escapeHtml(u.included ? (u.nextChargeOn || 'Not scheduled') : '—')}</td>
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
      const chosenPreviewUser = $('#sm-b-preview-user').value;
      $('#sm-b-preview-user').innerHTML = '<option value="">Example user</option>' + state.users
        .filter(u => !u.administrator).map(u => `<option value="${u.userId}" ${u.userId === chosenPreviewUser ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('');
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
        <td>${usd(t.amountCents)}</td><td>${usd(t.balanceAfterCents)}</td>
        <td>${t.cashAmountCents ? usd(t.cashAmountCents) : '—'}</td>
        <td>${escapeHtml(t.note)}</td>
        <td><button type="button" class="sm-button alt" data-refund="${t.id}" ${t.refundable ? '' : 'disabled'}
          title="${t.refundable ? 'Create a linked refund/reversal' : (t.refunded ? 'Already refunded' : 'No refundable amount')}">${t.refunded ? 'Refunded' : 'Refund'}</button></td>
      </tr>`).join('') || '<tr><td colspan="8">No transactions found.</td></tr>';
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
      $('#sm-detail-cycle').value = u.billingCycle || 'legacy';
      $('#sm-user-banner-title').value = u.bannerTitle || '';
      $('#sm-user-banner-color').value = u.bannerColor || '';
      $('#sm-opening-submit').disabled = u.openingRecorded;
      $('#sm-opening-submit').textContent = u.openingRecorded ? 'Initial setup already recorded' : 'Record initial subscription';
      if (!$('#sm-opening-start').value) $('#sm-opening-start').value = state.today || '';
      if (!$('#sm-opening-through').value) $('#sm-opening-through').value = u.paidThrough || '';
      previewOpening();
      if (scroll) $('#sm-detail').scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
    const bFields = {
      enabled:['sm-b-enabled','checked'], showActive:['sm-b-active','checked'],
      showExpiring:['sm-b-expiring','checked'], showExpired:['sm-b-expired','checked'],
      showUnmanaged:['sm-b-unmanaged','checked'], showAdmins:['sm-b-admins','checked'],
      showUserName:['sm-b-username','checked'], showDaysRemaining:['sm-b-days','checked'],
      showPlan:['sm-b-plan','checked'], showPaidThrough:['sm-b-date','checked'],
      showBalance:['sm-b-balance','checked'], showRenewal:['sm-b-renewal','checked'],
      dismissible:['sm-b-dismiss','checked'], gradient:['sm-b-gradient','checked'],
      layout:['sm-b-layout','value'], icon:['sm-b-icon','value'],
      titleTemplate:['sm-b-title-template','value'],
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
        const value = field(b, name);
        if (kind === 'checked') element.checked = bool(value);
        else element.value = value ?? '';
      });
      previewBanner();
    }
    function template(message, values) {
      return String(message || '').replace(/\{(name|plan|status|expiration|daysLeft|renewal|balance)\}/g,
        (all, key) => String(values[key] ?? '—'));
    }
    function previewBanner() {
      const b = getBannerSettings();
      const status = $('#sm-b-preview-status').value;
      const user = userById($('#sm-b-preview-user').value);
      const name = user?.name || 'Example User';
      const plan = planById(user?.planId)?.name || 'Standard';
      const expiration = user?.paidThrough || '2027-02-26';
      const values = { name, plan, status, expiration, daysLeft:'5',
        renewal:user?.nextChargeOn || '2027-02-27', balance:usd(user?.balanceCents ?? 1000) };
      const base = ({active:b.activeColor, expiring:b.expiringColor, expired:b.expiredColor,
        unmanaged:b.unmanagedColor})[status] || '#374151';
      const color = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(user?.bannerColor || '') ? user.bannerColor : base;
      const message = ({active:b.activeText, expiring:b.expiringText, expired:b.expiredText,
        unmanaged:b.unmanagedText})[status] || 'Subscription';
      const title = user?.bannerTitle || b.titleTemplate || 'Welcome, {name}!';
      const el = $('#sm-b-preview');
      el.style.background = b.gradient ? `linear-gradient(110deg, ${color}, rgba(25,25,30,.95))` : color;
      el.style.borderLeftColor = '#fff';
      el.replaceChildren();
      const icon = document.createElement('span');
      icon.className = 'sm-preview-icon'; icon.textContent = b.icon || '👋';
      const body = document.createElement('div');
      const head = document.createElement('div');
      head.className = 'sm-preview-title';
      head.textContent = template(b.showUserName ? title : title.replace(/\{name\}/g,'Subscriber'), values);
      const sub = document.createElement('div');
      sub.className = 'sm-preview-message';
      const lines = [template(message, values)];
      if (b.showPlan) lines.push('Plan: ' + values.plan);
      if (b.showPaidThrough) lines.push('Paid through: ' + values.expiration);
      if (b.showRenewal) lines.push('Renews: ' + values.renewal);
      if (b.showBalance) lines.push('Credit: ' + values.balance);
      if (b.showDaysRemaining && status === 'expiring') lines.push(values.daysLeft + ' days left');
      sub.textContent = lines.join(' · ');
      body.appendChild(head); body.appendChild(sub);
      el.appendChild(icon); el.appendChild(body);
      if (b.dismissible) {
        const close = document.createElement('span');
        close.className = 'sm-preview-close'; close.textContent = '×';
        el.appendChild(close);
      }
    }
    function fridayInMonth(year, monthIndex, mode) {
      const first = new Date(year, monthIndex, 1, 12);
      if (mode === 'firstFriday') return 1 + (5 - first.getDay() + 7) % 7;
      const last = new Date(year, monthIndex + 1, 0, 12);
      return last.getDate() - (last.getDay() - 5 + 7) % 7;
    }
    function nextOpeningBoundary(date, cycle, anchor) {
      if (cycle === 'legacy') {
        const next = new Date(date.getFullYear(), date.getMonth() + 1, 1, 12);
        const max = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
        next.setDate(Math.min(anchor, max)); return next;
      }
      const month = new Date(date.getFullYear(), date.getMonth() + 1, 1, 12);
      return new Date(month.getFullYear(), month.getMonth(), fridayInMonth(month.getFullYear(),month.getMonth(),cycle),12);
    }
    function formatDay(date) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    }
    function previewOpening() {
      const mode = $('#sm-opening-credit-toggle').checked ? 'credit' : 'paidThrough';
      $('#sm-opening-through-wrap').hidden = mode === 'credit';
      $('#sm-opening-credit-wrap').hidden = mode !== 'credit';
      const startStr = $('#sm-opening-start').value;
      const start = startStr ? new Date(startStr + 'T12:00:00') : null;
      const user = userById(selectedUser);
      const plan = planById(user?.planId);
      const output = $('#sm-opening-preview');
      if (!user || !start || Number.isNaN(start.getTime())) { output.textContent = 'Choose a starting date.'; return; }
      if (mode === 'paidThrough') {
        const thru = $('#sm-opening-through').value;
        output.textContent = thru ? `Coverage: ${startStr} through ${thru} (inclusive). First payment is historical, not spendable credit.` : 'Choose the paid-through date.';
        return;
      }
      try {
        if (!plan || plan.monthlyCents <= 0) { output.textContent = 'Assign a paid monthly plan before calculating months.'; return; }
        const amount = cents($('#sm-opening-credit').value || '0');
        if (amount < 0) throw new Error('Credit cannot be negative.');
        const months = Math.floor(amount / plan.monthlyCents);
        if (months > 120) throw new Error('Maximum 120 prepaid months.');
        let end = new Date(start);
        for (let i = 0; i < months; i++) end = nextOpeningBoundary(end, user.billingCycle, start.getDate());
        if (months) end.setDate(end.getDate() - 1);
        output.textContent = `${months} full month(s); ${months ? 'paid through ' + formatDay(end) : 'no months prepaid'}; remaining account credit ${usd(amount - months * plan.monthlyCents)}.`;
      } catch (e) { output.textContent = e.message; }
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
    async function refresh(message, recalculate = true) {
      state = normalizeOverview(await api('overview?recalculate=' + String(recalculate)));
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
      if (target.id === 'sm-sync-statuses') {
        try {
          flash('Updating Jellyfin and Seerr permissions...', false);
          const result = await api('sync/statuses', {});
          await refresh(field(result,'message') || 'Status sync completed without billing charges.', false);
        } catch (e) { flash(getError(e), true); }
      }
      if (target.dataset.refund) {
        const entry = state?.ledger.find(t => t.id === guid(target.dataset.refund));
        if (!entry?.refundable) return;
        if (!confirm(`Refund/reverse ${entry.kind} for ${userById(entry.userId)?.name || 'this user'}? Account balance changes by ${usd(-entry.amountCents)}. Paid-through coverage will NOT be automatically changed.`)) return;
        try { await invoke('transactions/' + entry.id + '/refund', {note:'Refund entered from transaction history'}, 'Refund/reversal recorded in history.'); }
        catch (_) { }
      }
      if (target.id === 'sm-export') exportCsv();
      if (target.id === 'sm-seerr-test') {
        flash('Testing Seerr connection...', false);
        try {
          const result = await api('seerr/test', {
            url:$('#sm-seerr-url').value.trim(), apiKey:$('#sm-seerr-key').value.trim(),
            enabled:$('#sm-seerr-enabled').checked, autoImportUsers:$('#sm-seerr-import').checked
          });
          if (field(result,'automaticallySaved')) await refresh();
          flash(field(result, 'message') || 'Seerr connection succeeded.', false);
        } catch (e) { flash('Seerr connection failed: ' + getError(e), true); }
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
      if (t.id === 'sm-opening-credit-toggle') previewOpening();
      if (t.id === 'sm-b-preview-user') previewBanner();
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
    $('#sm-cycle-form').addEventListener('submit', async ev => {
      ev.preventDefault();
      if (!selectedUser) return;
      try { await invoke('users/' + selectedUser + '/billing-cycle', {cycle:$('#sm-detail-cycle').value}, 'User billing cycle saved.'); }
      catch (_) { }
    });
    $('#sm-opening-form').addEventListener('input', previewOpening);
    $('#sm-opening-form').addEventListener('change', previewOpening);
    $('#sm-opening-form').addEventListener('submit', async ev => {
      ev.preventDefault();
      if (!selectedUser) return;
      const mode = $('#sm-opening-credit-toggle').checked ? 'credit' : 'paidThrough';
      try {
        const payload = { mode, startDate:$('#sm-opening-start').value,
          paidThrough:mode === 'paidThrough' ? $('#sm-opening-through').value || null : null,
          firstPaymentCents:cents($('#sm-opening-payment').value || '0'),
          startingCreditCents:mode === 'credit' ? cents($('#sm-opening-credit').value || '0') : 0,
          note:'Initial subscription setup' };
        if (!confirm('Record the opening subscription? This is a ONE-TIME operation and will add ledger entries.')) return;
        await invoke('users/' + selectedUser + '/opening', payload, 'First payment and opening coverage recorded.');
      } catch (e) { if (!e?.status) flash(e?.message || 'Opening setup failed.', true); }
    });
    $('#sm-user-banner-form').addEventListener('submit', async ev => {
      ev.preventDefault();
      if (!selectedUser) return;
      try { await invoke('users/' + selectedUser + '/banner', {
        title:$('#sm-user-banner-title').value, color:$('#sm-user-banner-color').value
      }, 'Personal banner saved.'); } catch (_) { }
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
      const lines = [['DateUTC', 'User', 'Kind', 'AccountChangeUSD', 'BalanceAfterUSD', 'CashMovementUSD', 'Note', 'RefundOf'],
        ...records.map(t => [t.createdUtc, userById(t.userId)?.name || t.userId, t.kind,
          (t.amountCents / 100).toFixed(2), (t.balanceAfterCents / 100).toFixed(2),
          (t.cashAmountCents / 100).toFixed(2), t.note, t.refundOf || ''])];
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
    $('#sm-b-preview-user').addEventListener('change', previewBanner);
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
