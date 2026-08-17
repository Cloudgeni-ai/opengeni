import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { Sheet } from "@/components/ui/sheet";
import {
  GOOGLE_DRIVE_ACCESS_DISCLOSURE,
  GOOGLE_DRIVE_APP_DESCRIPTION,
  GOOGLE_DRIVE_PUBLISHING_DISCLOSURE,
  GOOGLE_DRIVE_SYNC_BEHAVIOR,
  localConnectedGoogleDrivePreview,
} from "@/lib/google-drive-connection";
import type { AccessContext, ConnectionMetadata } from "@/types";

import { IntegrationSheetBody, integrationDisclosureElementId } from "./integration-sheet";
import {
  configuredGoogleDriveSources,
  googleDriveDestinationOptionDisabled,
  googleDriveReadPolicyLabel,
} from "./google-drive-sources";

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";

const mutableContext: { current: Record<string, unknown> } = { current: {} };
mock.module("@/context", () => ({
  useAppContext: () => mutableContext.current,
}));
const requestMock = mock(async (..._args: unknown[]): Promise<unknown> => {
  throw new Error("unexpected API request in test");
});
mock.module("@/api", () => ({ request: requestMock }));

const { useGoogleDriveIntegration } = await import("./use-google-drive-integration");

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

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

function accessContext(permissions: string[]): AccessContext {
  return {
    mode: "managed",
    subjectId: "subject-a",
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId: WORKSPACE_ID,
        accountId: "account-a",
        subjectId: "subject-a",
        permissions,
      },
    ],
    defaultAccountId: "account-a",
    defaultWorkspaceId: WORKSPACE_ID,
  } as unknown as AccessContext;
}

function connectedDriveFixture(): ConnectionMetadata {
  return localConnectedGoogleDrivePreview("?previewGoogleDrive=connected", WORKSPACE_ID, true)!;
}

async function renderDriveSheet(connections: ConnectionMetadata[]) {
  mutableContext.current = {
    client: {},
    accessContext: accessContext(["connections:read", "connections:write"]),
  };
  let captured: ReturnType<typeof useGoogleDriveIntegration> | null = null;
  function Probe() {
    captured = useGoogleDriveIntegration({
      workspaceId: WORKSPACE_ID,
      connections,
      connectionsLoaded: true,
      refresh: async () => {},
      replaceConnection: () => {},
    });
    return (
      <Sheet open>
        <IntegrationSheetBody model={captured.model} />
      </Sheet>
    );
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  const sheet = document.querySelector('[data-integration-sheet="google-drive"]');
  if (!sheet || !captured) throw new Error("Google Drive sheet did not render");
  return {
    sheet,
    adapter: captured as ReturnType<typeof useGoogleDriveIntegration>,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("Google Drive sheet disclosures", () => {
  test("renders both limited-use disclosures and describes the Set up button", async () => {
    const rendered = await renderDriveSheet([]);
    try {
      expect(rendered.sheet.textContent).toContain(GOOGLE_DRIVE_ACCESS_DISCLOSURE);
      expect(rendered.sheet.textContent).toContain(GOOGLE_DRIVE_PUBLISHING_DISCLOSURE);
      const setupButton = [...rendered.sheet.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Set up",
      )!;
      expect(setupButton.getAttribute("aria-describedby")).toBe(
        integrationDisclosureElementId("google-drive-access"),
      );
    } finally {
      await rendered.unmount();
    }
  });

  test("describes the reconnect and publish affordances on a connected account", async () => {
    const rendered = await renderDriveSheet([connectedDriveFixture()]);
    try {
      const reconnect = [...rendered.sheet.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Reconnect",
      )!;
      expect(reconnect.getAttribute("aria-describedby")).toBe(
        integrationDisclosureElementId("google-drive-access"),
      );
      const publishToggle = rendered.sheet.querySelector(
        `[aria-describedby="${integrationDisclosureElementId("google-drive-publishing")}"][role="switch"]`,
      );
      expect(publishToggle).not.toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
});

describe("Google Drive sync toggle", () => {
  test("writes the shared saved settings when they are uniform", async () => {
    const fixture = connectedDriveFixture();
    requestMock.mockClear();
    requestMock.mockImplementationOnce(async () => ({ connection: fixture }));
    const rendered = await renderDriveSheet([fixture]);
    try {
      const sync = rendered.adapter.model.options.find(
        (option) => option.id === "google-drive-sync",
      )!;
      expect(sync.kind).toBe("toggle");
      await act(async () => {
        if (sync.kind === "toggle") sync.onChange(false);
      });
      expect(requestMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse((requestMock.mock.calls[0]![1] as { body: string }).body);
      expect(body.syncEnabled).toBe(false);
      expect(body.syncCadence).toBe("hourly");
      expect(body.readPolicy).toBe("allow");
      expect(body.sources).toHaveLength(2);
    } finally {
      await rendered.unmount();
    }
  });

  test("refuses to flatten sources whose saved settings differ", async () => {
    const fixture = connectedDriveFixture();
    const metadata = fixture.metadata as {
      selectedSources: Array<{ syncCadence: string }>;
    };
    metadata.selectedSources[1]!.syncCadence = "daily";
    requestMock.mockClear();
    const rendered = await renderDriveSheet([fixture]);
    try {
      const sync = rendered.adapter.model.options.find(
        (option) => option.id === "google-drive-sync",
      )!;
      await act(async () => {
        if (sync.kind === "toggle") sync.onChange(false);
      });
      // No save request: the blanket toggle would overwrite per-source settings.
      expect(requestMock).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });
});
