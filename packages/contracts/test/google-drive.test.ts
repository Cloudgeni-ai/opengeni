import { describe, expect, test } from "bun:test";
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_FULL_SCOPE,
  GOOGLE_DRIVE_CREDENTIAL_LABEL,
  GOOGLE_DRIVE_CREDENTIAL_ROLE,
  GOOGLE_DRIVE_LEGACY_CREDENTIAL_LABEL,
  GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
  GoogleDriveConnectionMetadata,
  GoogleDriveConnectionLifecycle,
  GoogleDriveDisconnectRequest,
  GoogleDriveLifecycleActionRequest,
  SaveGoogleDriveIntegrationSourceRequest,
  SaveGoogleDriveSourceRequest,
  googleDriveOAuthScopeDecision,
  googleDriveScopesAllowCapability,
} from "../src/google-drive";

describe("Google Drive OAuth scope capabilities", () => {
  test("uses truthful labels for new connections while accepting legacy metadata", () => {
    const metadata = {
      credentialRole: GOOGLE_DRIVE_CREDENTIAL_ROLE,
      googlePermissionId: "permission-a",
      googleEmail: "drive@example.com",
      googleDisplayName: "Drive User",
      verifiedAt: "2026-08-10T14:00:00.000Z",
      accessMode: "readonly",
    } as const;

    expect(GOOGLE_DRIVE_CREDENTIAL_LABEL).toBe("Google Drive read-only source sync");
    expect(
      GoogleDriveConnectionMetadata.parse({
        ...metadata,
        credentialLabel: GOOGLE_DRIVE_CREDENTIAL_LABEL,
      }).credentialLabel,
    ).toBe(GOOGLE_DRIVE_CREDENTIAL_LABEL);
    expect(
      GoogleDriveConnectionMetadata.parse({
        ...metadata,
        credentialLabel: GOOGLE_DRIVE_LEGACY_CREDENTIAL_LABEL,
      }).credentialLabel,
    ).toBe(GOOGLE_DRIVE_LEGACY_CREDENTIAL_LABEL);
  });

  test("maps read-only and stronger full-Drive grants to recursive source access", () => {
    for (const scope of [GOOGLE_DRIVE_READONLY_SCOPE, GOOGLE_DRIVE_FULL_SCOPE]) {
      expect(googleDriveOAuthScopeDecision([scope])).toEqual({
        accessMode: "readonly",
        capabilities: [
          "picker_file_read",
          ...(scope === GOOGLE_DRIVE_FULL_SCOPE ? (["publish_file"] as const) : []),
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
      accessMode: "file_only",
      capabilities: ["picker_file_read", "publish_file"],
    });
    expect(
      googleDriveOAuthScopeDecision([
        GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
        GOOGLE_DRIVE_FILE_SCOPE,
      ]),
    ).toEqual({
      accessMode: "metadata_readonly",
      capabilities: ["picker_file_read", "publish_file", "source_metadata_discovery"],
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

describe("Google Drive source selection contracts", () => {
  const source = {
    id: "folder-1",
    name: "Product",
    mimeType: "application/vnd.google-apps.folder",
    driveId: null,
  };
  const request = {
    sources: [source],
    destination: { authorityKind: "workspace" as const, collectionId: null },
    syncCadence: "hourly" as const,
    readPolicy: "allow" as const,
    idempotencyKey: "00000000-0000-4000-8000-000000000000",
  };

  test("requires one to 100 unique sources before provider verification", () => {
    expect(SaveGoogleDriveIntegrationSourceRequest.safeParse(request).success).toBeTrue();
    expect(
      SaveGoogleDriveIntegrationSourceRequest.safeParse({ ...request, sources: [] }).success,
    ).toBeFalse();
    expect(
      SaveGoogleDriveIntegrationSourceRequest.safeParse({
        ...request,
        sources: Array.from({ length: 101 }, (_, index) => ({
          ...source,
          id: `folder-${index}`,
        })),
      }).success,
    ).toBeFalse();
    expect(
      SaveGoogleDriveIntegrationSourceRequest.safeParse({
        ...request,
        sources: [source, source],
      }).success,
    ).toBeFalse();
    expect(
      SaveGoogleDriveSourceRequest.safeParse({
        sources: [],
        targetScope: "workspace",
      }).success,
    ).toBeTrue();
  });
});
