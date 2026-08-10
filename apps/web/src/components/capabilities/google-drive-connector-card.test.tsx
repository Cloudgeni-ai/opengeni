import { describe, expect, test } from "bun:test";

import {
  configuredGoogleDriveSources,
  googleDriveDestinationOptionDisabled,
  googleDriveReadPolicyLabel,
} from "./google-drive-connector-card";

describe("Google Drive connector document destination UI", () => {
  test("disables destinations the actor cannot administer", () => {
    expect(googleDriveDestinationOptionDisabled("personal", false, false)).toBe(false);
    expect(googleDriveDestinationOptionDisabled("workspace", false, true)).toBe(true);
    expect(googleDriveDestinationOptionDisabled("workspace", true, false)).toBe(false);
    expect(googleDriveDestinationOptionDisabled("organization", true, false)).toBe(true);
    expect(googleDriveDestinationOptionDisabled("organization", false, true)).toBe(false);
  });

  test("projects legacy connector config as workspace authority instead of widening it", () => {
    expect(
      configuredGoogleDriveSources({
        credentialRole: "google_drive_metadata",
        credentialLabel: "Google Drive metadata browser",
        googlePermissionId: "permission",
        googleEmail: "owner@example.com",
        googleDisplayName: null,
        verifiedAt: "2026-08-04T00:00:00.000Z",
        accessMode: "readonly",
        selectedSources: [
          {
            id: "root",
            name: "My Drive",
            mimeType: "application/vnd.google-apps.folder",
            driveId: null,
            targetScope: "organization",
            syncCadence: "hourly",
            syncEnabled: false,
            configGeneration: 1,
            readPolicy: "allow",
            selectedAt: "2026-08-04T00:00:00.000Z",
          },
        ],
      })[0]?.authorityKind,
    ).toBe("workspace");
  });

  test("scopes read policy wording to interactive connector actions", () => {
    expect(googleDriveReadPolicyLabel("allow")).toBe("Actions allowed");
    expect(googleDriveReadPolicyLabel("ask")).toBe("Ask for actions");
    expect(googleDriveReadPolicyLabel("block")).toBe("Actions blocked");
  });
});
