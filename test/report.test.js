import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { generatePlaywrightTest, renderHtml, renderMarkdown } from '../src/report.js';

const action = { id: 'checkout', type: 'click', selector: '#checkout', label: 'Complete checkout' };
const baseJourney = {
  version: 1, name: 'Checkout crashes', url: 'http://127.0.0.1:3000', setup: [], actions: [action],
  failure: { type: 'page-error', includes: 'CHECKOUT_TOTAL_UNDEFINED' },
  options: { actionTimeoutMs: 1000, observeMs: 150, viewport: { width: 1280, height: 800 } },
};
const makeReport = (overrides = {}) => ({
  version: 1, toolVersion: '0.1.0', createdAt: '2026-09-08T00:00:00.000Z',
  journey: { ...baseJourney, actions: [{ id: 'browse', type: 'click', selector: '#browse' }, action] },
  result: { status: 'complete', originalCount: 2, reducedActions: [action], runs: 8, confirmations: 2, verified: true, oneMinimal: true, trials: [{ index: 1, phase: 'baseline', actionIds: ['browse', 'checkout'], outcome: 'reproduced', durationMs: 234 }] },
  finalTrial: { outcome: 'reproduced', evidence: { matched: ['page-error: CHECKOUT_TOTAL_UNDEFINED'], pageErrors: ['CHECKOUT_TOTAL_UNDEFINED'], consoleErrors: [], httpErrors: [] } },
  ...overrides,
});

function generatedHarness(journey, settings = {}) {
  let body;
  let useOptions;
  let setTimeout;
  const calls = [];
  const listeners = new Map();
  const emit = (event, value) => { for (const fn of listeners.get(event) ?? []) fn(value); };
  const playwrightTest = (_name, callback) => { body = callback; };
  playwrightTest.use = (options) => { useOptions = options; };
  playwrightTest.setTimeout = (timeout) => { setTimeout = timeout; };
  const expect = (actual, message) => ({ toEqual: (expected) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message) });
  vm.runInNewContext(generatePlaywrightTest(journey).replace("import { test, expect } from '@playwright/test';", 'const { test, expect } = harness;'), { harness: { test: playwrightTest, expect }, process: { env: settings.env ?? {} } });
  assert.equal(typeof body, 'function');
  const invoke = async (type, selector, value) => {
    calls.push([type, selector, value]);
    await settings.onAction?.({ type, selector, value, emit });
    if (settings.failSelector === selector) throw new Error('Action failed: ' + selector);
  };
  const page = {
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(fn); },
    setDefaultTimeout(ms) { calls.push(['defaultTimeout', ms]); },
    setDefaultNavigationTimeout(ms) { calls.push(['navigationTimeout', ms]); },
    async goto(url, options) { calls.push(['goto', url, options.waitUntil]); await settings.onNavigate?.(emit); },
    async waitForTimeout(ms) { calls.push(['observe', ms]); await settings.onObserve?.(emit); },
    locator(selector) {
      return {
        click: () => invoke('click', selector), fill: (value) => invoke('fill', selector, value),
        press: (key) => invoke('press', selector, key), selectOption: (value) => invoke('select', selector, value),
        check: () => invoke('check', selector), uncheck: () => invoke('uncheck', selector),
        waitFor: (options) => invoke('wait-for', selector, options.state),
        count: async () => settings.visibleCount ?? 1,
        isVisible: async () => settings.visible ?? true,
        textContent: async () => settings.text ?? 'Failure text',
      };
    },
  };
  return { run: () => body({ page }), calls, options: () => useOptions, timeout: () => setTimeout };
}

test('report shows real reduction, original and retained actions, and verification limits', () => {
  const report = makeReport();
  const html = renderHtml(report);
  assert.match(html, /Reduced from 2 to 1 actions/);
  assert.match(html, /50%/);
  assert.match(html, /Complete checkout/);
  assert.match(html, /step removed/);
  assert.match(html, /1-minimal/);
  assert.match(html, /A smaller sequence may exist/);
  assert.match(html, /data-filter="invalid"/);
  assert.match(html, /data-outcome="reproduced"/);
  assert.match(html, /id="regression-test"/);
  assert.match(html, /id="repair-brief"/);
});

test('unverified candidates are identified in hero, brief, and minimality metric', () => {
  const report = makeReport({ result: { status: 'budget-exhausted', reducedActions: [], runs: 3, confirmations: 0, verified: false, oneMinimal: false, reason: 'Replay budget reached', trials: [] } });
  const html = renderHtml(report);
  assert.match(html, /candidate unverified/);
  assert.match(html, /Final reproduction has not been confirmed/);
  assert.match(html, /Minimality<\/span><strong>Not verified/);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /Verified: no/);
  assert.match(markdown, /After: candidate actions/);
  assert.match(markdown, /Root cause has not been established/);
  assert.doesNotMatch(markdown, /Verified: yes/);
});

