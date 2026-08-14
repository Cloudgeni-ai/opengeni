import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { testSettings } from "@opengeni/testing";
import { buildGoogleDriveReleaseReadiness } from "./google-drive-release-readiness";

describe("Google Drive release readiness", () => {
  test("reports a secret-safe ready contract without provider calls", () => {
    const result = buildGoogleDriveReleaseReadiness(
      testSettings({
        environment: "production",
        integrationsEnabled: true,
        publicBaseUrl: "https://opengeni.example.com",
        integrationsStateSecret: "state-secret-must-not-print",
        environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
        googleDriveClientId: "client-id-must-not-print.apps.googleusercontent.com",
        googleDriveClientSecret: "client-secret-must-not-print",
        observabilityStructuredLogs: true,
        observabilityMetricsEnabled: true,
      }),
    );

    expect(result.status).toBe("ready");
    expect(result.providerCallsPerformed).toBe(false);
    expect(result.runtime.callbackUrl).toBe(
      "https://opengeni.example.com/v1/integrations/google-drive/callback",
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("state-secret-must-not-print");
    expect(serialized).not.toContain("client-id-must-not-print");
    expect(serialized).not.toContain("client-secret-must-not-print");
    expect(result.pendingApprovalGates).toContain(
      "merged declared Drive source-security dependency",
    );
  });

  test("blocks disabled observability and missing release credentials", () => {
    const result = buildGoogleDriveReleaseReadiness(
      testSettings({
        integrationsEnabled: false,
        googleDriveClientId: undefined,
        googleDriveClientSecret: undefined,
        integrationsStateSecret: undefined,
        environmentsEncryptionKey: undefined,
        publicBaseUrl: undefined,
        observabilityStructuredLogs: false,
        observabilityMetricsEnabled: false,
      }),
    );
    expect(result.status).toBe("blocked");
    expect(result.checks.filter((candidate) => candidate.status === "block")).toHaveLength(7);
  });

  test("does not reflect malformed callback URL secrets into readiness evidence", () => {
    const sentinel = "drive-url-secret-must-not-print";
    const result = buildGoogleDriveReleaseReadiness(
      testSettings({
        integrationsEnabled: true,
        publicBaseUrl: `https://user:${sentinel}@opengeni.example.com/path?token=${sentinel}#${sentinel}`,
        integrationsStateSecret: "state-secret",
        environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
        googleDriveClientId: "client.apps.googleusercontent.com",
        googleDriveClientSecret: "client-secret",
        observabilityStructuredLogs: true,
        observabilityMetricsEnabled: true,
      }),
    );

    expect(result.status).toBe("blocked");
    expect(result.runtime.callbackUrl).toBeNull();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  test("CLI emits only bounded invalid-configuration evidence", () => {
    const sentinel = "drive-secret-sentinel-must-not-print";
    const result = spawnSync("bun", ["scripts/google-drive-release-readiness.ts"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        OPENGENI_GOOGLE_DRIVE_CLIENT_ID: sentinel,
      },
    });
    expect(result.status).toBe(3);
    expect(result.stdout).not.toContain(sentinel);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "blocked",
      providerCallsPerformed: false,
      checks: [{ id: "configuration_parse", status: "block" }],
    });
  });
});
