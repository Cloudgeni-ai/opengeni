import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { buildGoogleDriveReleaseReadiness } from "./google-drive-release-readiness";

describe("Google Drive native release readiness retirement", () => {
  test("never claims local configuration proves MCP or OAuth readiness", () => {
    expect(buildGoogleDriveReleaseReadiness()).toMatchObject({
      schema: "opengeni.google-drive-release-readiness.v2",
      status: "blocked",
      nativeConnectorStatus: "retired",
      providerCallsPerformed: false,
      oauthVerificationStatus: "not_checked",
      checks: [{ id: "native_drive_retired", status: "block" }],
      operatorGuide: "docs/google-drive.md",
    });
  });

  test("CLI stays blocked with old credentials and new setup gates enabled", () => {
    const sentinel = "drive-secret-sentinel-must-not-print";
    const result = spawnSync("bun", ["scripts/google-drive-release-readiness.ts"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        OPENGENI_INTEGRATIONS_ENABLED: "true",
        OPENGENI_GOOGLE_CONNECTOR_SETUP_ENABLED: "true",
        OPENGENI_GOOGLE_DRIVE_MCP_ENABLED: "true",
        OPENGENI_GOOGLE_DRIVE_CLIENT_ID: sentinel,
        OPENGENI_GOOGLE_DRIVE_CLIENT_SECRET: sentinel,
        OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON: JSON.stringify({
          "https://accounts.google.com": { clientId: sentinel, clientSecret: sentinel },
        }),
        OPENGENI_PUBLIC_BASE_URL: `https://user:${sentinel}@example.com/?token=${sentinel}`,
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(sentinel);
    expect(JSON.parse(result.stdout)).toEqual(buildGoogleDriveReleaseReadiness());
  });

  test("CLI requires no runtime configuration to report retirement", () => {
    const result = spawnSync("bun", ["scripts/google-drive-release-readiness.ts"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(buildGoogleDriveReleaseReadiness());
  });
});
