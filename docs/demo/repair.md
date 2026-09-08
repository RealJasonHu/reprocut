# ReproCut repair brief: Express shipping \+ coupon crashes checkout

Fix the configured failure below while preserving the intended behavior of the remaining journey. Root cause has not been established.

## Run summary

- URL: http://127\.0\.0\.1:54260/
- Generated: 2026\-09\-08T03:47:58\.998Z
- Status: complete
- Steps: 12 → 3 (9 removed; 75% reduction)
- Replays: 36
- Final confirmations: 2
- Verified: yes
- Confirmed 1-minimal: each single-action deletion was rejected in the tested trials. A smaller sequence may exist through other combinations.
- Run note: The retained candidate is confirmed and every single deletion was rejected\.

## Exact failure predicate

```json
{
  "type": "page-error",
  "includes": "CHECKOUT_TOTAL_UNDEFINED"
}
```

Event failures count from the start of the first reducible action through the observation window. Navigation and fixed setup are excluded. HTTP failures require a request started inside that window. Visible failures inspect the final page. Every setup and action must succeed.

## Fixed setup (excluded from reduction)

_No actions._

## Before: original actions

1. Search for ceramic — fill \#search = "ceramic"
2. Clear search — fill \#search = ""
3. Save mug to favorites — click \#favorite
4. Read product details — click \#details
5. Change theme — click \#theme
6. Choose express shipping — check \#express
7. Join the newsletter — check \#newsletter
8. Enter coupon SAVE10 — fill \#coupon = "SAVE10"
9. Add gift wrapping — check \#gift
10. Write a gift note — fill \#note = "A gift for a friend"
11. Change theme again — click \#theme
12. Place order — click \#checkout

## After: confirmed actions

1. Choose express shipping — check \#express
2. Enter coupon SAVE10 — fill \#coupon = "SAVE10"
3. Place order — click \#checkout

## Captured evidence

```json
{
  "outcome": "reproduced",
  "matched": [
    "page-error: CHECKOUT_TOTAL_UNDEFINED: express shipping with SAVE10"
  ],
  "pageErrors": [
    "CHECKOUT_TOTAL_UNDEFINED: express shipping with SAVE10"
  ],
  "consoleErrors": [],
  "httpErrors": []
}
```

Evidence text is bounded by the recorder; matching uses the original event text. A screenshot, when captured, is available in the HTML report. Captured text and URLs may contain application data; review artifacts before sharing.

## Reduced journey

```json
{
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
}
```

## Repair acceptance

1. Run the reduced journey against the same application and environment.
2. Identify the cause from the observed evidence; do not infer a diagnosis from reduction alone.
3. Fix the failure and run the regression below. It must fail while the exact predicate remains and pass once the predicate is absent. Setup or action errors still fail the test.
4. Check the original journey for behavior affected by the repair.

## Playwright regression test

Save as `reprocut.spec.js`, install `@playwright/test` and its Chromium browser, then run `npx playwright test reprocut.spec.js` with the application running. Set `REPROCUT_URL` to override the captured application URL.

```js
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

```
