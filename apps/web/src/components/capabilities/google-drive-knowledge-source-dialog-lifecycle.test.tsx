import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type {
  ApiIntegrationInstallationSummary,
  GoogleDriveBrowseResponse,
  IntegrationFacetDefinitionSummary,
} from "@/types";

const toastError = mock(() => undefined);
const toastWarning = mock(() => undefined);

mock.module("sonner", () => ({
  toast: {
    success: mock(() => undefined),
    error: toastError,
    info: mock(() => undefined),
    warning: toastWarning,
  },
}));

mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-dialog>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const { GoogleDriveKnowledgeSourceDialog } = await import("./google-drive-knowledge-source-dialog");

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

beforeEach(() => {
  toastError.mockClear();
  toastWarning.mockClear();
});

describe("Google Drive knowledge-source browse ownership", () => {
  test("ignores an old browse failure after the dialog closes and reopens", async () => {
    const firstBrowse = deferred<GoogleDriveBrowseResponse>();
    const secondBrowse = deferred<GoogleDriveBrowseResponse>();
    let browseCount = 0;
    const browseGoogleDriveFacetSource = mock(async () => {
      browseCount += 1;
      return await (browseCount === 1 ? firstBrowse.promise : secondBrowse.promise);
    });
    const client = { browseGoogleDriveFacetSource } as unknown as OpenGeniBrowserClient;
    const rendered = await renderDialog({ client, entry });
    try {
      await waitFor(() => browseGoogleDriveFacetSource.mock.calls.length === 1);

      await rendered.rerender({ client, entry: null });
      await rendered.rerender({ client, entry: { ...entry } });
      await waitFor(() => browseGoogleDriveFacetSource.mock.calls.length === 2);
      await waitFor(() => rendered.container.textContent?.includes("Loading folders") === true);

      await act(async () => {
        firstBrowse.reject(new Error("stale provider failure"));
        await Promise.resolve();
      });
      await act(async () => await Bun.sleep(0));

      expect(toastError).not.toHaveBeenCalled();
      expect(toastWarning).not.toHaveBeenCalled();
      expect(rendered.container.textContent).toContain("Loading folders");

      await act(async () => {
        secondBrowse.resolve(browseResponse("Current Drive"));
        await Promise.resolve();
      });
      await waitFor(() => rendered.container.textContent?.includes("Current Drive") === true);

      expect(rendered.container.textContent).not.toContain("Loading folders");
      expect(toastError).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }
  });
});

async function renderDialog(
  props: Partial<ComponentProps<typeof GoogleDriveKnowledgeSourceDialog>> = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (
    nextProps: Partial<ComponentProps<typeof GoogleDriveKnowledgeSourceDialog>> = props,
  ) => {
    await act(async () => {
      root.render(
        <GoogleDriveKnowledgeSourceDialog
          client={{} as OpenGeniBrowserClient}
          workspaceId="00000000-0000-4000-8000-000000000101"
          instance={instance}
          entry={null}
          canManage
          canManagePersonalDestination
          canManageWorkspaceDestination
          canManageOrganizationDestination={false}
          onClose={() => undefined}
          onMutationStart={() => ({
            apply: () => true,
            isCurrent: () => true,
            finish: () => undefined,
          })}
          {...nextProps}
        />,
      );
      await Promise.resolve();
    });
  };
  await render();
  return {
    container,
    rerender: render,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      document.body.replaceChildren();
    },
  };
}

function browseResponse(name: string): GoogleDriveBrowseResponse {
  const current = {
    id: "root",
    name,
    mimeType: "application/vnd.google-apps.folder",
    kind: "folder" as const,
    driveId: null,
    modifiedTime: null,
    size: null,
    webViewLink: null,
  };
  return {
    connection: {
      id: instance.connectionId!,
      accountId: "00000000-0000-4000-8000-000000000105",
      workspaceId: "00000000-0000-4000-8000-000000000101",
      subjectId: "user:caller",
      providerDomain: "drive.google.com",
      kind: "oauth2",
      status: "active",
      grantedScopes: [],
      expiresAt: null,
      lastRefreshAt: null,
      lastUsedAt: null,
      lastError: null,
      version: 1,
      metadata: {},
      createdBySubjectId: "user:caller",
      updatedBySubjectId: "user:caller",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
    },
    parentId: "root",
    current,
    items: [],
    nextPageToken: null,
    incompleteSearch: false,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await act(async () => await Bun.sleep(0));
  }
  throw new Error("Timed out waiting for Google Drive dialog state");
}

const definition: IntegrationFacetDefinitionSummary = {
  facetKey: "drive-content",
  kind: "knowledge_source",
  configSchema: { type: "object", properties: {} },
  capabilities: { provider: "google-drive" },
};

const entry = { definition, binding: null };

const instance: ApiIntegrationInstallationSummary = {
  capabilityId: "api:google-drive",
  pluginKey: "integration/google-drive",
  installationVersion: 1,
  instanceId: "00000000-0000-4000-8000-000000000104",
  instanceKey: "finance",
  displayName: "Google Drive — Finance",
  instanceVersion: 1,
  serverId: "google_drive_finance",
  name: "Google Drive",
  description: "Google Drive Integration",
  protocol: "openapi",
  definitionId: "google-drive",
  definitionProvenance: "curated",
  providerDomain: "drive.google.com",
  baseUrl: "https://www.googleapis.com/drive/v3/",
  sourceUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
  connected: true,
  requiresConnection: true,
  connectionId: "00000000-0000-4000-8000-000000000103",
  ownership: "personal",
  allowedTools: ["files.list"],
  toolCount: 1,
  approvalRequiredToolCount: 0,
  revisionId: "openapi:fixture",
  contentSha256: "a".repeat(64),
};
