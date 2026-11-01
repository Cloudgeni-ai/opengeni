import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Radix portals (the ⋯ menu and dialogs) decide at import time whether a DOM exists.
GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
afterAll(() => GlobalRegistrator.unregister());

const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const connectors = await import("./organization-connectors");
const route = await import("@/lib/organization-route");
type OrganizationConnector = import("@opengeni/contracts").OrganizationConnector;
type CapabilityCatalogItem = import("@opengeni/react/app/types").CapabilityCatalogItem;
type ConnectorLocation = import("@/lib/organization-route").ConnectorLocation;
type Client = import("@opengeni/sdk/browser").OpenGeniBrowserClient;

const ORG = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const OPS = "33333333-3333-4333-8333-333333333333";
const LINEAR_ID = "44444444-4444-4444-8444-444444444444";

function connector(overrides: Partial<OrganizationConnector> = {}): OrganizationConnector {
  return {
    id: LINEAR_ID,
    organizationId: ORG,
    capabilityId: "registry:linear",
    name: "Linear",
    description: null,
    endpointUrl: "https://mcp.linear.app/mcp",
    source: "catalog",
    login: "each_person",
    headerNames: [],
    allowedTools: null,
    availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
    status: "active",
    available: true,
    generation: 3,
    createdAt: "2026-10-30T00:00:00Z",
    updatedAt: "2026-10-30T00:00:00Z",
    ...overrides,
  };
}

function catalogItem(overrides: Partial<CapabilityCatalogItem> = {}): CapabilityCatalogItem {
  return {
    id: "registry:notion",
    kind: "mcp",
    source: "registry",
    name: "Notion",
    description: "Search and edit Notion pages.",
    endpointUrl: "https://mcp.notion.com/mcp",
    mcpUrl: "https://mcp.notion.com/mcp",
    providerDomain: "mcp.notion.com",
    surfaceType: null,
    authKind: "oauth2",
    logoAssetPath: null,
    metadata: {},
    ...overrides,
  } as unknown as CapabilityCatalogItem;
}

function fakeClient(initial: OrganizationConnector[]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let rows = [...initial];
  const client = {
    listOrganizationConnectors: async (...args: unknown[]) => {
      calls.push({ method: "list", args });
      return rows;
    },
    createOrganizationConnector: async (...args: unknown[]) => {
      calls.push({ method: "create", args });
      const request = args[1] as { login: OrganizationConnector["login"] };
      const created = connector({
        id: "55555555-5555-4555-8555-555555555555",
        capabilityId: "registry:notion",
        name: "Notion",
        login: request.login,
      });
      rows = [...rows, created];
      return created;
    },
    updateOrganizationConnector: async (...args: unknown[]) => {
      calls.push({ method: "update", args });
      const [, id, request] = args as [string, string, Partial<OrganizationConnector>];
      const current = rows.find((row) => row.id === id)!;
      const updated = { ...current, ...request, generation: current.generation + 1 };
      rows = rows.map((row) => (row.id === id ? updated : row));
      return updated;
    },
    deleteOrganizationConnector: async (...args: unknown[]) => {
      calls.push({ method: "delete", args });
      rows = rows.filter((row) => row.id !== args[1]);
    },
    listCapabilities: async () => ({
      items: [
        catalogItem({ id: "registry:linear", name: "Linear" }),
        catalogItem(),
        catalogItem({ id: "mcp:workspace-own", name: "Own server", workspaceId: TEAM }),
      ],
    }),
    catalogAssetUrl: () => null,
    getOrganizationAdministrationOverview: async () => ({
      workspaces: [
        { id: OPS, name: "Ops" },
        { id: TEAM, name: "Team" },
      ],
    }),
  };
  return { client: client as unknown as Client, calls };
}