test('all untrusted HTML and script fields stay inert with an exact inline-script CSP hash', () => {
  const hostile = '</script><script>alert("x")</script><img src="https://attacker.invalid/pixel" onerror="alert(1)">';
  const report = makeReport();
  report.journey = { ...report.journey, name: hostile, url: hostile, actions: [{ ...action, id: hostile, label: hostile, selector: hostile }], failure: { type: 'page-error', includes: hostile } };
  report.result = { ...report.result, reason: hostile, reducedActions: report.journey.actions, trials: [{ phase: hostile, actionIds: [hostile], outcome: hostile, error: hostile, failedActionId: hostile }] };
  report.finalTrial = { outcome: hostile, error: hostile, evidence: { matched: [hostile], screenshot: hostile } };
  const html = renderHtml(report);
  assert.doesNotMatch(html, /<script>alert|<img src="https:/);
  assert.match(html, /&lt;\/script&gt;/);
  assert.match(html, /data-outcome="unknown"/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const hash = createHash('sha256').update(scripts[0][1]).digest('base64');
  assert.ok(html.includes(`script-src 'sha256-${hash}'`));
  assert.match(html, /default-src 'none'/);
  assert.match(html, /img-src data:/);
  assert.doesNotMatch(html, /<link |<iframe|<script src=/);
});

test('screenshots accept only base64 PNG data and retain accessible alt text', () => {
  const report = makeReport();
  report.finalTrial.evidence.screenshot = 'iVBORw0KGgoAAA==';
  assert.match(renderHtml(report), /src="data:image\/png;base64,iVBORw0KGgoAAA==" alt="Browser screenshot/);
  report.finalTrial.evidence.screenshot = 'https://example.com/leak';
  assert.doesNotMatch(renderHtml(report), /src="https:/);
  assert.match(renderHtml(report), /No screenshot was captured/);
});

test('markdown fences survive arbitrary backticks, and titles cannot inject headings', () => {
  const journey = { ...baseJourney, name: '# title\n## injected', actions: [{ ...action, label: '```\n# surprise', selector: '`'.repeat(8) }], failure: { type: 'page-error', includes: '```\nignored' } };
  const markdown = renderMarkdown(makeReport({ journey, result: { ...makeReport().result, reducedActions: journey.actions } }));
  assert.match(markdown, /^# ReproCut repair brief: \\# title \\#\\# injected/m);
  assert.doesNotMatch(markdown, /^# surprise/m);
  assert.match(markdown, /`{9}json/);
  assert.match(markdown, /`{9}js/);
});

test('generated test is ESM, serializes literal hostile strings, and exports no helper dependency', async () => {
  const hostile = '</script>`${globalThis.bad = true}`\n\u2028\u2029';
  const journey = { ...baseJourney, name: hostile, actions: [{ ...action, selector: hostile }] };
  const source = generatePlaywrightTest(journey);
  assert.match(source, /^import \{ test, expect \} from '@playwright\/test';/);
  assert.doesNotMatch(source, /<\/script>/);
  assert.doesNotMatch(source, /from ['"]\.\//);
  assert.match(source, /\\u003c\/script>/);
  const harness = generatedHarness(journey);
  await harness.run();
  assert.ok(harness.calls.some((call) => call[0] === 'click' && call[1] === hostile));
  assert.equal(harness.options().serviceWorkers, 'block');
  assert.equal(harness.options().viewport.width, 1280);
});

test('generated test executes all seven action kinds and setup before observation', async () => {
  const actions = [
    { id: 'a', type: 'click', selector: '#a' }, { id: 'b', type: 'fill', selector: '#b', value: 'hello' },
    { id: 'c', type: 'press', selector: '#c', key: 'Enter' }, { id: 'd', type: 'select', selector: '#d', value: 'yes' },
    { id: 'e', type: 'check', selector: '#e' }, { id: 'f', type: 'uncheck', selector: '#f' },
    { id: 'g', type: 'wait-for', selector: '#g', state: 'hidden' },
  ];
  const harness = generatedHarness({ ...baseJourney, setup: [{ id: 'setup', type: 'click', selector: '#setup' }], actions });
  await harness.run();
  assert.deepEqual(harness.calls.filter((call) => !['defaultTimeout', 'navigationTimeout', 'goto', 'observe'].includes(call[0])).map((call) => call.slice(0, 2)), [['click', '#setup'], ...actions.map((a) => [a.type, a.selector])]);
  assert.deepEqual(harness.calls.find((call) => call[0] === 'wait-for'), ['wait-for', '#g', 'hidden']);
  assert.deepEqual(harness.calls.at(-1), ['observe', 150]);
  assert.ok(harness.timeout() >= 30000);
});

test('page-error regression ignores setup/navigation events but fails matching action events', async () => {
  const emitTarget = (emit) => emit('pageerror', new Error('CHECKOUT_TOTAL_UNDEFINED'));
  const setupJourney = { ...baseJourney, setup: [{ id: 'setup', type: 'click', selector: '#setup' }] };
  await generatedHarness(setupJourney, { onNavigate: emitTarget, onAction: ({ selector, emit }) => { if (selector === '#setup') emitTarget(emit); } }).run();
  await assert.rejects(generatedHarness(baseJourney, { onAction: ({ emit }) => emitTarget(emit) }).run(), /exact ReproCut failure must be absent/);
  await generatedHarness(baseJourney, { onAction: ({ emit }) => emit('pageerror', new Error('different failure')) }).run();
  await assert.rejects(generatedHarness(baseJourney, { onObserve: emitTarget }).run(), /exact ReproCut failure must be absent/);
});

test('empty action sequence keeps event predicates disarmed through observation', async () => {
  await generatedHarness({ ...baseJourney, actions: [] }, { onObserve: (emit) => emit('pageerror', new Error('CHECKOUT_TOTAL_UNDEFINED')) }).run();
});

test('console-error requires error severity and a literal matching substring', async () => {
  const journey = { ...baseJourney, failure: { type: 'console-error', includes: '[failure].*' } };
  const event = (type, text) => ({ type: () => type, text: () => text });
  await generatedHarness(journey, { onAction: ({ emit }) => emit('console', event('warn', '[failure].*')) }).run();
  await generatedHarness(journey, { onAction: ({ emit }) => emit('console', event('error', 'failure any text')) }).run();
  await assert.rejects(generatedHarness(journey, { onAction: ({ emit }) => emit('console', event('error', 'prefix [failure].* suffix')) }).run());
});

test('HTTP regression excludes setup requests and requires exact status and literal URL substring', async () => {
  const journey = { ...baseJourney, failure: { type: 'http-error', urlIncludes: '/checkout?mode=x', status: 503 } };
  const setupRequest = {};
  const response = (request, status = 503, url = 'http://local/checkout?mode=x') => ({ request: () => request, status: () => status, url: () => url });
  await generatedHarness(journey, { onNavigate: (emit) => emit('request', setupRequest), onAction: ({ emit }) => emit('response', response(setupRequest)) }).run();
  for (const [status, url] of [[500, 'http://local/checkout?mode=x'], [503, 'http://local/checkout?mode=y']]) {
    await generatedHarness(journey, { onAction: ({ emit }) => { const request = {}; emit('request', request); emit('response', response(request, status, url)); } }).run();
  }
  await assert.rejects(generatedHarness(journey, { onAction: ({ emit }) => { const request = {}; emit('request', request); emit('response', response(request)); } }).run(), /exact ReproCut failure must be absent/);
});

test('visible regression handles zero, unique, ambiguous, hidden and case-sensitive matches', async () => {
  const journey = { ...baseJourney, actions: [], failure: { type: 'visible', selector: '#error', textIncludes: 'Failure' } };
  await generatedHarness(journey, { visibleCount: 0 }).run();
  await generatedHarness(journey, { visible: false }).run();
  await generatedHarness(journey, { text: 'failure' }).run();
  await assert.rejects(generatedHarness(journey, { text: 'Failure text' }).run(), /exact ReproCut failure must be absent/);
  await assert.rejects(generatedHarness(journey, { visibleCount: 2 }).run(), /Ambiguous visible failure selector/);
});

test('setup and action errors fail regression even if target is absent or already matched', async () => {
  await assert.rejects(generatedHarness(baseJourney, { failSelector: '#checkout' }).run(), /Action failed/);
  await assert.rejects(generatedHarness({ ...baseJourney, setup: [{ id: 'setup', type: 'click', selector: '#setup' }] }, { failSelector: '#setup' }).run(), /Action failed/);
  await assert.rejects(generatedHarness(baseJourney, { failSelector: '#checkout', onAction: ({ emit }) => emit('pageerror', new Error('CHECKOUT_TOTAL_UNDEFINED')) }).run(), /Action failed/);
});


test('zero observation window does not introduce an extra asynchronous wait and URL is overridable', async () => {
  const journey = { ...baseJourney, options: { ...baseJourney.options, observeMs: 0 } };
  const harness = generatedHarness(journey, { env: { REPROCUT_URL: 'http://127.0.0.1:45001' } });
  await harness.run();
  assert.ok(harness.calls.some((call) => call[0] === 'goto' && call[1] === 'http://127.0.0.1:45001'));
  assert.ok(!harness.calls.some((call) => call[0] === 'observe'));
});
