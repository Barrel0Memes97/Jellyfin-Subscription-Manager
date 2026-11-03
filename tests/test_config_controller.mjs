/* Lightweight Jellyfin 12 view-controller regression test; no third-party test runner needed. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../Jellyfin.SubscriptionManager/Configuration/SubscriptionManager.js', import.meta.url), 'utf8');
const { default: Controller } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

class Element {
  constructor(id = '') {
    this.id = id;
    this.dataset = {};
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.textContent = '';
    this.innerHTML = '';
    this.style = {};
    this.classList = { toggle: () => {}, contains: () => false };
    this.attributes = {};
  }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
  async fire(name, event = {}) {
    for (const fn of this.listeners[name] || []) await fn(event);
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  appendChild() {}
  replaceChildren() {}
  scrollIntoView() { this.scrolled = true; }
  reset() { this.value = ''; }
}

function createPage() {
  const elements = new Map();
  const page = new Element('subscriptionManagerPage');
  const tabs = ['users', 'plans', 'payments', 'transactions', 'banner', 'settings'].map(name => {
    const el = new Element('tab-' + name);
    el.dataset.tab = name;
    return el;
  });
  const panels = tabs.map(t => new Element('sm-panel-' + t.dataset.tab));
  const get = sel => {
    const dataPlan = sel.match(/^\[data-plan="(.+)"\]$/);
    assert.ok(sel.startsWith('#') || dataPlan, 'unexpected selector ' + sel);
    const id = dataPlan ? 'plan-picker-' + dataPlan[1] : sel.slice(1);
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  page.querySelector = get;
  const names = ['enableMediaPlayback','enableRemoteAccess','enableContentDownloading','enableLiveTvAccess',
    'enableVideoPlaybackTranscoding','enableAudioPlaybackTranscoding','enablePlaybackRemuxing'];
  const permissionControls = names.map(name => {
    const el = new Element('perm-' + name); el.dataset.smPlanPermission = name; return el;
  });
  page.querySelectorAll = sel => sel === '.sm-tab' ? tabs : sel === '.sm-panel' ? panels :
    sel === '[data-sm-plan-permission]' ? permissionControls : [];
  get('#sm-pay-user').value = '';
  get('#sm-ledger-user').value = '';
  get('#sm-b-preview-status').value = 'active';
  return { page, tabs, panels, get, permissionControls };
}

globalThis.document = { createElement: (name) => new Element(name) };
const id = 'c4c15b58-9cf0-4acc-99a3-f6bcb617b321';
const planId = '30bd6817-e984-4bea-a1db-64d32db618c1';
const state = {
  users: [{userId:id, name:'Demo', included:false, administrator:false, planId:null,
    balanceCents:0, paidThrough:null, status:'not managed', nextChargeOn:null}],
  // A real server may serialize concrete Plan objects with capitalized keys.
  plans: [{Id:planId, Name:'Basic', MonthlyCents:450, Enabled:true, Description:'Standard access',
    JellyfinPermissions:{EnableContentDownloading:false}, SeerrRequestAccess:'deny'}],
  ledger: [], activeCount:0, enrolledCount:0,
  totalCollectedCents:0, totalBalanceCents:0, timeZoneId:'America/Los_Angeles', banner:null,
  seerr:{enabled:true, url:'http://seerr:5055', hasApiKey:true, autoImportUsers:false, status:'Connected'}
};
const calls = [];
globalThis.ApiClient = {
  getUrl: path => '/' + path,
  ajax: async options => {
    calls.push(options);
    if (options.url.includes('/overview')) return structuredClone(state);
    return { success:true };
  }
};

const { page, tabs, panels, get, permissionControls } = createPage();
new Controller(page);
assert.ok(page.listeners.click?.length, 'click delegation not attached');
assert.ok(page.listeners.viewshow?.length, 'viewshow not attached');
assert.ok(get('#sm-plan-form').listeners.submit?.length, 'form handler not attached');
await new Promise(resolve => setImmediate(resolve));
assert.ok(calls.some(c => c.url.includes('/overview')), 'admin data never requested');
assert.match(get('#sm-metrics').innerHTML, /Active subscriptions/);
assert.match(get('#sm-plans').innerHTML, /Basic/);
assert.match(get('#sm-plans').innerHTML, /\$4\.50/);
assert.match(get('#sm-plans').innerHTML, /Yes/);
assert.doesNotMatch(get('#sm-plans').innerHTML, /Hidden/);
assert.match(get('#sm-users').innerHTML, /Basic/);
assert.match(get('#sm-users').innerHTML, /\$4\.50/);
assert.equal(get('#sm-seerr-key').value, '', 'API secret must never be inserted into UI');
assert.match(get('#sm-plans').innerHTML, /Set default/, 'plan table lacks a one-click default action');
assert.match(get('#sm-default-plan-current').textContent, /No default plan selected/, 'default-plan summary missing');
assert.match(get('#sm-users-default-plan').textContent, /No default plan selected/, 'Users page does not expose default status');
// One-click default choice saves a real plan ID using the administrator API.
await page.fire('click', {target:{closest:()=>({dataset:{defaultPlan:planId},id:'set-default'})}});
const quickDefault = calls.filter(c => c.url.endsWith('/plans/default')).at(-1);
assert.equal(JSON.parse(quickDefault.data).planId, planId);


// All six tabs must respond without making a network request.
for (let i = 0; i < tabs.length; i++) {
  await page.fire('click', { target: {closest: () => tabs[i]} });
  panels.forEach((panel, j) => assert.equal(panel.hidden, i !== j, `tab ${i} did not select the right panel`));
  assert.equal(tabs[i].attributes['aria-selected'], 'true');
}

// User configure action must make the details panel visible AND scroll into view.
await page.fire('click', { target:{ closest:()=>({dataset:{ details:id }, id:'details'}) } });
assert.equal(get('#sm-detail').hidden, false);
assert.equal(get('#sm-detail').scrolled, true);
assert.match(get('#sm-detail-name').textContent, /Demo/);

// Opening plan config must populate all fields using normalized plan data.
await page.fire('click', { target:{ closest:()=>({dataset:{ editPlan:planId }, id:'edit'}) } });
assert.equal(get('#sm-plan-name').value, 'Basic');
assert.equal(get('#sm-plan-price').value, '4.50');
assert.equal(get('#sm-plan-enabled').checked, true);
assert.equal(get('#sm-plan-desc').value, 'Standard access');
assert.equal(get('#sm-plan-seerr').value, 'deny');
assert.equal(permissionControls.find(e => e.dataset.smPlanPermission === 'enableContentDownloading').value, 'false');


// Form submission must reach the authenticated API.
get('#sm-plan-name').value = 'Standard';
get('#sm-plan-price').value = '5.00';
get('#sm-plan-enabled').checked = true;
await get('#sm-plan-form').fire('submit', { preventDefault() {} });
const planSave = calls.find(c => c.url.endsWith('/plans'));
assert.ok(planSave, 'Save plan never sent a request');
assert.equal(JSON.parse(planSave.data).monthlyCents, 500);
assert.equal(JSON.parse(planSave.data).seerrRequestAccess, 'deny');
assert.equal(JSON.parse(planSave.data).description, 'Standard access');
assert.equal(JSON.parse(planSave.data).jellyfinPermissions.enableContentDownloading, false);
assert.equal(JSON.parse(planSave.data).jellyfinPermissions.enableRemoteAccess, null);

// Enrolling a user must send the selected user ID and on/off value.
get('#sm-plan-id').value = '';
get('#sm-pay-user').value = id;
await page.fire('change', { target: {dataset:{enroll:id}, checked:true} });
const enrollment = calls.find(c => c.url.endsWith('/users/' + id));
assert.ok(enrollment, 'Enroll toggle did not send a request');
assert.equal(JSON.parse(enrollment.data).included, true);

// A plan selection must enroll the user atomically, while clearing it disables.
await page.fire('change', { target: { dataset:{plan:id}, value:planId } });
const assignment = calls.filter(c => c.url.endsWith('/users/' + id)).at(-1);
assert.equal(JSON.parse(assignment.data).planId, planId);
assert.equal(JSON.parse(assignment.data).included, true);
await page.fire('change', { target: { dataset:{plan:id}, value:'' } });
const cleared = calls.filter(c => c.url.endsWith('/users/' + id)).at(-1);
assert.equal(JSON.parse(cleared.data).planId, null);
assert.equal(JSON.parse(cleared.data).included, false);

// Enabling from the checkbox with no selected plan uses the configured default.
state.defaultPlanId = planId;
await page.fire('viewshow');
await new Promise(resolve => setImmediate(resolve));
get('#plan-picker-' + id).value = '';
await page.fire('change', { target: {dataset:{enroll:id}, checked:true} });
const fromDefault = calls.filter(c => c.url.endsWith('/users/' + id)).at(-1);
assert.equal(JSON.parse(fromDefault.data).included, true);
assert.equal(JSON.parse(fromDefault.data).planId, planId);
// A disabled checkbox keeps a previously assigned plan for easy re-enrollment.
get('#plan-picker-' + id).value = planId;
await page.fire('change', {target:{dataset:{enroll:id}, checked:false}});
const unchecked = calls.filter(c => c.url.endsWith('/users/' + id)).at(-1);
assert.equal(JSON.parse(unchecked.data).included, false);
assert.equal(JSON.parse(unchecked.data).planId, planId);

// The Plans tab exposes a saveable default plan selector.
get('#sm-default-plan').value = planId;
await get('#sm-default-plan-form').fire('submit', {preventDefault(){}});
const defaultSave = calls.find(c => c.url.endsWith('/plans/default'));
assert.equal(JSON.parse(defaultSave.data).planId, planId);

// Seerr settings must not leak/clear the existing API key on a blank edit.
get('#sm-seerr-enabled').checked = true;
get('#sm-seerr-url').value = 'http://seerr:5055';
get('#sm-seerr-key').value = '';
await get('#sm-seerr-form').fire('submit', { preventDefault() {} });
const seerrSave = calls.find(c => c.url.endsWith('/seerr/settings'));
assert.ok(seerrSave, 'Seerr settings did not save');
assert.equal(JSON.parse(seerrSave.data).apiKey, '');
assert.equal(JSON.parse(seerrSave.data).clearApiKey, false);

// Banner form must post its configuration to the correct endpoint.
await get('#sm-banner-form').fire('submit', { preventDefault() {} });
assert.ok(calls.some(c => c.url.endsWith('/banner')), 'Banner settings did not save');

// Reflect a successful plan assignment in the mock server on the next page load.
state.users[0].planId = planId;
await page.fire('viewshow');
// New 0.2.4.0: Friday-cycle selector and opening-credit mode must make
// authenticated POST requests with the selected user's id, not screen labels.
get('#sm-detail-cycle').value = 'lastFriday';
await get('#sm-cycle-form').fire('submit', {preventDefault() {}});
const cycleRequest = calls.find(c => c.url.endsWith('/users/' + id + '/billing-cycle'));
assert.equal(JSON.parse(cycleRequest.data).cycle, 'lastFriday');

globalThis.confirm = () => true;
get('#sm-opening-start').value = '2026-12-08';
get('#sm-opening-payment').value = '20.00';
get('#sm-opening-credit-toggle').checked = true;
get('#sm-opening-credit').value = '20.00';
await get('#sm-opening-form').fire('change', {target:get('#sm-opening-credit-toggle')});
assert.equal(get('#sm-opening-credit-wrap').hidden, false);
assert.equal(get('#sm-opening-through-wrap').hidden, true);
assert.match(get('#sm-opening-preview').textContent, /4 full month/); // $20 / $4.50
await get('#sm-opening-form').fire('submit', {preventDefault() {}});
const initial = calls.find(c => c.url.endsWith('/users/' + id + '/opening'));
assert.ok(initial, 'opening credit was not submitted');
assert.equal(JSON.parse(initial.data).firstPaymentCents, 2000);
assert.equal(JSON.parse(initial.data).startingCreditCents, 2000);
assert.equal(JSON.parse(initial.data).mode, 'credit');

get('#sm-user-banner-title').value = 'Welcome back, {name}!';
get('#sm-user-banner-color').value = '#4120ff';
get('#sm-user-banner-use-color').checked = true;
get('#sm-user-banner-message').value = 'Your special welcome, {name}!';
await get('#sm-user-banner-form').fire('submit', {preventDefault() {}});
const personal = calls.find(c => c.url.endsWith('/users/' + id + '/banner'));
assert.equal(JSON.parse(personal.data).color, '#4120ff');
assert.equal(JSON.parse(personal.data).message, 'Your special welcome, {name}!');

// Update statuses must NOT make billing charges. It uses overview?recalculate=false.
await page.fire('click', {target:{closest:()=>({dataset:{},id:'sm-sync-statuses'})}});
assert.ok(calls.some(c => c.url.endsWith('/sync/statuses')));
assert.ok(calls.some(c => c.url.endsWith('/overview?recalculate=false')));
assert.equal(get('#sm-flash').scrolled, true, 'alerts should scroll into view');

// Seerr test must use unsaved form values, rather than silently testing
// the previously persisted credentials.
get('#sm-seerr-url').value = 'http://seerr-new:5055';
get('#sm-seerr-key').value = 'seerr-secret-not-persisted-yet';
await page.fire('click', {target:{closest:()=>({dataset:{},id:'sm-seerr-test'})}});
const testRequest = calls.find(c => c.url.endsWith('/seerr/test'));
assert.equal(JSON.parse(testRequest.data).url, 'http://seerr-new:5055');
assert.equal(JSON.parse(testRequest.data).apiKey, 'seerr-secret-not-persisted-yet');

const txId = 'd1e66419-bf20-42be-a48b-fc62161e8e8b';
state.ledger = [{Id:txId,UserId:id,Kind:'deposit',AmountCents:2000,
  CashAmountCents:2000,BalanceAfterCents:2000,Refundable:true,CreatedUtc:'2026-12-08T12:00:00Z',Note:'Cash'}];
await page.fire('viewshow');
await new Promise(resolve => setImmediate(resolve));
assert.match(get('#sm-ledger').innerHTML, /Refund/);
await page.fire('click', {target:{closest:()=>({dataset:{refund:txId},id:'refund'})}});
const refundRequest = calls.find(c => c.url.endsWith('/transactions/' + txId + '/refund'));
assert.ok(refundRequest, 'refund did not send a request');

// Banner preview must show a gradient and its custom greeting, even when
// server settings are serialized in PascalCase.
state.banner = {Enabled:true, Layout:'home', Gradient:true, Icon:'👋', TitleTemplate:'Welcome, {name}!',
  ActiveColor:'#166534', ActiveText:'Active until {expiration}', ShowUserName:true,
  ShowPlan:true, ShowPaidThrough:true, ShowRenewal:true, Dismissible:true};
await page.fire('viewshow');
await new Promise(resolve => setImmediate(resolve));
assert.match(get('#sm-b-preview').style.background, /linear-gradient/);
assert.equal(get('#sm-b-title-template').value, 'Welcome, {name}!');
get('#sm-b-position').value = 'bottom';
get('#sm-b-layout').value = 'home';
await get('#sm-banner-form').fire('input', {});
assert.equal(get('#sm-b-preview-viewport').dataset.position, 'bottom');
assert.match(get('#sm-b-preview-placement').textContent, /bottom of the content/);
get('#sm-b-layout').value = 'floating';
await get('#sm-banner-form').fire('input', {});
assert.match(get('#sm-b-preview-placement').textContent, /bottom of the screen/);

// Repeated controller setup on the same DOM node should not multiply callbacks.
const before = page.listeners.click.length;
new Controller(page);
assert.equal(page.listeners.click.length, before);

// Even when the overview endpoint is unavailable, the tab controls should stay functional
// and surface the server error rather than silently doing nothing.
const originalAjax = globalThis.ApiClient.ajax;
globalThis.ApiClient.ajax = async () => { throw new Error('Mock 403'); };
const originalError = console.error;
console.error = () => {}; // This API error is intentional in the test.
const bad = createPage();
new Controller(bad.page);
await new Promise(resolve => setImmediate(resolve));
assert.match(bad.get('#sm-flash').textContent, /Mock 403/);
await bad.page.fire('click', { target: {closest: () => bad.tabs[4]} });
assert.equal(bad.panels[4].hidden, false);
globalThis.ApiClient.ajax = originalAjax;
console.error = originalError;
console.log('Admin UI controller tests passed (billing cycle, opening credit, personal banner, refund, Seerr test, status sync, banner preview, original coverage).');
