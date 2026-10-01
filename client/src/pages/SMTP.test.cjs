// UI behavior tests use the actual JSX with mocked hooks, APIs, and timers.
// Run: node --test client/src/pages/SMTP.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const React = require('react');
const source = fs.readFileSync(__dirname + '/SMTP.jsx', 'utf8');
const code = transformSync(source + '\nexport { Wizard, parseNames, friendly, safeLog };', {
  loader: 'jsx', format: 'cjs', jsx: 'automatic',
}).code;
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(api = {}, billing = { canAccessApp: true }) {
  let cursor = 0;
  const slots = [], pending = [], timers = new Map();
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useCallback(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) slots[i] = { fn, deps };
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) {
        slots[i]?.cleanup?.();
        slots[i] = { deps };
        pending.push(() => { slots[i].cleanup = fn(); });
      }
    },
  };
  const upgrades = [];
  const context = {
    module: { exports: {} },
    require(name) {
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return require(name);
      if (name.includes('Sidebar')) return { __esModule: true, default: () => null };
      if (name.includes('/lib/api')) return { __esModule: true, default: api };
      if (name.includes('BillingContext')) return { useBilling: () => ({ billing, openUpgrade: v => upgrades.push(v), refreshBilling: () => {} }) };
      if (name.endsWith('.css')) return {};
      throw new Error(name);
    },
    document: { body: { style: {} }, activeElement: { focus() {} }, addEventListener() {}, removeEventListener() {}, hidden: false },
    navigator: {}, Blob, URL,
    setTimeout(fn, ms) { const id = Symbol(); timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = Symbol(); timers.set(id, { fn, ms }); return id; },
    clearInterval(id) { timers.delete(id); },
  };
  vm.runInNewContext(code, context);
  return {
    ...context.module.exports, timers, upgrades,
    render(component, props = {}) {
      cursor = 0;
      const tree = component(props);
      pending.splice(0).forEach(fn => fn());
      return tree;
    },
    dispose() { slots.forEach(slot => slot?.cleanup?.()); },
    async fire(ms) {
      const entry = [...timers.entries()].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `Expected a ${ms}ms timer`);
      timers.delete(entry[0]);
      await entry[1].fn(); await tick();
    },
  };
}
function nodes(tree, predicate) {
  const result = [];
  function visit(node) {
    if (!React.isValidElement(node)) { if (Array.isArray(node)) node.forEach(visit); return; }
    if (predicate(node)) result.push(node);
    visit(node.props.children);
  }
  visit(tree); return result;
}
function content(node) {
  if (Array.isArray(node)) return node.map(content).join('');
  if (React.isValidElement(node)) return content(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}
const draft = { id: 5, domain: 'example.com', status: 'draft', mailbox_names: [], name_servers: [], total_mailboxes: 0, nameservers_connected: false };
const prepared = { ...draft, status: 'pending_nameservers', name_servers: ['one.example.net', 'two.example.net'] };
function wizardProps(order = draft) { return { initialOrder: order, connected: true, onUpdate() {}, onClose() {}, onError: () => false }; }

test('One-per-line validation matches server rules and normalizes full addresses', () => {
  const f = fixture();
  assert.deepEqual(Array.from(f.parseNames(' Stacy@Example.com\r\namy+\nsam-\n', 'example.com').names), ['stacy', 'amy+', 'sam-']);
  for (const input of ['amy\n\nsam', 'Amy\namy', 'amy@other.com', 'amy,sam', 'amy.', 'a'.repeat(65)]) assert.ok(f.parseNames(input, 'example.com').error, input);
});
test('Safe errors and activity never render upstream secrets', () => {
  const f = fixture();
  for (const code of ['BILLING_REQUIRED', 'INBOX_LIMIT_REACHED', 'DOMAIN_UNAVAILABLE']) {
    const message = f.friendly({ response: { data: { code, error: 're_secret upstream body' } } });
    assert.ok(!message.includes('secret')); assert.notEqual(message, 'This action could not be completed. Try again.');
  }
  assert.equal(f.safeLog('re_secret password=secret'), 'Provisioning Paused');
  assert.equal(f.safeLog('Creating Inbox 2 Of 10'), 'Creating Inbox 2 Of 10');
});
test('Draft wizard polls repeatedly until prepared nameservers arrive, then stops', async () => {
  const updates = []; let gets = 0;
  const f = fixture({ get: async () => ({ data: ++gets < 3 ? draft : prepared }) });
  const props = { ...wizardProps(), onUpdate: order => updates.push(order) };
  let tree = f.render(f.Wizard, props); await tick();
  assert.equal(nodes(tree, n => n.type === 'button' && n.props.type === 'submit')[0].props.disabled, true);
  await f.fire(3000); await f.fire(3000);
  tree = f.render(f.Wizard, props);
  assert.ok(content(tree).includes('one.example.net') || nodes(tree, n => n.type === 'input' && n.props.value === 'one.example.net').length);
  assert.equal(nodes(tree, n => n.type === 'button' && n.props.type === 'submit')[0].props.disabled, false);
  assert.equal([...f.timers.values()].filter(t => t.ms === 3000).length, 0);
  assert.equal(updates.length, 3); f.dispose();
});
test('Closing the wizard prevents pending poll results and clears timers', async () => {
  let resolve; let updates = 0;
  const f = fixture({ get: () => new Promise(done => { resolve = done; }) });
  f.render(f.Wizard, { ...wizardProps(), onUpdate: () => updates++ });
  f.dispose(); resolve({ data: prepared }); await tick();
  assert.equal(updates, 0); assert.equal(f.timers.size, 0);
});
test('Failed draft retries preparation through the route contract before checking nameservers', async () => {
  const calls = [];
  const f = fixture({ post: async path => { calls.push(path); return { data: path.endsWith('/start') ? prepared : { order: { ...prepared, status: 'ready', nameservers_connected: true }, connected: true } }; } });
  const props = wizardProps({ ...draft, status: 'failed', error_code: 'RESEND_UNAVAILABLE' });
  let tree = f.render(f.Wizard, props);
  assert.ok(content(tree).includes('Retry Preparation'));
  nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }); await tick();
  tree = f.render(f.Wizard, props);
  assert.ok(content(tree).includes('Check Nameservers'));
  nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }); await tick();
  tree = f.render(f.Wizard, props);
  assert.ok(content(tree).includes('Enter one inbox name per line.'));
  assert.deepEqual(calls, ['/smtp/orders/5/start', '/smtp/orders/5/nameservers/check']); f.dispose();
});
test('Ready order continues the name wizard; connected card uses actual count and safe logs', async () => {
  const order = { ...prepared, status: 'ready', nameservers_connected: true };
  const f = fixture({ get: async path => ({ data: path === '/smtp/connection' ? { connected: true, connected_domain_count: 17 } : path.endsWith('/logs') ? [{ timestamp: '2026-10-01T00:00:00Z', message: 'password=secret' }] : [order] }) });
  f.render(f.default); await tick(); f.render(f.default); await tick();
  const tree = f.render(f.default);
  assert.ok(content(tree).includes('Resend — Connected'));
  assert.ok(content(tree).includes('Domains Connected: 17'));
  assert.ok(content(tree).includes('New SMTP Order'));
  assert.ok(content(tree).includes('Continue Setup'));
  assert.ok(!content(tree).includes('Start Provisioning'));
  assert.ok(!content(tree).includes('password=secret'));
  assert.equal(nodes(tree, n => n.type === 'time')[0].props.dateTime, '2026-10-01T00:00:00Z'); f.dispose();
});
test('Billing-required load opens upgrade once', async () => {
  const f = fixture({ get: async () => { throw { response: { data: { code: 'BILLING_REQUIRED', recommendedCheckoutIntent: 'starter' } } }; } });
  f.render(f.default); await tick();
  assert.deepEqual(f.upgrades, ['starter']); f.dispose();
});
test('Draft polling recovers from a temporary error and advances when DNS is already connected', async () => {
  let gets = 0;
  const f = fixture({ get: async () => {
    if (++gets === 1) throw { response: { data: { error: 'private upstream stack' } } };
    return { data: { ...prepared, status: 'ready', nameservers_connected: true } };
  } });
  const props = wizardProps();
  f.render(f.Wizard, props); await tick();
  let tree = f.render(f.Wizard, props);
  assert.ok(content(tree).includes('Retrying automatically.'));
  assert.ok(!content(tree).includes('private upstream stack'));
  await f.fire(3000); tree = f.render(f.Wizard, props);
  assert.ok(content(tree).includes('Enter one inbox name per line.'));
  assert.equal([...f.timers.values()].filter(t => t.ms === 3000).length, 0); f.dispose();
});
test('Failed preparation retries stay in the wizard and show only safe errors', async () => {
  const f = fixture({ post: async () => ({ data: { ...draft, status: 'failed', error_code: 'DOMAIN_UNAVAILABLE', error_message: 'private provider response' } }) });
  const props = wizardProps({ ...draft, status: 'failed' });
  let tree = f.render(f.Wizard, props);
  nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} }); await tick();
  tree = f.render(f.Wizard, props);
  assert.ok(content(tree).includes('Retry Preparation'));
  assert.ok(content(tree).includes('This domain is already in use.'));
  assert.ok(!content(tree).includes('private provider response')); f.dispose();
});
