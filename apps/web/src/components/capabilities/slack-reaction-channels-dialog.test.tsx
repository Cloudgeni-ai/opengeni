import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  DEFAULT_WORKSPACE_SLACK_REACTION_SUMMON_SETTINGS,
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  type WorkspaceSlackReactionSummonSettings,
} from "@opengeni/contracts";
import type { SlackReactionChannel } from "@opengeni/sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConnectionMetadata } from "@/types";

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const mutableContext: { current: Record<string, unknown> } = { current: {} };
mock.module("@/context", () => ({ useAppContext: () => mutableContext.current }));
// Keep the real body and fields; happy-dom does not mount Radix portals.
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
}));

const { SlackReactionChannelsDialog } = await import("./slack-reaction-channels-dialog");
const mounted: Array<{ root: Root; host: HTMLElement }> = [];
beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

function connection(name: string, overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  const now = new Date(0).toISOString();
  return {
    id: crypto.randomUUID(),
    accountId: "22222222-2222-4222-8222-222222222222",
    workspaceId: WORKSPACE_ID,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    status: "active",
    grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    verifiedInstallAt: now,
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId: `T_${name}`,
      slackTeamName: name,
      botId: `B_${name}`,
      botUserId: `U_${name}`,
      botDisplayName: "Opengeni",
    },
    createdBySubjectId: "subject-a",
    updatedBySubjectId: "subject-a",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function renderDialog({
  connections,
  connectionId,
  list,
  onSave = async () => true,
}: {
  connections?: ConnectionMetadata[];
  connectionId: string | null;
  list: (
    workspaceId: string,
    connectionId: string,
    cursor?: string,
  ) => Promise<{ channels: SlackReactionChannel[]; nextCursor?: string }>;
  onSave?: (settings: WorkspaceSlackReactionSummonSettings) => Promise<boolean>;
}) {
  mutableContext.current = { client: { listOpenGeniSlackReactionChannels: list } };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(
      <SlackReactionChannelsDialog
        workspaceId={WORKSPACE_ID}
        connectionId={connectionId}
        connections={connections}
        settings={{
          enabled: true,
          emoji: DEFAULT_WORKSPACE_SLACK_REACTION_SUMMON_SETTINGS.emoji,
          channelPolicy: { mode: "allowlist", channelIds: ["C_EXISTING_HIDDEN"] },
        }}
        open
        canManage
        onOpenChange={() => {}}
        onSave={onSave}
      />,
    );
  });
  return host;
}

describe("Slack reaction channels across installations", () => {
  test("groups only verified local active bots and preserves the global selection", async () => {
    const internal = connection("Internal");
    const community = connection("Community");
    const calls: unknown[][] = [];
    const saves: WorkspaceSlackReactionSummonSettings[] = [];
    const host = await renderDialog({
      connectionId: null,
      connections: [
        internal,
        internal,
        community,
        connection("Foreign", { workspaceId: crypto.randomUUID() }),
        connection("Revoked", { status: "revoked" }),
        connection("Unverified", { verifiedInstallAt: null, verifiedInstallVersion: null }),
      ],
      list: async (...args) => {
        calls.push(args);
        const [, id, cursor] = args;
        return id === internal.id
          ? {
              channels: [{ id: "C_INTERNAL", name: "internal", isPrivate: false }],
              ...(cursor ? {} : { nextCursor: "next" }),
            }
          : { channels: [{ id: "C_COMMUNITY", name: "community", isPrivate: false }] };
      },
      onSave: async (settings) => {
        saves.push(settings);
        return true;
      },
    });
    expect(calls).toHaveLength(3);
    expect(calls).toContainEqual([WORKSPACE_ID, internal.id, undefined]);
    expect(calls).toContainEqual([WORKSPACE_ID, internal.id, "next"]);
    expect(calls).toContainEqual([WORKSPACE_ID, community.id, undefined]);
    const groups = [...host.querySelectorAll("fieldset")];
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.querySelector("legend")?.textContent).join(" ")).toContain(
      "Internal",
    );
    expect(groups.map((group) => group.querySelector("legend")?.textContent).join(" ")).toContain(
      "Community",
    );
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(host.textContent).toContain("all Slack bots installed in this Opengeni workspace");
    const communityGroup = groups.find((group) => group.textContent?.includes("#community"));
    await act(async () => communityGroup?.querySelector<HTMLInputElement>("input")?.click());
    const save = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    );
    await act(async () => save?.click());
    expect(saves[0]?.channelPolicy).toEqual({
      mode: "allowlist",
      channelIds: ["C_EXISTING_HIDDEN", "C_COMMUNITY"],
    });
  });

  test("preserves the exact current connection for callers without connection metadata", async () => {
    const calls: unknown[][] = [];
    await renderDialog({
      connectionId: "legacy-selected",
      list: async (...args) => {
        calls.push(args);
        return { channels: [] };
      },
    });
    expect(calls).toEqual([[WORKSPACE_ID, "legacy-selected", undefined]]);
  });

  test("does not save an incomplete channel listing after a bot request fails", async () => {
    const host = await renderDialog({
      connectionId: null,
      connections: [connection("Internal")],
      list: async () => {
        throw new Error("Disconnected");
      },
    });
    expect(host.textContent).toContain("Couldn't load Slack channels.");
    const save = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    );
    expect(save?.disabled).toBe(true);
  });
});
