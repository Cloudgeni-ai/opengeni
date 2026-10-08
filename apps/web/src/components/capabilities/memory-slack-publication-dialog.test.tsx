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
      return { ...currentConfiguration, ...(body as object), revision: 9 };
    }
    if (path.endsWith("/memory-slack-publications")) {
      return { publications: [], nextCursor: null };
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

async function render(props: { enableOnSave?: boolean }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const saved: MemorySlackPublicationConfiguration[] = [];
  const openChanges: boolean[] = [];
  await act(async () => {
    root.render(
      <MemorySlackPublicationDialog
        workspaceId={workspaceId}
        connections={[botConnection]}
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
  return {
    saved,
    openChanges,
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

describe("Slack decision publication dialog", () => {
  test("keeps the copy short and shows one stacked channel picker", async () => {
    requests.length = 0;
    currentConfiguration = null;
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
    requests.length = 0;
    currentConfiguration = { ...savedConfiguration };
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
    requests.length = 0;
    currentConfiguration = { ...savedConfiguration };
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
});
