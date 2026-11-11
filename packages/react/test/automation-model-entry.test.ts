import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  automationAgentOpeningMessage,
  automationNextRun,
  automationWhenWords,
  sortAutomations,
} from "../src/automation-model";
import { createOpenGeniText } from "../src/messages/runtime";

const packageRoot = join(import.meta.dir, "..");

function importSpecifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:import|export)\b[^;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveRelative(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      // Try the next supported source form.
    }
  }
  return null;
}

describe("automation-model entry", () => {
  // React Native hosts (the phone app's Automations screens) import it, so it
  // must not reach the DOM components or their icon and menu libraries. The
  // message catalog's provider is the only React it reaches.
  test("reaches only pure local source, the SDK and contracts leaves", () => {
    const visited = new Set<string>();
    const thirdParty = new Set<string>();
    const queue = [join(packageRoot, "src/automation-model.ts")];
    while (queue.length > 0) {
      const file = queue.pop();
      if (!file || visited.has(file)) continue;
      visited.add(file);
      for (const specifier of importSpecifiersOf(readFileSync(file, "utf8"))) {
        const local = resolveRelative(specifier, file);
        if (local) queue.push(local);
        else thirdParty.add(specifier);
      }
    }
    expect(
      [...visited]
        .filter((file) => file.endsWith(".tsx"))
        .map((file) => file.slice(packageRoot.length + 1)),
    ).toEqual(["src/messages/runtime.tsx"]);
    expect([...thirdParty].sort()).toEqual([
      "@opengeni/contracts/claude-subscription-model-ids",
      "@opengeni/contracts/event-triggers",
      "@opengeni/contracts/session-history",
      "@opengeni/sdk",
      "@opengeni/sdk/model-display",
      "@opengeni/sdk/model-picker-order",
      "react",
    ]);
  });

  test("reads automations the way the web pages do", () => {
    const t = createOpenGeniText();
    const now = new Date("2026-11-09T07:00:00Z");
    const daily = {
      name: "Morning digest",
      status: "active" as const,
      schedule: { type: "calendar" as const, timeZone: "Europe/Oslo", hour: 9, minute: 0 },
    };
    const paused = { ...daily, name: "A paused one", status: "paused" as const };
    expect(automationWhenWords(t, daily, [], now)).toBe("Every day at 09:00 · Oslo");
    expect(automationNextRun(daily, now)?.toISOString()).toBe("2026-11-09T08:00:00.000Z");
    expect(sortAutomations([paused, daily], now).map((task) => task.name)).toEqual([
      "Morning digest",
      "A paused one",
    ]);
    expect(automationAgentOpeningMessage("  Every Monday, sum up last week. ", "Europe/Oslo")).toBe(
      "Help me create an automation in this workspace.\n\nEvery Monday, sum up last week.\n\nMy time zone is Europe/Oslo.",
    );
  });
});
