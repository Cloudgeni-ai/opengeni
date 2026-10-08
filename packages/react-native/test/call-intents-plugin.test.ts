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
    expect(source).toContain("internal import OpenGeniCall");
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

const control = require("../plugin/call-control.cjs") as {
  CONTROL_TARGET: string;
  resolveControl(call: Record<string, unknown>, appName?: string): null | Record<string, string>;
  controlSource(
    call: Record<string, unknown>,
    control: Record<string, string>,
    kind: string,
  ): string;
  controlInfoPlist(input: { displayName: string; version: string; buildNumber: string }): string;
  controlBuildSettings(input: {
    bundleIdentifier: string;
    control: Record<string, string>;
    developmentTeam?: string;
    debug: boolean;
  }): Record<string, string>;
};

describe("call control extension", () => {
  test("is opt-in", () => {
    expect(control.resolveControl({}, "Agent")).toBeNull();
    expect(control.resolveControl({ control: false }, "Agent")).toBeNull();
    expect(control.resolveControl({ control: true }, "Agent")?.title).toBe("Call Agent");
  });

  test("generates a control whose button runs the app's call intent", () => {
    const { call } = resolveOptions({ call: { title: "Call the agent" } });
    const options = control.resolveControl({ control: { title: "Ring {app}" } }, "Agent")!;
    const source = control.controlSource(call, options, "com.example.app.call-control");
    expect(source).toContain("struct OpenGeniStartCallIntent: AppIntent");
    expect(source).toContain("static let openAppWhenRun: Bool = true");
    expect(source).toContain('StaticControlConfiguration(kind: "com.example.app.call-control")');
    expect(source).toContain("ControlWidgetButton(action: OpenGeniStartCallIntent())");
    expect(source).toContain('Label("Ring Agent", systemImage: "phone.fill")');
    expect(source).toContain("@main");
    // The extension never links the call module; only the app's copy starts calls.
    expect(source).not.toContain("OpenGeniCall\n");
    expect(source).not.toContain("OpenGeniCallLauncher");
  });

  test("writes a widget extension Info.plist and matching build settings", () => {
    const plist = control.controlInfoPlist({
      displayName: "Call <Agent>",
      version: "1.2.3",
      buildNumber: "7",
    });
    expect(plist).toContain("<string>com.apple.widgetkit-extension</string>");
    expect(plist).toContain("<string>Call &lt;Agent&gt;</string>");
    expect(plist).toContain("<string>1.2.3</string>");
    const options = control.resolveControl({ control: true }, "Agent")!;
    const settings = control.controlBuildSettings({
      bundleIdentifier: "com.example.app",
      control: options,
      developmentTeam: "TEAM123",
      debug: false,
    });
    expect(settings.PRODUCT_BUNDLE_IDENTIFIER).toBe('"com.example.app.CallControl"');
    expect(settings.IPHONEOS_DEPLOYMENT_TARGET).toBe("18.0");
    expect(settings.DEVELOPMENT_TEAM).toBe("TEAM123");
    expect(settings.INFOPLIST_FILE).toContain(control.CONTROL_TARGET);
  });

  test("rejects unusable options", () => {
    expect(() => control.resolveControl({ control: true }, "")).toThrow("no name");
    expect(() => control.resolveControl({ control: { bundleIdSuffix: "a.b" } }, "A")).toThrow(
      "bundleIdSuffix",
    );
    expect(() => control.resolveControl({ control: { deploymentTarget: "17.0" } }, "A")).toThrow(
      "deploymentTarget",
    );
  });
});
