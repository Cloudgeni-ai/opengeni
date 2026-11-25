import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
import type { Agent, CapabilityCatalogItem } from "@opengeni/sdk";
import type { Root } from "react-dom/client";

// Register the DOM before React DOM and Radix load (see select-menu.test.tsx).
GlobalRegistrator.register({ url: "https://example.test" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const updates: unknown[] = [];
const toolReads: string[] = [];
const asset = (path: string | null) => (path ? `/assets/${path}` : null);
function item(
  id: string,
  name: string,
  domain: string | null,
  overrides: Partial<CapabilityCatalogItem> = {},
): CapabilityCatalogItem {
  return {
    id,
    kind: "mcp",
    source: "manual",
    name,
    enabled: true,
    providerDomain: domain,
    connectionRef: domain ? { providerDomain: domain, kind: "oauth2" } : null,
    logoAssetPath: null,
    metadata: {},
    mcpUrl: null,
    endpointUrl: null,
    tools: [{ kind: "mcp", id: `server-${id}` }],
    runtime: { available: true, mcpServerId: `server-${id}` },
    ...overrides,
  } as CapabilityCatalogItem;
}
const catalog = [
  item("mail", "Mail", "mail.example", { logoAssetPath: "mail.svg" }),
  item("mail-2", "Mail (second account)", "mail.example"),
  item("chat", "Chat", "chat.example"),
  item("docs", "Docs server", null),
  item("off", "Off", "off.example", { enabled: false }),
  // Not usable here, but its logo is filed under a domain a rule names.
  item("listing", "Listing", "tickets.example", {
    kind: "integration" as CapabilityCatalogItem["kind"],
    logoAssetPath: "tickets.svg",
  }),
];
const tools: Record<string, string[]> = {
  mail: ["send", "read"],
  "mail-2": ["send", "archive"],
  chat: ["post"],
};
const context = {
  client: {
    catalogAssetUrl: asset,
    listCapabilities: async () => ({ items: catalog }),
    getConnectorToolPermissions: async (_workspace: string, id: string) => {
      toolReads.push(id);
      return {
        tools: (tools[id] ?? []).map((name) =>
          name === "archive" ? { name, title: "Archive a message" } : { name },
        ),
      };
    },
    updateAgent: async (_workspace: string, _id: string, patch: { toolPermissions: unknown }) => {
      updates.push(patch.toolPermissions);
      return { ...agent, toolPermissions: patch.toolPermissions };
    },
  },
};
mock.module("../../app-context", () => ({ useAppContext: () => context }));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AgentCanUse, canUseConnections, ruledConnections, withAgentRule } =
  await import("./agent-can-use");
const { canUseToolPermission, canUseTools, humanizeToolName, withAgentToolRules } =
  await import("./agent-tool-names");

afterAll(() => GlobalRegistrator.unregister());

const agent = {
  id: "agent-1",
  version: 2,
  viewer: { canEdit: true },
  toolPermissions: [
    { connector: "mail.example", tool: "send", permission: "ask" },
    { connector: "tickets.example", tool: "*", permission: "block" },
  ],
} as unknown as Agent;

describe("Can use connections", () => {
  test("one per rule key with the picker's logo, plus Opengeni's own GitHub tools", () => {
    const connections = canUseConnections(catalog, asset);
    expect(
      connections.map(({ key, name, logo, itemIds }) => ({ key, name, logo, itemIds })),
    ).toEqual([
      {
        key: "mail.example",
        name: "Mail",
        logo: "/assets/mail.svg",
        itemIds: ["mail", "mail-2"],
      },
      { key: "chat.example", name: "Chat", logo: null, itemIds: ["chat"] },
      { key: "server-docs", name: "Docs server", logo: null, itemIds: ["docs"] },
      {
        key: "github.com",
        name: "GitHub",
        logo: expect.stringContaining("data:image/svg+xml") as unknown as string,
        itemIds: [],
      },
    ]);
  });

  test("only connections with a rule are listed; an unlisted rule keeps its key and a domain logo", () => {
    const connections = canUseConnections(catalog, asset);
    const ruled = ruledConnections(
      connections,
      [...agent.toolPermissions, { connector: "*", tool: "*", permission: "ask" }],
      (domain) => (domain === "tickets.example" ? "/assets/tickets.svg" : null),
    );
    expect(ruled.map(({ key, name, logo }) => ({ key, name, logo }))).toEqual([
      { key: "mail.example", name: "Mail", logo: "/assets/mail.svg" },
      { key: "tickets.example", name: "tickets.example", logo: "/assets/tickets.svg" },
      { key: "*", name: "Every connection", logo: null },
    ]);
  });

  test("a rule is set, replaced and cleared per connector and tool", () => {
    const set = withAgentRule([], "mail.example", "*", "ask");
    expect(withAgentRule(set, "mail.example", "*", "block")).toEqual([
      { connector: "mail.example", tool: "*", permission: "block" },
    ]);
    expect(withAgentRule(set, "mail.example", "*", null)).toEqual([]);
  });
});

describe("AgentCanUse", () => {
  let container: HTMLDivElement;
  let root: Root;
  const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  const pick = async (label: string, option: string) => {
    const trigger = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    await act(async () => trigger.click());
    await settle();
    const match = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) =>
      entry.textContent?.includes(option),
    )!;
    await act(async () => match.click());
    await settle();
  };
  beforeEach(() => {
    updates.length = 0;
    toolReads.length = 0;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  test("lists only the connections with a rule, with logos, and adds a per-tool rule", async () => {
    await act(async () =>
      root.render(
        <AgentCanUse
          agent={agent}
          workspaceId="ws"
          onSaved={() => undefined}
          onError={() => undefined}
        />,
      ),
    );
    await settle();
    const rows = [...container.querySelectorAll("[data-agent-can-use]")].map((row) =>
      row.getAttribute("data-agent-can-use"),
    );
    expect(rows).toEqual(["mail.example", "tickets.example"]);
    expect(container.textContent).not.toContain("Chat");
    // Its tool rule shows without opening the tool list, by a readable name.
    expect(container.textContent).toContain("Send");
    expect(container.querySelector("code")).toBeNull();
    expect(
      container.querySelector('[data-agent-can-use="mail.example"] img')?.getAttribute("src"),
    ).toBe("/assets/mail.svg");
    // A rule for a connection not listed finds its logo by domain, as the picker does.
    expect(
      container.querySelector('[data-agent-can-use="tickets.example"] img')?.getAttribute("src"),
    ).toBe("/assets/tickets.svg");

    const add = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Add rule",
    )!;
    await act(async () => add.click());
    await pick("Connection", "Chat");
    expect(toolReads).toEqual(["chat"]);
    await pick("Tool", "Post");
    await pick("Choice", "Block");
    expect(updates).toEqual([
      [...agent.toolPermissions, { connector: "chat.example", tool: "post", permission: "block" }],
    ]);
    expect(container.querySelector("[data-agent-add-rule]")).toBeNull();
  });

  test("an existing rule is removed from its row", async () => {
    await act(async () =>
      root.render(
        <AgentCanUse
          agent={agent}
          workspaceId="ws"
          onSaved={() => undefined}
          onError={() => undefined}
        />,
      ),
    );
    await settle();
    await pick("tickets.example: all tools", "Remove");
    expect(updates).toEqual([[agent.toolPermissions[0]]]);
  });

  test("GitHub tools show one readable row per action, and a choice there sets every name", async () => {
    const ruledAgent = {
      ...agent,
      toolPermissions: [
        { connector: "github.com", tool: "merge_pull_request", permission: "block" },
        { connector: "github.com", tool: "pull_request_merge", permission: "block" },
      ],
    } as unknown as Agent;
    await act(async () =>
      root.render(
        <AgentCanUse
          agent={ruledAgent}
          workspaceId="ws"
          onSaved={() => undefined}
          onError={() => undefined}
        />,
      ),
    );
    await settle();
    const rows = [...container.querySelectorAll("[data-agent-can-use-tool]")];
    expect(rows.map((row) => row.textContent?.includes("Merge pull request"))).toEqual([true]);
    expect(rows[0]!.textContent).toContain("Block");
    expect(container.textContent).not.toContain("merge_pull_request");
    await pick("GitHub: Merge pull request", "Ask first");
    expect(updates).toEqual([
      [
        { connector: "github.com", tool: "pull_request_merge", permission: "ask" },
        { connector: "github.com", tool: "merge_pull_request", permission: "ask" },
      ],
    ]);
  });

  test("Add rule names tools readably and sets every name of a GitHub action", async () => {
    await act(async () =>
      root.render(
        <AgentCanUse
          agent={agent}
          workspaceId="ws"
          onSaved={() => undefined}
          onError={() => undefined}
        />,
      ),
    );
    await settle();
    const add = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Add rule",
    )!;
    await act(async () => add.click());
    await pick("Connection", "GitHub");
    await pick("Tool", "Merge pull request");
    await pick("Choice", "Block");
    expect(updates).toEqual([
      [
        ...agent.toolPermissions,
        { connector: "github.com", tool: "pull_request_merge", permission: "block" },
        { connector: "github.com", tool: "merge_pull_request", permission: "block" },
      ],
    ]);
  });
});

