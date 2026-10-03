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
  getWorkspaceCredentialProvider: mock(
    async (): Promise<{
      provider: {
        workspaceId: string;
        url: string;
        enabled: boolean;
        timeoutMs: number;
        createdAt: string;
        updatedAt: string;
      } | null;
    }> => ({ provider: null }),
  ),
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
  requestJson: mock(async (method: string, path: string): Promise<unknown> => {
    if (path.endsWith("/inherited-integrations")) {
      return {
        credentialProvider: null,
        webhooks: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            url: "https://org.example/events",
            eventTypes: ["turn.completed"],
            description: null,
          },
        ],
      };
    }
    if (method === "POST" && path.endsWith("/test") && path.includes("/webhooks/")) {
      return {
        result: {
          ok: false,
          status: 401,
          durationMs: 12,
          error:
            "The endpoint refused the request (HTTP 401). Check that it verifies with this webhook's signing secret.",
          request: JSON.stringify({ type: "webhook.test" }),
          responseBody: "bad signature",
          credentials: null,
        },
      };
    }
    if (method === "POST" && path.endsWith("/credential-provider/test")) {
      return {
        lane: "workspace",
        url: "https://product.example/credentials",
        result: {
          ok: true,
          status: 200,
          durationMs: 30,
          error: null,
          request: JSON.stringify({ type: "credentials.request", purpose: "test" }),
          responseBody: null,
          credentials: {
            status: "ok",
            environment: ["GITHUB_TOKEN"],
            files: [],
            git: ["github.com"],
            mcp: [],
            expiresAt: null,
            authNeeded: [],
          },
        },
      };
    }
    throw new Error(`unexpected ${method} ${path}`);
  }),
};

// UI primitives read DOM globals at module load, so register Happy DOM first.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const { WorkspaceDeveloperSettings } = await import("./workspace-developer-settings");
const { WorkspaceSandboxImageRow } = await import("./workspace-sandbox-image-row");
const { webhookHealth } = await import("./developer/webhooks");
type DeveloperLocation = import("@/lib/developer-route").DeveloperLocation;
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

