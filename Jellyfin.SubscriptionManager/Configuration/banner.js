/* Subscription Manager banner for Jellyfin 12 Web.
 * The home screen is rebuilt by Jellyfin's router/React after initial load.
 * Mounting once, or observing only document.body's immediate children, makes
 * the banner flash on refresh and then vanish. Retain our element and remount
 * it in the CURRENT home-page container after DOM and navigation changes.
 * Only /SubscriptionManager/me (authenticated current user) is requested. */
(() => {
  'use strict';
  if (window.__jellyfinSubscriptionBannerLoaded) return;
  window.__jellyfinSubscriptionBannerLoaded = true;

  const script = document.currentScript;
  const endpoint = script?.src ? new URL('me', script.src).toString() : null;
  const bannerId = 'jf-personalized-user-banner';
  const styleId = 'jf-subscription-banner-style';
  let bannerElement = null;
  let lastRefresh = 0;
  let dismissedUntil = 0;
  let refreshMs = 5 * 60000;
  let requestInFlight = false;
  let lastIdentity = null;
  let lastData = null;
  let mountQueued = false;

  const api = () => window.ApiClient || window.apiClient;
  const cash = value => new Intl.NumberFormat('en-US', {style:'currency',currency:'USD'}).format(value / 100);
  const field = (object, key) => object?.[key] ?? object?.[key[0].toUpperCase() + key.slice(1)];
  const format = (value, substitutions) => String(value || '').replace(/\{(name|plan|status|expiration|daysLeft|renewal|balance)\}/g,
    (_, key) => String(substitutions[key] ?? '—'));

  function visiblyPresent(element) {
    if (!element || !element.isConnected || element.closest('.hide, [hidden], [aria-hidden="true"]')) return false;
    // A cached home tab may still be present but CSS-hidden in the old view.
    // Do not use offsetParent: Jellyfin's modern fixed-position UI has none.
    return typeof element.getClientRects !== 'function' || element.getClientRects().length > 0;
  }

  function isLogin() {
    if (/(?:login|selectserver|selectuser)/i.test(location.pathname + location.hash)) return true;
    return [...document.querySelectorAll('.loginPage, #loginPage')].some(visiblyPresent);
  }

  function activeHomeTab() {
    const tab = [...document.querySelectorAll('#homeTab')].find(visiblyPresent);
    if (!tab) return null;
    // Jellyfin can cache Home while another native tab is selected.
    const siblings = tab.parentElement?.querySelectorAll('.tabContent.is-active, .pageTabContent.is-active') || [];
    if (siblings.length && !tab.classList.contains('is-active')) return null;
    return tab;
  }

  function homeNode() {
    const tab = activeHomeTab();
    if (tab) return tab.querySelector('.homeSectionsContainer') || tab;
    const nodes = document.querySelectorAll(
      '#indexPage .homeSectionsContainer, #indexPage .homePageMain, .homePageMain, .homePage, .homeSectionsContainer');
    return [...nodes].find(visiblyPresent) || null;
  }

  // The original jellyfin-banner.js prepended to .homePageMain (or .homePage),
  // NOT to .homeSectionsContainer. Sections follow the Media Bar/hero, so
  // prepending inside sections incorrectly puts the banner BELOW the hero.
  // Jellyfin 12 and Media Bar also use #homeTab > #slides-container. When the
  // hero exists, insert the banner immediately before it in the same parent.
  // This puts the banner below Jellyfin's header and above the media slideshow.
  function homeTopPlacement() {
    const tab = activeHomeTab();
    const root = tab || [...document.querySelectorAll(
      '#indexPage .homePageMain, .homePageMain, #indexPage .homePage, .homePage')]
      .find(visiblyPresent);
    if (!root) return null;
    const media = root.querySelector(
      '#slides-container, #mediaBar, #media-bar, .mediaBar, .media-bar, .slideshow-container');
    if (media && visiblyPresent(media) && media.parentElement && root.contains(media.parentElement)) {
      return { target: media.parentElement, before: media };
    }
    if (tab) {
      // On Jellyfin 12, #homeTab itself is below the application menu bar.
      // Inserting before its sections also handles heroes added later.
      return { target: tab, before: null };
    }
    return { target: root, before: null };
  }

  function onHome() {
    const route = (location.hash || '').replace(/^#\/?/, '/').toLowerCase();
    if (route && !/^\/(?:home(?:\.html)?|index(?:\.html)?)(?:[/?#]|$)/.test(route)) return false;
    const pathname = location.pathname.toLowerCase();
    if (!route && !/(?:\/home(?:\.html)?|\/index(?:\.html)?|\/web\/?)$/.test(pathname)) {
      // Browser history routing in Jellyfin 12 can use /home without a hash.
      return false;
    }
    return !!homeNode();
  }

  function remove() {
    // Detached elements may not be found by getElementById; keep one instance.
    bannerElement?.remove();
  }

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

  function ensureMounted() {
    const data = lastData;
    if (!data?.show || isLogin() || Date.now() < dismissedUntil || !bannerElement) { remove(); return; }
    const floating = field(data.appearance || {}, 'layout') === 'floating';
    if (floating) {
      if (bannerElement.parentElement !== document.body) document.body.appendChild(bannerElement);
      return;
    }
    if (!onHome()) { remove(); return; }
    const bottom = field(data.appearance || {}, 'position') === 'bottom';
    if (bottom) {
      // Bottom intentionally follows every home section, not just the hero.
      const target = homeNode();
      if (!target) { remove(); return; }
      if (bannerElement.parentElement !== target || target.lastElementChild !== bannerElement) {
        target.appendChild(bannerElement);
      }
      return;
    }
    const placement = homeTopPlacement();
    if (!placement) { remove(); return; }
    const { target, before } = placement;
    if (before) {
      if (bannerElement.parentElement !== target || bannerElement.nextElementSibling !== before) {
        target.insertBefore(bannerElement, before);
      }
    } else if (bannerElement.parentElement !== target || target.firstElementChild !== bannerElement) {
      target.prepend(bannerElement);
    }
  }

  function queueMount() {
    if (mountQueued) return;
    mountQueued = true;
    window.requestAnimationFrame(() => {
      mountQueued = false;
      ensureMounted();
    });
  }

  function render(data) {
    lastData = data;
    if (!data?.show || isLogin() || Date.now() < dismissedUntil) { remove(); return; }
    installCss();
    const a = data.appearance || {};
    const floating = field(a, 'layout') === 'floating';
    const colors = {active:field(a,'activeColor'),expiring:field(a,'expiringColor'),
      expired:field(a,'expiredColor'),unmanaged:field(a,'unmanagedColor')};
    const base = colors[data.status] || '#3b82f6';
    // Personal colors and messages apply only to fully active subscriptions.
    // Warning and expired notices must remain distinguishable and informative.
    const color = data.status === 'active' && /^#[0-9a-f]{6}$/i.test(data.customColor || '')
      ? data.customColor : base;
    const message = data.status === 'active' && (data.customMessage || '').trim()
      ? data.customMessage
      : ({active:field(a,'activeText'),expiring:field(a,'expiringText'),
        expired:field(a,'expiredText'),unmanaged:field(a,'unmanagedText')}[data.status] || 'Subscription information');
    const values = {
      name:data.userName || 'Subscriber',plan:data.plan || '—',status:data.status,
      expiration:data.paidThrough || '—',daysLeft:data.daysRemaining ?? '—',
      renewal:data.renewalOn || '—',balance:typeof data.balanceCents === 'number' ? cash(data.balanceCents) : '—'
    };
    if (!bannerElement) {
      bannerElement = document.createElement('section');
      bannerElement.id = bannerId;
      bannerElement.setAttribute('role','status');
      bannerElement.setAttribute('aria-live','polite');
    }
    const banner = bannerElement;
    banner.className = floating ? 'jf-floating' : '';
    banner.dataset.position = field(a,'position') === 'bottom' ? 'bottom' : 'top';
    // Clear the other edge explicitly so updates never inherit stale placement.
    banner.style.top = floating && banner.dataset.position === 'top'
      ? 'max(72px, env(safe-area-inset-top))' : '';
    banner.style.bottom = floating && banner.dataset.position === 'bottom'
      ? 'max(16px, env(safe-area-inset-bottom))' : '';
    banner.style.opacity = '1';
    banner.style.transform = floating ? 'translateX(-50%)' : 'none';
    banner.style.background = field(a,'gradient') !== false
      ? `linear-gradient(110deg,${color},rgba(25,25,30,.95))` : color;
    banner.style.boxShadow = `0 6px 24px #0007, 0 2px 16px ${color}44`;
    banner.replaceChildren();
    const content = document.createElement('div'); content.className = 'jf-banner-content';
    const icon = document.createElement('span'); icon.className = 'jf-banner-icon';
    icon.textContent = field(a,'icon') || '👋'; content.appendChild(icon);
    const info = document.createElement('div'); info.className = 'jf-banner-text';
    const heading = document.createElement('div'); heading.className = 'jf-banner-title';
    heading.textContent = format(data.customTitle || field(a,'titleTemplate') || 'Welcome, {name}!', values);
    info.appendChild(heading);
    const sub = document.createElement('div'); sub.className = 'jf-banner-message';
    sub.textContent = format(message, values);
    info.appendChild(sub);
    const extras = [];
    if (data.plan) extras.push('Plan: ' + data.plan);
    if (data.paidThrough) extras.push('Paid through: ' + data.paidThrough);
    if (data.renewalOn) extras.push('Next renewal: ' + data.renewalOn);
    if (typeof data.balanceCents === 'number') extras.push('Credit: ' + cash(data.balanceCents));
    if (extras.length) {
      const detail = document.createElement('div'); detail.className = 'jf-banner-extra';
      for (const part of extras) { const span = document.createElement('span'); span.textContent = part; detail.appendChild(span); }
      info.appendChild(detail);
    }
    content.appendChild(info); banner.appendChild(content);
    refreshMs = Math.max(1, Math.min(120, Number(field(a, 'refreshMinutes')) || 5)) * 60000;
    if (field(a, 'dismissible') !== false) {
      const dismiss = document.createElement('button'); dismiss.className = 'jf-banner-close';
      dismiss.type = 'button'; dismiss.textContent = '×'; dismiss.setAttribute('aria-label','Dismiss subscription notice');
      dismiss.addEventListener('click', () => {
        dismissedUntil = Date.now() + refreshMs;
        banner.style.opacity = '0';
        banner.style.transform = floating ? 'translate(-50%,-6px)' : 'translateY(-6px)';
        window.setTimeout(remove, 185);
      });
      banner.appendChild(dismiss);
    }
    ensureMounted();
  }

  async function refresh(force = false) {
    const client = api();
    const identity = typeof client?.getCurrentUserId === 'function' ? client.getCurrentUserId() : null;
    if (identity !== lastIdentity) {
      remove(); lastData = null; lastRefresh = 0; lastIdentity = identity;
      dismissedUntil = 0; // A different signed-in user must have their own dismissal state.
    }
    if (isLogin() || !client || !identity || typeof client.ajax !== 'function') { remove(); return; }
    if (!endpoint || requestInFlight || (!force && Date.now() - lastRefresh < refreshMs)) {
      ensureMounted(); return;
    }
    requestInFlight = true;
    lastRefresh = Date.now();
    try {
      const data = await client.ajax({type:'GET',url:endpoint,dataType:'json'});
      // Ignore a response from a user who signed out/switched accounts mid-request.
      if (identity === lastIdentity && api()?.getCurrentUserId?.() === identity) render(data);
    } catch (_) {
      // Transient auth/network failures must not make an already-approved banner
      // disappear. A real logout still clears it via the identity check above.
      if (lastData) ensureMounted();
    } finally { requestInFlight = false; }
  }

  function start() {
    if (document.body) {
      const observer = new MutationObserver(() => {
        // Jellyfin 12 replaces nested homepage nodes without touching body's
        // immediate child list. No new HTTP request is needed to remount.
        if (!document.hidden && lastData) queueMount();
      });
      observer.observe(document.body, {childList:true, subtree:true});
    }
    const onNavigation = () => { queueMount(); refresh(); };
    window.addEventListener('hashchange', onNavigation);
    window.addEventListener('popstate', onNavigation);
    window.addEventListener('pageshow', onNavigation);
    document.addEventListener('viewshow', onNavigation);
    document.addEventListener('HISTORY_UPDATE', onNavigation);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { queueMount(); refresh(true); }
    });
    // Lightweight fallback for tab class changes that don't mutate child lists.
    // This only checks placement; the network refresh follows the saved cadence.
    window.setInterval(() => { ensureMounted(); refresh(); }, 5000);
    refresh(true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start,{once:true});
  else start();
})();
