# Contributing

ReproCut is a small browser delta-debugging tool. Contributions should improve reproducibility, integration or inspectability.

## Development

Node.js 22+, npm (or pnpm) and Chromium are required.

```bash
npm install
npx playwright install chromium
npm test
npm run check
npm run demo -- --out my-demo
```

Unit tests exercise reducer budgets, unstable outcomes and input/report validation. Browser tests use local fixtures. The integration test checks the complete reduction and that the exported regression fails on a buggy app and passes on its fixed counterpart. Do not change observed verdicts merely to make a demo appear successful.

## Design invariants

- Keep the failure predicate constant across all candidate trials.
- Never accept missing selectors, setup failures or unrelated timeouts as reproduction.
- Account for every replay in the run budget.
- Preserve action order, fixed setup and honest incomplete/unstable statuses.
- Keep generated tests semantically aligned with the runner.
- Escape user-controlled data in reports; add no remote scripts, analytics or automatic upload.
- Discuss new runtime dependencies and code-execution hooks before implementation.

## Useful next issues

1. Record declarative journeys from a local browser, with a review step for sensitive values.
2. Import the supported subset of Playwright codegen output, rejecting unsupported operations explicitly.
3. Design deterministic test-environment reset hooks without silently executing untrusted journey files.
4. Add fixtures from real applications, with a clear target signature and repeatable setup.

Open an issue with the problem and a compact example before large changes. Small bug fixes with a regression test are welcome directly. Never include real credentials, customer data or private reports.
