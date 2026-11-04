/* Subscriber portal for Jellyfin Web 12.x.
 * A real full-screen client page, launched from the header or subscription
 * banner, using only authenticated /SubscriptionManager/account/* endpoints.
 * Does not depend on administrator-only Jellyfin plugin configuration pages.
 */
(() => {
  'use strict';
  if (window.__subscriptionManagerAccountLoaded) return;
  window.__subscriptionManagerAccountLoaded = true;
  // KefinTweaks Custom Menu Links can navigate to this stable Jellyfin Home route.
  // Avoid a non-existent #/my-subscription Jellyfin route which may show 404.
  const accountRoute = '#/home?smAccount=1';
  const isAccountRoute = () => /[?&]smAccount=1(?:&|$)/i.test(location.hash || '');
  const portalId = 'jf-subscription-account-page';
  const buttonId = 'jf-subscription-account-entry';
  const styleId = 'jf-subscription-account-style';
  const client = () => window.ApiClient || window.apiClient;
  const identity = () => client()?.getCurrentUserId?.() || null;
  const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const read = (obj,key) => obj?.[key] ?? obj?.[key[0].toUpperCase() + key.slice(1)];
  const money = cents => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(cents || 0)/100);
  const day = value => value ? escapeHtml(String(value).slice(0,10)) : 'Not scheduled';
  const datetime = value => value ? escapeHtml(String(value).replace('T',' ').slice(0,16) + ' UTC') : '—';
  let activeUser = null;
  let portal = null;
  let currentData = null;
  let loading = false;
  let ticking = false;
  let settings = null;
  let openedFromRoute = false;

  function authReady() {
    return !!identity() && !/(?:login|selectserver|selectuser)/i.test(location.pathname + location.hash);
  }

  function installCss() {
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style'); style.id = styleId;
    style.textContent = `
      #${portalId}{position:fixed;inset:0;z-index:10010;overflow:auto;background:var(--background,#101318);
        --sma-accent:#007ba6;--sma-card:#222630;
        color:var(--primary-text-color,#f5f5f5);font-family:inherit;box-sizing:border-box;}
      #${portalId} *,#${portalId} *::before,#${portalId} *::after{box-sizing:border-box;}
      #${portalId} .sma-shell{max-width:1040px;margin:0 auto;padding:24px 20px 75px;}
      #${portalId} .sma-top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;margin-bottom:24px;}
      #${portalId} h1{font-size:clamp(24px,4vw,32px);margin:0;}
      #${portalId} h2{font-size:19px;margin:0 0 12px;}
      #${portalId} p{line-height:1.55;}
      #${portalId} .sma-muted{opacity:.73;}
      #${portalId} .sma-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;}
      #${portalId} .sma-card{border:1px solid #8885;border-radius:12px;padding:20px;background:var(--sma-card);margin-bottom:17px;}
      #${portalId} .sma-stat b{font-size:25px;display:block;margin-top:5px;overflow-wrap:anywhere;}
      #${portalId} .sma-label{font-size:12px;letter-spacing:.04em;text-transform:uppercase;opacity:.8;}
      #${portalId} .sma-button{background:var(--sma-accent);color:#fff;border:1px solid #ffffff55;border-radius:8px;cursor:pointer;
        padding:11px 16px;font:inherit;min-height:43px;}
      #${portalId} .sma-button.secondary{background:transparent;border-color:#aaa8;color:inherit;}
      #${portalId} .sma-button:disabled{opacity:.5;cursor:not-allowed;}
      #${portalId} input,#${portalId} textarea,#${portalId} select{width:100%;max-width:100%;padding:10px 12px;
        background:var(--input-background,#2d3038);color:inherit;border:1px solid #9999;border-radius:7px;font:inherit;}
      #${portalId} input[type=color]{width:75px;padding:3px;height:42px;cursor:pointer;}
      #${portalId} label{display:block;margin:12px 0 6px;}
      #${portalId} .sma-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;}
      #${portalId} #sma-notice:not(:empty){padding:14px;margin-bottom:16px;border-radius:9px;background:#087ba344;border:1px solid #13a4d5;}
      #${portalId} #sma-notice.sma-error{background:#9b232344;border-color:#dc4040;}
      #${portalId} table{width:100%;border-collapse:collapse;font-size:14px;}
      #${portalId} th,#${portalId} td{text-align:left;padding:12px;border-bottom:1px solid #7775;}
      #${portalId} .sma-table{overflow:auto;}
      #${portalId} .sma-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(275px,1fr));gap:16px;}
      #${portalId} .sma-state{display:inline-block;border:1px solid #23a878a0;background:#21644355;border-radius:20px;padding:5px 12px;}
      #${portalId} .sma-warning{border-left:4px solid #e4a838;padding:10px 13px;background:#e4a83818;}
      #${buttonId}{cursor:pointer;white-space:nowrap;align-self:center;border:0;border-radius:7px;
        background:transparent;color:inherit;font:inherit;font-size:13px;padding:7px 9px;}
      #${buttonId}:hover{background:#aaa3;}
      #jf-subscription-account-floating{position:fixed;right:16px;bottom:16px;z-index:9992;border:1px solid #0ca8da;
        color:#fff;border-radius:25px;background:#007ba6;padding:11px 15px;cursor:pointer;font:inherit;box-shadow:0 5px 20px #0007;}
      @media(max-width:600px){#${portalId} .sma-shell{padding:15px 12px 60px;}
        #${portalId} th,#${portalId} td{padding:10px 7px;}}
    `;
    document.head.appendChild(style);
  }

  function api(path, payload) {
    const c = client();
    if (!authReady() || typeof c?.ajax !== 'function' || typeof c?.getUrl !== 'function')
      return Promise.reject(new Error('Sign in to Jellyfin to view your subscription.'));
    const config = {type: payload === undefined ? 'GET' : 'POST', url:c.getUrl('SubscriptionManager/account/' + path), dataType:'json'};
    if (payload !== undefined) { config.contentType='application/json'; config.data=JSON.stringify(payload); }
    return c.ajax(config);
  }

  function errorText(err) {
    let message = err?.responseJSON?.message || err?.message || err?.statusText || 'The request failed.';
    if (typeof err?.responseText === 'string') {
      try { message=JSON.parse(err.responseText).message || message; } catch(_) {}
    }
    return String(message);
  }

  function notice(text, error=false) {
    if (!portal) return;
    const bar = portal.querySelector('#sma-notice');
    bar.textContent=text || '';
    bar.classList.toggle('sma-error',error);
    if (text) bar.scrollIntoView?.({behavior:'smooth',block:'nearest'});
  }

  function shell() {
    if (portal?.isConnected) return portal;
    installCss();
    portal=document.createElement('main'); portal.id=portalId;
    portal.setAttribute('role','dialog'); portal.setAttribute('aria-modal','true');
    portal.setAttribute('aria-label','My Subscription');
    portal.innerHTML=`<div class="sma-shell">
      <div class="sma-top"><div><h1 id="sma-page-title">My Subscription</h1><p class="sma-muted" id="sma-page-subtitle">Your Jellyfin account, plan, and payment credit.</p></div>
        <div class="sma-actions"><button class="sma-button secondary" id="sma-reload" type="button">Refresh</button>
        <button class="sma-button secondary" id="sma-close" type="button">✕ Close</button></div></div>
      <div id="sma-notice" role="status" aria-live="polite"></div>
      <div id="sma-content">Loading your account...</div>
    </div>`;
    portal.addEventListener('click', e=>{
      const button=e.target.closest('button');
      if (!button) return;
      if (button.id==='sma-close') close();
      if (button.id==='sma-reload') load();
    });
    document.body.appendChild(portal);
    return portal;
  }

  function render(data) {
    if (!portal?.isConnected) return;
    currentData=data;
    settings=read(data,'page') || {};
    if(read(settings,'enabled') === false) {
      portal.querySelector('#sma-content').textContent='The subscriber portal is currently unavailable.';
      return;
    }
    const setting=(key, fallback=true)=>read(settings,key) ?? fallback;
    portal.style.setProperty('--sma-accent', /^#[0-9a-f]{6}$/i.test(setting('accentColor','')) ? setting('accentColor') : '#007ba6');
    portal.style.setProperty('--sma-card', /^#[0-9a-f]{6}$/i.test(setting('cardColor','')) ? setting('cardColor') : '#222630');
    portal.querySelector('#sma-page-title').textContent=setting('title','My Subscription');
    portal.querySelector('#sma-page-subtitle').textContent=setting('subtitle','');
    const launcherName=String(setting('menuName','My Subscription') || 'My Subscription');
    [document.getElementById(buttonId),document.getElementById('jf-subscription-account-floating')]
      .filter(Boolean).forEach(button=>{if(button.textContent!==launcherName) button.textContent=launcherName;});
    const p=read(data,'plan');
    const plans=read(data,'availablePlans') || [];
    const requested=read(data,'pendingPlan');
    const managed=read(data,'managed') === true;
    const currentId=String(read(p || {},'id') || '').toLowerCase();
    const balance=Number(read(data,'balanceCents') || 0);
    const status=String(read(data,'status') || 'unknown');
    const trx=read(data,'transactions') || [];
    const banner=read(data,'banner') || {};
    portal.querySelector('#sma-content').innerHTML=`
      <p>${escapeHtml(setting('welcomeMessage',''))}</p>
      <p>Signed in as <strong>${escapeHtml(read(data,'name'))}</strong> · <span class="sma-state">${escapeHtml(status)}</span></p>
      <div class="sma-grid">
        ${setting('showBalance') ? `<div class="sma-card sma-stat"><span class="sma-label">Available account credit</span><b>${money(balance)}</b></div>` : ''}
        ${setting('showPlan') ? `<div class="sma-card sma-stat"><span class="sma-label">Your plan</span><b>${escapeHtml(read(p || {},'name') || 'No plan')}</b><span>${p ? money(read(p,'monthlyCents'))+'/month' : 'Not enrolled'}</span></div>` : ''}
        ${setting('showPaidThrough') ? `<div class="sma-card sma-stat"><span class="sma-label">Paid through (inclusive)</span><b>${day(read(data,'paidThrough'))}</b></div>` : ''}
        ${setting('showRenewal') ? `<div class="sma-card sma-stat"><span class="sma-label">Next renewal</span><b>${day(read(data,'renewalOn'))}</b></div>` : ''}
      </div>
      <div class="sma-two">
        ${setting('showPlanDetails') ? `<section class="sma-card"><h2>${escapeHtml(setting('planSectionTitle','Your active plan'))}</h2>
          <p><strong>${escapeHtml(read(p || {},'name') || 'Not subscribed')}</strong></p>
          <p>${escapeHtml(read(p || {},'description') || 'No description available.')}</p>
          <p class="sma-muted">Billing schedule: ${escapeHtml(read(data,'billingCycle') || 'legacy')}. Your remaining credit is applied automatically when a monthly charge is due.</p>
          ${!managed ? '<p class="sma-warning">Subscription management is not enabled for your account. Contact your server administrator to enroll.</p>' : ''}
        </section>` : ''}
        ${setting('allowPlanRequests') ? `<section class="sma-card"><h2>${escapeHtml(setting('changeSectionTitle','Request a plan change'))}</h2>
          ${requested ? `<p class="sma-warning">Awaiting administrator approval: <strong>${escapeHtml(read(requested,'name'))}</strong> (${money(read(requested,'monthlyCents'))}/month). No changes have been applied yet.</p>` : ''}
          <p class="sma-muted">Choose a new plan and send a request to the server owner. Changes require approval; your balance and coverage remain unchanged while pending.</p>
          <form id="sma-plan-form"><label for="sma-plan">Available plans</label><select id="sma-plan" ${!managed || !!requested ? 'disabled' : ''}>
          <option value="">Choose a different plan...</option>
          ${plans.filter(plan=>String(read(plan,'id')).toLowerCase()!==currentId && read(plan,'selectable')===true).map(plan=>
            `<option value="${escapeHtml(read(plan,'id'))}">${escapeHtml(read(plan,'name'))} · ${money(read(plan,'monthlyCents'))}/month — ${escapeHtml(read(plan,'description') || '')}</option>`).join('')}
          </select><p><button class="sma-button" type="submit" ${!managed || !!requested || plans.filter(plan=>String(read(plan,'id')).toLowerCase()!==currentId && read(plan,'selectable')===true).length===0 ? 'disabled' : ''}>Request plan change</button></p></form>
        </section>` : ''}
      </div>
      ${setting('allowBannerCustomization') ? `<section class="sma-card"><h2>${escapeHtml(setting('bannerSectionTitle','Personalize your subscription banner'))}</h2>
        <p class="sma-muted">These settings only affect your own greeting. Warning and expired banner colors and messages stay unchanged.</p>
        <form id="sma-banner-form">
          <label for="sma-banner-title">Greeting title</label><input id="sma-banner-title" maxlength="120" value="${escapeHtml(read(banner,'title') || '')}" placeholder="Welcome, {name}!" />
          <label for="sma-banner-message">Custom active-subscription message</label><textarea id="sma-banner-message" maxlength="250" rows="2" placeholder="Thanks for supporting the server!">${escapeHtml(read(banner,'message') || '')}</textarea>
          <label for="sma-banner-color">Custom active banner color</label><input id="sma-banner-color" type="color" value="${/^#[0-9a-f]{6}$/i.test(read(banner,'color')||'') ? escapeHtml(read(banner,'color')) : '#166534'}" />
          <label><input id="sma-banner-default" type="checkbox" ${read(banner,'color') ? '' : 'checked'} style="width:auto" /> Use default color instead</label>
          <p><button class="sma-button secondary" type="submit">Save banner preferences</button></p>
        </form>
      </section>` : ''}
      ${setting('showTransactions') ? `<section class="sma-card"><h2>${escapeHtml(setting('transactionSectionTitle','Recent transactions'))}</h2>
        <p class="sma-muted">Payments and credit adjustments are recorded by your server administrator. The amounts below are changes to your available account credit; this page cannot add funds or issue refunds.</p>
        <div class="sma-table"><table><thead><tr><th>Date (UTC)</th><th>Type</th><th>Amount</th><th>Balance after</th><th>Details</th></tr></thead><tbody>
        ${trx.map(t=>`<tr><td>${datetime(read(t,'createdUtc'))}</td><td>${escapeHtml(read(t,'kind'))}</td>
          <td>${money(read(t,'amountCents'))}</td><td>${money(read(t,'balanceAfterCents'))}</td>
          <td>${escapeHtml(read(t,'note'))}</td></tr>`).join('') || '<tr><td colspan="5">No transactions yet.</td></tr>'}
        </tbody></table></div>
      </section>` : ''}
      <section class="sma-card"><h2>${escapeHtml(setting('supportSectionTitle','Need help?'))}</h2><p>${escapeHtml(setting('supportMessage',''))}</p></section>`;
    const planForm=portal.querySelector('#sma-plan-form');
    planForm?.addEventListener('submit',async e=>{
      e.preventDefault();
      const id=portal?.querySelector('#sma-plan')?.value;
      if(!id) {notice('Select a plan first.',true);return;}
      if(!confirm('Send a plan change request to the administrator? Your plan will not change until approved.')) return;
      try {await api('plan-request',{planId:id});await load('Plan change requested. Your current plan remains active until approval.');}
      catch(err){notice(errorText(err),true);}
    });
    portal.querySelector('#sma-banner-form')?.addEventListener('submit',async e=>{
      e.preventDefault();
      const title=portal.querySelector('#sma-banner-title').value;
      const message=portal.querySelector('#sma-banner-message').value;
      const color=portal.querySelector('#sma-banner-default').checked?'':portal.querySelector('#sma-banner-color').value;
      try {await api('banner',{title,message,color});await load('Your banner preferences were saved. Changes appear the next time the banner refreshes.');}
      catch(err){notice(errorText(err),true);}
    });
  }

  async function load(message='') {
    if(!portal?.isConnected || loading) return;
    loading=true;notice('Loading account...');
    const forUser=identity();
    try {
      const data=await api('me');
      if(portal?.isConnected && identity()===forUser) {render(data);notice(message);}
    } catch(e) {notice(errorText(e),true);}
    finally {loading=false;}
  }

  function open() {
    if(!authReady()) return;
    activeUser=identity();
    shell();
    // Avoid stale data if an administrator has changed a plan while this client is open.
    openedFromRoute=isAccountRoute();
    load();
    portal.querySelector('#sma-close')?.focus();
  }
  function close() {
    portal?.remove(); portal=null; currentData=null;
    if(isAccountRoute()) {
      // Remove only the opt-in portal query parameter; return to a supported
      // Jellyfin Home route without adding a spurious history entry.
      history.replaceState(history.state, '', '#/home');
    }
    openedFromRoute=false;
  }
  window.__subscriptionManagerOpenAccount=open;

  function attachLauncher() {
    const old=document.getElementById(buttonId);
    if(!authReady()) {settings=null;old?.remove();document.getElementById('jf-subscription-account-floating')?.remove();close();return;}
    if(activeUser && activeUser!==identity()) {settings=null;close();}
    if(isAccountRoute() && !portal?.isConnected) { open(); }
    if(openedFromRoute && !isAccountRoute() && portal?.isConnected) close();
    // An administrator may hide the native launcher when using KefinTweaks.
    if(settings && (read(settings,'showLauncher') === false || read(settings,'enabled') === false)) {
      old?.remove();document.getElementById('jf-subscription-account-floating')?.remove();return;
    }
    const header=[...document.querySelectorAll('.headerUserButton')]
      .find(button=>button.isConnected && !button.closest('[hidden], .hide, [aria-hidden="true"]'));
    if(header?.parentElement) {
      if(!old || old.parentElement!==header.parentElement) {
        old?.remove();
        const button=document.createElement('button');button.id=buttonId;button.type='button';
        button.textContent='My Subscription';button.setAttribute('aria-label','Open My Subscription');
        button.addEventListener('click',open);header.parentElement.insertBefore(button,header);
      }
      document.getElementById('jf-subscription-account-floating')?.remove();
    } else if(!document.getElementById('jf-subscription-account-floating')) {
      // Mobile and custom themes may not display a headerUserButton.
      const button=document.createElement('button');button.id='jf-subscription-account-floating';
      button.type='button';button.textContent='My Subscription';
      button.addEventListener('click',open);document.body.appendChild(button);
    }
  }
  function queueLauncher() {
    if(ticking) return;
    ticking=true;
    requestAnimationFrame(()=>{ticking=false;attachLauncher();});
  }
  document.addEventListener('keydown',e=>{if(e.key==='Escape' && portal?.isConnected)close();});
  window.addEventListener('hashchange',queueLauncher);
  window.addEventListener('pageshow',queueLauncher);
  if(document.body) {
    new MutationObserver(changes=>{
      // Avoid a render loop from changes inside the account page itself.
      if(changes.every(m=>m.target?.closest?.('#'+portalId)))return;
      queueLauncher();
    }).observe(document.body,{childList:true,subtree:true});
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',queueLauncher,{once:true});
  else queueLauncher();
})();
