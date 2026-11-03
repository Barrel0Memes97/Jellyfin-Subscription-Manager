/* Subscription Manager banner for Jellyfin Web. Mirrors the original personal welcome
 * design: home-page insertion, gradient, wave emoji, left accent, and close control.
 * Only /SubscriptionManager/me (authenticated current user) is ever requested. */
(() => {
  'use strict';
  if (window.__jellyfinSubscriptionBannerLoaded) return;
  window.__jellyfinSubscriptionBannerLoaded = true;
  const script = document.currentScript;
  const endpoint = script?.src ? new URL('me', script.src).toString() : null;
  const bannerId = 'jf-personalized-user-banner';
  const styleId = 'jf-subscription-banner-style';
  let lastRefresh = 0;
  let dismissedUntil = 0;
  let refreshMs = 5 * 60000;
  let requestInFlight = false;
  let lastIdentity = null;
  let lastData = null;
  const api = () => window.ApiClient || window.apiClient;
  const cash = value => new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' }).format(value / 100);
  const field = (object, key) => object?.[key] ?? object?.[key[0].toUpperCase() + key.slice(1)];
  const format = (value, substitutions) => String(value || '').replace(/\{(name|plan|status|expiration|daysLeft|renewal|balance)\}/g,
    (_, key) => String(substitutions[key] ?? '—'));
  const isLogin = () => /(?:login|selectserver|selectuser)/i.test(location.hash) ||
    !!document.querySelector('.loginPage:not(.hide), #loginPage:not(.hide)');
  const onHome = () => /(?:^|[/#])home(?:[/?#]|$)/i.test(location.hash) ||
    !!document.querySelector('.homePage:not(.hide), .homePageMain:not(.hide)');
  const homeNode = () => {
    const selectors = ['.homePageMain', '.homePage', '.homeSectionsContainer', '.mainAnimatedPage'];
    return selectors.map(s => document.querySelector(s)).find(el => el && !el.classList.contains('hide') &&
      !el.closest('.hide, [hidden]')) || null;
  };
  const remove = () => document.getElementById(bannerId)?.remove();

  function installCss() {
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      #${bannerId} {box-sizing:border-box; width:calc(100% - 32px);max-width:800px;
        min-height:58px; margin:12px auto 8px; display:flex;gap:12px;align-items:center;
        position:relative;padding:13px 44px 13px 15px; border-radius:10px;
        border-left:5px solid rgba(255,255,255,.96);font-family:inherit;
        color:#fff;line-height:1.42;box-shadow:0 5px 20px #0007;
        opacity:1;transition:opacity .18s ease,transform .18s ease;}
      #${bannerId} .jf-banner-content { display:flex;gap:12px;align-items:center;min-width:0; }
      #${bannerId} .jf-banner-icon { font-size:24px;flex-shrink:0; }
      #${bannerId} .jf-banner-text { min-width:0; }
      #${bannerId} .jf-banner-title { font-size:16px;font-weight:700; }
      #${bannerId} .jf-banner-message { font-size:13px;opacity:.87;margin-top:3px; }
      #${bannerId} .jf-banner-extra { font-size:12px;opacity:.87;margin-top:4px;
        display:flex;flex-wrap:wrap;gap:4px 14px; }
      #${bannerId} .jf-banner-close {position:absolute;right:10px;top:10px;
        border:0;border-radius:50%;width:28px;height:28px;background:#ffffff30;
        color:#fff;font-size:20px;line-height:26px;cursor:pointer;
        transition:transform .15s ease,background-color .15s ease;}
      #${bannerId} .jf-banner-close:hover {background:#ffffff55;transform:scale(1.08);}
      #${bannerId}.jf-floating {position:fixed;left:50%;transform:translateX(-50%);
        width:min(800px,calc(100vw - 32px));margin:0;z-index:9999;}
      #${bannerId}.jf-floating[data-position="top"] {top:max(72px,env(safe-area-inset-top));}
      #${bannerId}.jf-floating[data-position="bottom"] {bottom:max(16px,env(safe-area-inset-bottom));}
      @media(max-width:650px){#${bannerId}{margin:9px auto;padding:12px 38px 12px 12px;gap:8px;}
        #${bannerId} .jf-banner-icon{font-size:20px;}#${bannerId} .jf-banner-title{font-size:15px;}}
    `;
    document.head.appendChild(style);
  }

  function render(data) {
    lastData = data;
    if (!data?.show || isLogin() || Date.now() < dismissedUntil) { remove(); return; }
    const a = data.appearance || {};
    const floating = field(a, 'layout') === 'floating';
    const home = !floating ? homeNode() : null;
    if (!floating && (!onHome() || !home)) { remove(); return; }
    installCss();
    const colors = {active:field(a,'activeColor'),expiring:field(a,'expiringColor'),
      expired:field(a,'expiredColor'),unmanaged:field(a,'unmanagedColor')};
    const base = colors[data.status] || '#3b82f6';
    const color = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(data.customColor || '') ? data.customColor : base;
    const message = {active:field(a,'activeText'),expiring:field(a,'expiringText'),
      expired:field(a,'expiredText'),unmanaged:field(a,'unmanagedText')}[data.status] || 'Subscription information';
    const values = {
      name:data.userName || 'Subscriber',plan:data.plan || '—',status:data.status,
      expiration:data.paidThrough || '—',daysLeft:data.daysRemaining ?? '—',
      renewal:data.renewalOn || '—',balance:typeof data.balanceCents === 'number' ? cash(data.balanceCents) : '—'
    };
    let banner = document.getElementById(bannerId);
    if (!banner) { banner = document.createElement('section'); banner.id = bannerId;
      banner.setAttribute('role','status'); banner.setAttribute('aria-live','polite'); }
    banner.className = floating ? 'jf-floating' : '';
    banner.dataset.position = field(a,'position') === 'bottom' ? 'bottom' : 'top';
    banner.style.background = field(a,'gradient') !== false
      ? `linear-gradient(110deg,${color},rgba(25,25,30,.95))` : color;
    banner.style.boxShadow = `0 6px 24px #0007, 0 2px 16px ${color}44`;
    banner.replaceChildren();
    const content = document.createElement('div'); content.className = 'jf-banner-content';
    const icon = document.createElement('span'); icon.className = 'jf-banner-icon';
    icon.textContent = field(a,'icon') || '👋'; content.appendChild(icon);
    const text = document.createElement('div'); text.className = 'jf-banner-text';
    const heading = document.createElement('div'); heading.className = 'jf-banner-title';
    heading.textContent = format(data.customTitle || field(a,'titleTemplate') || 'Welcome, {name}!', values);
    text.appendChild(heading);
    const sub = document.createElement('div'); sub.className = 'jf-banner-message';
    sub.textContent = format(message, values);
    text.appendChild(sub);
    const extras = [];
    if (data.plan) extras.push('Plan: ' + data.plan);
    if (data.paidThrough) extras.push('Paid through: ' + data.paidThrough);
    if (data.renewalOn) extras.push('Next renewal: ' + data.renewalOn);
    if (typeof data.balanceCents === 'number') extras.push('Credit: ' + cash(data.balanceCents));
    if (extras.length) {
      const detail = document.createElement('div'); detail.className = 'jf-banner-extra';
      for (const part of extras) { const span = document.createElement('span'); span.textContent = part; detail.appendChild(span); }
      text.appendChild(detail);
    }
    content.appendChild(text); banner.appendChild(content);
    refreshMs = Math.max(1, Math.min(120, Number(field(a, 'refreshMinutes')) || 5)) * 60000;
    if (field(a, 'dismissible') !== false) {
      const dismiss = document.createElement('button'); dismiss.className = 'jf-banner-close';
      dismiss.type = 'button'; dismiss.textContent = '×'; dismiss.setAttribute('aria-label','Dismiss subscription notice');
      dismiss.addEventListener('click', () => {
        dismissedUntil = Date.now() + refreshMs; banner.style.opacity = '0';
        banner.style.transform = floating ? 'translate(-50%,-6px)' : 'translateY(-6px)';
        window.setTimeout(remove, 185);
      });
      banner.appendChild(dismiss);
    }
    if (floating && banner.parentElement !== document.body) document.body.appendChild(banner);
    else if (home && (banner.parentElement !== home || home.firstElementChild !== banner)) home.prepend(banner);
  }

  async function refresh(force = false) {
    const client = api();
    const identity = typeof client?.getCurrentUserId === 'function' ? client.getCurrentUserId() : null;
    if (identity !== lastIdentity) { remove(); lastData = null; lastRefresh = 0; lastIdentity = identity; }
    if (isLogin() || !client || !identity || typeof client.ajax !== 'function') { remove(); return; }
    if (!endpoint || requestInFlight || (!force && Date.now() - lastRefresh < refreshMs)) {
      if (lastData) render(lastData); return;
    }
    requestInFlight = true;
    lastRefresh = Date.now();
    try { render(await client.ajax({type:'GET',url:endpoint,dataType:'json'})); }
    catch (_) { lastData = null; remove(); }
    finally { requestInFlight = false; }
  }

  function start() {
    if (document.body) {
      const observer = new MutationObserver(() => {
        if (!document.hidden && lastData && !isLogin() && !document.getElementById(bannerId)) render(lastData);
      });
      observer.observe(document.body,{childList:true,subtree:false});
    }
    window.addEventListener('hashchange', () => { remove(); refresh(true); });
    window.addEventListener('popstate', () => refresh(true));
    window.addEventListener('pageshow', () => refresh(true));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
    window.setInterval(() => refresh(), 10000);
    refresh(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start,{once:true});
  else start();
})();
