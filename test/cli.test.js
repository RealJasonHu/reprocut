import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startDemo } from '../examples/server.js';
import { validateJourney } from '../src/journey.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reprocut-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function runCli(args, cwd) {
  try {
    return { code: 0, ...await execute(process.execPath, [cli, ...args], { cwd, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }) };
  } catch (error) {
    if (typeof error.code !== 'number' || error.signal) throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

function assertInputError(result, message) {
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '', 'Errors should not contaminate machine-readable stdout');
  assert.match(result.stderr, /^ReproCut: /);
  if (message) assert.match(result.stderr, message);
}

test('CLI help and version are successful stdout-only commands', async (t) => {
  const directory = await workspace(t);
  for (const flags of [[], ['--help'], ['-h']]) {
    const result = await runCli(flags, directory);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^ReproCut 0\.1\.0/);
    assert.match(result.stdout, /reprocut shrink journey\.json/);
    assert.match(result.stdout, /replay: exit 0 = target reproduced/);
  }
  const version = await runCli(['--version'], directory);
  assert.deepEqual(version, { code: 0, stdout: '0.1.0\n', stderr: '' });
});

test('CLI init writes normalized valid JSON and refuses duplicate output without changing the file', async (t) => {
  const directory = await workspace(t);
  const args = ['init', '--out', 'example', '--url', 'http://127.0.0.1:43210'];
  const result = await runCli(args, directory);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Created .*journey\.json/);
  const file = join(directory, 'example', 'journey.json');
  const before = await readFile(file, 'utf8');
  const journey = JSON.parse(before);
  assert.deepEqual(validateJourney(journey), journey);
  assert.equal(journey.url, 'http://127.0.0.1:43210/');
  assert.equal(journey.actions[0].type, 'click');
  assert.equal(journey.failure.type, 'page-error');
  assert.ok(before.endsWith('\n'));
  const duplicate = await runCli(args, directory);
  assertInputError(duplicate, /Output exists:/);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('CLI rejects malformed or unknown journey fields before starting a browser', async (t) => {
  const directory = await workspace(t);
  await writeFile(join(directory, 'broken.json'), '{ nope');
  assertInputError(await runCli(['replay', 'broken.json', '--out', 'broken-output', '--json'], directory), /Invalid journey JSON:/);
  const template = { version: 1, name: 'Invalid input', url: 'http://127.0.0.1:1', setup: [], actions: [], failure: { type: 'page-error', includes: 'BUG' }, arbitraryCode: 'do not run' };
  await writeFile(join(directory, 'unknown.json'), JSON.stringify(template));
  assertInputError(await runCli(['shrink', 'unknown.json', '--out', 'unknown-output', '--json'], directory), /journey\.arbitraryCode is unknown/);
  assertInputError(await runCli(['replay', 'missing.json', '--out', 'missing-output', '--json'], directory), /ENOENT/);
});

test('CLI rejects misspelled flags, unknown commands, missing input and invalid numeric limits', async (t) => {
  const directory = await workspace(t);
  const cases = [
    { args: ['shrink', 'journey.json', '--max-run', '10'], message: /Unknown option '--max-run'/ },
    { args: ['shrnik', 'journey.json'], message: /Unknown command: shrnik/ },
    { args: ['replay'], message: /requires a journey\.json file/ },
    { args: ['init', 'unexpected'], message: /Unexpected positional argument/ },
    { args: ['init', '--max-runs', '3'], message: /--max-runs must be 4\.\.1000/ },
    { args: ['init', '--confirmations', '2oops'], message: /--confirmations must be 1\.\.10/ },
    { args: ['init', '--max-runs', '4', '--confirmations', '3'], message: /at least twice --confirmations/ },
  ];
  for (const { args, message } of cases) assertInputError(await runCli(args, directory), message);
});

test('CLI replay returns accurate exit codes and uncontaminated JSON for reproduced, absent and invalid outcomes', { timeout: 45000 }, async (t) => {
  const directory = await workspace(t);
  const demo = await startDemo();
  t.after(() => demo.close());
  const journey = {
    version: 1, name: 'CLI replay contract', url: demo.url, setup: [],
    actions: [
      { id: 'express', type: 'check', selector: '#express' },
      { id: 'coupon', type: 'fill', selector: '#coupon', value: 'SAVE10' },
      { id: 'checkout', type: 'click', selector: '#checkout' },
    ],
    failure: { type: 'page-error', includes: 'CHECKOUT_TOTAL_UNDEFINED' },
    options: { actionTimeoutMs: 300, observeMs: 50, viewport: { width: 1280, height: 800 } },
  };
  const cases = [
    { name: 'reproduced', code: 0, value: journey },
    { name: 'not-reproduced', code: 1, value: { ...journey, failure: { type: 'page-error', includes: 'A_DIFFERENT_TARGET' } } },
    { name: 'invalid', code: 2, value: { ...journey, actions: [{ id: 'missing', type: 'click', selector: '#does-not-exist' }] } },
  ];
  for (const entry of cases) {
    const input = join(directory, `${entry.name}.json`);
    const output = join(directory, entry.name);
    await writeFile(input, JSON.stringify(entry.value));
    const result = await runCli(['replay', input, '--out', output, '--json'], directory);
    assert.equal(result.code, entry.code, result.stderr);
    assert.equal(result.stderr, '');
    const trial = JSON.parse(result.stdout);
    assert.equal(trial.outcome, entry.name);
    assert.equal(typeof trial.durationMs, 'number');
    assert.ok(Array.isArray(trial.evidence.matched));
    assert.deepEqual(JSON.parse(await readFile(join(output, 'replay.json'), 'utf8')), trial);
    if (entry.name === 'reproduced') assert.match(trial.evidence.matched.join('\n'), /CHECKOUT_TOTAL_UNDEFINED/);
    if (entry.name === 'not-reproduced') assert.deepEqual(trial.evidence.matched, []);
    if (entry.name === 'invalid') {
      assert.equal(trial.failedActionId, 'missing');
      assert.match(trial.error, /action:/);
    }
  }
});