describe("Can use tool names", () => {
  test("a tool's own title, else a curated GitHub name, else its code name in words", () => {
    expect(humanizeToolName("merge_pull_request")).toBe("Merge pull request");
    expect(humanizeToolName("sendMessage")).toBe("Send message");
    expect(humanizeToolName("files.upload-v2")).toBe("Files upload v2");
    expect(
      canUseTools("mail.example", [
        { name: "send" },
        { name: "archive", title: "Archive a message" },
        { name: "send" },
      ]),
    ).toEqual([
      { key: "send", label: "Send", names: ["send"] },
      { key: "archive", label: "Archive a message", names: ["archive"] },
    ]);
    // GitHub: both servers' names of one action share a row; a title still wins.
    expect(
      canUseTools("github.com", [
        { name: "merge_pull_request" },
        { name: "pull_request_merge" },
        { name: "push_files" },
        { name: "create_pull_request", title: "Open a pull request" },
        { name: "brand_new_tool" },
      ]),
    ).toEqual([
      {
        key: "pull_request_merge",
        label: "Merge pull request",
        names: ["pull_request_merge", "merge_pull_request"],
      },
      { key: "push_files", label: "Push files", names: ["push_files"] },
      {
        key: "pull_request_create",
        label: "Open a pull request",
        names: ["pull_request_create", "create_pull_request"],
      },
      { key: "brand_new_tool", label: "Brand new tool", names: ["brand_new_tool"] },
    ]);
    // Two tools with one name say which each is.
    expect(
      canUseTools("chat.example", [{ name: "post", title: "Send" }, { name: "send" }]).map(
        (row) => row.label,
      ),
    ).toEqual(["Send (post)", "Send (send)"]);
    // Elsewhere the same names are separate tools.
    expect(canUseTools("other.example", [{ name: "merge_pull_request" }])).toEqual([
      { key: "merge_pull_request", label: "Merge pull request", names: ["merge_pull_request"] },
    ]);
  });

  test("a row shows its one rule, Mixed when its names differ, and sets or clears every name", () => {
    const [merge] = canUseTools("github.com", [{ name: "merge_pull_request" }]);
    const rules = [
      { connector: "github.com", tool: "merge_pull_request", permission: "allow" },
      { connector: "github.com", tool: "pull_request_merge", permission: "ask" },
      { connector: "other.example", tool: "pull_request_merge", permission: "block" },
    ] as const;
    // Never a stricter choice than one name has: differing or partial rules are Mixed.
    expect(canUseToolPermission(rules, "github.com", merge!)).toBe("mixed");
    expect(canUseToolPermission(rules.slice(0, 1), "github.com", merge!)).toBe("mixed");
    expect(
      canUseToolPermission(
        withAgentToolRules(rules, "github.com", merge!.names, "ask"),
        "github.com",
        merge!,
      ),
    ).toBe("ask");
    expect(canUseToolPermission([], "github.com", merge!)).toBeUndefined();
    expect(withAgentToolRules(rules, "github.com", merge!.names, "block")).toEqual([
      rules[2],
      { connector: "github.com", tool: "pull_request_merge", permission: "block" },
      { connector: "github.com", tool: "merge_pull_request", permission: "block" },
    ]);
    expect(withAgentToolRules(rules, "github.com", merge!.names, null)).toEqual([rules[2]]);
  });
});
