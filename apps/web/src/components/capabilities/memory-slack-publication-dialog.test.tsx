import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
} from "@opengeni/contracts";
import { OPENGENI_SLACK_BOT_REQUESTED_SCOPES } from "@opengeni/contracts/slack-bot-scopes";
import type { MemorySlackPublicationConfiguration } from "@opengeni/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectionMetadata } from "@/types";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";

type Request = { method: string; path: string; body: unknown };
const requests: Request[] = [];
let currentConfiguration: MemorySlackPublicationConfiguration | null = null;
let publications: unknown[] = [];
let putError: Error | null = null;
/** Runs when a publication action succeeds, e.g. to simulate another admin saving meanwhile. */
let onAction: (() => void) | null = null;

function resetServer(configuration: MemorySlackPublicationConfiguration | null) {
  requests.length = 0;
  currentConfiguration = configuration;
  publications = [];
  putError = null;
  onAction = null;
}

const client = {
  requestJson: async (method: string, path: string, body?: unknown) => {
    requests.push({ method, path, body });
    if (path.includes("/memory-slack-publications/channels")) {
      return {
        channels: [
          { id: "C1", name: "general", isPrivate: false },
          { id: "C2", name: "engineering-decisions", isPrivate: false },
        ],
        nextCursor: null,
      };
    }
    if (path.endsWith("/memory-slack-publications/configuration") && method === "GET") {
      return { current: currentConfiguration, history: [] };
    }
    if (path.endsWith("/memory-slack-publications/configuration") && method === "PUT") {
      if (putError) throw putError;
      return { ...currentConfiguration, ...(body as object), revision: 9 };
    }
    if (path.endsWith("/action") && method === "POST") {
      onAction?.();
      return publications[0];
    }
    if (path.endsWith("/memory-slack-publications")) {
      return { publications, nextCursor: null };
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  },
};

mock.module("@/context", () => ({ useAppContext: () => ({ client }) }));

if (!globalThis.document) GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { MemorySlackPublicationDialog } = await import("./memory-slack-publication-dialog");

afterAll(() => {
  GlobalRegistrator.unregister();
});

const botConnection = {
  id: connectionId,
  subjectId: null,
  providerDomain: "slack.com",
  kind: "app_install",
  status: "active",
  version: 1,
  verifiedInstallAt: "2026-10-01T00:00:00.000Z",
  verifiedInstallVersion: 1,
  grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
  createdAt: "2026-10-01T00:00:00.000Z",
  metadata: {
    credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
    credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
    slackTeamId: "T1",
    slackTeamName: "Cloudgeni",
    botId: "B1",
    botUserId: "U1",
    botDisplayName: "OpenGeni",
  },
} as unknown as ConnectionMetadata;

const savedConfiguration: MemorySlackPublicationConfiguration = {
  id: "44444444-4444-4444-8444-444444444444",
  workspaceId,
  revision: 3,
  enabled: false,
  connectionId,
  slackTeamId: "T1",
  slackChannelId: "C2",
  slackChannelName: "engineering-decisions",
  // Minor sits in neither list: it must read as Off, not fall back to a default.
  autoImportances: ["major"],
  reviewImportances: ["normal"],
  createdBySubjectId: "user:owner",
  createdAt: "2026-10-01T00:00:00.000Z",
};

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(props: { enableOnSave?: boolean; connections?: ConnectionMetadata[] }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const saved: MemorySlackPublicationConfiguration[] = [];
  const openChanges: boolean[] = [];
  const draw = async (connections: ConnectionMetadata[]) => {
    await act(async () => {
      root.render(
        <MemorySlackPublicationDialog
          workspaceId={workspaceId}
          connections={connections}
          canManage
          open
          enableOnSave={props.enableOnSave}
          onOpenChange={(open) => openChanges.push(open)}
          onSaved={(configuration) => saved.push(configuration)}
        />,
      );
    });
    await settle();
    await settle();
  };
  await draw(props.connections ?? [botConnection]);
  return {
    saved,
    openChanges,
    rerender: draw,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function dialog(): HTMLElement {
  const element = document.body.querySelector<HTMLElement>('[role="dialog"]');
  if (!element) throw new Error("dialog not rendered");
  return element;
}

function button(name: string): HTMLButtonElement {
  const match = [...dialog().querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!match) throw new Error(`button ${name} not found`);
  return match;
}

function policyGroup(label: string): HTMLElement {
  const group = dialog().querySelector<HTMLElement>(`[aria-label="${label} items"]`);
  if (!group) throw new Error(`policy ${label} not found`);
  return group;
}

function selectedPolicy(label: string): string | undefined {
  return policyGroup(label).querySelector('[data-state="on"]')?.textContent?.trim();
}

async function choosePolicy(label: string, option: string) {
  const target = [...policyGroup(label).querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === option,
  );
  if (!target) throw new Error(`policy option ${label} ${option} not found`);
  await act(async () => {
    target.click();
  });
}

function puts(): Request[] {
  return requests.filter((request) => request.method === "PUT");
}

function configurationReads(): number {
  return requests.filter(
    (request) => request.method === "GET" && request.path.endsWith("/configuration"),
  ).length;
}

describe("Slack decision publication dialog", () => {
  test("keeps the copy short and shows one stacked channel picker", async () => {
    resetServer(null);
    const rendered = await render({ enableOnSave: true });
    try {
      const text = dialog().textContent ?? "";
      expect(text).toContain("Publish important decisions to Slack");
      expect(text).not.toContain("immutable");
      expect(text).not.toContain("durable");
      expect(text).not.toContain("authoritative");
      // One installation: nothing to pick, so no installation picker.
      expect(text).not.toContain("Slack workspace");
      expect(text).toContain("Channel");
      expect(dialog().querySelector("table")).toBeNull();
      expect(selectedPolicy("Major")).toBe("Automatic");
      expect(selectedPolicy("Normal")).toBe("Review first");
      expect(selectedPolicy("Minor")).toBe("Off");
      // Turning on needs a channel first.
      expect(button("Turn on").disabled).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });

  test("reads saved policies exactly and keeps publishing off when saved from Configure", async () => {
    resetServer({ ...savedConfiguration });
    const rendered = await render({});
    try {
      expect(selectedPolicy("Major")).toBe("Automatic");
      expect(selectedPolicy("Normal")).toBe("Review first");
      expect(selectedPolicy("Minor")).toBe("Off");
      expect(dialog().textContent).toContain("#engineering-decisions");

      const minorAutomatic = [...policyGroup("Minor").querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === "Automatic",
      );
      await act(async () => {
        minorAutomatic!.click();
      });
      expect(selectedPolicy("Minor")).toBe("Automatic");

      await act(async () => {
        button("Save").click();
      });
      await settle();

      const put = requests.find((request) => request.method === "PUT");
      expect(put?.body).toEqual({
        expectedRevision: 3,
        enabled: false,
        connectionId,
        slackChannelId: "C2",
        slackChannelName: "engineering-decisions",
        autoImportances: ["major", "minor"],
        reviewImportances: ["normal"],
      });
      expect(rendered.saved).toHaveLength(1);
      expect(rendered.openChanges).toEqual([false]);
    } finally {
      await rendered.unmount();
    }
  });

  test("an enable attempt turns publishing on when saved", async () => {
    resetServer({ ...savedConfiguration });
    const rendered = await render({ enableOnSave: true });
    try {
      await act(async () => {
        button("Turn on").click();
      });
      await settle();
      const put = requests.find((request) => request.method === "PUT");
      expect(put?.body).toMatchObject({ enabled: true });
    } finally {
      await rendered.unmount();
    }
  });
  test("a saved installation that is no longer connected falls back and asks for a channel again", async () => {
    resetServer({
      ...savedConfiguration,
      enabled: true,
      connectionId: "99999999-9999-4999-8999-999999999999",
    });
    const rendered = await render({});
    try {
      const text = dialog().textContent ?? "";
      expect(text).toContain("no longer connected");
      expect(text).not.toContain("#engineering-decisions");
      // Channels load for the connected installation instead of the dead one.
      const channelReads = requests.filter((request) => request.path.includes("/channels"));
      expect(channelReads.at(-1)?.path).toContain(`connectionId=${connectionId}`);
      // Publishing is on, so it can't be saved without a channel.
      expect(button("Save").disabled).toBe(true);
    } finally {
      await rendered.unmount();
    }
  });

  test("approving a post keeps unsaved edits and the revision they were made against", async () => {
    resetServer({ ...savedConfiguration });
    publications = [
      {
        id: "55555555-5555-4555-8555-555555555555",
        workspaceId,
        configurationRevision: 3,
        connectionId,
        slackTeamId: "T1",
        slackChannelId: "C2",
        sourceType: "workspace_memory",
        sourceId: "s",
        sourceVersion: null,
        importance: "normal",
        deliveryMode: "review",
        state: "review_pending",
        summary: "Staging deploys wait for the canary receipt.",
        sourceLabel: "Knowledge",
        authoritativePath: null,
        initiatorKind: "agent",
        initiatorSubjectId: "a",
        initiatingHumanSubjectId: null,
        attemptCount: 0,
        retryAt: null,
        lastErrorCode: null,
        slackMessageTimestamp: null,
        createdAt: "2026-10-08T08:00:00.000Z",
        updatedAt: "2026-10-08T08:00:00.000Z",
        receipts: [],
      },
    ];
    // Another admin turns publishing on and saves while this dialog is open.
    onAction = () => {
      currentConfiguration = { ...savedConfiguration, revision: 7, enabled: true };
    };
    const rendered = await render({});
    try {
      await choosePolicy("Minor", "Review first");
      await act(async () => {
        button("Approve").click();
      });
      await settle();
      expect(selectedPolicy("Minor")).toBe("Review first");
      expect(configurationReads()).toBe(1);

      await act(async () => {
        button("Save").click();
      });
      await settle();
      expect(puts()[0]?.body).toMatchObject({
        expectedRevision: 3,
        enabled: false,
        reviewImportances: ["normal", "minor"],
      });
    } finally {
      await rendered.unmount();
    }
  });

  test("a new connections array does not reload the settings over unsaved edits", async () => {
    resetServer({ ...savedConfiguration });
    const rendered = await render({});
    try {
      await choosePolicy("Major", "Off");
      await rendered.rerender([{ ...botConnection }]);
      await rendered.rerender([{ ...botConnection }]);
      expect(selectedPolicy("Major")).toBe("Off");
      expect(configurationReads()).toBe(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("a revision conflict shows the latest settings so the next save can succeed", async () => {
    resetServer({ ...savedConfiguration });
    putError = Object.assign(new Error("OpenGeni API 409: configuration revision conflict"), {
      status: 409,
    });
    const rendered = await render({});
    try {
      await choosePolicy("Major", "Off");
      currentConfiguration = { ...savedConfiguration, revision: 8 };
      await act(async () => {
        button("Save").click();
      });
      await settle();
      expect(rendered.openChanges).toEqual([]);
      expect(configurationReads()).toBe(2);
      expect(selectedPolicy("Major")).toBe("Automatic");

      putError = null;
      await act(async () => {
        button("Save").click();
      });
      await settle();
      expect(puts().at(-1)?.body).toMatchObject({ expectedRevision: 8 });
    } finally {
      await rendered.unmount();
    }
  });
});
