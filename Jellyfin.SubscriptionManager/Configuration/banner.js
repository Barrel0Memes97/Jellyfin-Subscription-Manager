/* Subscription Manager browser banner. No third-party JavaScript injector required.
 * Only displayed to an authenticated user and only contains that user's data.
 * Jellyfin Web only; native TV/mobile clients will not display this UI. */
(() => {
  'use strict';
  if (window.__jellyfinSubscriptionBannerLoaded) return;
  window.__jellyfinSubscriptionBannerLoaded = true;
  const script = document.currentScript;
  const endpoint = script?.src ? new URL('me', script.src).toString() : null;
  const bannerId = 'sm-user-banner';
  const styleId = 'sm-user-banner-css';
  let inFlight = false;
  let lastRefresh = 0;
  let refreshMs = 5 * 60 * 1000;
  let dismissedUntil = 0;

  const getClient = () => window.ApiClient || window.apiClient;
  const money = cents => (cents / 100).toLocaleString(undefined, {
    style: 'currency', currency: 'USD'
  });

  function removeBanner() { document.getElementById(bannerId)?.remove(); }

  function installCss() {
    if (document.getElementById(styleId)) return;
    const css = document.createElement('style');
    css.id = styleId;
    css.textContent = `
      #${bannerId} {position:fixed;z-index:9999;left:50%;transform:translateX(-50%);
        width:min(850px,calc(100vw - 24px));box-sizing:border-box;
        box-shadow:0 6px 24px #0006;border:1px solid #ffffff35;border-radius:12px;
        color:#fff;padding:11px 48px 11px 17px;line-height:1.45;
        font-family:inherit;font-size:14px;pointer-events:auto;}
      #${bannerId}[data-position="top"] {top:max(78px,env(safe-area-inset-top));}
      #${bannerId}[data-position="bottom"] {bottom:max(18px,env(safe-area-inset-bottom));}
      #${bannerId} .sm-banner-title {font-weight:700;font-size:15px;display:block;}
      #${bannerId} .sm-banner-detail {font-size:13px;opacity:.94;display:flex;gap:5px 12px;flex-wrap:wrap;}
      #${bannerId} .sm-banner-close {position:absolute;top:8px;right:8px;color:inherit;
        border:0;background:#ffffff2a;border-radius:50%;cursor:pointer;
        width:30px;height:30px;font-size:20px;line-height:25px;}
      @media (max-width:650px) {#${bannerId}[data-position="top"] {top:max(68px,env(safe-area-inset-top));}}
    `;
    document.head.appendChild(css);
  }

  function isLoginView() {
    return /(?:login|selectserver|selectuser)/i.test(location.hash) ||
      !!document.querySelector('.loginPage:not(.hide), #loginPage:not(.hide)');
  }

  function show(data) {
    const client = getClient();
    if (isLoginView() || !data?.show || !client || (typeof client.getCurrentUserId === 'function' && !client.getCurrentUserId()) || Date.now() < dismissedUntil) {
      removeBanner();
      return;
    }
    installCss();
    const a = data.appearance || {};
    const color = ({active:a.activeColor, expiring:a.expiringColor,
      expired:a.expiredColor, unmanaged:a.unmanagedColor})[data.status] || '#374151';
    const title = ({active:a.activeText, expiring:a.expiringText,
      expired:a.expiredText, unmanaged:a.unmanagedText})[data.status] || 'Subscription status';
    let el = document.getElementById(bannerId);
    if (!el) {
      el = document.createElement('section');
      el.id = bannerId;
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.dataset.position = a.position === 'bottom' ? 'bottom' : 'top';
    el.style.backgroundColor = /^#[0-9a-f]{6}$/i.test(color) ? color : '#374151';
    el.replaceChildren();
    const heading = document.createElement('strong');
    heading.className = 'sm-banner-title';
    heading.textContent = data.userName ? `${data.userName}: ${title}` : title;
    el.appendChild(heading);
    const detail = document.createElement('div');
    detail.className = 'sm-banner-detail';
    const parts = [];
    if (data.plan) parts.push('Plan: ' + data.plan);
    if (data.paidThrough) parts.push('Paid through: ' + data.paidThrough);
    if (data.status === 'expiring' && Number.isInteger(data.daysRemaining)) {
      parts.push(data.daysRemaining === 0 ? 'Expires today' :
        `${data.daysRemaining} day${data.daysRemaining === 1 ? '' : 's'} remaining`);
    }
    if (typeof data.balanceCents === 'number') parts.push('Credit: ' + money(data.balanceCents));
    for (const part of parts) {
      const span = document.createElement('span');
      span.textContent = part;
      detail.appendChild(span);
    }
    el.appendChild(detail);
    if (a.dismissible) {
      const close = document.createElement('button');
      close.className = 'sm-banner-close';
      close.setAttribute('aria-label', 'Dismiss subscription notice');
      close.type = 'button';
      close.textContent = '×';
      close.addEventListener('click', () => {
        dismissedUntil = Date.now() + refreshMs;
        removeBanner();
      });
      el.appendChild(close);
    }
    refreshMs = Math.max(1, Math.min(120, Number(a.refreshMinutes) || 5)) * 60000;
  }

  async function refresh(force = false) {
    const now = Date.now();
    if (inFlight || !endpoint || (!force && now - lastRefresh < refreshMs)) return;
    const client = getClient();
    if (!client || (typeof client.getCurrentUserId === 'function' && !client.getCurrentUserId()) || typeof client.ajax !== 'function') {
      removeBanner();
      return;
    }
    inFlight = true;
    lastRefresh = now;
    try {
      // ApiClient supplies the current Jellyfin user's access token.
      const response = await client.ajax({type:'GET',url:endpoint,dataType:'json'});
      show(response);
    } catch (_) {
      removeBanner(); // no account details are displayed on auth/network failure
    } finally {
      inFlight = false;
    }
  }

  // Jellyfin Web is a single-page application. Refresh on route/user changes.
  window.addEventListener('pageshow', () => refresh(true));
  window.addEventListener('popstate', () => refresh(true));
  window.addEventListener('hashchange', () => { if (isLoginView()) removeBanner(); else refresh(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  const observer = new MutationObserver(() => {
    if (!document.hidden && Date.now() - lastRefresh > refreshMs) refresh();
  });
  function start() {
    if (document.body) observer.observe(document.body, {childList:true,subtree:false});
    refresh(true);
    window.setInterval(() => {
      if (isLoginView()) removeBanner();
      else refresh();
    }, 10000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
  else start();
})();
