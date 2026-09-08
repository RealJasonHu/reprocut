#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadJourney, validateJourney } from './journey.js';
import { createRunner } from './runner.js';
import { reduceJourney } from './reducer.js';
import { renderHtml, renderMarkdown, generatePlaywrightTest } from './report.js';
import { startDemo } from '../examples/server.js';

const HELP = `ReproCut 0.1.0 — less journey, same bug.

Usage:
  reprocut demo [--out directory]                 Run the real local browser demo
  reprocut shrink journey.json [options]          Reduce your failing journey
  reprocut replay journey.json [--out directory]  Check the same failure once
  reprocut init [--out directory]                 Write an editable journey template
  reprocut install                               Install Playwright Chromium

Options:
  --out <directory>       Output directory (default: reprocut-output)
  --max-runs <integer>    Browser-run budget, 4..1000 (default: 80)
  --confirmations <n>     Replays per accepted candidate, 1..10 (default: 2)
  --url <http(s) URL>     Override the journey's initial URL
  --headed               Show the browser
  --json                 Print the final report JSON to stdout (progress uses stderr)
  --help                 Show this help
  --version              Show the version

shrink: exit 0 = verified complete, 1 = incomplete/unreproduced/unstable, 2 = input/runtime error.
replay: exit 0 = target reproduced, 1 = target not reproduced, 2 = invalid/input/runtime error.
Report files include entered values, URLs, error text and screenshots. Review before sharing.
Replay repeats real UI actions. Use a disposable test environment.
`;

function number(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be ${min}..${max}`);
  return n;
}
async function safeOutput(directory, names) {
  await mkdir(directory, { recursive: true });
  for (const name of names) {
    try { await stat(path.join(directory, name)); throw new Error(`Output exists: ${path.join(directory, name)}. Choose a new --out directory.`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });

async function main() {
  const { values, positionals } = parseArgs({ options: {
    out: { type: 'string' }, 'max-runs': { type: 'string' }, confirmations: { type: 'string' },
    url: { type: 'string' }, headed: { type: 'boolean' }, json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
  }, allowPositionals: true, strict: true });
  if (values.version) { console.log('0.1.0'); return; }
  if (values.help || !positionals.length) { console.log(HELP); return; }
  const [command, input, ...extra] = positionals;
  if (!['demo', 'shrink', 'replay', 'init', 'install'].includes(command)) throw new Error(`Unknown command: ${command}. See --help.`);
  if (extra.length || (!['shrink', 'replay'].includes(command) && input)) throw new Error('Unexpected positional argument. See --help.');
  if (['shrink', 'replay'].includes(command) && !input) throw new Error(`${command} requires a journey.json file`);
  const out = path.resolve(values.out ?? 'reprocut-output');
  const maxRuns = number(values['max-runs'], 80, 4, 1000, '--max-runs');
  const confirmations = number(values.confirmations, 2, 1, 10, '--confirmations');
  if (maxRuns < confirmations * 2) throw new Error('--max-runs must cover baseline and final confirmations (at least twice --confirmations)');
  if (command === 'install') {
    const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('playwright/package.json')));
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code ?? 2)); });
    return;
  }
  if (command === 'init') {
    await safeOutput(out, ['journey.json']);
    const journey = validateJourney({ version: 1, name: 'Replace with your bug', url: values.url ?? 'http://localhost:3000', setup: [], actions: [{ id: 'trigger', type: 'click', selector: '#trigger', label: 'Trigger the bug' }], failure: { type: 'page-error', includes: 'REPLACE_WITH_YOUR_ERROR' } });
    await writeJson(path.join(out, 'journey.json'), journey);
    console.log(`Created ${path.join(out, 'journey.json')}. Edit the selector and exact failure signature.`);
    return;
  }
  const names = command === 'replay' ? ['replay.json'] : ['report.json', 'report.html', 'repair.md', 'original.journey.json', 'reduced.journey.json', 'regression.spec.js'];
  await safeOutput(out, names);
  let demo, runner;
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= Promise.allSettled([runner?.close(), demo?.close()]).then((results) => {
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    });
    return cleanupPromise;
  };
  const interrupt = async () => {
    try { await cleanup(); } catch (error) { console.error(`Cleanup: ${error.message}`); }
    finally { process.exit(130); }
  };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    let journey;
    if (command === 'demo') {
      demo = await startDemo();
      journey = validateJourney({ ...JSON.parse(await readFile(new URL('../examples/checkout.journey.json', import.meta.url), 'utf8')), url: demo.url });
    } else journey = await loadJourney(input);
    if (values.url) journey = validateJourney({ ...journey, url: values.url });
    runner = await createRunner(journey, { headless: !values.headed });
    if (command === 'replay') {
      const trial = await runner.run(journey.actions, { capture: true });
      await writeJson(path.join(out, 'replay.json'), trial);
      if (values.json) console.log(JSON.stringify(trial));
      else console.log(`${trial.outcome}: ${journey.name}\n${path.join(out, 'replay.json')}`);
      process.exitCode = trial.outcome === 'reproduced' ? 0 : trial.outcome === 'invalid' ? 2 : 1;
      return;
    }
    console.error(`ReproCut · ${journey.name}\n${journey.actions.length} actions · budget ${maxRuns} browser runs · ${confirmations} confirmations`);
    const result = await reduceJourney(journey.actions, (actions, options) => runner.run(actions, options), {
      maxRuns, confirmations,
      onTrial: (trial) => console.error(`  ${String(trial.index).padStart(2)}  ${trial.phase.padEnd(8)}  ${String(trial.actionIds.length).padStart(2)} actions  ${trial.outcome}`),
    });
    const report = { version: 1, toolVersion: '0.1.0', createdAt: new Date().toISOString(), journey, result, finalTrial: result.finalTrial ?? null };
    const reduced = { ...journey, actions: result.reducedActions };
    await writeJson(path.join(out, 'report.json'), report);
    await writeJson(path.join(out, 'original.journey.json'), journey);
    await writeJson(path.join(out, 'reduced.journey.json'), reduced);
    await writeFile(path.join(out, 'report.html'), renderHtml(report), { flag: 'wx' });
    await writeFile(path.join(out, 'repair.md'), renderMarkdown(report), { flag: 'wx' });
    await writeFile(path.join(out, 'regression.spec.js'), generatePlaywrightTest(reduced), { flag: 'wx' });
    if (values.json) console.log(JSON.stringify(report));
    else console.log(`\n${result.status}: ${result.originalCount} → ${result.reducedActions.length} actions · ${result.runs} browser runs\nReport: ${path.join(out, 'report.html')}\nTest:   ${path.join(out, 'regression.spec.js')}\nBrief:  ${path.join(out, 'repair.md')}`);
    if (command === 'demo') console.error('Demo server is now stopped. For replay: npm run demo:serve, then use --url http://127.0.0.1:4173. Generated tests support REPROCUT_URL.');
    process.exitCode = result.status === 'complete' && result.verified ? 0 : 1;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    await cleanup();
  }
}

main().catch((error) => {
  console.error(`ReproCut: ${error.message}`);
  if (/Executable doesn't exist|browserType.launch/.test(error.message)) console.error('Install Chromium with: reprocut install (or npx playwright install chromium after cloning).');
  process.exitCode = 2;
});