function Harness({ client, start }: { client: Client; start: ConnectorLocation }) {
  const [location, setLocation] = useState<ConnectorLocation>(start);
  return (
    <>
      <output data-location>{JSON.stringify(location)}</output>
      <connectors.OrganizationConnectors
        client={client}
        organizationId={ORG}
        organizationName="Acme"
        workspaceId={TEAM}
        location={location}
        onNavigate={setLocation}
      />
    </>
  );
}

async function mount(client: Client, start: ConnectorLocation = { kind: "list" }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<Harness client={client} start={start} />));
  await settle();
  return {
    container,
    location: () =>
      JSON.parse(container.querySelector("[data-location]")!.textContent!) as ConnectorLocation,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function settle() {
  for (let index = 0; index < 4; index += 1) await act(async () => {});
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!match) throw new Error(`No button "${label}"`);
  return match;
}

function radio(scope: ParentNode, title: string): HTMLElement {
  const match = [...scope.querySelectorAll<HTMLElement>('[role="radio"]')].find((node) =>
    node.textContent?.includes(title),
  );
  if (!match) throw new Error(`No choice "${title}"`);
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

describe("organization connector helpers", () => {
  test("integrations URLs address Add connector, a connector's page and its forms", () => {
    expect(route.parseConnectorParam(LINEAR_ID.toUpperCase())).toBe(LINEAR_ID);
    expect(route.parseConnectorParam("../x")).toBeUndefined();
    expect(route.parseConnectorView("replace-key")).toBe("replace-key");
    expect(route.parseConnectorView("invite")).toBeUndefined();
    expect(route.connectorLocation({})).toEqual({ kind: "list" });
    expect(route.connectorLocation({ view: "new-connector" })).toEqual({ kind: "new" });
    expect(route.connectorLocation({ connector: LINEAR_ID })).toEqual({
      kind: "connector",
      connectorId: LINEAR_ID,
      view: "page",
    });
    expect(route.connectorLocation({ connector: LINEAR_ID, view: "new-connector" })).toEqual({
      kind: "connector",
      connectorId: LINEAR_ID,
      view: "page",
    });
  });

  test("sign-in choices follow what the catalog says the server uses", () => {
    expect(connectors.catalogLoginChoices({ name: "Linear", authKind: "oauth2" })).toEqual({
      allowed: {
        each_person: null,
        organization_key: null,
        none: "Linear needs people to sign in.",
      },
      initial: "each_person",
    });
    const key = connectors.catalogLoginChoices({ name: "Search", authKind: "api_key" });
    expect(key.initial).toBe("organization_key");
    expect(key.allowed.each_person).toBe("Search has no sign-in of its own.");
    expect(connectors.catalogLoginChoices({ name: "Open", authKind: "none" }).initial).toBe("none");
    expect(connectors.catalogLoginChoices({ name: "?", authKind: null }).initial).toBeNull();
  });

  test("only shared remote MCP servers can be added for the organization", () => {
    const items = connectors.addableCatalogItems([
      catalogItem({ name: "Zeta" }),
      catalogItem({ id: "a", name: "Alpha" }),
      catalogItem({ id: "own", workspaceId: TEAM }),
      catalogItem({ id: "builtin", source: "built_in" }),
      catalogItem({ id: "fiken", surfaceType: "first_party_fiken" }),
      catalogItem({ id: "skill", kind: "skill" }),
      catalogItem({ id: "nourl", endpointUrl: null }),
      catalogItem({
        id: "custom-org",
        metadata: { organizationConnector: { source: "custom" } },
      }),
    ]);
    expect(items.map((item) => item.name)).toEqual(["Alpha", "Zeta"]);
  });

  test("reach reads the same way as the organization's other shared things", () => {
    expect(
      connectors.connectorReachSummary({
        allowedWorkspaceIds: null,
        allowPersonalWorkspaces: true,
      }),
    ).toBe("All workspaces + Personal");
    expect(
      connectors.connectorReachSummary({
        allowedWorkspaceIds: [TEAM, OPS],
        allowPersonalWorkspaces: false,
      }),
    ).toBe("2 workspaces");
  });
});

describe("organization connectors in settings", () => {
  test("the list says how each connector signs in, where it works, and when it is off", async () => {
    const { client } = fakeClient([
      connector(),
      connector({
        id: "66666666-6666-4666-8666-666666666666",
        name: "Team docs",
        source: "custom",
        login: "organization_key",
        headerNames: ["Authorization"],
        availability: { allowedWorkspaceIds: [TEAM], allowPersonalWorkspaces: false },
        status: "disabled",
      }),
    ]);
    const view = await mount(client);
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("Each person signs in · All workspaces + Personal");
      expect(text).toContain("Organization key · 1 workspace");
      expect(text).toContain("Off");
      await click(button(view.container, "Team docs"));
      expect(view.location()).toEqual({
        kind: "connector",
        connectorId: "66666666-6666-4666-8666-666666666666",
        view: "page",
      });
    } finally {
      await view.unmount();
    }
  });

  test("an empty organization says each workspace sets up its own", async () => {
    const { client } = fakeClient([]);
    const view = await mount(client);
    try {
      expect(view.container.textContent).toContain("No organization connectors yet");
      await click(button(view.container, "Add connector"));
      expect(view.location()).toEqual({ kind: "new" });
    } finally {
      await view.unmount();
    }
  });

  test("adding a catalog connector starts from its own sign-in and reaches every workspace", async () => {
    const { client, calls } = fakeClient([connector()]);
    const view = await mount(client, { kind: "new" });
    try {
      // Linear is already added; the workspace's own server is not offered.
      expect(view.container.textContent).toContain("Already added for your organization.");
      expect(view.container.textContent).not.toContain("Own server");
      await submit(view.container);
      expect(view.container.textContent).toContain("Choose a connector.");
      expect(calls.some((call) => call.method === "create")).toBe(false);

      await click(button(view.container, "Notion"));
      expect(view.container.textContent).toContain("Chosen connector");
      expect(radio(view.container, "Each person signs in").getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(radio(view.container, "No sign-in").getAttribute("data-disabled")).not.toBeNull();
      await submit(view.container);
      const create = calls.find((call) => call.method === "create")!;
      expect(create.args).toEqual([
        ORG,
        {
          capabilityId: "registry:notion",
          login: "each_person",
          availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
        },
      ]);
      expect(view.location()).toEqual({
        kind: "connector",
        connectorId: "55555555-5555-4555-8555-555555555555",
        view: "page",
      });
    } finally {
      await view.unmount();
    }
  });

  test("a custom server with an organization key is checked before it is sent", async () => {
    const { client, calls } = fakeClient([]);
    const view = await mount(client, { kind: "new" });
    try {
      await click(radio(view.container, "Custom server"));
      await click(radio(view.container, "Organization key"));
      await submit(view.container);
      const text = view.container.textContent ?? "";
      expect(text).toContain("Give the server a name.");
      expect(text).toContain("Enter the server's https:// address.");
      expect(text).toContain("Paste the key.");
      expect(calls.some((call) => call.method === "create")).toBe(false);

      const inputs = [...view.container.querySelectorAll<HTMLInputElement>("input")];
      const byPlaceholder = (placeholder: string) =>
        inputs.find((input) => input.placeholder === placeholder)!;
      await type(byPlaceholder("Team docs"), "Team docs");
      await type(byPlaceholder("https://example.com/mcp"), "https://docs.example.com/mcp");
      await type(byPlaceholder("Bearer …"), "Bearer secret");
      await submit(view.container);
      const create = calls.find((call) => call.method === "create")!;
      expect(create.args[1]).toEqual({
        custom: { name: "Team docs", endpointUrl: "https://docs.example.com/mcp" },
        login: "organization_key",
        headers: { Authorization: "Bearer secret" },
        availability: { allowedWorkspaceIds: null, allowPersonalWorkspaces: true },
      });
    } finally {
      await view.unmount();
    }
  });

  test("a connector's page turns it off everywhere, changes where it works, and removes it", async () => {
    const { client, calls } = fakeClient([connector()]);
    const view = await mount(client, { kind: "connector", connectorId: LINEAR_ID, view: "page" });
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("Belongs to Acme");
      expect(text).toContain("a workspace that sets up the same connector itself");
      const turnedOn = view.container.querySelector<HTMLElement>(
        'button[aria-label="Linear turned on"]',
      )!;
      await click(turnedOn);
      expect(calls.find((call) => call.method === "update")!.args).toEqual([
        ORG,
        LINEAR_ID,
        { status: "disabled", expectedGeneration: 3 },
      ]);
      expect(view.container.textContent).toContain(
        "No workspace gets it until you turn it back on",
      );

      await click(button(view.container, "Change"));
      expect(view.location()).toEqual({
        kind: "connector",
        connectorId: LINEAR_ID,
        view: "available-in",
      });
      await click(radio(view.container, "Selected workspaces"));
      const checkbox = (label: string) => {
        const named = [...view.container.querySelectorAll("label")].find(
          (node) => node.htmlFor && node.textContent?.includes(label),
        )!;
        return document.getElementById(named.htmlFor)!;
      };
      // Personal workspaces alone is a choice; nothing at all is not.
      await click(checkbox("Personal workspaces"));
      await submit(view.container);
      expect(view.container.textContent).toContain(
        "Pick at least one workspace, or choose All workspaces.",
      );
      await click(checkbox("Team"));
      await submit(view.container);
      const updates = calls.filter((call) => call.method === "update");
      expect(updates.at(-1)!.args).toEqual([
        ORG,
        LINEAR_ID,
        {
          availability: { allowedWorkspaceIds: [TEAM], allowPersonalWorkspaces: false },
          expectedGeneration: 4,
        },
      ]);
      expect(view.location()).toEqual({ kind: "connector", connectorId: LINEAR_ID, view: "page" });

      const more = view.container.querySelector<HTMLElement>(
        'button[aria-label="More actions for Linear"]',
      )!;
      await act(async () => {
        more.dispatchEvent(
          new PointerEvent("pointerdown", { button: 0, ctrlKey: false, bubbles: true }),
        );
      });
      const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (node) => node.textContent?.trim() === "Remove connector",
      )!;
      await click(remove);
      expect(document.body.textContent).toContain("Every workspace stops getting it at once.");
      expect(document.body.textContent).toContain("People's own sign-ins stay");
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      await click(button(dialog, "Remove connector"));
      expect(calls.find((call) => call.method === "delete")!.args).toEqual([ORG, LINEAR_ID]);
      expect(view.location()).toEqual({ kind: "list" });
    } finally {
      await view.unmount();
    }
  });

  test("an organization key is replaced from the connector's page", async () => {
    const keyed = connector({ login: "organization_key", headerNames: ["X-Api-Key"] });
    const { client, calls } = fakeClient([keyed]);
    const view = await mount(client, { kind: "connector", connectorId: LINEAR_ID, view: "page" });
    try {
      expect(view.container.textContent).toContain("sent as X-Api-Key");
      await click(button(view.container, "Replace key"));
      const value = view.container.querySelector<HTMLInputElement>('input[type="password"]')!;
      await type(value, "new-key");
      await submit(view.container);
      expect(calls.find((call) => call.method === "update")!.args).toEqual([
        ORG,
        LINEAR_ID,
        { headers: { "X-Api-Key": "new-key" }, expectedGeneration: 3 },
      ]);
    } finally {
      await view.unmount();
    }
  });

  test("a removed connector's page says so instead of loading forever", async () => {
    const { client } = fakeClient([]);
    const view = await mount(client, { kind: "connector", connectorId: LINEAR_ID, view: "page" });
    try {
      expect(view.container.textContent).toContain("This connector isn't in your organization");
    } finally {
      await view.unmount();
    }
  });
});
