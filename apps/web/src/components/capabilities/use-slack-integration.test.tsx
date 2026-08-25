import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { OPENGENI_PERSONAL_SLACK_MCP_URL } from "@opengeni/contracts";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { Sheet } from "@/components/ui/sheet";
import type { AccessContext, ConnectionMetadata, SlackInstallationBinding } from "@/types";
import { IntegrationSheetBody } from "./integration-sheet";
import type {
  IntegrationChoiceOption,
  IntegrationToggleOption,
  IntegrationViewModel,
} from "./integration-view-model";

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const PERSONAL_CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

// The adapter reads everything through the app context; swap it per case.
const mutableContext: { current: Record<string, unknown> } = { current: {} };
mock.module("@/context", () => ({
  useAppContext: () => mutableContext.current,
}));

// Radix portals do not mount under happy-dom; render dialog frames inline so
// the reaction-channel dialog's real body can be exercised.
mock.module("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
    open ? <div data-dialog>{children}</div> : null,
  DialogContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children?: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
}));

const {
  localConnectedSlackPreview,
  SLACK_PERSONAL_PERMISSION_SENTENCE,
  slackBotDocumentDestinationAuthority,
  slackBotPersistableDestinationAuthority,
  useSlackIntegration,
} = await import("./use-slack-integration");

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
        accountId: ACCOUNT_ID,
        subjectId: "subject-a",
        permissions,
      },
    ],
    defaultAccountId: ACCOUNT_ID,
    defaultWorkspaceId: WORKSPACE_ID,
  } as unknown as AccessContext;
}

function appContext(permissions: string[]): Record<string, unknown> {
  return {
    client: {},
    accessContext: accessContext(permissions),
    workspaces: [{ id: WORKSPACE_ID, settings: {} }],
    captureWorkspaceInvocation: (workspaceId: string) => ({ workspaceId, revision: 1 }),
    ownsWorkspaceInvocation: () => true,
    updateWorkspaceSettings: async () => null,
  };
}

