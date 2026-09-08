import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRunner } from '../src/runner.js';

let server;
let url;
const fixture = `<!doctype html><html><body>
<input id="input"><input id="check" type="checkbox">
<select id="select"><option value="a">A</option><option value="b">B</option></select>
<button id="target" onclick="throw new Error('TARGET_FAILURE')">Target</button>
<button id="other" onclick="throw new Error('UNRELATED_FAILURE')">Other</button>
<button id="console" onclick="console.error('TARGET_CONSOLE')">Console</button>
<button id="http" onclick="fetch('/failed')">HTTP</button>
<button id="delayed-http" onclick="fetch('/slow-failed')">Delayed HTTP</button>
<button id="store" onclick="localStorage.setItem('seen','yes'); document.cookie='seen=yes'">Store</button>
<button id="inspect" onclick="if(localStorage.getItem('seen') || document.cookie.includes('seen=yes')) throw new Error('DIRTY_CONTEXT')">Inspect</button>
<button id="visible" onclick="document.querySelector('#message').hidden=false">Show</button>
<button id="form-state" onclick="if(document.querySelector('#input').value==='hello' && document.querySelector('#select').value==='b' && !document.querySelector('#check').checked) throw new Error('FORM_CONFIGURED')">Check form state</button>
<button id="many" onclick="for(let i=0;i<75;i++)console.error('X'.repeat(4000)); console.error('Y'.repeat(2500)+'TAIL_TARGET')">Many</button>
<p id="message" hidden>The Cart is broken</p>
<script>if(location.pathname==='/initial-error') throw new Error('TARGET_FAILURE');</script>
</body></html>`;

