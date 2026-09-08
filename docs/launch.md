# Launch kit

These are draft launch materials. Nothing is posted automatically.

## English post

I built ReproCut: a small open-source tool that removes unnecessary steps from a failing browser journey.

You give it a JSON sequence and an explicit failure signature. It replays in fresh Chromium contexts, tries deleting actions, and keeps a shorter sequence only when the same symptom still reproduces. The output includes a runnable Playwright regression test, a repair brief, and an offline HTML evidence report.

In the included checkout fixture, it reduced 12 actions to 3 in 36 real browser runs. The generated regression fails against the buggy fixture and passes against its fixed counterpart. That's a demo, not a cross-application benchmark.

No API key or model required. Early release: Chromium, single-page JSON journeys. I'd especially like feedback from people with long, repetitive browser bug reports.

https://github.com/RealJasonHu/reprocut

## 中文介绍

我做了一个开源工具 ReproCut：自动删掉浏览器 Bug 复现流程里的无关操作。

输入操作步骤和明确的错误特征后，它会用真实 Chromium 反复重放。只有删完后仍然触发同一个错误，才接受缩减。最终导出可运行的 Playwright 回归测试、修复说明和离线 HTML 报告，可以直接交给开发者或 AI 编码助手。

内置结账案例实际从 12 步缩到 3 步，共重放 36 次；导出的测试在有 Bug 时失败，修复后通过。不需要 API Key，也不依赖模型判断。

这是早期版本，目前支持 Chromium 单页面和 JSON 操作流程。欢迎提供已脱敏、可重复运行的真实案例，尤其是那些“我也不知道前面哪些操作有用”的长复现流程。

https://github.com/RealJasonHu/reprocut

## First two weeks

1. Share the real before/after report and the reproducible demo with relevant Playwright/testing communities, following each community's self-promotion rules. Start with one focused post and respond to technical feedback.
2. Seek three outside-user journeys. Record whether install succeeds, whether their original failure reproduces, the action reduction and actual run cost. Report misses as well as successes.
3. Fix the largest adoption obstacle. Manual JSON authoring is the most obvious current friction; validate demand for a recorder or codegen importer before broadening the product.
4. Publish a follow-up release with the issue links and actual case evidence. Avoid mass issue comments, unsolicited outreach, bought stars, or performance claims based only on the bundled fixture.

Track meaningful signals alongside stars: successful first demos, completed external reductions, actionable issues, repeat users and contributions. This plan is a launch hypothesis, not a star-count forecast.
