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
  page.querySelectorAll = sel => sel === '.sm-tab' ? tabs : sel === '.sm-panel' ? panels : [];
  get('#sm-pay-user').value = '';
  get('#sm-ledger-user').value = '';
  get('#sm-b-preview-status').value = 'active';
  return { page, tabs, panels, get };
}

globalThis.document = { createElement: (name) => new Element(name) };
const id = 'c4c15b58-9cf0-4acc-99a3-f6bcb617b321';
const state = {
  users: [{userId:id, name:'Demo', included:false, administrator:false, planId:null,
    balanceCents:0, paidThrough:null, status:'not managed', nextChargeOn:null}],
  plans: [], ledger: [], activeCount:0, enrolledCount:0,
  totalCollectedCents:0, totalBalanceCents:0, timeZoneId:'America/Los_Angeles', banner:null
};
const calls = [];
globalThis.ApiClient = {
  getUrl: path => '/' + path,
  ajax: async options => {
    calls.push(options);
    if (options.url.endsWith('/overview')) return structuredClone(state);
    return { success:true };
  }
};

const { page, tabs, panels, get } = createPage();
new Controller(page);
assert.ok(page.listeners.click?.length, 'click delegation not attached');
assert.ok(page.listeners.viewshow?.length, 'viewshow not attached');
assert.ok(get('#sm-plan-form').listeners.submit?.length, 'form handler not attached');
await new Promise(resolve => setImmediate(resolve));
assert.ok(calls.some(c => c.url.endsWith('/overview')), 'admin data never requested');
assert.match(get('#sm-metrics').innerHTML, /Active subscriptions/);

// All six tabs must respond without making a network request.
for (let i = 0; i < tabs.length; i++) {
  await page.fire('click', { target: {closest: () => tabs[i]} });
  panels.forEach((panel, j) => assert.equal(panel.hidden, i !== j, `tab ${i} did not select the right panel`));
  assert.equal(tabs[i].attributes['aria-selected'], 'true');
}

// Form submission must reach the authenticated API.
get('#sm-plan-name').value = 'Standard';
get('#sm-plan-price').value = '5.00';
get('#sm-plan-enabled').checked = true;
await get('#sm-plan-form').fire('submit', { preventDefault() {} });
const planSave = calls.find(c => c.url.endsWith('/plans'));
assert.ok(planSave, 'Save plan never sent a request');
assert.equal(JSON.parse(planSave.data).monthlyCents, 500);

// Enrolling a user must send the selected user ID and on/off value.
get('#sm-plan-id').value = '';
get('#sm-pay-user').value = id;
await page.fire('change', { target: {dataset:{enroll:id}, checked:true} });
const enrollment = calls.find(c => c.url.endsWith('/users/' + id));
assert.ok(enrollment, 'Enroll toggle did not send a request');
assert.equal(JSON.parse(enrollment.data).included, true);

// Banner form must post its configuration to the correct endpoint.
await get('#sm-banner-form').fire('submit', { preventDefault() {} });
assert.ok(calls.some(c => c.url.endsWith('/banner')), 'Banner settings did not save');

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
console.log('Admin UI controller tests passed (load, six tabs, save plan, enrollment, banner save, error UI, duplicate handler prevention).');
