import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { sandboxEnvironmentSettingsForRoute } from "../src/activities/agent-turn/run-credentials";

describe("machine-home managed-group settings", () => {
  test("uses the managed provider for fallback manifests and preserves machine-primary settings", () => {
    const machineHome = testSettings({ sandboxBackend: "selfhosted" });

    const managed = sandboxEnvironmentSettingsForRoute({
      runSettings: machineHome,
      machinePrimary: false,
      groupBoxBackend: "modal",
    });
    expect(managed).not.toBe(machineHome);
    expect(managed.sandboxBackend).toBe("modal");

    expect(
      sandboxEnvironmentSettingsForRoute({
        runSettings: machineHome,
        machinePrimary: true,
        groupBoxBackend: "selfhosted",
      }),
    ).toBe(machineHome);

    const modalHome = testSettings({ sandboxBackend: "modal" });
    expect(
      sandboxEnvironmentSettingsForRoute({
        runSettings: modalHome,
        machinePrimary: false,
        groupBoxBackend: "modal",
      }),
    ).toBe(modalHome);
  });
});
