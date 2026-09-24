import { describe, expect, test } from "bun:test";
import { ConnectionCatalog } from "@opengeni/react/connect";
import { OPENGENI_SLACK_BOT_REQUESTED_SCOPES } from "@opengeni/contracts/slack-bot-scopes";
import { renderToStaticMarkup } from "react-dom/server";

import { atlassianChip } from "@/components/capabilities/use-atlassian-integration";
import { githubChip } from "@/components/capabilities/use-github-integration";
import { googleDriveChip } from "@/components/capabilities/use-google-drive-integration";
import {
  canInstallOpenGeniSlackBot,
  canManageSlackReactionSummon,
  canWriteWorkspaceConnections,
  localConnectedSlackPreview,
  slackBotDocumentDestinationAuthority,
} from "@/components/capabilities/use-slack-integration";
import type { AccessContext, GitHubAppInfo } from "@/types";
import {
  catalogStatusForChip,
  connectionAccessChip,
  connectionAccessModel,
  type IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";
import { capabilityStateChip } from "@/lib/capabilities";
import {
  canManageApiIntegrations,
  fetchOAuthReturnRows,
  integrationQuickConnect,
  integrationRowBusy,
} from "./capabilities";

test("OAuth return still completes its connection read when catalog lookup fails", async () => {
  let reads = 0;
  const client = {
    listCapabilities: async () => {
      throw new Error("Catalog unavailable");
    },
  } as unknown as Parameters<typeof fetchOAuthReturnRows>[0];

  await expect(
    fetchOAuthReturnRows(client, "workspace-a", async () => {
      reads++;
      return null; // A denied fetch has already retired the hook's cached rows.
    }),
  ).rejects.toThrow("Catalog unavailable");
  expect(reads).toBe(1);
});

function accessContext(
  permissions: AccessContext["workspaceGrants"][number]["permissions"],
): AccessContext {
  return {
    mode: "managed",
    subjectId: "subject-a",
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId: "workspace-a",
        accountId: "account-a",
        subjectId: "subject-a",
        permissions,
      },
    ],
    defaultAccountId: "account-a",
    defaultWorkspaceId: "workspace-a",
  };
}

