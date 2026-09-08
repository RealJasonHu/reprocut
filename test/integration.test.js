import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startDemo } from '../examples/server.js';
import { validateJourney } from '../src/journey.js';
import { createRunner } from '../src/runner.js';
import { reduceJourney } from '../src/reducer.js';
import { generatePlaywrightTest } from '../src/report.js';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
const playwrightCli = fileURLToPath(new URL('../node_modules/playwright/cli.js', import.meta.url));

async function runRegression(directory, url) {
  let execution;
  let exitCode = 0;
  try {
    execution = await execute(process.execPath, [playwrightCli, 'test', '--config', join(directory, 'playwright.config.mjs')], {
      cwd: repository,
      env: { ...process.env, REPROCUT_URL: url, CI: '1', FORCE_COLOR: '0' },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    if (error.code !== 1) throw error;
    execution = error;
    exitCode = error.code;
  }
  let report;
  try {
    report = JSON.parse(execution.stdout);
  } catch {
    assert.fail(`Playwright did not produce a valid JSON report:\n${execution.stdout}\n${execution.stderr}`);
  }
  return { exitCode, report, stderr: execution.stderr };
}

function testResults(suites) {
  return suites.flatMap((suite) => [
    ...(suite.specs ?? []).flatMap((spec) => spec.tests.flatMap((entry) => entry.results)),
    ...testResults(suite.suites ?? []),
  ]);
}

test('real browser reduces 12 actions to 3 and its generated regression fails before the fix, passes after', {
  timeout: 180_000,
}, async () => {
  let buggy;
  let fixed;
  let runner;
  let directory;
  try {
    buggy = await startDemo();
    fixed = await startDemo({ fixed: true });
    const fixture = JSON.parse(await readFile(new URL('../examples/checkout.journey.json', import.meta.url), 'utf8'));
    const journey = validateJourney({ ...fixture, url: buggy.url });
    assert.equal(journey.actions.length, 12);
    runner = await createRunner(journey);
    const result = await reduceJourney(journey.actions, runner.run, { maxRuns: 80, confirmations: 2 });
    assert.equal(result.status, 'complete', JSON.stringify({ reason: result.reason, trials: result.trials }));
    assert.equal(result.verified, true);
    assert.equal(result.oneMinimal, true);
    assert.equal(result.confirmations, 2);
    assert.deepEqual(result.reducedActions.map((action) => action.id), ['express', 'coupon', 'checkout']);
    assert.ok(result.runs <= 80);
    assert.equal(result.runs, result.trials.length);
    assert.equal(result.finalTrial.outcome, 'reproduced');
    assert.ok(result.finalTrial.evidence.matched.some((event) => event.includes('CHECKOUT_TOTAL_UNDEFINED')));
    assert.match(result.finalTrial.evidence.screenshot, /^iVBORw0KGgo/);
    await runner.close();
    runner = null;

    // Keep the generated artifact inside the repository so its standalone
    // @playwright/test import resolves through this checkout's node_modules.
    directory = await mkdtemp(join(repository, '.reprocut-integration-'));
    const regression = generatePlaywrightTest({ ...journey, actions: result.reducedActions });
    assert.match(regression, /process\.env\.REPROCUT_URL/);
    await writeFile(join(directory, 'regression.spec.js'), regression);
    await writeFile(join(directory, 'playwright.config.mjs'), `export default {
  testDir: '.',
  testMatch: 'regression.spec.js',
  retries: 0,
  workers: 1,
  reporter: [['json']],
  outputDir: './artifacts',
  use: { browserName: 'chromium', headless: true },
};\n`);

    const broken = await runRegression(directory, buggy.url);
    assert.equal(broken.exitCode, 1);
    assert.deepEqual(broken.report.errors, []);
    assert.equal(broken.report.stats.unexpected, 1);
    assert.equal(broken.report.stats.expected, 0);
    const failed = testResults(broken.report.suites);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].status, 'failed');
    assert.match(failed[0].error.message, /The exact ReproCut failure must be absent/);
    assert.match(failed[0].error.message, /CHECKOUT_TOTAL_UNDEFINED/);

    const repaired = await runRegression(directory, fixed.url);
    assert.equal(repaired.exitCode, 0, JSON.stringify(repaired.report));
    assert.deepEqual(repaired.report.errors, []);
    assert.equal(repaired.report.stats.expected, 1);
    assert.equal(repaired.report.stats.unexpected, 0);
    const passed = testResults(repaired.report.suites);
    assert.equal(passed.length, 1);
    assert.equal(passed[0].status, 'passed');
  } finally {
    const cleanup = await Promise.allSettled([
      runner?.close(),
      buggy?.close(),
      fixed?.close(),
      directory ? rm(directory, { recursive: true, force: true }) : undefined,
    ]);
    for (const outcome of cleanup) {
      if (outcome.status === 'rejected') throw outcome.reason;
    }
  }
});
