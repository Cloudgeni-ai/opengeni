import { describe, expect, test } from "bun:test";

import { englishMessages } from "../src/messages/en";
import { createOpenGeniText } from "../src/messages/runtime";
import { SINGLE_SEND_WORDING, singleSendText } from "../src/messages/single-send";

const catalog = englishMessages as Record<string, string>;
const PLURAL = /_(zero|one|two|few|many|other)$/;

function variants(key: string): string[] {
  return Object.keys(catalog).filter(
    (candidate) => candidate === key || candidate.replace(PLURAL, "") === key,
  );
}

function params(key: string): string[] {
  const names = new Set<string>();
  for (const variant of variants(key)) {
    for (const match of catalog[variant]!.matchAll(/\{(\w+)\}/g)) names.add(match[1]!);
  }
  return [...names].sort();
}

describe("single-Send wording", () => {
  const entries = Object.entries(SINGLE_SEND_WORDING) as Array<[string, string]>;

  test("swaps each phrase for an existing one with the same parameters", () => {
    for (const [source, target] of entries) {
      expect({ source, found: variants(source).length > 0 }).toEqual({ source, found: true });
      expect({ target, found: variants(target).length > 0 }).toEqual({ target, found: true });
      expect({ source, params: params(target) }).toEqual({ source, params: params(source) });
    }
  });

  test("never names the queue or Steer, and applying it twice changes nothing", () => {
    const sources = new Set(entries.map(([source]) => source));
    for (const [, target] of entries) {
      expect(sources.has(target)).toBe(false);
      for (const variant of variants(target)) {
        expect({
          variant,
          named: /queue|steer/i.test(catalog[variant]!.replace(/\{\w+\}/g, "")),
        }).toEqual({
          variant,
          named: false,
        });
      }
    }
    const t = createOpenGeniText();
    const once = singleSendText(t);
    const twice = singleSendText(once);
    expect(twice("sessionChrome.queuedPromptCount", { count: 2 })).toBe("2 waiting messages");
    expect(once("composerMessages.addMessageToQueue")).toBe("Send message");
    expect(once("composerMessages.sendMessage")).toBe(t("composerMessages.sendMessage"));
  });
});
