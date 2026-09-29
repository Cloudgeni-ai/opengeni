import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-09-24T10:00:00.000Z";
const existing = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId,
  url: "https://receiver.example/events",
  eventTypes: ["turn.completed" as const],
  enabled: true,
  description: null,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const client = {
  listWorkspaceWebhooks: mock(async () => ({ webhooks: [existing] })),
  createWorkspaceWebhook: mock(async () => ({
    webhook: { ...existing, id: "33333333-3333-4333-8333-333333333333" },
    secret: "whsec_one_time_value",
  })),
  updateWorkspaceWebhook: mock(async () => ({ ...existing, enabled: false })),
  deleteWorkspaceWebhook: mock(async () => undefined),
  listWorkspaceWebhookDeliveries: mock(async () => ({
    deliveries: [
      {
        id: "44444444-4444-4444-8444-444444444444",
        webhookId: existing.id,
        eventId: "55555555-5555-4555-8555-555555555555",
        eventType: "turn.completed",
        status: "failed" as const,
        attempts: 12,
        lastStatus: 500,
        lastError: "HTTP 500",
        nextAttemptAt: null,
        deliveredAt: null,
        failedAt: timestamp,
        createdAt: timestamp,
      },
    ],
  })),
  redeliverWorkspaceWebhookDelivery: mock(async () => ({})),
  getWorkspaceCredentialProvider: mock(async () => ({ provider: null })),
  putWorkspaceCredentialProvider: mock(async () => ({
    provider: {
      workspaceId,
      url: "https://product.example/credentials",
      enabled: true,
      timeoutMs: 10000,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    secret: "ogcp_one_time_value",
  })),
  deleteWorkspaceCredentialProvider: mock(async () => undefined),
  listWorkspaceSandboxImages: mock(async () => ({
    images: ["ghcr.io/acme/sandbox:1"],
    selected: null,
  })),
  updateWorkspaceSettings: mock(async () => ({})),
};

// UI primitives read DOM globals at module load, so register Happy DOM first.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { WorkspaceDeveloperSettings, WorkspaceSandboxImageRow } =
  await import("./workspace-developer-settings");
const { OpenGeniApiError } = await import("@opengeni/sdk");

function apiError(status: number, message: string) {
  return new OpenGeniApiError(
    status,
    JSON.stringify({ error: { message, requestId: "7f1c2d4e-0000-4000-8000-000000000001" } }),
    { mutation: false },
  );
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const match = Array.from(root.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return match;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    const reactPropsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
    const props = (
      input as unknown as Record<
        string,
        { onChange?: (event: { target: HTMLInputElement }) => void }
      >
    )[reactPropsKey ?? ""];
    props?.onChange?.({ target: input });
  });
}

afterAll(() => {
  GlobalRegistrator.unregister();
});

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

async function render(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(node));
  await flush();
  return container;
}