before(async () => {
  server = createServer((request, response) => {
    if (request.url === '/failed' || request.url === '/slow-failed') {
      const send = () => { response.writeHead(503); response.end('Unavailable'); };
      if (request.url === '/slow-failed') setTimeout(send, 120);
      else send();
    } else {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(fixture);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

const click = (id) => ({ id, type: 'click', selector: `#${id}` });
function journey(failure = { type: 'page-error', includes: 'TARGET_FAILURE' }, extra = {}) {
  return {
    version: 1, name: 'Runner fixture', url, setup: [], actions: [], failure,
    // CI launches this file beside integration browsers; action readiness must
    // not fail just because three Chromium processes are starting together.
    options: { actionTimeoutMs: 2_000, observeMs: 180, viewport: { width: 640, height: 480 } },
    ...extra,
  };
}
async function withRunner(spec, use) {
  const runner = await createRunner(spec);
  try { return await use(runner); }
  finally { await runner.close(); }
}

test('target page errors reproduce, unrelated errors do not, and capture is opt-in', async () => {
  await withRunner(journey(), async (runner) => {
    const target = await runner.run([click('target')], { capture: true });
    assert.equal(target.outcome, 'reproduced', target.error ?? JSON.stringify(target.evidence));
    assert.equal(target.evidence.pageErrors[0], 'TARGET_FAILURE');
    assert.ok(target.evidence.screenshot.startsWith('iVBOR'));
    assert.ok(target.durationMs >= 0);
    const unrelated = await runner.run([click('other')]);
    assert.equal(unrelated.outcome, 'not-reproduced');
    assert.equal(unrelated.evidence.pageErrors[0], 'UNRELATED_FAILURE');
    assert.equal(unrelated.evidence.screenshot, undefined);
  });
});

test('fresh contexts isolate cookies and local storage between trials', async () => {
  await withRunner(journey({ type: 'page-error', includes: 'DIRTY_CONTEXT' }), async (runner) => {
    assert.equal((await runner.run([click('store'), click('inspect')])).outcome, 'reproduced');
    assert.equal((await runner.run([click('inspect')])).outcome, 'not-reproduced');
  });
});

test('a target emitted before a failed action never counts as reproduced', async () => {
  await withRunner(journey(), async (runner) => {
    const trial = await runner.run([click('target'), click('missing')]);
    assert.equal(trial.outcome, 'invalid');
    assert.equal(trial.failedActionId, 'missing');
    assert.match(trial.error, /^action:/);
    assert.ok(trial.evidence.matched.length > 0);
    assert.equal((await runner.run([click('target')])).outcome, 'reproduced');
  });
});

test('navigation/setup events and empty candidate do not satisfy event predicates', async () => {
  await withRunner(journey(undefined, { url: `${url}/initial-error`, setup: [click('target')] }), async (runner) => {
    const empty = await runner.run([]);
    assert.equal(empty.outcome, 'not-reproduced');
    assert.deepEqual(empty.evidence.pageErrors, []);
    const unrelated = await runner.run([click('other')]);
    assert.equal(unrelated.outcome, 'not-reproduced');
    assert.deepEqual(unrelated.evidence.pageErrors, ['UNRELATED_FAILURE']);
  });
});

test('setup action failures are invalid and identified', async () => {
  await withRunner(journey(undefined, { setup: [click('missing')] }), async (runner) => {
    const result = await runner.run([click('target')]);
    assert.equal(result.outcome, 'invalid');
    assert.equal(result.failedActionId, 'missing');
    assert.match(result.error, /^setup:/);
    assert.deepEqual(result.evidence.matched, []);
  });
});

test('console predicate retains matching beyond evidence limits', async () => {
  await withRunner(journey({ type: 'console-error', includes: 'TAIL_TARGET' }), async (runner) => {
    const result = await runner.run([click('many')]);
    assert.equal(result.outcome, 'reproduced');
    assert.equal(result.evidence.consoleErrors.length, 50);
    assert.ok(result.evidence.consoleErrors.every((line) => line.length < 2_050));
    assert.ok(result.evidence.matched.length > 0);
    assert.match(result.evidence.matched[0], /TAIL_TARGET/);
  });
});

test('HTTP predicate requires matching status and action-origin request', async () => {
  await withRunner(journey({ type: 'http-error', urlIncludes: '/failed', status: 503 }), async (runner) => {
    const result = await runner.run([click('http')]);
    assert.equal(result.outcome, 'reproduced');
    assert.equal(result.evidence.httpErrors[0].status, 503);
  });
  await withRunner(journey({ type: 'http-error', urlIncludes: '/failed', status: 500 }), async (runner) => {
    assert.equal((await runner.run([click('http')])).outcome, 'not-reproduced');
  });
  await withRunner(journey({ type: 'http-error', urlIncludes: '/slow-failed', status: 503 }, { setup: [click('delayed-http')] }), async (runner) => {
    const result = await runner.run([click('store')]);
    assert.equal(result.outcome, 'not-reproduced');
    assert.deepEqual(result.evidence.httpErrors, []);
  });
});

test('visible predicate requires visibility and literal case-sensitive text', async () => {
  await withRunner(journey({ type: 'visible', selector: '#message', textIncludes: 'Cart is broken' }), async (runner) => {
    assert.equal((await runner.run([])).outcome, 'not-reproduced');
    assert.equal((await runner.run([click('visible')])).outcome, 'reproduced');
  });
  await withRunner(journey({ type: 'visible', selector: '#message', textIncludes: 'cart is broken' }), async (runner) => {
    assert.equal((await runner.run([click('visible')])).outcome, 'not-reproduced');
  });
  await withRunner(journey({ type: 'visible', selector: '#missing', textIncludes: 'Cart' }), async (runner) => {
    assert.equal((await runner.run([])).outcome, 'not-reproduced');
  });
  await withRunner(journey({ type: 'visible', selector: 'button', textIncludes: 'Target' }), async (runner) => {
    const result = await runner.run([]);
    assert.equal(result.outcome, 'invalid');
    assert.match(result.error, /Ambiguous visible failure selector/);
  });
});

test('declarative locator actions change form state and obey waits', async () => {
  await withRunner(journey({ type: 'page-error', includes: 'FORM_CONFIGURED' }), async (runner) => {
    const result = await runner.run([
      { id: 'fill', type: 'fill', selector: '#input', value: 'hello' },
      { id: 'press', type: 'press', selector: '#input', key: 'End' },
      { id: 'select', type: 'select', selector: '#select', value: 'b' },
      { id: 'check', type: 'check', selector: '#check' },
      { id: 'uncheck', type: 'uncheck', selector: '#check' },
      { id: 'wait', type: 'wait-for', selector: '#target', state: 'visible' },
      click('form-state'),
    ]);
    assert.equal(result.outcome, 'reproduced');
  });
});

test('close is idempotent and rejects future trials explicitly', async () => {
  const runner = await createRunner(journey());
  await runner.close();
  await runner.close();
  await assert.rejects(runner.run([]), /runner is closed/);
});
