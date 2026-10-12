import { describe, expect, test } from "bun:test";
import {
  detectConnectPlatform,
  deviceVerificationUri,
  installOneLiner,
  installOneLinerWindows,
} from "./deployment";

describe("Connected Machine deployment URLs", () => {
  test("builds an additive token connect command pinned to this deployment", () => {
    const command = installOneLiner("https://one.opengeni.example/", {
      enrollToken: "oget_example",
    });

    expect(command).toBe(
      "curl -fsSL https://one.opengeni.example/install.sh | " +
        "OPENGENI_API_URL=https://one.opengeni.example " +
        "OPENGENI_ENROLL_TOKEN=oget_example sh",
    );
    expect(command).not.toContain("--force");
  });

  test("pins interactive setup and approval to the selected deployment", () => {
    expect(
      installOneLiner("https://two.opengeni.example///", { workspaceId: "workspace-2" }),
    ).toContain(
      "OPENGENI_API_URL=https://two.opengeni.example OPENGENI_WORKSPACE_ID=workspace-2 sh",
    );
    expect(deviceVerificationUri("https://two.opengeni.example/")).toBe(
      "https://two.opengeni.example/device",
    );
  });

  test("builds the PowerShell connect command with quoted values", () => {
    expect(
      installOneLinerWindows("https://app.example.test/", { enrollToken: "oget_abc.sig" }),
    ).toBe(
      "$env:OPENGENI_API_URL='https://app.example.test'; $env:OPENGENI_ENROLL_TOKEN='oget_abc.sig'; irm 'https://app.example.test/install.ps1' | iex",
    );
    expect(installOneLinerWindows("https://o'brien.example", { workspaceId: "ws" })).toContain(
      "$env:OPENGENI_API_URL='https://o''brien.example'",
    );
  });

  test("defaults Windows browsers to the PowerShell command", () => {
    expect(detectConnectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectConnectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)")).toBe("unix");
    expect(detectConnectPlatform(undefined)).toBe("unix");
  });
});
