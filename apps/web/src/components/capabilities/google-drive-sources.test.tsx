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
import type {
  AccessContext,
  ApiIntegrationInstallationSummary,
  ConnectionMetadata,
  IntegrationDefinitionSummary,
} from "@/types";

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

const GOOGLE_DRIVE_DEFINITIONS = [
  {
    id: "google-drive",
    name: "Google Drive",
    summary: "Files, folders, permissions, and shared drives.",
    protocol: "openapi",
    provider: { id: "google", domain: "www.googleapis.com" },
    authentication: { kind: "oauth2", scopes: [] },
    facets: [],
  },
] as unknown as IntegrationDefinitionSummary[];

function extraDriveAccount(
  overrides: Partial<ApiIntegrationInstallationSummary> = {},
): ApiIntegrationInstallationSummary {
  return {
    capabilityId: "api:google-drive",
    pluginKey: "integration/google-drive",
    installationVersion: 1,
    instanceId: "instance-extra",
    instanceKey: "account-extra",
    displayName: "finance@example.com",
    instanceVersion: 1,
    serverId: "api_google_drive_account_extra",
    name: "Google Drive",
    description: null,
    protocol: "openapi",
    definitionId: "google-drive",
    definitionProvenance: "curated",
    providerDomain: "www.googleapis.com",
    baseUrl: "https://www.googleapis.com/drive/v3/",
    sourceUrl: null,
    connected: true,
    requiresConnection: true,
    connectionId: "connection-extra",
    ownership: "workspace",
    allowedTools: ["drive_files_list"],
    toolCount: 1,
    approvalRequiredToolCount: 0,
    revisionId: "rev-1",
    contentSha256: "sha-1",
    ...overrides,
  } as unknown as ApiIntegrationInstallationSummary;
}

async function renderDriveSheet(
  connections: ConnectionMetadata[],
  instances: ApiIntegrationInstallationSummary[] = [],
) {
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
      definitions: GOOGLE_DRIVE_DEFINITIONS,
      instances,
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

describe("Google Drive extra accounts fold into the same row", () => {
  test("an extra account needing reauth forces the whole row to Needs attention", async () => {
    const rendered = await renderDriveSheet(
      [connectedDriveFixture()],
      [extraDriveAccount({ connected: false })],
    );
    try {
      // A healthy primary must never roll a broken second account up to green.
      expect(rendered.adapter.model.chip).toEqual({ label: "Needs attention", tone: "warn" });
    } finally {
      await rendered.unmount();
    }
  });

  test("all-healthy accounts leave the primary chip alone", async () => {
    const rendered = await renderDriveSheet([connectedDriveFixture()], [extraDriveAccount()]);
    try {
      expect(rendered.adapter.model.chip).toEqual({ label: "Connected", tone: "ok" });
    } finally {
      await rendered.unmount();
    }
  });

  test("the saved folders stay visible under the primary account", async () => {
    const rendered = await renderDriveSheet([connectedDriveFixture()], [extraDriveAccount()]);
    try {
      const access = rendered.adapter.model.access!;
      expect(access.title).toBe("Connected accounts");
      expect(access.items).toHaveLength(2);
      const primary = access.items[0]!;
      expect(primary.meta).toBe("Primary");
      expect(primary.subItems?.length).toBeGreaterThan(0);
      expect(primary.subItemsEmptyMessage).toContain("No folders selected yet");
      // The folder names and their sync meta reach the rendered sheet, not just
      // the view-model.
      for (const folder of primary.subItems ?? []) {
        expect(rendered.sheet.textContent).toContain(folder.name);
      }
      expect(rendered.sheet.textContent).toMatch(/syncing|on request/);
    } finally {
      await rendered.unmount();
    }
  });

  test("the extras path keeps the Google limited-use disclosure wired to its actions", async () => {
    // Read access was never granted, so the primary account's inline action is
    // the one that asks Google for more - exactly what the disclosure describes.
    const withoutSourceScope = connectedDriveFixture();
    const metadata = withoutSourceScope.metadata as Record<string, unknown>;
    metadata.selectedSources = [];
    metadata.accessMode = "file_only";
    const rendered = await renderDriveSheet([withoutSourceScope], [extraDriveAccount()]);
    try {
      const describedById = integrationDisclosureElementId("google-drive-access");
      const addAccount = [...rendered.sheet.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "+ Add account",
      )!;
      expect(addAccount.getAttribute("aria-describedby")).toBe(describedById);
      const allowAccess = [...rendered.sheet.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Allow folder access",
      )!;
      expect(allowAccess).toBeDefined();
      expect(allowAccess.getAttribute("aria-describedby")).toBe(describedById);
      expect(document.getElementById(describedById)?.textContent).toBe(
        GOOGLE_DRIVE_ACCESS_DISCLOSURE,
      );
    } finally {
      await rendered.unmount();
    }
  });
});
