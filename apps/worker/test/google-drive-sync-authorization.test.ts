import { describe, expect, test } from "bun:test";
import {
  GOOGLE_DRIVE_FULL_SCOPE,
  GOOGLE_DRIVE_METADATA_READONLY_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
} from "@opengeni/contracts/google-drive";

import { googleDriveSyncProviderAccessAllowed } from "../src/activities/knowledge-source-sync";

describe("Google Drive worker provider authorization", () => {
  const allowed = (
    overrides: Partial<Parameters<typeof googleDriveSyncProviderAccessAllowed>[0]>,
  ) =>
    googleDriveSyncProviderAccessAllowed({
      connectionVersion: 4,
      resolvedConnectionVersion: 4,
      connectionStatus: "active",
      lifecycleState: "active",
      grantedScopes: [GOOGLE_DRIVE_READONLY_SCOPE],
      ...overrides,
    });

  test("accepts exact active generations with recursive-read capability", () => {
    expect(allowed({})).toBe(true);
    expect(allowed({ grantedScopes: ["openid", GOOGLE_DRIVE_FULL_SCOPE] })).toBe(true);
  });

  test("rejects refreshed scope downgrades and stale connection generations", () => {
    expect(allowed({ grantedScopes: [GOOGLE_DRIVE_METADATA_READONLY_SCOPE] })).toBe(false);
    expect(allowed({ resolvedConnectionVersion: undefined })).toBe(false);
    expect(allowed({ resolvedConnectionVersion: 5 })).toBe(false);
    expect(allowed({ connectionStatus: "needs_reauth" })).toBe(false);
    expect(allowed({ lifecycleState: "reconsent_required" })).toBe(false);
  });
});
