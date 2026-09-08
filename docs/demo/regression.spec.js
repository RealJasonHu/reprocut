import { test, expect } from '@playwright/test';

// Install: npm install --save-dev @playwright/test
// Browser: npx playwright install chromium
// Save as reprocut.spec.js; run: npx playwright test reprocut.spec.js
// Keep the application running at journey.url, or override it with REPROCUT_URL.
// Treat this file as a local artifact.
const journey = {
  "version": 1,
  "name": "Express shipping + coupon crashes checkout",
  "url": "http://127.0.0.1:54260/",
  "setup": [],
  "actions": [
    {
      "id": "express",
      "type": "check",
      "selector": "#express",
      "label": "Choose express shipping"
    },
    {
      "id": "coupon",
      "type": "fill",
      "selector": "#coupon",
      "value": "SAVE10",
      "label": "Enter coupon SAVE10"
    },
    {
      "id": "checkout",
      "type": "click",
      "selector": "#checkout",
      "label": "Place order"
    }
  ],
  "failure": {
    "type": "page-error",
    "includes": "CHECKOUT_TOTAL_UNDEFINED"
  },
  "options": {
    "actionTimeoutMs": 800,
    "observeMs": 80,
    "viewport": {
      "width": 1280,
      "height": 800
    }
  }
};

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