function submitForm(container: HTMLElement) {
  return act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function developerPage(
  location: DeveloperLocation = {},
  options: { canManage?: boolean; personal?: boolean } = {},
) {
  const navigations: DeveloperLocation[] = [];
  const container = await render(
    <WorkspaceDeveloperSettings
      client={client as never}
      workspaceId={workspaceId}
      canManage={options.canManage ?? true}
      personal={options.personal ?? false}
      location={location}
      onNavigate={(next) => navigations.push(next)}
    />,
  );
  return { container, navigations };
}

describe("webhook health", () => {
  const delivery = (status: "pending" | "delivered" | "failed", attempts: number) => ({
    id: crypto.randomUUID(),
    webhookId: existing.id,
    eventId: crypto.randomUUID(),
    eventType: "turn.completed",
    status,
    attempts,
    lastStatus: null,
    lastError: null,
    nextAttemptAt: null,
    deliveredAt: status === "delivered" ? timestamp : null,
    failedAt: status === "failed" ? timestamp : null,
    createdAt: timestamp,
  });

  test("the newest tried delivery decides; paused wins; untried is not unhealthy", () => {
    expect(webhookHealth({ enabled: false }, [delivery("failed", 12)]).kind).toBe("paused");
    expect(webhookHealth({ enabled: true }, []).kind).toBe("unused");
    expect(webhookHealth({ enabled: true }, [delivery("pending", 0)]).kind).toBe("unused");
    expect(
      webhookHealth({ enabled: true }, [delivery("pending", 0), delivery("failed", 12)]).kind,
    ).toBe("failing");
    expect(webhookHealth({ enabled: true }, [delivery("pending", 3)]).kind).toBe("retrying");
    expect(webhookHealth({ enabled: true }, [delivery("delivered", 1)]).kind).toBe("healthy");
  });
});

describe("workspace developer settings", () => {
  test("lists webhooks with what needs attention and what the organization adds", async () => {
    const { container, navigations } = await developerPage();
    expect(container.textContent).toContain("receiver.example/events");
    expect(container.textContent).toContain("Failing");
    expect(container.textContent).toContain("An organization webhook also gets");
    expect(container.textContent).toContain("org.example");
    expect(container.textContent).toContain("Workspace ID");
    expect(container.textContent).toContain("Not connected");

    await act(async () => button(container, "Add webhook").click());
    expect(navigations.at(-1)).toEqual({ view: "new-webhook" });
    await act(async () => button(container, "Connect provider").click());
    expect(navigations.at(-1)).toEqual({ view: "connect-credential-provider" });
  });

  test("adds a webhook on its own page and shows the signing secret once", async () => {
    const { container, navigations } = await developerPage({ view: "new-webhook" });
    await type(
      container.querySelector<HTMLInputElement>("#webhook-url")!,
      "https://new.example/hook",
    );
    await submitForm(container);
    await flush();
    expect(client.createWorkspaceWebhook).toHaveBeenCalledWith(workspaceId, {
      url: "https://new.example/hook",
      eventTypes: [
        "turn.completed",
        "turn.failed",
        "session.requiresAction",
        "session.humanInput.requested",
      ],
    });
    expect(
      Array.from(container.querySelectorAll<HTMLInputElement>("input[readonly], textarea")).map(
        (input) => input.value,
      ),
    ).toContain("whsec_one_time_value");
    expect(container.textContent).toContain("won't be able to see it again");

    await submitForm(container);
    await flush();
    expect(navigations.at(-1)).toEqual({ webhook: "33333333-3333-4333-8333-333333333333" });
  });

  test("a webhook's page sends a test event and shows deliveries", async () => {
    const { container } = await developerPage({ webhook: existing.id });
    expect(container.textContent).toContain("Deliveries");
    expect(container.textContent).toContain("gave up after 12 attempts");
    expect(container.textContent).toContain("verifyWebhookEvent");

    await act(async () => button(container, "Send test event").click());
    await flush();
    expect(client.requestJson).toHaveBeenCalledWith(
      "POST",
      `/v1/workspaces/${workspaceId}/webhooks/${existing.id}/test`,
    );
    expect(container.textContent).toContain("Test event not delivered");
    expect(container.textContent).toContain("signing secret");

    await act(async () => button(container, "Send Turn completed again").click());
    await flush();
    expect(client.redeliverWorkspaceWebhookDelivery).toHaveBeenCalled();
  });

  test("connects a credential provider and shows its secret once", async () => {
    const { container, navigations } = await developerPage({
      view: "connect-credential-provider",
    });
    expect(container.textContent).toContain("How it works");
    await type(
      container.querySelector<HTMLInputElement>("#credential-provider-url")!,
      "https://product.example/credentials",
    );
    await submitForm(container);
    await flush();
    expect(client.putWorkspaceCredentialProvider).toHaveBeenCalledWith(workspaceId, {
      url: "https://product.example/credentials",
      enabled: true,
      timeoutMs: 10000,
    });
    expect(
      Array.from(container.querySelectorAll<HTMLInputElement>("input[readonly], textarea")).map(
        (input) => input.value,
      ),
    ).toContain("ogcp_one_time_value");
    await submitForm(container);
    await flush();
    expect(navigations.at(-1)).toEqual({ view: "credential-provider" });
  });

  test("Test connection names what a run would get, never the values", async () => {
    client.getWorkspaceCredentialProvider.mockImplementation(async () => ({
      provider: {
        workspaceId,
        url: "https://product.example/credentials",
        enabled: true,
        timeoutMs: 10000,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    }));
    try {
      const { container } = await developerPage({ view: "credential-provider" });
      await act(async () => button(container, "Test connection").click());
      await flush();
      expect(container.textContent).toContain("Connected");
      expect(container.textContent).toContain("GITHUB_TOKEN");
      expect(container.textContent).toContain("github.com");
      expect(container.textContent).toContain("isn't shown because it holds credentials");

      const list = await developerPage();
      expect(list.container.textContent).toContain("product.example/credentials");
      expect(list.container.textContent).not.toContain("Not connected");
    } finally {
      client.getWorkspaceCredentialProvider.mockImplementation(async () => ({ provider: null }));
    }
  });

  test("read-only viewers get no add or connect actions", async () => {
    const { container } = await developerPage({}, { canManage: false });
    expect(container.textContent).not.toContain("Add webhook");
    expect(container.textContent).not.toContain("Connect provider");
    expect(container.textContent).not.toContain("Workspace ID");
  });

  test("a missing permission reads as unavailable, not as an error", async () => {
    client.listWorkspaceWebhooks.mockImplementationOnce(async () => {
      throw apiError(403, "missing permission: workspace:admin");
    });
    client.getWorkspaceCredentialProvider.mockImplementationOnce(async () => {
      throw apiError(403, "missing permission: workspace:admin");
    });
    const { container } = await developerPage({}, { canManage: false });
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
    const personal = await developerPage({}, { canManage: false, personal: true });
    expect(personal.container.textContent).toContain(
      "Webhooks aren't available in a Personal workspace.",
    );
  });

  test("a failed load says what to do and keeps the reference in Technical details", async () => {
    client.listWorkspaceWebhooks.mockImplementationOnce(async () => {
      throw apiError(503, "upstream unavailable");
    });
    const { container } = await developerPage();
    expect(container.textContent).toContain("Couldn't load webhooks.");
    expect(container.textContent).toContain("Try again in a moment.");
    expect(container.textContent).not.toContain("OpenGeni API");
    const reference = container.querySelector("dl");
    expect(reference?.hidden).toBe(true);
    expect(reference?.textContent).toContain("7f1c2d4e-0000-4000-8000-000000000001");

    await act(async () => button(container, "Try again").click());
    await flush();
    expect(container.textContent).toContain("receiver.example/events");
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
