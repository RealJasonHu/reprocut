# v0.1.0 verification record

Recorded on 2026-09-08. This page describes observed checks, not a general reliability or performance guarantee.

## Local validation

- macOS Apple Silicon, Node.js 24.19.0, Playwright 1.63.0 / Chromium build 1243.
- 60 Node test cases passed: journey validation, all 128 deterministic failure predicates over three actions, reducer budgets and instability, generated report/test behavior, real browser replay, CLI exit codes and end-to-end regression.
- The complete integration check actually executes a generated Playwright test. It fails specifically on `CHECKOUT_TOTAL_UNDEFINED` against the buggy fixture and passes against its fixed counterpart.
- The packed release was installed in a separate temporary directory. The installed `reprocut` binary reported version 0.1.0, resolved and ran its Chromium installer, and completed the bundled demo.
- The offline report was rendered at desktop and mobile widths with no horizontal overflow or page JavaScript errors. Outcome filters selected 20 non-reproducing trials and restored all 36 trials.

## Committed demo

The [JSON evidence](demo/report.json) and [HTML report](demo/report.html) were generated from a real local run, not hand-entered result numbers.

| Observation | Result |
| --- | --- |
| Original reducible actions | 12 |
| Retained actions | 3 |
| Steps removed | 9 (75%) |
| Total browser replays | 36 |
| Final successful confirmations | 2 |
| Retained IDs | `express`, `coupon`, `checkout` |
| Status | `complete`, `verified: true`, `oneMinimal: true` |

The original/reduced journeys use the ephemeral port from the recorded run; the server is no longer running. Restart with `npm run demo:serve` and pass `--url http://127.0.0.1:4173` to replay, or `REPROCUT_URL=http://127.0.0.1:4173` to the exported test.

The demo is a purpose-built deterministic fixture. It does not establish average reduction, a runtime speedup across applications, root-cause accuracy, or a star-count prediction.

## Reproduce

```bash
npm install
npx playwright install chromium
npm test
npm run check
npm run demo -- --out verification-demo
```

See [GitHub Actions](https://github.com/RealJasonHu/reprocut/actions/workflows/ci.yml) for the current Linux / Node.js 22 and 24 results; the local record above should not be substituted for current CI state.
