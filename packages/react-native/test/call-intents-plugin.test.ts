import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { intentsSource, resolveOptions } = require("../plugin/call-intents.cjs") as {
  intentsSource(call: Record<string, unknown>): string;
  resolveOptions(props?: Record<string, unknown>): {
    call: Record<string, unknown> & { phrases: string[] };
    alternativeAppNames: string[];
    appIntents: boolean;
  };
};

describe("native call config plugin", () => {
  test("generates an App Intent and App Shortcut phrases with the app-name interpolation", () => {
    const { call } = resolveOptions({
      call: { title: "Call the agent", phrases: ["Call {app}", 'Ring "{app}" now'] },
    });
    const source = intentsSource(call);
    expect(source).toContain('static let title: LocalizedStringResource = "Call the agent"');
    expect(source).toContain('"Call \\(.applicationName)"');
    expect(source).toContain('"Ring \\"\\(.applicationName)\\" now"');
    expect(source).toContain("OpenGeniCallLauncher.requestStart()");
    expect(source).toContain("struct OpenGeniCallShortcuts: AppShortcutsProvider");
  });

  test("defaults apply without options", () => {
    const options = resolveOptions();
    expect(options.call.phrases.length).toBeGreaterThan(0);
    expect(options.alternativeAppNames).toEqual([]);
    expect(options.appIntents).toBe(true);
  });

  test("keeps Siri synonyms and can skip the generated intent", () => {
    const options = resolveOptions({
      call: { alternativeAppNames: ["Assistant"], appIntents: false },
    });
    expect(options.alternativeAppNames).toEqual(["Assistant"]);
    expect(options.appIntents).toBe(false);
  });

  test("rejects phrases without exactly one app name", () => {
    expect(() => resolveOptions({ call: { phrases: ["Call the agent"] } })).toThrow("{app}");
    expect(() => resolveOptions({ call: { phrases: ["{app} calls {app}"] } })).toThrow("{app}");
    expect(() => resolveOptions({ call: { phrases: [] } })).toThrow("phrases");
  });
});
