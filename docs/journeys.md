# Journey reference

ReproCut reads a data-only JSON format, version `1`. Unknown keys, duplicate IDs, empty failure signatures and invalid time bounds are rejected. It never imports or evaluates code embedded in a journey.

## Top-level fields

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Exactly `1` |
| `name` | yes | Human-readable case name |
| `url` | yes | Absolute HTTP(S) starting URL, no embedded username/password |
| `setup` | no | Fixed action array, default `[]` |
| `actions` | yes | Ordered action array to reduce (may be empty) |
| `failure` | yes | Exactly one predicate below |
| `options` | no | Defaults and limits below |

IDs must be unique across both arrays. Each array is limited to 200 actions. Strings are limited to 10,000 characters and the CLI input to 2 MiB.

## Actions

Every action requires `id`, `type`, and `selector`; `label` is optional. Locators use Playwright's selector syntax. Use stable selectors such as `[data-testid="checkout"]`. Ambiguous targets fail through Playwright strict mode.

| Type | Additional fields | Example |
| --- | --- | --- |
| `click` | none | `{"id":"buy","type":"click","selector":"#checkout"}` |
| `fill` | `value` (empty allowed) | `{"id":"coupon","type":"fill","selector":"#coupon","value":"SAVE10"}` |
| `press` | `key` | `{"id":"submit","type":"press","selector":"#search","key":"Enter"}` |
| `select` | `value` | `{"id":"size","type":"select","selector":"#size","value":"large"}` |
| `check` | none | `{"id":"express","type":"check","selector":"#express"}` |
| `uncheck` | none | `{"id":"standard","type":"uncheck","selector":"#express"}` |
| `wait-for` | `state` | `{"id":"ready","type":"wait-for","selector":"#checkout","state":"visible"}` |

Wait states: `visible`, `hidden`, `attached`, `detached`. Fixed sleeps are intentionally not an action; use a relevant readiness locator. The observation window below is specifically for collecting asynchronous failure events after the journey.

## Failure predicates

| Type | Required fields | Match |
| --- | --- | --- |
| `page-error` | `includes` | Unhandled page exception message contains literal substring |
| `console-error` | `includes` | `console.error` message contains literal substring |
| `http-error` | `urlIncludes`, `status` | Response URL contains literal substring AND exact 400–599 status |
| `visible` | `selector`, `textIncludes` | Exactly one matched element is visible and its text content contains literal substring |

Substrings are case-sensitive, not regexes. Choose a sufficiently specific signature: `"Error"` is usually too broad. For `visible`, zero matching elements means not reproduced, more than one means invalid.

Event predicates arm immediately before the first reducible action, after navigation and setup. They remain active through the post-action observation window. With no actions, they stay disarmed. HTTP responses are counted only if their requests began in the action window. `visible` inspects the final page even with zero actions. Browser event timing is not causality: delayed setup JavaScript can still throw during actions.

All setup/actions must complete successfully for a replay to reproduce the target, even if the target error was observed earlier. Navigating to an unreachable page or clicking a missing element is `invalid`, never a successful reproducer.

## Options

```json
{
  "actionTimeoutMs": 1000,
  "observeMs": 150,
  "viewport": { "width": 1280, "height": 800 }
}
```

`actionTimeoutMs`: 100–60,000 ms. Navigation timeout: at least 10 seconds. `observeMs`: 0–10,000 ms; increase it for slow symptoms, at the cost of slower reduction. Viewport: width 320–3840 and height 240–2160. Chromium runs headless unless `--headed` is set. Service workers are blocked; this release is not suitable for testing service-worker-specific bugs.

## Verdicts and minimality

Replays return `reproduced`, `not-reproduced`, or `invalid`. Reduction uses ordered chunk deletion and then checks every one-action deletion. Accepted candidates must reproduce the configured number of times; a rejection needs only one non-reproducing/invalid observation. Consequently 1-minimality is conditional on these finite observations and the declared replay conditions, especially for flaky apps.

`complete` requires final repeated confirmation and all single deletions rejected. `budget-exhausted` may still include a verified smaller candidate, but never a completed minimality claim. `baseline-not-reproduced` means the original did not reliably exhibit the target; `unstable` indicates mixed observed outcomes or failed final confirmation. Read `verified`, `oneMinimal`, `reason`, and `trials` in `report.json` together.

Every browser run counts toward the budget, including baseline, candidate checks, verification and final screenshot capture. Fixed setup steps are excluded from the reported action reduction. The reducer cannot reorder or simplify values, and a smaller non-monotone combination may exist.

## Library use

```js
import { loadJourney, createRunner, reduceJourney } from '@realjasonhu/reprocut';

const journey = await loadJourney('./journey.json');
const runner = await createRunner(journey);
try {
  const result = await reduceJourney(journey.actions, (steps, options) => runner.run(steps, options));
  console.log(result.status, result.reducedActions, result.oneMinimal);
} finally {
  await runner.close();
}
```

Always validate externally supplied journeys before calling `createRunner`. All file paths and output artifacts are local. No application state reset, authentication-state import, shell reset hooks or remote report upload is provided.
