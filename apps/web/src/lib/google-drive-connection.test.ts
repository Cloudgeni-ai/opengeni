import { describe, expect, test } from "bun:test";

import type { ConnectionMetadata, GoogleDriveConnectionMetadata } from "@/types";
import {
  googleDriveAccountState,
  googleDriveConnections,
  preferredGoogleDriveConnection,
} from "./google-drive-connection";

function connection(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  const metadata: GoogleDriveConnectionMetadata = {
    credentialRole: "google_drive_metadata",
    credentialLabel: "Google Drive metadata browser",
    googlePermissionId: "permission-a",
    googleEmail: "drive@example.com",
    googleDisplayName: "Drive User",
    verifiedAt: "2026-08-03T10:00:00.000Z",
    accessMode: "readonly",
    lifecycle: {
      state: "active",
      recoverable: true,
      observedAt: "2026-08-03T10:00:00.000Z",
    },
  };
  return {
    id: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    subjectId: "subject-a",
    providerDomain: "googleapis.com",
    kind: "oauth2",
    status: "active",
    grantedScopes: ["https://www.googleapis.com/auth/drive.readonly"],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata,
    createdBySubjectId: "subject-a",
    updatedBySubjectId: "subject-a",
    createdAt: "2026-08-03T09:00:00.000Z",
    updatedAt: "2026-08-03T10:00:00.000Z",
    ...overrides,
  };
}

function lifecycle(
  state: NonNullable<GoogleDriveConnectionMetadata["lifecycle"]>["state"],
): GoogleDriveConnectionMetadata {
  return {
    ...(connection().metadata as GoogleDriveConnectionMetadata),
    lifecycle:
      state === "app_removed"
        ? { state, recoverable: false, observedAt: "2026-08-03T10:01:00.000Z" }
        : { state, recoverable: true, observedAt: "2026-08-03T10:01:00.000Z" },
  };
}

describe("Google Drive connection lifecycle projection", () => {
  test("selects only the current subject-owned Drive connection and retains disconnected truth", () => {
    const disconnected = connection({
      id: "44444444-4444-4444-8444-444444444444",
      status: "revoked",
      updatedAt: "2026-08-03T10:02:00.000Z",
    });
    const active = connection();
    const workspaceOwned = connection({ id: crypto.randomUUID(), subjectId: null });
    const otherProvider = connection({ id: crypto.randomUUID(), providerDomain: "example.com" });
    expect(googleDriveConnections([workspaceOwned, otherProvider, disconnected, active])).toEqual([
      disconnected,
      active,
    ]);
    expect(preferredGoogleDriveConnection([disconnected, active])?.id).toBe(active.id);
    expect(preferredGoogleDriveConnection([disconnected])?.id).toBe(disconnected.id);
  });

  test("projects paused, revoked-token, app-removed, reconnect, re-consent, and disconnected states", () => {
    expect(googleDriveAccountState(null, false)).toEqual({ state: "unverified" });
    expect(googleDriveAccountState(null, true)).toEqual({ state: "not_connected" });
    expect(googleDriveAccountState(connection(), true)).toMatchObject({ state: "connected" });
    expect(
      googleDriveAccountState(connection({ metadata: lifecycle("paused") }), true),
    ).toMatchObject({ state: "paused", recoverable: true });
    expect(
      googleDriveAccountState(
        connection({ status: "needs_reauth", metadata: lifecycle("token_revoked") }),
        true,
      ),
    ).toMatchObject({ state: "token_revoked", recoverable: true });
    expect(
      googleDriveAccountState(
        connection({ status: "error", metadata: lifecycle("app_removed") }),
        true,
      ),
    ).toMatchObject({ state: "app_removed", recoverable: false });
    expect(
      googleDriveAccountState(connection({ status: "needs_reauth", lastError: "raw body" }), true),
    ).toMatchObject({ state: "reconnect_required", recoverable: true });
    expect(
      googleDriveAccountState(
        connection({ status: "needs_reauth", metadata: lifecycle("reconsent_required") }),
        true,
      ),
    ).toMatchObject({ state: "reconsent_required", recoverable: true });
    expect(googleDriveAccountState(connection({ status: "revoked" }), true)).toMatchObject({
      state: "disconnected",
      recoverable: true,
    });
    expect(
      googleDriveAccountState(connection({ metadata: lifecycle("disconnected") }), true),
    ).toMatchObject({ state: "disconnected", recoverable: true });
  });

  test("legacy metadata-only grants require re-consent without reading lastError", () => {
    const metadata = {
      ...(connection().metadata as GoogleDriveConnectionMetadata),
      accessMode: "metadata_readonly" as const,
      lifecycle: undefined,
    };
    expect(
      googleDriveAccountState(
        connection({ metadata, lastError: "provider body must not render" }),
        true,
      ),
    ).toMatchObject({ state: "reconsent_required" });
  });
});
