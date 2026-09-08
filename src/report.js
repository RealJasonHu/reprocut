import { createHash } from 'node:crypto';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const literal = (value) => JSON.stringify(value, null, 2).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const markdownText = (value) => String(value ?? '').replace(/[\\`*_{}\[\]<>()#+.!|~-]/g, '\\$&').replace(/[\r\n]+/g, ' ');
const codeFence = (value, language = '') => {
  const text = String(value);
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(([match]) => match.length + 1)));
  return `${fence}${language}\n${text}\n${fence}`;
};

/** A standalone Playwright test whose success means the exact observed failure is gone. */
export function generatePlaywrightTest(journey) {
  return `import { test, expect } from '@playwright/test';

// Install: npm install --save-dev @playwright/test
// Browser: npx playwright install chromium
// Save as reprocut.spec.js; run: npx playwright test reprocut.spec.js
// Keep the application running at journey.url, or override it with REPROCUT_URL.
// Treat this file as a local artifact.
const journey = ${literal(journey)};

test.use({ viewport: journey.options?.viewport ?? { width: 1280, height: 800 }, serviceWorkers: 'block' });

test(journey.name || 'ReproCut regression', async ({ page }) => {
  const actionTimeoutMs = journey.options?.actionTimeoutMs ?? 1000;
  const observeMs = journey.options?.observeMs ?? 150;
  const setup = journey.setup ?? [];
  const actions = journey.actions ?? [];
  test.setTimeout(Math.max(30000, (setup.length + actions.length + 2) * actionTimeoutMs + observeMs + 30000));
  page.setDefaultTimeout(actionTimeoutMs);
  page.setDefaultNavigationTimeout(Math.max(actionTimeoutMs, 10000));
  const failure = journey.failure;
  const matches = [];
  const actionRequests = new Set();
  let armed = false;

  page.on('pageerror', (error) => {
    if (armed && failure.type === 'page-error' && error.message.includes(failure.includes)) {
      matches.push('page-error: ' + error.message);
    }
  });
  page.on('console', (message) => {
    if (armed && failure.type === 'console-error' && message.type() === 'error' && message.text().includes(failure.includes)) {
      matches.push('console-error: ' + message.text());
    }
  });
  page.on('request', (request) => { if (armed) actionRequests.add(request); });
  page.on('response', (response) => {
    if (armed && actionRequests.has(response.request()) && failure.type === 'http-error' &&
        response.status() === failure.status && response.url().includes(failure.urlIncludes)) {
      matches.push('http-error: ' + response.status() + ' ' + response.url());
    }
  });

  async function act(action) {
    const target = page.locator(action.selector);
    switch (action.type) {
      case 'click': return target.click();
      case 'fill': return target.fill(action.value);
      case 'press': return target.press(action.key);
      case 'select': return target.selectOption(action.value);
      case 'check': return target.check();
      case 'uncheck': return target.uncheck();
      case 'wait-for': return target.waitFor({ state: action.state ?? 'visible' });
      default: throw new Error('Unsupported action: ' + action.type);
    }
  }

  await page.goto(process.env.REPROCUT_URL || journey.url, { waitUntil: 'domcontentloaded' });
  for (const action of setup) await act(action);
  // Navigation and setup do not contribute event failures. With no actions,
  // event capture stays off. Visible predicates still inspect the final page.
  armed = actions.length > 0;
  for (const action of actions) await act(action);
  if (observeMs > 0) await page.waitForTimeout(observeMs);
  if (failure.type === 'visible') {
    const target = page.locator(failure.selector);
    const count = await target.count();
    if (count > 1) throw new Error('Ambiguous visible failure selector: ' + failure.selector);
    if (count === 1 && await target.isVisible()) {
      const text = (await target.textContent()) ?? '';
      if (text.includes(failure.textIncludes ?? '')) matches.push('visible: ' + text);
    }
  }
  // Setup/action errors already fail the test; they cannot count as a fix.
  expect(matches, 'The exact ReproCut failure must be absent').toEqual([]);
});
`;
}

function reportParts(report) {
  const journey = report.journey ?? {};
  const result = report.result ?? {};
  const original = Array.isArray(journey.actions) ? journey.actions : [];
  const reduced = Array.isArray(result.reducedActions) ? result.reducedActions : original;
  const setup = Array.isArray(journey.setup) ? journey.setup : [];
  const removed = Math.max(0, original.length - reduced.length);
  const percent = original.length ? Math.round(100 * removed / original.length) : 0;
  const verified = result.verified === true || (result.verified === undefined && result.status === 'complete');
  const reducedJourney = { ...journey, setup, actions: reduced };
  const evidence = report.finalTrial?.evidence ?? {};
  return { journey, result, original, reduced, setup, removed, percent, verified, reducedJourney, evidence };
}

function actionDescription(action) {
  const type = String(action.type ?? 'unknown');
  const details = type === 'fill' || type === 'select' ? ` = ${JSON.stringify(action.value)}`
    : type === 'press' ? ` · ${action.key}` : type === 'wait-for' ? ` · ${action.state ?? 'visible'}` : '';
  return `${type} ${action.selector ?? ''}${details}`;
}

function verificationText(result, verified) {
  if (!verified) return 'The reduced candidate is unverified. Review the run status and trials before using it as reproduction evidence.';
  if (result.oneMinimal) return 'Confirmed 1-minimal: each single-action deletion was rejected in the tested trials. A smaller sequence may exist through other combinations.';
  return 'The candidate reproduced the configured failure. Single-action minimality has not been fully verified.';
}

/** Copyable repair brief containing observations and an exact regression target. */
export function renderMarkdown(report) {
  const { journey, result, original, reduced, setup, removed, percent, verified, reducedJourney, evidence } = reportParts(report);
  const list = (actions) => actions.length ? actions.map((action, i) => `${i + 1}. ${markdownText(action.label || action.id)} — ${markdownText(actionDescription(action))}`).join('\n') : '_No actions._';
  return `# ReproCut repair brief: ${markdownText(journey.name || 'Browser failure')}

Fix the configured failure below while preserving the intended behavior of the remaining journey. Root cause has not been established.

## Run summary

- URL: ${markdownText(journey.url)}
- Generated: ${markdownText(report.createdAt)}
- Status: ${markdownText(result.status || 'unknown')}
- Steps: ${original.length} → ${reduced.length} (${removed} removed; ${percent}% reduction)
- Replays: ${Number.isFinite(result.runs) ? result.runs : (result.trials ?? []).length}
- Final confirmations: ${Number.isFinite(result.confirmations) ? result.confirmations : 0}
- Verified: ${verified ? 'yes' : 'no'}
- ${verificationText(result, verified)}
${result.reason ? `- Run note: ${markdownText(result.reason)}\n` : ''}
## Exact failure predicate

${codeFence(JSON.stringify(journey.failure ?? {}, null, 2), 'json')}

Event failures count from the start of the first reducible action through the observation window. Navigation and fixed setup are excluded. HTTP failures require a request started inside that window. Visible failures inspect the final page. Every setup and action must succeed.

## Fixed setup (excluded from reduction)

${list(setup)}

## Before: original actions

${list(original)}

## After: ${verified ? 'confirmed' : 'candidate'} actions

${list(reduced)}

## Captured evidence

${codeFence(JSON.stringify({ outcome: report.finalTrial?.outcome ?? 'unavailable', failedActionId: report.finalTrial?.failedActionId, error: report.finalTrial?.error, matched: evidence.matched ?? [], pageErrors: evidence.pageErrors ?? [], consoleErrors: evidence.consoleErrors ?? [], httpErrors: evidence.httpErrors ?? [], screenshotError: evidence.screenshotError }, null, 2), 'json')}

Evidence text is bounded by the recorder; matching uses the original event text. A screenshot, when captured, is available in the HTML report. Captured text and URLs may contain application data; review artifacts before sharing.

## Reduced journey

${codeFence(JSON.stringify(reducedJourney, null, 2), 'json')}

## Repair acceptance

1. Run the reduced journey against the same application and environment.
2. Identify the cause from the observed evidence; do not infer a diagnosis from reduction alone.
3. Fix the failure and run the regression below. It must fail while the exact predicate remains and pass once the predicate is absent. Setup or action errors still fail the test.
4. Check the original journey for behavior affected by the repair.

## Playwright regression test

Save as \`reprocut.spec.js\`, install \`@playwright/test\` and its Chromium browser, then run \`npx playwright test reprocut.spec.js\` with the application running. Set \`REPROCUT_URL\` to override the captured application URL.

${codeFence(generatePlaywrightTest(reducedJourney), 'js')}
`;
}

const REPORT_SCRIPT = `(() => {
  const status = document.getElementById('copy-status');
  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const content = document.getElementById(button.dataset.copy)?.textContent || '';
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(content);
        status.textContent = button.dataset.copy === 'repair-brief' ? 'Repair brief copied.' : 'Regression test copied.';
      } catch {
        const target = document.getElementById(button.dataset.copy);
        const disclosure = target.closest('details');
        if (disclosure) disclosure.open = true;
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection.removeAllRanges(); selection.addRange(range);
        status.textContent = 'Text selected. Press Ctrl+C or Command+C to copy.';
      }
    });
  });
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-filter]').forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
      let shown = 0;
      document.querySelectorAll('[data-outcome]').forEach((trial) => {
        trial.hidden = button.dataset.filter !== 'all' && trial.dataset.outcome !== button.dataset.filter;
        if (!trial.hidden) shown++;
      });
      document.getElementById('trial-count').textContent = shown + ' trials shown';
    });
  });
})();`;

const STYLE = `
:root{color-scheme:light;--paper:#f5f4ee;--card:#fffef9;--ink:#20241e;--muted:#62685e;--line:#d9dccf;--green:#d8f84a;--dark:#252c22;--red:#9a3c2b;--mono:ui-monospace,SFMono-Regular,Consolas,monospace;--sans:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.55}a{color:inherit}button,summary{cursor:pointer}button{font:inherit}button:focus-visible,summary:focus-visible,a:focus-visible{outline:3px solid #648310;outline-offset:4px}button{border:1px solid var(--ink);border-radius:5px;background:transparent;padding:10px 16px;font-size:13px;font-weight:650}button:hover{background:#e8ebdd}.primary{background:var(--green)}.primary:hover{background:#c9eb39}.page{max-width:1180px;margin:auto;padding:0 42px}header{height:96px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--ink)}.wordmark{font-size:25px;font-weight:750;letter-spacing:-1.2px;display:flex;align-items:center;gap:10px}.mark{display:grid;grid-template-columns:repeat(2,9px);gap:3px;transform:rotate(-8deg)}.mark i{display:block;width:9px;height:9px;background:var(--ink)}.mark i:last-child{background:#8eaa1c}.edition,.eyebrow,.micro,.section-label{font:11px/1.4 var(--mono);text-transform:uppercase;letter-spacing:1.3px}.edition{color:var(--muted)}.intro{padding:60px 0 32px}.eyebrow{display:flex;align-items:center;gap:8px;color:var(--muted)}.dot{width:7px;height:7px;background:#6f8319;border-radius:50%}h1{font-size:clamp(30px,4.8vw,56px);line-height:1.08;letter-spacing:-2px;max-width:900px;margin:17px 0 20px;font-weight:620;overflow-wrap:anywhere}.url{font:12px/1.8 var(--mono);color:var(--muted);overflow-wrap:anywhere}.intro-bottom{display:flex;justify-content:space-between;gap:24px;align-items:end}.intro-bottom p{margin:0;max-width:560px;color:var(--muted)}.hero{display:grid;grid-template-columns:1.4fr 1fr;background:var(--dark);color:var(--paper);border-radius:8px;overflow:hidden;margin:0 0 22px}.numbers{padding:32px 36px 34px}.number-row{display:flex;align-items:center;gap:25px;margin:12px 0 10px}.number{font-size:clamp(70px,9vw,116px);line-height:1;letter-spacing:-7px;font-weight:560;font-variant-numeric:tabular-nums}.number.before{color:#a3aa96}.arrow{font-size:38px;color:#808b74;line-height:1}.after{color:var(--green)}.number-caption{color:#b6bfae;font-size:13px}.hero-right{background:var(--green);color:var(--ink);padding:32px 36px;display:flex;flex-direction:column;justify-content:space-between}.percent{font-size:58px;font-weight:620;letter-spacing:-3px;line-height:1.15}.hero-right p{margin:7px 0 0;max-width:310px;font-size:13px}.hero-right .micro{margin-top:23px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:6px;margin-bottom:58px}.metric{padding:17px 24px;border-right:1px solid var(--line)}.metric:last-child{border-right:0}.metric strong{display:block;margin-top:4px;font-size:20px;font-weight:590;letter-spacing:-.3px}.metric .micro{color:var(--muted)}section{margin:0 0 56px}.section-heading{display:flex;justify-content:space-between;align-items:center;gap:20px;margin:0 0 20px}.section-heading h2{font-size:24px;font-weight:610;letter-spacing:-.7px;margin:5px 0 0}.section-label{color:var(--muted)}.section-note{max-width:500px;color:var(--muted);font-size:13px;margin:0}.pill{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:100px;padding:5px 10px;font:11px var(--mono);white-space:nowrap}.predicate{padding:22px 25px;border:1px solid var(--line);border-left:3px solid #8cae21;border-radius:5px;background:var(--card)}.predicate pre{margin:0;background:transparent;padding:0}.columns{display:grid;grid-template-columns:1fr 1fr;gap:22px}.journey{border:1px solid var(--line);border-radius:6px;background:var(--card);overflow:hidden}.journey-head{display:flex;align-items:center;justify-content:space-between;padding:17px 22px;border-bottom:1px solid var(--line);font-size:13px;font-weight:650}.journey.after-list .journey-head{background:#eaf2c9}.steps{list-style:none;counter-reset:steps;margin:0;padding:0}.step{counter-increment:steps;display:flex;gap:13px;padding:17px 22px;border-bottom:1px solid #e8eade}.step:last-child{border-bottom:0}.step:before{content:counter(steps,decimal-leading-zero);color:#8c9482;font:11px/22px var(--mono);flex:0 0 20px}.step.removed{background:#f0f0e8;color:#7f8678}.step.removed .step-title{text-decoration:line-through}.step-title{font-size:13px;font-weight:620;overflow-wrap:anywhere}.step-action{font:11px/1.7 var(--mono);color:var(--muted);margin-top:3px;overflow-wrap:anywhere}.step-flag{font:9px var(--mono);text-transform:uppercase;color:var(--muted);margin-left:5px}.empty{padding:25px 22px;color:var(--muted);font-size:13px}.setup{margin-top:18px}.setup summary{font-size:12px;color:var(--muted)}.setup .steps{border:1px solid var(--line);border-radius:5px;margin-top:12px}.verification{margin:17px 0 0;font-size:12px;color:var(--muted);max-width:850px}.filters{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 15px}.filters button{padding:6px 11px;font-size:11px;border-color:var(--line)}.filters button[aria-pressed=true]{background:var(--ink);color:var(--paper);border-color:var(--ink)}#trial-count{color:var(--muted);font:11px var(--mono)}.trial-list{border-top:1px solid var(--line)}.trial{border-bottom:1px solid var(--line)}.trial[hidden]{display:none}.trial summary{display:grid;grid-template-columns:55px 1fr 95px 135px 22px;align-items:center;gap:10px;padding:14px 5px;list-style:none;font-size:12px}.trial summary::-webkit-details-marker{display:none}.trial summary:after{content:'+';text-align:center;font:18px var(--mono);color:var(--muted)}.trial[open] summary:after{content:'−'}.trial-id,.trial-duration{color:var(--muted);font:11px var(--mono)}.outcome{font:10px var(--mono);padding:4px 8px;width:max-content;border-radius:3px;background:#e9ede2}.outcome.reproduced{background:#e3edb9;color:#344807}.outcome.invalid{background:#f3dfd3;color:#8b3c29}.trial-content{padding:0 18px 18px 65px}.trial-content pre{margin:8px 0 0}.evidence-grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}.evidence-box{border:1px solid var(--line);border-radius:6px;background:var(--card);overflow:hidden}.box-head{padding:17px 22px;border-bottom:1px solid var(--line);font-size:13px;font-weight:620}.evidence-box pre{margin:0;background:transparent;font-size:11px;max-height:430px}.screenshot{margin:0;background:#e8ebdf;padding:14px}.screenshot img{display:block;width:100%;height:auto;max-height:520px;object-fit:contain;object-position:top}.screenshot figcaption{font-size:11px;color:var(--muted);margin:11px 2px 0}.callout{border:1px solid var(--line);background:var(--card);border-radius:7px;overflow:hidden}.callout-top{display:flex;align-items:center;justify-content:space-between;gap:22px;padding:25px}.callout-top h3{font-size:19px;font-weight:610;letter-spacing:-.4px;margin:0 0 5px}.callout-top p{font-size:12px;color:var(--muted);margin:0;max-width:570px}.callout details{border-top:1px solid var(--line);padding:14px 25px}.callout summary{font-size:12px;font-weight:550}.callout pre{margin:15px -10px 0;max-height:450px}.callout+.callout{margin-top:15px}pre{font:12px/1.65 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;background:#eeefe7;border-radius:4px;padding:18px;overflow:auto}code{font-family:var(--mono)}.copy-status{font-size:12px;min-height:20px;margin-top:12px;color:#4a6110}footer{display:flex;justify-content:space-between;gap:20px;border-top:1px solid var(--ink);padding:21px 0 36px;color:var(--muted);font:10px/1.7 var(--mono)}footer span:last-child{text-align:right}.privacy{font-size:11px;color:var(--muted);margin-top:14px}.reason{font-size:12px;color:var(--muted);margin:0 0 22px;overflow-wrap:anywhere}@media(max-width:760px){.page{padding:0 20px}header{height:96px;flex-direction:column;align-items:flex-start;justify-content:center;gap:8px}.wordmark{white-space:nowrap}.edition{font-size:9px;letter-spacing:.4px}.intro{padding-top:37px}h1{letter-spacing:-1.2px}.intro-bottom{align-items:start;flex-direction:column}.hero{grid-template-columns:1fr}.numbers,.hero-right{padding:24px}.hero-right{flex-direction:row;align-items:center;gap:20px}.hero-right .micro{margin-top:0}.hero-right p{max-width:200px}.percent{font-size:45px}.number{font-size:85px}.metrics{margin-bottom:40px}.metric{padding:15px 12px}.metric .micro{font-size:9px;letter-spacing:.5px}.metric strong{font-size:16px}.columns,.evidence-grid{grid-template-columns:1fr}.section-heading{align-items:start;flex-direction:column;gap:10px}.trial summary{grid-template-columns:36px 1fr 105px 16px;gap:6px}.trial-duration{display:none}.trial-content{padding-left:42px}.callout-top{align-items:start;flex-direction:column;padding:22px}.callout details{padding:14px 22px}.section-heading h2{font-size:23px}footer{flex-direction:column}footer span:last-child{text-align:left}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}@media print{.page{padding:0;max-width:none}button,.filters,.copy-status{display:none}body{background:white}.hero,.hero-right{-webkit-print-color-adjust:exact;print-color-adjust:exact}section{break-inside:avoid}.callout details{display:none}footer{padding-bottom:0}}
`;

/** Render a portable, network-free HTML artifact. All report fields are untrusted. */
export function renderHtml(report) {
  const { journey, result, original, reduced, setup, removed, percent, verified, reducedJourney, evidence } = reportParts(report);
  const h = escapeHtml;
  const trials = Array.isArray(result.trials) ? result.trials : [];
  const retained = new Set(reduced.map((action) => action.id));
  const renderSteps = (actions, before = false) => actions.length ? `<ol class="steps">${actions.map((action) => {
    const removedStep = before && !retained.has(action.id);
    return `<li class="step${removedStep ? ' removed' : ''}"><div><div class="step-title">${h(action.label || action.id)}${removedStep ? '<span class="step-flag">removed</span>' : ''}</div><div class="step-action">${h(actionDescription(action))}</div></div></li>`;
  }).join('')}</ol>` : '<div class="empty">No reducible actions.</div>';
  const screenshot = typeof evidence.screenshot === 'string' && /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(evidence.screenshot) ? evidence.screenshot : null;
  const evidenceText = JSON.stringify({ outcome: report.finalTrial?.outcome ?? 'unavailable', failedActionId: report.finalTrial?.failedActionId, error: report.finalTrial?.error, matched: evidence.matched ?? [], pageErrors: evidence.pageErrors ?? [], consoleErrors: evidence.consoleErrors ?? [], httpErrors: evidence.httpErrors ?? [], screenshotError: evidence.screenshotError }, null, 2);
  const scriptHash = createHash('sha256').update(REPORT_SCRIPT).digest('base64');
  const statusLabel = String(result.status ?? 'unknown').replaceAll('-', ' ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light">
<title>${h(journey.name || 'Browser failure')} · ReproCut</title>
<style>${STYLE}</style>
</head>
<body>
<div class="page">
<header><div class="wordmark"><span class="mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>ReproCut<span style="font-size:12px;letter-spacing:0;font-weight:450;color:var(--muted)"> / report</span></div><span class="edition">Browser bug reduction · v${h(report.toolVersion || '0.1.0')}</span></header>
<main>
<div class="intro"><div class="eyebrow"><span class="dot" aria-hidden="true"></span> ${h(statusLabel)}${verified ? ' · failure confirmed' : ' · candidate unverified'}</div><h1>${h(journey.name || 'Browser failure')}</h1><div class="intro-bottom"><div><p>A shorter path to the same browser failure.</p><div class="url">${h(journey.url)}</div></div><button class="primary" data-copy="repair-brief">Copy repair brief ↗</button></div></div>
<div class="hero" aria-label="Reduced from ${original.length} to ${reduced.length} actions"><div class="numbers"><div class="micro">${verified ? 'Confirmed reproduction' : 'Reduction candidate'}</div><div class="number-row"><span class="number before">${original.length}</span><span class="arrow" aria-hidden="true">→</span><span class="number after">${reduced.length}</span></div><div class="number-caption">Original actions <span aria-hidden="true">/</span> ${verified ? 'confirmed' : 'candidate'} actions</div></div><div class="hero-right"><div><div class="percent">${percent}%</div><div>fewer actions</div></div><div><div class="micro">${removed} steps removed</div><p>${verified ? 'The configured failure still reproduces after the recorded reduction.' : 'Final reproduction has not been confirmed. Review the trial evidence.'}</p></div></div></div>
<div class="metrics"><div class="metric"><span class="micro">Replay runs</span><strong>${h(Number.isFinite(result.runs) ? result.runs : trials.length)}</strong></div><div class="metric"><span class="micro">Final confirmations</span><strong>${h(Number.isFinite(result.confirmations) ? result.confirmations : 0)}</strong></div><div class="metric"><span class="micro">Minimality</span><strong>${result.oneMinimal && verified ? '1-minimal' : 'Not verified'}</strong></div></div>
${result.reason ? `<p class="reason">Run note: ${h(result.reason)}</p>` : ''}
<section aria-labelledby="failure-heading"><div class="section-heading"><div><div class="section-label">01 / The signal</div><h2 id="failure-heading">One exact failure.</h2></div><p class="section-note">Every replay uses this predicate. A failed action cannot qualify as a reproduction.</p></div><div class="predicate"><pre>${h(JSON.stringify(journey.failure ?? {}, null, 2))}</pre></div><p class="verification">Event capture begins with the first reducible action. Navigation and fixed setup are excluded. Visible predicates inspect the final page after the observation window.</p></section>
<section aria-labelledby="journey-heading"><div class="section-heading"><div><div class="section-label">02 / The cut</div><h2 id="journey-heading">Follow what remains.</h2></div><span class="pill">${setup.length} fixed setup ${setup.length === 1 ? 'step' : 'steps'}</span></div><div class="columns"><div class="journey"><div class="journey-head"><span>Before</span><span>${original.length} actions</span></div>${renderSteps(original, true)}</div><div class="journey after-list"><div class="journey-head"><span>After${verified ? '' : ' · unverified'}</span><span>${reduced.length} actions</span></div>${renderSteps(reduced)}</div></div>${setup.length ? `<details class="setup"><summary>Inspect fixed setup · ${setup.length} steps retained on every replay</summary>${renderSteps(setup)}</details>` : ''}<p class="verification">${h(verificationText(result, verified))}</p></section>
<section aria-labelledby="trials-heading"><div class="section-heading"><div><div class="section-label">03 / The search</div><h2 id="trials-heading">Every attempt, on record.</h2></div><span id="trial-count" aria-live="polite">${trials.length} trials shown</span></div><div class="filters" role="group" aria-label="Filter trials by outcome"><button data-filter="all" aria-pressed="true">All trials</button><button data-filter="reproduced" aria-pressed="false">Reproduced</button><button data-filter="not-reproduced" aria-pressed="false">Not reproduced</button><button data-filter="invalid" aria-pressed="false">Invalid actions</button></div><div class="trial-list">${trials.length ? trials.map((trial, i) => {
    const outcome = ['reproduced', 'not-reproduced', 'invalid'].includes(trial.outcome) ? trial.outcome : 'unknown';
    const actionIds = Array.isArray(trial.actionIds) ? trial.actionIds : [];
    return `<details class="trial" data-outcome="${outcome}"><summary><span class="trial-id">${String(i + 1).padStart(2, '0')}</span><span>${h(trial.phase || 'replay')} <span style="color:var(--muted)">· ${actionIds.length} actions</span></span><span class="trial-duration">${Number.isFinite(trial.durationMs) ? Math.round(trial.durationMs) + ' ms' : '—'}</span><span class="outcome ${outcome}">${h(outcome.replaceAll('-', ' '))}</span></summary><div class="trial-content"><div class="micro">Action IDs</div><pre>${h(actionIds.length ? actionIds.join('\n') : '(empty candidate)')}</pre>${trial.error || trial.failedActionId ? `<pre>${h(JSON.stringify({ failedActionId: trial.failedActionId, error: trial.error }, null, 2))}</pre>` : ''}</div></details>`;
  }).join('') : '<p class="empty">No replay trials were recorded.</p>'}</div></section>
<section aria-labelledby="evidence-heading"><div class="section-heading"><div><div class="section-label">04 / The evidence</div><h2 id="evidence-heading">The observed result.</h2></div><p class="section-note">Final replay evidence. Root cause has not been established.</p></div><div class="evidence-grid"><div class="evidence-box"><div class="box-head">Captured failure signals</div><pre>${h(evidenceText)}</pre></div><div class="evidence-box"><div class="box-head">Final browser frame</div>${screenshot ? `<figure class="screenshot"><img src="data:image/png;base64,${screenshot}" alt="Browser screenshot captured after the final replay"><figcaption>Captured after the final replay observation window.</figcaption></figure>` : '<div class="empty">No screenshot was captured for this report.</div>'}</div></div><p class="privacy">Evidence text is bounded; predicate matching uses full event text. This report opens offline. Captured text, screenshots, and URLs may contain application data; review before sharing.</p></section>
<section aria-labelledby="handoff-heading"><div class="section-heading"><div><div class="section-label">05 / The handoff</div><h2 id="handoff-heading">Ready for the repair.</h2></div></div><div class="callout"><div class="callout-top"><div><h3>Give the next agent the evidence.</h3><p>A repair brief with the exact predicate, setup, reduced journey, captured evidence, and acceptance criteria.</p></div><button class="primary" data-copy="repair-brief">Copy repair brief ↗</button></div><details><summary>Read the full repair brief</summary><pre id="repair-brief">${h(renderMarkdown(report))}</pre></details></div><div class="callout"><div class="callout-top"><div><h3>Keep the failure from coming back.</h3><p>A runnable Playwright regression. It fails while the configured failure remains; setup and action errors also fail.</p></div><button data-copy="regression-test">Copy regression test ↗</button></div><details><summary>Inspect the Playwright test</summary><pre id="regression-test">${h(generatePlaywrightTest(reducedJourney))}</pre></details></div><div id="copy-status" class="copy-status" role="status" aria-live="polite"></div></section>
</main><footer><span>ReproCut / Less noise. Same failure.</span><span>${h(report.createdAt || '')}<br>Self-contained report · No remote assets</span></footer>
</div>
<script>${REPORT_SCRIPT}</script>
</body>
</html>`;
}
