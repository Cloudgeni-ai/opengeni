import { describe, expect, test } from "bun:test";

import {
  GOOGLE_DRIVE_ACCESS_DISCLOSURE,
  GOOGLE_DRIVE_APP_DESCRIPTION,
  GOOGLE_DRIVE_PUBLISHING_DISCLOSURE,
  GOOGLE_DRIVE_SYNC_BEHAVIOR,
} from "@/lib/google-drive-connection";

import {
  configuredGoogleDriveSources,
  googleDriveDestinationOptionDisabled,
  googleDriveReadPolicyLabel,
} from "./google-drive-connector-card";

describe("Google Drive connector truthfulness copy", () => {
  test("describes the shipped read-only browser without claiming Drive writes", () => {
    expect(GOOGLE_DRIVE_APP_DESCRIPTION).toContain("read-only");
    expect(GOOGLE_DRIVE_APP_DESCRIPTION).toContain("Shared Drives");
    expect(GOOGLE_DRIVE_APP_DESCRIPTION).not.toMatch(/create|edit|delete|write/i);

    expect(GOOGLE_DRIVE_ACCESS_DISCLOSURE).toContain("only after you enable synchronization");
    expect(GOOGLE_DRIVE_ACCESS_DISCLOSURE).toContain("boundaries you select");
    expect(GOOGLE_DRIVE_ACCESS_DISCLOSURE).toContain("tokens stay encrypted on the server");
    expect(GOOGLE_DRIVE_ACCESS_DISCLOSURE).toContain("cannot create, edit, or delete");
    expect(GOOGLE_DRIVE_ACCESS_DISCLOSURE).toContain("separate publishing consent");
    expect(GOOGLE_DRIVE_PUBLISHING_DISCLOSURE).toContain("drive.file");
    expect(GOOGLE_DRIVE_PUBLISHING_DISCLOSURE).toContain("ask before writing by default");
    expect(GOOGLE_DRIVE_PUBLISHING_DISCLOSURE).toContain("does not widen source-sync boundaries");
  });

  test("describes scheduled repair scans instead of a Changes-only flow", () => {
    expect(GOOGLE_DRIVE_SYNC_BEHAVIOR).toContain("rescan");
    expect(GOOGLE_DRIVE_SYNC_BEHAVIOR).toContain("skip unchanged revisions");
    expect(GOOGLE_DRIVE_SYNC_BEHAVIOR).toContain("Changes API eventing is not enabled");
    expect(GOOGLE_DRIVE_SYNC_BEHAVIOR).not.toContain("changes only");
  });
});

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
        credentialLabel: "Google Drive read-only source sync",
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
