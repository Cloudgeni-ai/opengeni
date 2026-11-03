import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import * as SonnerPackage from "sonner";

import type {
  McpAutoConnectRefusalReason,
  McpTrustedIssuer,
  McpTrustedIssuerEvent,
} from "@opengeni/contracts";
import type { McpConnection } from "@/lib/mcp-connections";
import type { AutoConnectApi } from "./auto-connect";
import type { ConnectedAgentsLocation } from "./connected-agents";

mock.module("sonner", () => ({
  ...SonnerPackage,
  toast: Object.assign(
    mock((_message: string) => undefined),
    { success: mock((_message: string) => undefined), error: mock(() => undefined) },
  ),
}));

GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ConnectedAgents } = await import("./connected-agents");
const autoConnect = await import("./auto-connect");

afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

const ORG = "11111111-1111-4111-8111-111111111111";
const ISSUER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const me = "user:44444444-4444-4444-8444-444444444444";
const at = "2026-11-01T10:00:00.000Z";
const CLAUDE_URL = "https://identity.anthropic.com/issuers/iss_01ABC";

function issuer(overrides: Partial<McpTrustedIssuer> = {}): McpTrustedIssuer {
  return {
    id: ISSUER_ID,
    organizationId: ORG,
    name: "Claude",
    provider: "claude",
    issuer: CLAUDE_URL,
    jwksUri: null,
    allowedClientIds: null,
    access: {
      preset: "read_only",
      permissions: ["workspace:read"],
      workspaceScope: { kind: "all" },
    },
    status: "active",
    connectedPeople: 3,
    lastConnectedAt: at,
    lastRefusal: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function agent(overrides: Partial<McpConnection> = {}): McpConnection {
  return {
    id: AGENT_ID,
    clientName: "Claude",
    clientHost: "claude.ai",
    actor: "user",
    connectedBy: { subjectId: me, name: "Maja Berg" },
    policy: {
      preset: "read_only",
      permissions: ["workspace:read"],
      workspaceScope: { kind: "all" },
    },
    createdAt: at,
    lastUsedAt: at,
    expiresAt: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
    autoConnect: { trustedIssuerId: ISSUER_ID, issuerName: "Claude" },
    ...overrides,
  };
}

function fakeAutoConnect(initial: McpTrustedIssuer[], events: McpTrustedIssuerEvent[] = []) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let rows = [...initial];
  const api: AutoConnectApi = {
    list: async () => {
      calls.push({ method: "list", args: [] });
      return {
        trustedIssuers: rows,
        mcpUrl: "https://opengeni.test/v1/mcp",
        audience: "https://opengeni.test",
      };
    },
    check: async (request) => {
      calls.push({ method: "check", args: [request] });
      return request.issuer === CLAUDE_URL
        ? {
            status: "ok",
            issuer: request.issuer,
            jwksUri: `${request.issuer}/jwks`,
            keyCount: 2,
            algorithms: ["ES256"],
          }
        : { status: "failed", issuer: request.issuer, message: "No signing keys at that issuer." };
    },
    create: async (request) => {
      calls.push({ method: "create", args: [request] });
      const created = issuer({
        id: "55555555-5555-4555-8555-555555555555",
        name: request.name,
        provider: request.provider,
        issuer: request.issuer,
        access: request.access,
        connectedPeople: 0,
        lastConnectedAt: null,
      });
      rows = [...rows, created];
      return created;
    },
    update: async (id, request) => {
      calls.push({ method: "update", args: [id, request] });
      const current = rows.find((row) => row.id === id)!;
      const next = { ...current, ...(request.status ? { status: request.status } : {}) };
      rows = rows.map((row) => (row.id === id ? next : row));
      return next;
    },
    remove: async (id) => {
      calls.push({ method: "remove", args: [id] });
      rows = rows.filter((row) => row.id !== id);
    },
    events: async (id) => {
      calls.push({ method: "events", args: [id] });
      return { events };
    },
  };
  return { api, calls };
}

function Harness({
  issuers,
  connections,
  canManageAll,
  start,
}: {
  issuers: AutoConnectApi;
  connections: McpConnection[];
  canManageAll: boolean;
  start: ConnectedAgentsLocation;
}) {
  const [location, setLocation] = useState<ConnectedAgentsLocation>(start);
  return (
    <>
      <output data-location>{JSON.stringify(location)}</output>
      <ConnectedAgents
        organizationName="Acme"
        mcpUrl="https://opengeni.test/v1/mcp"
        api={{
          list: async () => ({ connections, canManageAll }),
          update: async () => connections[0]!,
          disconnect: async () => undefined,
        }}
        currentSubjectId={me}
        workspaces={[]}
        location={location}
        onNavigate={setLocation}
        autoConnect={{ organizationId: ORG, api: issuers }}
      />
    </>
  );
}

async function settle() {
  for (let index = 0; index < 4; index += 1) await act(async () => {});
}

async function mount(input: {
  issuers: AutoConnectApi;
  connections?: McpConnection[];
  canManageAll?: boolean;
  start?: ConnectedAgentsLocation;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <Harness
        issuers={input.issuers}
        connections={input.connections ?? []}
        canManageAll={input.canManageAll ?? true}
        start={input.start ?? {}}
      />,
    ),
  );
  await settle();
  return {
    container,
    text: () => container.textContent ?? "",
    location: () =>
      JSON.parse(
        container.querySelector("[data-location]")!.textContent!,
      ) as ConnectedAgentsLocation,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!match) throw new Error(`No button "${label}"`);
  return match;
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
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

async function submit(scope: ParentNode) {
  const form = scope.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function waitFor(check: () => boolean) {
  for (let tries = 0; tries < 40 && !check(); tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
}

function inputValues(scope: ParentNode): string[] {
  return [...scope.querySelectorAll<HTMLInputElement>("input")].map((input) => input.value);
}

describe("auto-connect words", () => {
  test("every refusal has its own plain reason", () => {
    const reasons: McpAutoConnectRefusalReason[] = [
      "malformed",
      "wrong_type",
      "issuer_disabled",
      "signature_invalid",
      "keys_unavailable",
      "wrong_audience",
      "wrong_resource",
      "client_mismatch",
      "client_not_allowed",
      "unknown_client",
      "expired",
      "replayed",
      "email_unverified",
      "no_matching_member",
      "several_organizations",
    ];
    const texts = reasons.map((reason) => autoConnect.refusalText(reason, "Acme"));
    expect(new Set(texts).size).toBe(reasons.length);
    expect(texts.every((text) => /^[A-Z].*\.$/u.test(text))).toBe(true);
    expect(autoConnect.refusalText("no_matching_member", "Acme")).toContain("Acme");
  });

  test("client IDs are read one per line, without repeats", () => {
    expect(autoConnect.parseClientIds(" a \n\nb, a c ")).toEqual(["a", "b", "c"]);
    expect(autoConnect.parseClientIds("")).toEqual([]);
  });

  test("an issuer's state follows what last happened", () => {
    expect(autoConnect.trustedIssuerState(issuer())).toBe("working");
    expect(autoConnect.trustedIssuerState(issuer({ connectedPeople: 0 }))).toBe("waiting");
    expect(autoConnect.trustedIssuerState(issuer({ lastRefusal: { reason: "expired", at } }))).toBe(
      "refused",
    );
    expect(autoConnect.trustedIssuerState(issuer({ status: "disabled" }))).toBe("off");
  });
});

describe("auto-connect on Connected agents", () => {
  test("members don't see it, and nothing is asked for", async () => {
    const { api, calls } = fakeAutoConnect([issuer()]);
    const view = await mount({ issuers: api, canManageAll: false });
    try {
      expect(view.text()).toContain("Your agents");
      expect(view.text()).not.toContain("Auto-connect");
      expect(calls.some((call) => call.method === "list")).toBe(false);
    } finally {
      await view.unmount();
    }
  });

  test("off, it is one action that opens the setup", async () => {
    const { api } = fakeAutoConnect([]);
    const view = await mount({ issuers: api });
    try {
      expect(view.text()).toContain("Auto-connect is off.");
      await click(button(view.container, "Set up auto-connect"));
      expect(view.location()).toEqual({ issuer: "new" });
      expect(view.text()).toContain("Set up auto-connect");
    } finally {
      await view.unmount();
    }
  });

  test("each issuer says how many people it connected, or that it was refused", async () => {
    const { api } = fakeAutoConnect([
      issuer(),
      issuer({
        id: "66666666-6666-4666-8666-666666666666",
        name: "Okta",
        provider: "okta",
        connectedPeople: 0,
        lastConnectedAt: null,
        lastRefusal: { reason: "no_matching_member", at },
      }),
    ]);
    const view = await mount({ issuers: api, connections: [agent()] });
    try {
      expect(view.text()).toContain("3 people · Read only · All workspaces");
      expect(view.text()).toContain("Refused");
      expect(view.text()).toContain("Auto-connected · Read only");
    } finally {
      await view.unmount();
    }
  });

  test("setting up Claude shows what to paste, checks the issuer and starts read only", async () => {
    const { api, calls } = fakeAutoConnect([]);
    const view = await mount({ issuers: api, start: { issuer: "new" } });
    try {
      expect(inputValues(view.container)).toEqual(
        expect.arrayContaining(["https://opengeni.test/v1/mcp", ORG]),
      );
      await submit(view.container);
      expect(view.text()).toContain("Paste the issuer URL from Claude.");
      expect(calls.some((call) => call.method === "create")).toBe(false);

      const field = view.container.querySelector<HTMLInputElement>(
        'input[placeholder^="https://identity.anthropic.com"]',
      )!;
      await type(field, "https://login.example.org");
      await waitFor(() => view.text().includes("No signing keys at that issuer."));
      expect(view.text()).toContain("No signing keys at that issuer.");
      await submit(view.container);
      expect(calls.some((call) => call.method === "create")).toBe(false);

      await type(field, CLAUDE_URL);
      await waitFor(() => view.text().includes("Found 2 signing keys."));
      expect(view.text()).toContain("Found 2 signing keys.");
      await submit(view.container);
      const create = calls.find((call) => call.method === "create")!;
      expect(create.args[0]).toEqual({
        name: "Claude",
        provider: "claude",
        issuer: CLAUDE_URL,
        access: {
          preset: "read_only",
          permissions: expect.any(Array),
          workspaceScope: { kind: "all" },
        },
      });
      expect(view.location()).toEqual({ issuer: "55555555-5555-4555-8555-555555555555" });
      expect(view.text()).toContain("Waiting for the first connection");
    } finally {
      await view.unmount();
    }
  });

  test("an issuer's page shows the last refusal and recent attempts in plain words", async () => {
    const { api, calls } = fakeAutoConnect(
      [issuer({ lastRefusal: { reason: "several_organizations", at } })],
      [
        {
          id: "77777777-7777-4777-8777-777777777777",
          outcome: "refused",
          reason: "no_matching_member",
          person: null,
          email: "guest@example.com",
          clientName: "Claude",
          at,
        },
        {
          id: "88888888-8888-4888-8888-888888888888",
          outcome: "connected",
          reason: null,
          person: { subjectId: me, name: "Maja Berg" },
          email: "maja@acme.test",
          clientName: "Claude",
          at,
        },
      ],
    );
    const view = await mount({ issuers: api, start: { issuer: ISSUER_ID } });
    try {
      expect(view.text()).toContain("The last attempt was refused");
      expect(view.text()).toContain("Enter the Tenant ID in the issuer's setup.");
      expect(view.text()).toContain("guest@example.com");
      expect(view.text()).toContain("Claude · No member of Acme has that verified email.");
      expect(view.text()).toContain("Maja Berg");
      expect(calls.some((call) => call.method === "events")).toBe(true);
      expect(inputValues(view.container)).toEqual(expect.arrayContaining([CLAUDE_URL, ORG]));
    } finally {
      await view.unmount();
    }
  });

  test("an auto-connected agent's access is set by its issuer", async () => {
    const { api } = fakeAutoConnect([issuer()]);
    const view = await mount({
      issuers: api,
      connections: [agent()],
      start: { agent: AGENT_ID },
    });
    try {
      expect(view.text()).toContain("Auto-connected through Claude");
      expect(view.text()).toContain("Set for everyone auto-connected through Claude.");
      // Read-only here, though it's the viewer's own agent.
      expect(view.container.querySelector('[role="radio"]')).toBeNull();
      await click(button(view.container, "Change"));
      expect(view.location()).toEqual({ issuer: ISSUER_ID });
    } finally {
      await view.unmount();
    }
  });
});
