<div align="center">

# ReproCut

### Less journey. Same bug.

Shrink a failing browser journey into a verified reproducer — and a runnable regression test.

[![CI](https://github.com/RealJasonHu/reprocut/actions/workflows/ci.yml/badge.svg)](https://github.com/RealJasonHu/reprocut/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-263c2a)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%E2%89%A522-263c2a)](https://nodejs.org/)

[English](README.md) · [简体中文](README.zh-CN.md) · [Demo report](https://github.com/RealJasonHu/reprocut/releases/latest) · [Journey format](docs/journeys.md)

</div>

You can reproduce the bug. You just don't know which of the twelve steps matter.

ReproCut replays your journey in fresh browser contexts, removes actions, and keeps a shorter sequence **only when the same explicit failure still reproduces**. Give the resulting test and repair brief to a teammate or your coding agent.

```text
Search → clear → favorite → details → theme → express → newsletter
       → coupon → gift → note → theme → checkout

                     ReproCut
                        ↓

             Express → coupon → checkout
                  Same target error.
```

## Try the real browser demo

Requires Node.js 22+ and a Chromium download on first use. No API key, model, account, or hosted service.

```bash
git clone https://github.com/RealJasonHu/reprocut.git
cd reprocut
npm install
npx playwright install chromium
npm run demo
```

Open `reprocut-output/report.html`. The command starts a deliberately buggy local shop, drives Chromium, reduces the journey, and stops the shop. All trial counts and screenshots come from actual runs.

**Checked demo result: 12 → 3 actions, 36 browser replays, 75% fewer steps.** This is one deterministic fixture, not a benchmark across applications.

![ReproCut's real browser reduction report](docs/assets/demo-report.png)

You can also install the versioned GitHub package without cloning:

```bash
npm install -g github:RealJasonHu/reprocut#v0.1.0
reprocut install
reprocut demo
```

The package is distributed through GitHub releases and Git installation; it is **not published to the npm registry**.

## Use it on your app

1. Run a disposable local/test instance of your application.
2. Describe the known reproduction as a small JSON journey.
3. Name the exact symptom ReproCut must preserve.

```bash
node src/cli.js init --url http://localhost:3000 --out my-case
# Edit my-case/journey.json with your selectors, actions and error.
node src/cli.js shrink my-case/journey.json --out my-repro
```

```json
{
  "version": 1,
  "name": "Express coupon breaks checkout",
  "url": "http://localhost:3000",
  "setup": [],
  "actions": [
    { "id": "theme", "type": "click", "selector": "#theme" },
    { "id": "express", "type": "check", "selector": "#express" },
    { "id": "coupon", "type": "fill", "selector": "#coupon", "value": "SAVE10" },
    { "id": "buy", "type": "click", "selector": "#checkout" }
  ],
  "failure": { "type": "page-error", "includes": "CHECKOUT_TOTAL_UNDEFINED" }
}
```

`setup` stays fixed. Only `actions` are reduced, in their original order. Use specific selectors and literal failure substrings. [All actions and failure predicates →](docs/journeys.md)

## What you get

| File | Purpose |
| --- | --- |
| `report.html` | Self-contained offline report: before/after, actual trials, evidence, final screenshot, copyable repair brief |
| `reduced.journey.json` | Replayable smaller journey with the original failure predicate |
| `regression.spec.js` | Playwright test that **fails while the target bug remains** |
| `repair.md` | Observed symptom, relevant steps, limitations and runnable test for an AI agent or human |
| `report.json` | Structured evidence, run status, timings and all trial outcomes |
| `original.journey.json` | Original input with normalized defaults |

Re-run a reduced journey:

```bash
node src/cli.js replay my-repro/reduced.journey.json --out replay-check
```

Run its generated regression test inside a project with `@playwright/test` installed:

```bash
npx playwright test my-repro/regression.spec.js
# To target a different running instance:
REPROCUT_URL=http://localhost:3001 npx playwright test my-repro/regression.spec.js
```

The target app must still be running. The demo uses a temporary port; restart it with `npm run demo:serve`, then set `REPROCUT_URL=http://127.0.0.1:4173`. The repository's integration test checks the generated test against both buggy and fixed versions of this fixture.

## Why this tool

Playwright's [Trace Viewer](https://playwright.dev/docs/trace-viewer) helps inspect a run. [TraceBug](https://github.com/prashantsinghmangat/TraceBug-ai) packages browser debugging evidence. ReproCut focuses on **running the deletion experiments**: which actions can you remove while preserving a declared symptom?

The reducer is based on established [delta debugging](https://www.st.cs.uni-saarland.de/papers/tse2002/), followed by a single-deletion verification pass. The contribution here is the browser workflow, conservative replay decisions, and executable handoff. No claim to have invented delta debugging or to automatically identify root causes.

## Honest results, bounded work

- **Same predicate every time.** A different error, failed action, or locator timeout cannot stand in for the target symptom.
- **Repeated confirmation.** Original, accepted candidates and final output must reproduce repeatedly (default: twice).
- **Run budget.** Every replay, including final evidence capture, counts toward `--max-runs` (default: 80).
- **1-minimal when verified.** Every individual deletion was tried and rejected; rejection can mean the symptom disappeared or the remaining actions could not run. This is not a globally shortest sequence.
- **Incomplete stays incomplete.** A budget stop, missing baseline or observed instability is explicit and exits nonzero.

```bash
node src/cli.js shrink journey.json --max-runs 120 --confirmations 3 --out reduced
```

| Exit | `shrink` | `replay` |
| --- | --- | --- |
| `0` | Verified, complete reduction | Target symptom reproduced |
| `1` | Budget exhausted, unstable, or baseline not reproduced | Target not reproduced |
| `2` | Input or runtime error | Invalid journey execution, input or runtime error |

## Scope and limits

**v0.1.0 is an early release.** Chromium, a single page, declarative JSON journeys, seven action types and four explicit failure predicates are supported. Importing arbitrary Playwright scripts/traces, recording journeys, frame/popup workflows, and automatic server-state reset are not implemented.

Fresh contexts reset browser state, not databases or third-party services. Repeated clicks can repeat real side effects: use seeded test data and a disposable app. Delayed setup errors may arrive during the observation window; repeated success is evidence, not proof against flakiness. Choose an observation window long enough for your symptom and a failure signature specific to your bug.

Reports contain action values, URLs, console/error messages and screenshots. They stay local until you share them, and **are not automatically redacted**. The tool itself has no telemetry or model calls; your app may make its own network requests.

## Contribute

```bash
npm install
npx playwright install chromium
npm test
npm run check
```

Good next contributions: journey recorder/importer, state-reset hooks, more failure predicates, and examples from real applications. Start with [CONTRIBUTING.md](CONTRIBUTING.md). If ReproCut helps isolate a bug, a small sanitized journey and a before/after count are more useful than an unsupported benchmark claim.

MIT · Built by [Jason Hu](https://github.com/RealJasonHu)
