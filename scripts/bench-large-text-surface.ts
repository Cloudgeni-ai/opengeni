#!/usr/bin/env bun
import { chromium } from "playwright";

const samples = integerArgument("--samples", 5);
const cpuThrottleRate = integerArgument("--cpu-throttle", 4);
const text = buildMaxSetup();
const cases = [
  "pre",
  "pre-contained",
  "textarea-readonly-wrap-off",
  "textarea-readonly-wrap-soft",
  "textarea-editable-wrap-off",
] as const;

const browser = await chromium.launch();
try {
  const receipts = [];
  for (const kind of cases) {
    for (let sample = 0; sample < samples; sample += 1) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addInitScript(() => {
        const longTasks: number[] = [];
        (window as unknown as { __largeTextLongTasks: number[] }).__largeTextLongTasks = longTasks;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        }).observe({ type: "longtask", buffered: true });
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottleRate });
      await page.goto("about:blank");
      const result = await page.evaluate(
        async ({ surface, value }) => {
          const startedAt = performance.now();
          const element = surface.startsWith("textarea")
            ? document.createElement("textarea")
            : document.createElement("pre");
          element.dataset.surface = surface;
          element.style.cssText =
            "display:block;box-sizing:border-box;width:374px;height:384px;overflow:auto;font:12px/16px monospace";
          if (element instanceof HTMLTextAreaElement) {
            element.readOnly = surface.includes("readonly");
            element.wrap = surface.includes("wrap-off") ? "off" : "soft";
            element.value = value;
          } else {
            if (surface === "pre-contained") element.style.contain = "strict";
            element.textContent = value;
          }
          document.body.append(element);
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          const readyMs = performance.now() - startedAt;
          const exact =
            element instanceof HTMLTextAreaElement
              ? element.value === value
              : element.textContent === value;
          const longTasks =
            (window as unknown as { __largeTextLongTasks?: number[] }).__largeTextLongTasks ?? [];
          return {
            readyMs,
            exact,
            scrollHeight: element.scrollHeight,
            scrollWidth: element.scrollWidth,
            longTaskTotalMs: longTasks.reduce((sum, duration) => sum + duration, 0),
            longTaskMaxMs: Math.max(0, ...longTasks),
          };
        },
        { surface: kind, value: text },
      );
      if (!result.exact) throw new Error(`${kind} lost source text`);
      receipts.push({ kind, sample, ...result });
      await cdp.detach();
      await context.close();
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        setupScriptCharacters: text.length,
        setupScriptUtf8Bytes: Buffer.byteLength(text, "utf8"),
        cpuThrottleRate,
        samples,
        summaries: cases.map((kind) => {
          const group = receipts.filter((receipt) => receipt.kind === kind);
          return {
            kind,
            readyMs: distribution(group.map((receipt) => receipt.readyMs)),
            longTaskTotalMs: distribution(group.map((receipt) => receipt.longTaskTotalMs)),
            longTaskMaxMs: distribution(group.map((receipt) => receipt.longTaskMaxMs)),
            scrollHeight: group[0]!.scrollHeight,
            scrollWidth: group[0]!.scrollWidth,
            contentParity: group.every((receipt) => receipt.exact) ? "pass" : "fail",
          };
        }),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser.close();
}

function buildMaxSetup(): string {
  let state = 0x5eed1234;
  const characters = ["#"];
  for (let index = 1; index < 131_072; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    characters.push(String.fromCharCode(0x4e00 + (state % 20_000)));
  }
  return characters.join("");
}

function distribution(values: readonly number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)]!;
  return {
    min: ordered[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: ordered.at(-1)!,
  };
}

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number.parseInt(process.argv[index + 1] ?? "", 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}
