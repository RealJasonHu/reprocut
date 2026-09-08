import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJourney, loadJourney } from '../src/journey.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const example = () => ({ version: 1, name: 'Bug', url: 'http://localhost:3000', actions: [{ id: 'click', type: 'click', selector: '#button' }], failure: { type: 'page-error', includes: 'boom' } });
test('normalizes defaults without mutating source', () => { const source = example(); const value = validateJourney(source); assert.equal(value.options.observeMs, 150); assert.deepEqual(value.setup, []); assert.equal(source.options, undefined); });
test('rejects misspelled keys at every meaningful level', () => {
  for (const mutate of [j => j.failuer = {}, j => j.actions[0].seletor = '#b', j => j.failure.include = 'x', j => j.options = { timeout: 1 }]) {
    const j = example(); mutate(j); assert.throws(() => validateJourney(j), /unknown/);
  }
});
test('requires specific target failure rather than arbitrary timeout', () => {
  for (const failure of [{ type: 'timeout' }, { type: 'page-error', includes: '' }, { type: 'http-error', status: 200, urlIncludes: '/api' }, { type: 'visible', selector: '#error', textIncludes: '' }]) {
    assert.throws(() => validateJourney({ ...example(), failure }));
  }
});
test('rejects duplicated ids including setup', () => { const j = example(); j.setup = [{ ...j.actions[0] }]; assert.throws(() => validateJourney(j), /Duplicate/); });
test('empty action sequence and empty fill are supported', () => {
  assert.deepEqual(validateJourney({ ...example(), actions: [] }).actions, []);
  const j = example(); j.actions[0] = { id: 'fill', type: 'fill', selector: 'input', value: '' }; assert.equal(validateJourney(j).actions[0].value, '');
});
test('rejects executable URLs and embedded credentials', () => { for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://user:pass@localhost', '/relative']) assert.throws(() => validateJourney({ ...example(), url })); });
test('bounds action and observation times and viewport', () => {
  for (const options of [{ actionTimeoutMs: 0 }, { observeMs: -1 }, { observeMs: NaN }, { actionTimeoutMs: 999999 }, { viewport: { width: 1, height: 800 } }]) assert.throws(() => validateJourney({ ...example(), options }));
});
test('rejects prototype keys masquerading as action/failure types', () => {
  const j = example(); j.actions[0].type = 'toString'; assert.throws(() => validateJourney(j), /unsupported/);
  assert.throws(() => validateJourney({ ...example(), failure: { type: '__proto__' } }), /unsupported/);
});
test('file limit counts UTF-8 bytes and loading rejects non-JSON', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reprocut-input-'));
  try {
    const file = path.join(dir, 'input.json');
    await writeFile(file, JSON.stringify(example()));
    assert.equal((await loadJourney(file)).version, 1);
    await writeFile(file, '坏'.repeat(800000));
    await assert.rejects(loadJourney(file), /2 MiB/);
    await writeFile(file, '{');
    await assert.rejects(loadJourney(file), /Invalid journey JSON/);
    await assert.rejects(loadJourney(dir), /regular file/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
