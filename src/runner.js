import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const MAX_EVENTS = 50;
const MAX_TEXT = 2_000;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

function bounded(value) {
  const text = String(value ?? '');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… [truncated]` : text;
}

function append(list, value) {
  if (list.length < MAX_EVENTS) list.push(value);
}

function matchedExcerpt(text, needle) {
  const index = text.indexOf(needle);
  if (index < MAX_TEXT / 2) return bounded(text);
  return bounded(`…${text.slice(Math.max(0, index - 250))}`);
}

/** Execute one declarative action. All locator actions use the page timeout. */
export async function executeAction(page, action) {
  const locator = page.locator(action.selector);
  switch (action.type) {
    case 'click': return locator.click();
    case 'fill': return locator.fill(action.value);
    case 'press': return locator.press(action.key);
    case 'select': return locator.selectOption(action.value);
    case 'check': return locator.check();
    case 'uncheck': return locator.uncheck();
    case 'wait-for': return locator.waitFor({ state: action.state });
    default: throw new Error(`Unsupported action type: ${action.type}`);
  }
}

/**
 * Reuse a browser process, never a browser context. A trial reports the configured
 * symptom only after every setup and candidate action completed successfully.
 */
export async function createRunner(journey, { headless = true } = {}) {
  const browser = await chromium.launch({ headless, timeout: 30_000 });
  let closed = false;
  const options = journey.options ?? {};
  const actionTimeoutMs = options.actionTimeoutMs ?? 1_000;
  const observeMs = options.observeMs ?? 150;
  const viewport = options.viewport ?? { width: 1280, height: 800 };

  return {
    async run(actions, { capture = false } = {}) {
      if (closed) throw new Error('Cannot replay a journey after its runner is closed.');
      const started = performance.now();
      const evidence = { pageErrors: [], consoleErrors: [], httpErrors: [], matched: [] };
      const trial = { outcome: 'not-reproduced', durationMs: 0, evidence };
      let context;
      let page;
      let active = false;
      let matched = false;
      let phase = 'navigation';
      let currentAction;
      const activeRequests = new WeakSet();
      const match = (description) => {
        matched = true;
        append(evidence.matched, bounded(description));
      };

      try {
        context = await browser.newContext({ viewport, serviceWorkers: 'block' });
        page = await context.newPage();
        page.setDefaultTimeout(actionTimeoutMs);
        page.setDefaultNavigationTimeout(Math.max(actionTimeoutMs, 10_000));

        page.on('pageerror', (error) => {
          if (!active) return;
          const message = error.message;
          append(evidence.pageErrors, bounded(message));
          if (journey.failure.type === 'page-error' && message.includes(journey.failure.includes)) {
            match(`page-error: ${matchedExcerpt(message, journey.failure.includes)}`);
          }
        });
        page.on('console', (message) => {
          if (!active || message.type() !== 'error') return;
          const text = message.text();
          append(evidence.consoleErrors, bounded(text));
          if (journey.failure.type === 'console-error' && text.includes(journey.failure.includes)) {
            match(`console-error: ${matchedExcerpt(text, journey.failure.includes)}`);
          }
        });
        page.on('request', (request) => {
          if (active) activeRequests.add(request);
        });
        page.on('response', (response) => {
          if (!active || !activeRequests.has(response.request())) return;
          const status = response.status();
          if (status < 400 || status > 599) return;
          const url = response.url();
          append(evidence.httpErrors, { url: bounded(url), status, statusText: bounded(response.statusText()) });
          if (journey.failure.type === 'http-error'
            && status === journey.failure.status
            && url.includes(journey.failure.urlIncludes)) {
            match(`http-error: ${status} ${matchedExcerpt(url, journey.failure.urlIncludes)}`);
          }
        });

        await page.goto(journey.url, { waitUntil: 'domcontentloaded' });
        phase = 'setup';
        for (const action of journey.setup ?? []) {
          currentAction = action.id;
          await executeAction(page, action);
        }

        phase = 'action';
        currentAction = undefined;
        // No reducible action means no action-origin event observation window.
        active = actions.length > 0;
        for (const action of actions) {
          currentAction = action.id;
          await executeAction(page, action);
        }
        currentAction = undefined;
        phase = 'observation';
        if (observeMs > 0) await page.waitForTimeout(observeMs);

        if (journey.failure.type === 'visible') {
          const locator = page.locator(journey.failure.selector);
          const count = await locator.count();
          if (count > 1) throw new Error(`Ambiguous visible failure selector: expected one element, found ${count}.`);
          if (count === 1 && await locator.isVisible()) {
            const text = await locator.textContent();
            if ((text ?? '').includes(journey.failure.textIncludes)) {
              match(`visible: ${journey.failure.selector} contains ${journey.failure.textIncludes}`);
            }
          }
        }
        trial.outcome = matched ? 'reproduced' : 'not-reproduced';
      } catch (error) {
        trial.outcome = 'invalid';
        trial.error = bounded(`${phase}: ${error instanceof Error ? error.message : error}`);
        if (currentAction !== undefined) trial.failedActionId = currentAction;
      } finally {
        // Screenshot hooks/animation changes cannot create a new target match.
        active = false;
        if (capture && page && !page.isClosed()) {
          try {
            const png = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', timeout: 5_000 });
            if (png.byteLength <= MAX_SCREENSHOT_BYTES) evidence.screenshot = png.toString('base64');
            else evidence.screenshotError = 'Screenshot omitted because it exceeded the 4 MiB evidence limit.';
          } catch (error) {
            evidence.screenshotError = bounded(`Screenshot unavailable: ${error instanceof Error ? error.message : error}`);
          }
        }
        if (context) {
          try { await context.close(); }
          catch (error) {
            trial.outcome = 'invalid';
            trial.error = bounded(`Context cleanup failed: ${error instanceof Error ? error.message : error}`);
          }
        }
        trial.durationMs = Math.round(performance.now() - started);
      }
      return trial;
    },
    async close() {
      if (closed) return;
      closed = true;
      await browser.close();
    },
  };
}