describe("integration state chips", () => {
  test("an initial 403 presents restricted connection-dependent tiles, not Loading or Retry", () => {
    const denied = true;
    const connectorChip = connectionAccessChip(
      capabilityStateChip({ enabled: true }, { state: "unverified" }),
      denied,
    );
    const integration: IntegrationViewModel = {
      id: "google-drive",
      name: "Google Drive",
      description: "Read connected files",
      mark: { monogram: "G" },
      chip: { label: "Loading", tone: "plain" },
      connection: [],
      options: [],
      footer: { kind: "setup", onSetup: () => {} },
      notice: {
        tone: "failed",
        title: "Temporary failure",
        action: { label: "Retry", onClick: () => {} },
      },
    };
    const model = connectionAccessModel(integration, denied);
    expect(connectorChip).toEqual({ label: "Access restricted", tone: "plain" });
    expect(model.chip).toEqual(connectorChip);
    expect(model.notice?.description).toContain("Ask a workspace admin for connection access");
    expect(model.notice?.action).toBeUndefined();
    expect(model.footer.kind).toBe("locked");
    expect(catalogStatusForChip(model.chip)).toBe("unavailable");

    const markup = renderToStaticMarkup(
      <ConnectionCatalog
        services={[model, { ...integration, id: "mail", name: "Mail", chip: connectorChip }].map(
          (entry) => ({
            id: entry.id,
            name: entry.name,
            options: [
              {
                id: entry.id,
                name: entry.name,
                status: entry.chip.label,
                state: catalogStatusForChip(entry.chip),
                connected: false,
                onOpen: () => {},
              },
            ],
          }),
        )}
      />,
    );
    expect(markup).not.toContain("Loading");
    expect(markup.match(/Access restricted/g)).toHaveLength(2);
    expect(markup).toContain("og-capability-catalog-row");
    expect(connectionAccessChip({ label: "Connected", tone: "ok" }, denied).label).toBe(
      "Connected",
    );
    expect(connectionAccessChip(integration.chip, false).label).toBe("Loading");
  });

  test("normalizes Google Drive states onto the shared chip vocabulary", () => {
    expect(googleDriveChip("connected", true, true).label).toBe("Connected");
    expect(googleDriveChip("connected", true, false).label).toBe("Set up by an admin");
    expect(googleDriveChip("paused", true, true).label).toBe("Needs attention");
    expect(googleDriveChip("not_connected", true, true).label).toBe("Not connected");
    expect(googleDriveChip("disconnected", true, true).label).toBe("Not connected");
    expect(googleDriveChip("reconsent_required", true, true).label).toBe("Needs attention");
    expect(googleDriveChip("unverified", true, true).label).toBe("Loading");
    expect(googleDriveChip("connected", false, false).label).toBe("Set up by an admin");
  });

  test("normalizes Atlassian and GitHub states the same way", () => {
    expect(atlassianChip("connected", true, true).label).toBe("Connected");
    expect(atlassianChip("paused", true, true).label).toBe("Connected");
    expect(atlassianChip("needs_attention", true, true).label).toBe("Needs attention");
    expect(atlassianChip("not_connected", true, true).label).toBe("Not connected");
    expect(atlassianChip("connected", true, false).label).toBe("Set up by an admin");

    const bound: GitHubAppInfo = {
      configured: true,
      status: "bound",
      setupMode: "platform",
      appId: "1",
      clientId: null,
      appSlug: "opengeni",
      installUrl: "https://github.example/install",
      linkUrl: null,
      installations: [
        {
          installationId: 7,
          githubAccountId: 1,
          accountLogin: "acme",
          accountType: "Organization",
          lifecycle: "active",
          repositoryScope: "selected",
          repositoryCount: 3,
          configureUrl: null,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
      missing: [],
    };
    expect(githubChip(null, true).label).toBe("Loading");
    expect(githubChip(bound, true).label).toBe("Connected");
    expect(githubChip(bound, false).label).toBe("Set up by an admin");
    expect(
      githubChip(
        {
          ...bound,
          installations: [{ ...bound.installations[0]!, lifecycle: "suspended" }],
        },
        true,
      ).label,
    ).toBe("Needs attention");
    expect(githubChip({ ...bound, status: "unbound", installations: [] }, true).label).toBe(
      "Not connected",
    );
  });
});

describe("Slack integration authority", () => {
  test("offers a local-only connected Slack preview without changing persisted connections", () => {
    expect(localConnectedSlackPreview("?previewSlack=connected", "workspace-a", false)).toBeNull();

    const preview = localConnectedSlackPreview("?previewSlack=connected", "workspace-a", true);
    expect(preview?.bot.workspaceId).toBe("workspace-a");
    expect(preview?.bot.status).toBe("active");
    expect(preview?.bot.grantedScopes).toEqual([...OPENGENI_SLACK_BOT_REQUESTED_SCOPES]);
    expect(preview?.personal.state).toBe("connected");
  });

  test("keeps workspace-bot knowledge out of personal scope", () => {
    expect(
      slackBotDocumentDestinationAuthority({
        documentDestination: { authorityKind: "personal" },
      }),
    ).toBe("workspace");
    expect(
      slackBotDocumentDestinationAuthority({
        documentDestination: { authorityKind: "organization" },
      }),
    ).toBe("organization");
  });

  test("uses the authoritative workspace permission grant", () => {
    expect(canInstallOpenGeniSlackBot(accessContext(["connections:read"]), "workspace-a")).toBe(
      false,
    );
    expect(canInstallOpenGeniSlackBot(accessContext(["connections:write"]), "workspace-a")).toBe(
      true,
    );
    expect(canInstallOpenGeniSlackBot(accessContext(["workspace:admin"]), "workspace-a")).toBe(
      true,
    );
    expect(canWriteWorkspaceConnections(accessContext(["connections:write"]), "workspace-a")).toBe(
      true,
    );
    expect(canManageSlackReactionSummon(accessContext(["connections:write"]), "workspace-a")).toBe(
      false,
    );
    expect(canManageSlackReactionSummon(accessContext(["workspace:admin"]), "workspace-a")).toBe(
      true,
    );
    expect(canManageApiIntegrations(accessContext(["connections:write"]), "workspace-a")).toBe(
      false,
    );
    expect(canManageApiIntegrations(accessContext(["capabilities:manage"]), "workspace-a")).toBe(
      true,
    );
    expect(canManageApiIntegrations(accessContext(["workspace:admin"]), "workspace-a")).toBe(true);
  });
});

describe("integration row quick-connect guard", () => {
  const setup = (
    footer: IntegrationViewModel["footer"],
    chip: IntegrationViewModel["chip"] = { label: "Not connected", tone: "idle" },
  ) => ({ chip, footer });

  test("offers the fast path only for a genuinely not-connected, idle setup footer", () => {
    const onSetup = () => {};
    expect(integrationQuickConnect(setup({ kind: "setup", onSetup }))).toBe(onSetup);
    expect(
      integrationQuickConnect(
        setup({ kind: "setup", onSetup }, { label: "Connected", tone: "ok" }),
      ),
    ).toBeUndefined();
    expect(
      integrationQuickConnect(
        setup({ kind: "locked" }, { label: "Set up by an admin", tone: "plain" }),
      ),
    ).toBeUndefined();
  });

  test("a busy or disabled setup never fires a second connect", () => {
    const onSetup = () => {};
    // A double click must not mint a second instance key and start a second
    // OAuth redirect.
    expect(integrationQuickConnect(setup({ kind: "setup", onSetup, busy: true }))).toBeUndefined();
    expect(
      integrationQuickConnect(setup({ kind: "setup", onSetup, disabled: true })),
    ).toBeUndefined();
  });

  test("row busy comes from the adapter's own footer, never a chip label", () => {
    expect(integrationRowBusy({ footer: { kind: "setup", onSetup: () => {}, busy: true } })).toBe(
      true,
    );
    expect(integrationRowBusy({ footer: { kind: "setup", onSetup: () => {} } })).toBe(false);
    expect(
      integrationRowBusy({
        footer: { kind: "connected", onReconnect: () => {}, onDisconnect: () => {}, busy: true },
      }),
    ).toBe(true);
    expect(integrationRowBusy({ footer: { kind: "locked" } })).toBe(false);
  });
});