describe("workspace developer settings", () => {
  test("adds a webhook, shows its secret once, and lists delivery history", async () => {
    const container = await render(
      <WorkspaceDeveloperSettings client={client as never} workspaceId={workspaceId} canManage />,
    );
    expect(container.textContent).toContain("https://receiver.example/events");
    expect(container.textContent).toContain("Turn completed");

    await act(async () => button(container, "Add webhook").click());
    await type(
      container.querySelector<HTMLInputElement>("#webhook-url")!,
      "https://new.example/hook",
    );
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(client.createWorkspaceWebhook).toHaveBeenCalledWith(workspaceId, {
      url: "https://new.example/hook",
      eventTypes: ["turn.completed", "turn.failed"],
    });
    expect(
      Array.from(container.querySelectorAll<HTMLInputElement>("input[readonly]")).map(
        (input) => input.value,
      ),
    ).toContain("whsec_one_time_value");
    expect(container.textContent).toContain("won't be shown again");

    await act(async () =>
      (container.querySelector('[aria-expanded="false"]') as HTMLButtonElement).click(),
    );
    await flush();
    expect(container.textContent).toContain("HTTP 500");
    await act(async () => button(container, "Send again").click());
    await flush();
    expect(client.redeliverWorkspaceWebhookDelivery).toHaveBeenCalled();

    await act(async () => button(container, `Send events to ${existing.url}`).click());
    expect(client.updateWorkspaceWebhook).toHaveBeenCalledWith(workspaceId, existing.id, {
      enabled: false,
    });
  });

  test("connects a credential provider and keeps read-only viewers out", async () => {
    const container = await render(
      <WorkspaceDeveloperSettings client={client as never} workspaceId={workspaceId} canManage />,
    );
    await type(
      container.querySelector<HTMLInputElement>("#credential-provider-url")!,
      "https://product.example/credentials",
    );
    await act(async () => button(container, "Connect").click());
    await flush();
    expect(client.putWorkspaceCredentialProvider).toHaveBeenCalledWith(workspaceId, {
      url: "https://product.example/credentials",
      enabled: true,
    });
    expect(
      Array.from(container.querySelectorAll<HTMLInputElement>("input[readonly]")).map(
        (input) => input.value,
      ),
    ).toContain("ogcp_one_time_value");

    const readOnly = await render(
      <WorkspaceDeveloperSettings
        client={client as never}
        workspaceId={workspaceId}
        canManage={false}
      />,
    );
    expect(readOnly.textContent).not.toContain("Add webhook");
    expect(readOnly.querySelector<HTMLInputElement>("#credential-provider-url")!.disabled).toBe(
      true,
    );
  });

  test("a missing permission reads as unavailable, not as an error", async () => {
    client.listWorkspaceWebhooks.mockImplementationOnce(async () => {
      throw apiError(403, "missing permission: workspace:admin");
    });
    client.getWorkspaceCredentialProvider.mockImplementationOnce(async () => {
      throw apiError(403, "missing permission: workspace:admin");
    });
    const container = await render(
      <WorkspaceDeveloperSettings
        client={client as never}
        workspaceId={workspaceId}
        canManage={false}
      />,
    );
    expect(container.textContent).toContain("Only workspace admins can manage webhooks.");
    expect(container.textContent).toContain("Ask a workspace admin for access.");
    expect(container.textContent).not.toContain("OpenGeni API");
    expect(container.textContent).not.toContain("missing permission");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll("button")).map((b) => b.textContent),
    ).not.toContain("Try again");

    client.listWorkspaceWebhooks.mockImplementationOnce(async () => {
      throw apiError(403, "missing permission: workspace:admin");
    });
    const personal = await render(
      <WorkspaceDeveloperSettings
        client={client as never}
        workspaceId={workspaceId}
        canManage={false}
        personal
      />,
    );
    expect(personal.textContent).toContain("Webhooks aren't available in a Personal workspace.");
  });

  test("a failed load says what to do and keeps the reference in Technical details", async () => {
    client.listWorkspaceWebhooks.mockImplementationOnce(async () => {
      throw apiError(503, "upstream unavailable");
    });
    const container = await render(
      <WorkspaceDeveloperSettings client={client as never} workspaceId={workspaceId} canManage />,
    );
    expect(container.textContent).toContain("Couldn't load webhooks.");
    expect(container.textContent).toContain("Try again in a moment.");
    expect(container.textContent).not.toContain("OpenGeni API");
    const reference = container.querySelector("dl");
    expect(reference?.hidden).toBe(true);
    expect(reference?.textContent).toContain("7f1c2d4e-0000-4000-8000-000000000001");

    await act(async () => button(container, "Try again").click());
    await flush();
    expect(container.textContent).toContain("https://receiver.example/events");
  });

  test("offers only allowlisted sandbox images", async () => {
    const container = await render(
      <WorkspaceSandboxImageRow client={client as never} workspaceId={workspaceId} canManage />,
    );
    const select = container.querySelector<HTMLSelectElement>("#workspace-sandbox-image")!;
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "",
      "ghcr.io/acme/sandbox:1",
    ]);
    await act(async () => {
      select.value = "ghcr.io/acme/sandbox:1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(client.updateWorkspaceSettings).toHaveBeenCalledWith(workspaceId, {
      defaultSandboxImage: "ghcr.io/acme/sandbox:1",
    });

    client.listWorkspaceSandboxImages.mockImplementationOnce(async () => ({
      images: [],
      selected: null,
    }));
    const hidden = await render(
      <WorkspaceSandboxImageRow client={client as never} workspaceId={workspaceId} canManage />,
    );
    expect(hidden.textContent).toBe("");
  });
});
