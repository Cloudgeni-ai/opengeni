import { describe, expect, test } from "bun:test";

import {
  configuredGoogleDriveKnowledgeSources,
  googleDriveDestinationOptionDisabled,
} from "./google-drive-knowledge-source-dialog";

const noPermissions = {
  canManagePersonalDestination: false,
  canManageWorkspaceDestination: false,
  canManageOrganizationDestination: false,
};

describe("Google Drive named-instance knowledge source UI", () => {
  test("disables every destination the exact actor cannot administer", () => {
    expect(
      googleDriveDestinationOptionDisabled("personal", {
        ...noPermissions,
        canManagePersonalDestination: true,
      }),
    ).toBe(false);
    expect(
      googleDriveDestinationOptionDisabled("workspace", {
        ...noPermissions,
        canManageWorkspaceDestination: true,
      }),
    ).toBe(false);
    expect(
      googleDriveDestinationOptionDisabled("organization", {
        ...noPermissions,
        canManageOrganizationDestination: true,
      }),
    ).toBe(false);
    expect(googleDriveDestinationOptionDisabled("personal", noPermissions)).toBe(true);
    expect(googleDriveDestinationOptionDisabled("workspace", noPermissions)).toBe(true);
    expect(googleDriveDestinationOptionDisabled("organization", noPermissions)).toBe(true);
  });

  test("projects only valid binding-owned source configuration into browser selections", () => {
    expect(
      configuredGoogleDriveKnowledgeSources({
        sources: [
          {
            id: "root",
            name: "My Drive",
            mimeType: "application/vnd.google-apps.folder",
            sourceKind: "my_drive",
            includeDescendants: true,
          },
          {
            id: "shared-drive-a",
            name: "Finance",
            mimeType: "application/vnd.google-apps.folder",
            driveId: "shared-drive-a",
            sourceKind: "shared_drive",
            includeDescendants: true,
          },
        ],
        destination: {
          authorityKind: "workspace",
          authorityAccountId: "account-a",
          authorityWorkspaceId: "workspace-a",
        },
        syncCadence: "hourly",
        readPolicy: "allow",
      }),
    ).toEqual([
      {
        id: "root",
        name: "My Drive",
        mimeType: "application/vnd.google-apps.folder",
        kind: "folder",
        driveId: null,
        modifiedTime: null,
        size: null,
        webViewLink: null,
      },
      {
        id: "shared-drive-a",
        name: "Finance",
        mimeType: "application/vnd.google-apps.folder",
        kind: "folder",
        driveId: "shared-drive-a",
        modifiedTime: null,
        size: null,
        webViewLink: null,
      },
    ]);

    expect(
      configuredGoogleDriveKnowledgeSources({
        sources: [{ id: "root" }],
        destination: { authorityKind: "workspace", authorityAccountId: "account-a" },
        syncCadence: "hourly",
        readPolicy: "allow",
      }),
    ).toEqual([]);
  });
});
