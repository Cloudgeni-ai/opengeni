import { describe, expect, test } from "bun:test";
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_FULL_SCOPE,
  GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
  GoogleDriveConnectionLifecycle,
  GoogleDriveDisconnectRequest,
  GoogleDriveLifecycleActionRequest,
  googleDriveOAuthScopeDecision,
  googleDriveScopesAllowCapability,
} from "../src/google-drive";

describe("Google Drive OAuth scope capabilities", () => {
  test("maps read-only and stronger full-Drive grants to recursive source access", () => {
    for (const scope of [GOOGLE_DRIVE_READONLY_SCOPE, GOOGLE_DRIVE_FULL_SCOPE]) {
      expect(googleDriveOAuthScopeDecision([scope])).toEqual({
        accessMode: "readonly",
        capabilities: [
          "picker_file_read",
          "source_metadata_discovery",
          "source_content_read",
          "recursive_source_sync",
        ],
      });
    }
  });

  test("keeps metadata-only and picker-file access narrower than recursive sync", () => {
    expect(googleDriveOAuthScopeDecision([GOOGLE_DRIVE_METADATA_READONLY_SCOPE])).toEqual({
      accessMode: "metadata_readonly",
      capabilities: ["source_metadata_discovery"],
    });
    expect(googleDriveOAuthScopeDecision([GOOGLE_DRIVE_FILE_SCOPE])).toEqual({
      accessMode: null,
      capabilities: ["picker_file_read"],
    });
    expect(
      googleDriveOAuthScopeDecision([
        GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
        GOOGLE_DRIVE_FILE_SCOPE,
      ]),
    ).toEqual({
      accessMode: "metadata_readonly",
      capabilities: ["picker_file_read", "source_metadata_discovery"],
    });
  });

  test("fails closed for partial, unrelated, and malformed grants", () => {
    for (const scopes of [
      [],
      ["openid", "email"],
      [` ${GOOGLE_DRIVE_READONLY_SCOPE}`],
      [`${GOOGLE_DRIVE_READONLY_SCOPE} `],
      [GOOGLE_DRIVE_FILE_SCOPE, "https://www.googleapis.com/auth/drive.meet.readonly"],
    ]) {
      expect(googleDriveScopesAllowCapability(scopes, "recursive_source_sync")).toBeFalse();
    }
  });

  test("is deterministic for duplicate grants and ignores unrelated incremental scopes", () => {
    expect(
      googleDriveOAuthScopeDecision([
        GOOGLE_DRIVE_READONLY_SCOPE,
        "openid",
        GOOGLE_DRIVE_READONLY_SCOPE,
        "email",
      ]),
    ).toEqual(googleDriveOAuthScopeDecision([GOOGLE_DRIVE_READONLY_SCOPE]));
  });

  test("keeps lifecycle state bounded and transition requests version-fenced", () => {
    expect(
      GoogleDriveConnectionLifecycle.parse({
        state: "token_revoked",
        recoverable: true,
        observedAt: "2026-08-03T10:00:00.000Z",
      }),
    ).toEqual({
      state: "token_revoked",
      recoverable: true,
      observedAt: "2026-08-03T10:00:00.000Z",
    });
    expect(
      GoogleDriveLifecycleActionRequest.parse({ action: "pause", expectedVersion: 7 }),
    ).toEqual({ action: "pause", expectedVersion: 7 });
    expect(() =>
      GoogleDriveLifecycleActionRequest.parse({ action: "resume", expectedVersion: 0 }),
    ).toThrow();
    expect(
      GoogleDriveDisconnectRequest.parse({
        expectedVersion: 7,
        idempotencyKey: "  disconnect-generation-7  ",
      }),
    ).toEqual({ expectedVersion: 7, idempotencyKey: "disconnect-generation-7" });
    expect(() =>
      GoogleDriveDisconnectRequest.parse({ expectedVersion: 0, idempotencyKey: "disconnect" }),
    ).toThrow();
    expect(() =>
      GoogleDriveDisconnectRequest.parse({ expectedVersion: 7, idempotencyKey: "" }),
    ).toThrow();
    expect(() =>
      GoogleDriveConnectionLifecycle.parse({
        state: "provider_error_body",
        recoverable: true,
        observedAt: "2026-08-03T10:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      GoogleDriveConnectionLifecycle.parse({
        state: "app_removed",
        recoverable: true,
        observedAt: "2026-08-03T10:00:00.000Z",
      }),
    ).toThrow();
    expect(
      GoogleDriveConnectionLifecycle.parse({
        state: "disconnected",
        recoverable: true,
        observedAt: "2026-08-03T10:00:00.000Z",
      }),
    ).toMatchObject({ state: "disconnected", recoverable: true });
  });
});