/** A verified bot connection plus its active installation binding. */
function installedBot(): { bot: ConnectionMetadata; binding: SlackInstallationBinding } {
  const bot = localConnectedSlackPreview("?previewSlack=connected", WORKSPACE_ID, true)!.bot;
  const now = new Date().toISOString();
  return {
    bot,
    binding: {
      id: "44444444-4444-4444-8444-444444444444",
      accountId: ACCOUNT_ID,
      accountName: "CloudGeni",
      workspaceId: WORKSPACE_ID,
      workspaceName: "Main",
      connectionId: bot.id,
      connectionStatus: "active",
      connectionVersion: bot.version,
      slackTeamId: "T_CLOUDGENI_PREVIEW",
      slackTeamName: "CloudGeni",
      botId: "B_CLOUDGENI_PREVIEW",
      botUserId: "U_CLOUDGENI_PREVIEW",
      botDisplayName: "OpenGeni",
      state: "active",
      quarantineReason: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function personalConnection(): ConnectionMetadata {
  const now = new Date().toISOString();
  return {
    id: PERSONAL_CONNECTION_ID,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    subjectId: "subject-a",
    providerDomain: "slack.com",
    kind: "oauth2",
    status: "active",
    grantedScopes: ["search:read.public", "chat:write"],
    expiresAt: null,
    lastRefreshAt: now,
    lastUsedAt: now,
    lastError: null,
    version: 1,
    metadata: { mcpUrl: OPENGENI_PERSONAL_SLACK_MCP_URL },
    createdBySubjectId: "subject-a",
    updatedBySubjectId: "subject-a",
    createdAt: now,
    updatedAt: now,
  } as ConnectionMetadata;
}

async function renderAdapter({
  permissions,
  connections,
  bindings,
}: {
  permissions: string[];
  connections: ConnectionMetadata[];
  bindings: SlackInstallationBinding[];
}): Promise<{ model: IntegrationViewModel; unmount: () => Promise<void> }> {
  mutableContext.current = appContext(permissions);
  let captured: IntegrationViewModel | null = null;
  function Probe() {
    const adapter = useSlackIntegration({
      workspaceId: WORKSPACE_ID,
      items: [],
      connections,
      connectionsLoaded: true,
      slackInstallationBindings: bindings,
      sheetOpen: false,
      refresh: async () => {},
      onRuntimeChanged: () => {},
    });
    captured = adapter.model;
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  if (!captured) throw new Error("Slack adapter model was not captured");
  return {
    model: captured,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function optionById(model: IntegrationViewModel, id: string) {
  return model.options.find((option) => option.id === id) ?? null;
}

describe("useSlackIntegration model selection and gating", () => {
  test("admin with an installed bot manages every option", async () => {
    const { bot, binding } = installedBot();
    const rendered = await renderAdapter({
      permissions: ["workspace:admin"],
      connections: [bot],
      bindings: [binding],
    });
    try {
      const { model } = rendered;
      expect(model.chip.label).toBe("Connected");
      expect(model.footer.kind).toBe("connected");
      const reaction = optionById(model, "slack-reaction") as IntegrationToggleOption;
      expect(reaction.disabled).toBeFalsy();
      expect(reaction.action?.label).toBe("Choose where it works");
      const destination = optionById(
        model,
        "slack-knowledge-destination",
      ) as IntegrationChoiceOption;
      expect(destination.disabled).toBeFalsy();
      const publication = optionById(model, "slack-publication") as IntegrationToggleOption;
      expect(publication.action?.label).toBe("Configure");
    } finally {
      await rendered.unmount();
    }
  });

  test("connections:write member sees the bot model with admin-only options disabled", async () => {
    const { bot, binding } = installedBot();
    const rendered = await renderAdapter({
      permissions: ["connections:write"],
      connections: [bot],
      bindings: [binding],
    });
    try {
      const { model } = rendered;
      // The bot model, not the personal one: install/reconnect/disconnect need
      // only connection management permission.
      expect(model.connection.some((fact) => fact.value.includes("CloudGeni"))).toBe(true);
      expect(model.chip.label).toBe("Connected");
      expect(model.footer.kind).toBe("connected");
      if (model.footer.kind === "connected") {
        expect(model.footer.reconnectDisabled).toBeFalsy();
        expect(model.footer.disconnectDisabled).toBeFalsy();
      }
      const reaction = optionById(model, "slack-reaction") as IntegrationToggleOption;
      expect(reaction.disabled).toBe(true);
      expect(reaction.action).toBeUndefined();
      const destination = optionById(
        model,
        "slack-knowledge-destination",
      ) as IntegrationChoiceOption;
      expect(destination.disabled).toBe(true);
      const publication = optionById(model, "slack-publication") as IntegrationToggleOption;
      expect(publication.disabled).toBe(true);
      expect(publication.action).toBeUndefined();
    } finally {
      await rendered.unmount();
    }
  });

  test("connections:write member without a bot can install it", async () => {
    const rendered = await renderAdapter({
      permissions: ["connections:write"],
      connections: [],
      bindings: [],
    });
    try {
      expect(rendered.model.chip.label).toBe("Not connected");
      expect(rendered.model.footer.kind).toBe("setup");
      if (rendered.model.footer.kind === "setup") {
        expect(rendered.model.footer.disabled).toBeFalsy();
      }
    } finally {
      await rendered.unmount();
    }
  });

  test("admin without a bot gets the same setup footer", async () => {
    const rendered = await renderAdapter({
      permissions: ["workspace:admin"],
      connections: [],
      bindings: [],
    });
    try {
      expect(rendered.model.chip.label).toBe("Not connected");
      expect(rendered.model.footer.kind).toBe("setup");
    } finally {
      await rendered.unmount();
    }
  });

  test("plain member with an installed bot gets the personal permission sentence", async () => {
    const { bot, binding } = installedBot();
    const rendered = await renderAdapter({
      permissions: ["sessions:create"],
      connections: [bot],
      bindings: [binding],
    });
    try {
      const { model } = rendered;
      expect(model.chip.label).toBe("Set up by an admin");
      expect(model.options).toHaveLength(0);
      expect(model.footer).toEqual({
        kind: "locked",
        message: SLACK_PERSONAL_PERMISSION_SENTENCE,
      });
    } finally {
      await rendered.unmount();
    }
  });

  test("plain member without a bot still gets the truthful permission sentence", async () => {
    const rendered = await renderAdapter({
      permissions: ["sessions:create"],
      connections: [],
      bindings: [],
    });
    try {
      expect(rendered.model.footer).toEqual({
        kind: "locked",
        message: SLACK_PERSONAL_PERMISSION_SENTENCE,
      });
    } finally {
      await rendered.unmount();
    }
  });

  test("a subject-owned personal status renders without exposing its private row id", async () => {
    const rendered = await renderAdapter({
      permissions: ["sessions:create"],
      connections: [personalConnection()],
      bindings: [],
    });
    try {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () =>
        root.render(
          <Sheet open>
            <IntegrationSheetBody model={rendered.model} />
          </Sheet>,
        ),
      );
      try {
        const sheet = document.querySelector('[data-integration-sheet="slack"]')!;
        expect(sheet.textContent).toContain("Your account");
        expect(sheet.textContent).toContain(SLACK_PERSONAL_PERMISSION_SENTENCE);
        expect(sheet.textContent).not.toContain(PERSONAL_CONNECTION_ID);
        const buttons = [...sheet.querySelectorAll("button")].map((node) =>
          node.textContent?.trim(),
        );
        expect(buttons).not.toContain("Disconnect");
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    } finally {
      await rendered.unmount();
    }
  });
});

describe("Slack channel routing", () => {
  test("shows where each channel starts work, and says so when nothing is chosen", async () => {
    const { bot, binding } = installedBot();
    const listChannels = mock(async () => ({
      channels: [
        { id: "C_ROUTED", name: "eng-platform", isPrivate: false },
        { id: "C_UNSET", name: "random", isPrivate: false },
      ],
      nextCursor: null,
    }));
    const listRoutes = mock(async () => ({
      routingEnabled: true,
      routes: [
        {
          slackChannelId: "C_ROUTED",
          targetWorkspaceId: "11111111-1111-4111-8111-111111111111",
          targetWorkspaceName: "Platform",
          source: "admin" as const,
          updatedAt: new Date(0).toISOString(),
        },
      ],
    }));
    mutableContext.current = {
      ...appContext(["workspace:admin"]),
      client: {
        listOpenGeniSlackReactionChannels: listChannels,
        listOpenGeniSlackChannelRoutes: listRoutes,
      },
      accessContext: accessContext(["workspace:admin"]),
    };
    let adapter: ReturnType<typeof useSlackIntegration> | null = null;
    function Probe() {
      adapter = useSlackIntegration({
        workspaceId: WORKSPACE_ID,
        items: [],
        connections: [bot],
        connectionsLoaded: true,
        slackInstallationBindings: [binding],
        sheetOpen: true,
        refresh: async () => {},
        onRuntimeChanged: () => {},
      });
      return <>{adapter.dialogs}</>;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      const access = adapter!.model.access;
      expect(access?.editLabel).toBe("Manage routing");
      const routed = access?.items.find((item) => item.name === "#eng-platform");
      expect(routed?.meta).toContain("starts work in Platform");
      const unset = access?.items.find((item) => item.name === "#random");
      // A channel with no choice is not broken: it asks once and remembers.
      expect(unset?.meta).toContain("asks once, then remembers");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("offers no routing affordance to a member who cannot administer the install", async () => {
    const { bot, binding } = installedBot();
    mutableContext.current = {
      ...appContext(["connections:write"]),
      client: {
        listOpenGeniSlackReactionChannels: mock(async () => ({ channels: [], nextCursor: null })),
        listOpenGeniSlackChannelRoutes: mock(async () => ({ routes: [], routingEnabled: true })),
      },
      accessContext: accessContext(["connections:write"]),
    };
    let adapter: ReturnType<typeof useSlackIntegration> | null = null;
    function Probe() {
      adapter = useSlackIntegration({
        workspaceId: WORKSPACE_ID,
        items: [],
        connections: [bot],
        connectionsLoaded: true,
        slackInstallationBindings: [binding],
        sheetOpen: true,
        refresh: async () => {},
        onRuntimeChanged: () => {},
      });
      return <>{adapter.dialogs}</>;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(adapter!.model.access?.editLabel).toBeUndefined();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  test("advertises no routing control when routing is switched off", async () => {
    const { bot, binding } = installedBot();
    mutableContext.current = {
      ...appContext(["workspace:admin"]),
      client: {
        listOpenGeniSlackReactionChannels: mock(async () => ({
          channels: [{ id: "C_OFF", name: "general", isPrivate: false }],
          nextCursor: null,
        })),
        // Stored routes exist but do not apply, so the sheet must not imply
        // they do.
        listOpenGeniSlackChannelRoutes: mock(async () => ({
          routingEnabled: false,
          routes: [
            {
              slackChannelId: "C_OFF",
              targetWorkspaceId: "11111111-1111-4111-8111-111111111111",
              targetWorkspaceName: "Platform",
              source: "admin" as const,
              updatedAt: new Date(0).toISOString(),
            },
          ],
        })),
      },
      accessContext: accessContext(["workspace:admin"]),
    };
    let adapter: ReturnType<typeof useSlackIntegration> | null = null;
    function Probe() {
      adapter = useSlackIntegration({
        workspaceId: WORKSPACE_ID,
        items: [],
        connections: [bot],
        connectionsLoaded: true,
        slackInstallationBindings: [binding],
        sheetOpen: true,
        refresh: async () => {},
        onRuntimeChanged: () => {},
      });
      return <>{adapter.dialogs}</>;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    try {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(adapter!.model.access?.editLabel).toBeUndefined();
      const row = adapter!.model.access?.items.find((item) => item.name === "#general");
      expect(row?.meta).toBe("invited");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("Slack reaction shortcut enablement", () => {
  test("enabling with an empty allowlist routes through the dialog and saves enabled", async () => {
    const { bot, binding } = installedBot();
    const listChannels = mock(async () => ({
      channels: [{ id: "C1", name: "general", isPrivate: false }],
      nextCursor: null,
    }));
    const updateWorkspaceSettings = mock(async () => true);
    mutableContext.current = {
      ...appContext(["workspace:admin"]),
      client: { listOpenGeniSlackReactionChannels: listChannels },
      accessContext: accessContext(["workspace:admin"]),
      workspaces: [
        {
          id: WORKSPACE_ID,
          settings: {
            slackReactionSummon: {
              enabled: false,
              emoji: "genie",
              channelPolicy: { mode: "allowlist", channelIds: [] },
            },
          },
        },
      ],
      updateWorkspaceSettings,
    };
    let adapter: ReturnType<typeof useSlackIntegration> | null = null;
    function Probe() {
      adapter = useSlackIntegration({
        workspaceId: WORKSPACE_ID,
        items: [],
        connections: [bot],
        connectionsLoaded: true,
        slackInstallationBindings: [binding],
        sheetOpen: false,
        refresh: async () => {},
        onRuntimeChanged: () => {},
      });
      return <>{adapter.dialogs}</>;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    try {
      const reaction = adapter!.model.options.find(
        (option) => option.id === "slack-reaction",
      ) as IntegrationToggleOption;
      expect(reaction.checked).toBe(false);
      // The enable attempt opens the channel dialog instead of saving disabled.
      await act(async () => reaction.onChange(true));
      expect(updateWorkspaceSettings).not.toHaveBeenCalled();
      // Let the dialog's channel fetch resolve and re-render the list.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(checkbox).not.toBeNull();
      await act(async () => {
        checkbox!.click();
      });
      const save = [...document.querySelectorAll("button")].find(
        (node) => node.textContent?.trim() === "Save",
      )!;
      await act(async () => save.click());
      // The save carries the original enable intent plus the picked channel.
      expect(updateWorkspaceSettings).toHaveBeenCalledTimes(1);
      const [, patch] = updateWorkspaceSettings.mock.calls[0] as unknown as [
        string,
        {
          slackReactionSummon: {
            enabled: boolean;
            channelPolicy: { mode: string; channelIds: string[] };
          };
        },
      ];
      expect(patch.slackReactionSummon.enabled).toBe(true);
      expect(patch.slackReactionSummon.channelPolicy).toEqual({
        mode: "allowlist",
        channelIds: ["C1"],
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("Slack orchestration notices", () => {
  async function renderOptions(
    settings: Record<string, unknown>,
    // When supplied, every write blocks on it, so a test can hold one in flight.
    gate?: Promise<void>,
  ) {
    const { bot, binding } = installedBot();
    const updateWorkspaceSettings = mock(async () => {
      if (gate) await gate;
      return true;
    });
    mutableContext.current = {
      ...appContext(["workspace:admin"]),
      accessContext: accessContext(["workspace:admin"]),
      workspaces: [{ id: WORKSPACE_ID, settings }],
      updateWorkspaceSettings,
    };
    let adapter: ReturnType<typeof useSlackIntegration> | null = null;
    function Probe() {
      adapter = useSlackIntegration({
        workspaceId: WORKSPACE_ID,
        items: [],
        connections: [bot],
        connectionsLoaded: true,
        slackInstallationBindings: [binding],
        sheetOpen: false,
        refresh: async () => {},
        onRuntimeChanged: () => {},
      });
      return <>{adapter.dialogs}</>;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    const option = (id: string) =>
      adapter!.model.options.find((candidate) => candidate.id === id) as IntegrationToggleOption;
    const flush = async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    return {
      updateWorkspaceSettings,
      flush,
      // Captured once: these are the handlers a stale render already handed
      // out, which is exactly what the in-flight guard has to survive.
      childNotice: option("slack-child-requires-action-notice"),
      goalNotice: option("slack-goal-paused-notice"),
      // Re-read from the current render, for the rendered disabled/busy flags.
      current: (id: string) => option(id),
      patches: () =>
        updateWorkspaceSettings.mock.calls.map(
          (call) =>
            (call as unknown as [string, { slackOrchestrationNotices: Record<string, boolean> }])[1]
              .slackOrchestrationNotices,
        ),
      cleanup: async () => {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  test("both toggles are unchecked for a workspace that never configured them", async () => {
    const rendered = await renderOptions({});
    try {
      expect(rendered.childNotice.label).toBe(
        "Tell me in Slack when a worker I started needs input",
      );
      expect(rendered.goalNotice.label).toBe(
        "Tell me in Slack when a goal pauses for budget or the continuation cap",
      );
      expect(rendered.childNotice.checked).toBe(false);
      expect(rendered.goalNotice.checked).toBe(false);

      // Turning one on writes the whole resolved pair, so a partially stored
      // object can never fail closed and silently switch the other one off.
      await act(async () => rendered.childNotice.onChange(true));
      expect(rendered.patches()).toEqual([{ childRequiresAction: true, goalPaused: false }]);
    } finally {
      await rendered.cleanup();
    }
  });

  test("a stored enable renders checked and leaves the other notice off", async () => {
    const rendered = await renderOptions({ slackOrchestrationNotices: { goalPaused: true } });
    try {
      expect(rendered.goalNotice.checked).toBe(true);
      expect(rendered.childNotice.checked).toBe(false);
      // Enabling the second notice carries the first one forward untouched.
      await act(async () => rendered.childNotice.onChange(true));
      expect(rendered.patches()).toEqual([{ childRequiresAction: true, goalPaused: true }]);
    } finally {
      await rendered.cleanup();
    }
  });

  test("one in-flight write makes both toggles unavailable", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rendered = await renderOptions({}, gate);
    try {
      expect(rendered.current("slack-child-requires-action-notice").disabled).toBe(false);
      expect(rendered.current("slack-goal-paused-notice").disabled).toBe(false);

      // Start a write and leave it hanging on the gate.
      await act(async () => {
        rendered.childNotice.onChange(true);
      });
      const child = rendered.current("slack-child-requires-action-notice");
      const goal = rendered.current("slack-goal-paused-notice");
      expect(child.busy).toBe(true);
      expect(child.disabled).toBe(true);
      // The notice that is NOT being written is unavailable too: a second write
      // would carry this one's pre-write value and revert it.
      expect(goal.busy).toBe(false);
      expect(goal.disabled).toBe(true);

      // Even a handler captured before the write started cannot slip through.
      await act(async () => {
        rendered.goalNotice.onChange(true);
      });
      expect(rendered.updateWorkspaceSettings).toHaveBeenCalledTimes(1);

      release();
      await rendered.flush();
      expect(rendered.patches()).toEqual([{ childRequiresAction: true, goalPaused: false }]);
      expect(rendered.current("slack-child-requires-action-notice").disabled).toBe(false);
      expect(rendered.current("slack-goal-paused-notice").disabled).toBe(false);
    } finally {
      await rendered.cleanup();
    }
  });

  test("a malformed stored value fails closed to both unchecked", async () => {
    const rendered = await renderOptions({
      slackOrchestrationNotices: { childRequiresAction: "true", goalPaused: true },
    });
    try {
      expect(rendered.childNotice.checked).toBe(false);
      expect(rendered.goalNotice.checked).toBe(false);
    } finally {
      await rendered.cleanup();
    }
  });
});

describe("Slack bot knowledge destination coercion", () => {
  test("a legacy stored personal destination displays and persists as workspace", () => {
    expect(
      slackBotDocumentDestinationAuthority({
        documentDestination: { authorityKind: "personal", collectionId: null },
      }),
    ).toBe("workspace");
    expect(slackBotPersistableDestinationAuthority("personal")).toBe("workspace");
    expect(slackBotPersistableDestinationAuthority("workspace")).toBe("workspace");
    expect(slackBotPersistableDestinationAuthority("organization")).toBe("organization");
  });
});
