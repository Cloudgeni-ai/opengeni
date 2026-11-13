import { describe, expect, test } from "bun:test";
import { teamsFullTenantMember } from "../src/integrations/teams-organization-agents";
import {
  resolveTeamsRoute,
  teamsAgentReplyHeader,
  teamsRouteOptionNamed,
  teamsReplyHeader,
  teamsRouteOptions,
  teamsRouteTargetOffered,
  teamsSwitchCardText,
  teamsSwitchCommand,
  type TeamsRouteDirectory,
} from "../src/integrations/teams-routing";

const directory = (overrides: Partial<TeamsRouteDirectory> = {}): TeamsRouteDirectory => ({
  candidates: [
    { workspaceId: "home", label: "Home", personal: false },
    { workspaceId: "research", label: "Research", personal: false },
  ],
  agents: [
    {
      id: "planner",
      name: "Planner",
      nameKey: "planner",
      targetAccountId: "org",
      targetWorkspaceId: "research",
      targetWorkspaceLabel: "Research",
      usable: true,
      member: true,
      open: false,
    },
    {
      id: "auditor",
      name: "Auditor",
      nameKey: "auditor",
      targetAccountId: "org",
      targetWorkspaceId: "finance",
      targetWorkspaceLabel: "Finance",
      usable: false,
      member: false,
      open: false,
    },
  ],
  personalWorkspaceId: null,
  ...overrides,
});
const route = (
  text: string,
  choice: { workspaceId: string; agentId: string | null } | null = null,
) => resolveTeamsRoute({ text, appName: "Opengeni Assistant", directory: directory(), choice });

describe("Teams switch commands", () => {
  test("only a whole message is a command", () => {
    expect(teamsSwitchCommand("switch")).toEqual({ kind: "list" });
    expect(teamsSwitchCommand(" Workspaces. ")).toEqual({ kind: "list" });
    expect(teamsSwitchCommand("/agents")).toEqual({ kind: "list" });
    expect(teamsSwitchCommand("switch 2")).toEqual({ kind: "pick", position: 2 });
    expect(teamsSwitchCommand("switch to Research")).toEqual({ kind: "named", name: "Research" });
    expect(teamsSwitchCommand("switch +planner")).toEqual({ kind: "named", name: "+planner" });
    // "use" is an ordinary word: "use Postgres instead" is a request.
    expect(teamsSwitchCommand("use Postgres instead")).toBeNull();
    expect(teamsSwitchCommand("use +planner")).toBeNull();
    expect(teamsSwitchCommand("switch the deploy to blue-green please")).toEqual({
      kind: "named",
      name: "the deploy to blue-green please",
    });
    expect(teamsSwitchCommand("Can you switch the order?")).toBeNull();
    expect(teamsSwitchCommand("switch " + "x".repeat(300))).toBeNull();
  });
});

describe("where a Teams 1:1 message goes", () => {
  test("in <Workspace>: is one message, and a workspace without access is refused", () => {
    expect(route("in research: run the numbers", { workspaceId: "home", agentId: null })).toEqual(
      expect.objectContaining({
        kind: "resolved",
        target: { workspaceId: "research", agentId: null },
        text: "run the numbers",
        source: "prefix",
        remember: false,
        announce: true,
      }),
    );
    expect(route("in Finance: show the ledger")).toEqual({
      kind: "denied",
      text: "You can't start work in a workspace called **Finance**. Your workspaces: Home, Research. No chat was started.",
    });
  });

  test("an agent addressed by name answers and becomes the chat's choice", () => {
    for (const text of ["Planner: draft it", "+planner draft it", "planner, draft it"])
      expect(route(text)).toEqual(
        expect.objectContaining({
          kind: "resolved",
          target: { workspaceId: "research", agentId: "planner" },
          agentName: "Planner",
          workspaceLabel: "Research",
          text: "draft it",
          remember: true,
        }),
      );
    expect(route("+planner")).toEqual({
      kind: "switched",
      target: { workspaceId: "research", agentId: "planner" },
      workspaceLabel: "Research",
      agentName: "Planner",
    });
    // An agent whose workspace the person can't use is named, never served elsewhere.
    expect(route("+auditor check")).toEqual({
      kind: "denied",
      text: "**Auditor** works in the **Finance** workspace, which you don't have access to. Ask an admin of that workspace for access. No chat was started.",
    });
    // A sentence that merely starts with a name is ordinary text.
    expect(route("Planner reviews look fine").kind).toBe("ask");
  });

  test("the app's own name goes back to the main assistant in the chat's workspace", () => {
    expect(
      route("Opengeni Assistant: summarize", { workspaceId: "research", agentId: "planner" }),
    ).toEqual(
      expect.objectContaining({
        kind: "resolved",
        target: { workspaceId: "research", agentId: null },
        text: "summarize",
        source: "main",
      }),
    );
    // A remembered workspace that no longer works is refused, never swapped
    // for the Personal or only workspace.
    expect(
      route("Opengeni Assistant: summarize", { workspaceId: "finance", agentId: null }),
    ).toEqual({
      kind: "denied",
      text: "You can no longer start chats in **the workspace this chat used** from Teams. Send **switch** to choose another. No chat was started.",
      forgetChoice: true,
    });
    expect(
      resolveTeamsRoute({
        text: "Opengeni:",
        appName: "Opengeni Assistant",
        directory: directory({ personalWorkspaceId: "home" }),
        choice: { workspaceId: "finance", agentId: null },
      }).kind,
    ).toBe("denied");
  });

  test("a remembered choice is used while it works and refused once it doesn't", () => {
    expect(route("next step", { workspaceId: "research", agentId: null })).toEqual(
      expect.objectContaining({ kind: "resolved", source: "choice", remember: false }),
    );
    expect(route("next step", { workspaceId: "finance", agentId: null })).toEqual({
      kind: "denied",
      text: "You can no longer start chats in **the workspace this chat used** from Teams. Send **switch** to choose another. No chat was started.",
      forgetChoice: true,
    });
  });

  test("Personal first, then a sole workspace, otherwise ask", () => {
    const withPersonal = directory({
      candidates: [
        { workspaceId: "home", label: "Home", personal: false },
        { workspaceId: "mine", label: "Personal", personal: true },
      ],
      personalWorkspaceId: "mine",
    });
    expect(
      resolveTeamsRoute({ text: "hi", appName: "Opengeni", directory: withPersonal, choice: null }),
    ).toEqual(
      expect.objectContaining({
        source: "personal",
        target: { workspaceId: "mine", agentId: null },
      }),
    );
    const sole = directory({
      candidates: [{ workspaceId: "home", label: "Home", personal: false }],
      agents: [],
    });
    expect(
      resolveTeamsRoute({ text: "hi", appName: "Opengeni", directory: sole, choice: null }),
    ).toEqual(expect.objectContaining({ source: "sole", announce: false }));
    expect(route("hi").kind).toBe("ask");
    expect(
      resolveTeamsRoute({
        text: "hi",
        appName: "Opengeni",
        directory: directory({ candidates: [], agents: [] }),
        choice: null,
      }).kind,
    ).toBe("denied");
  });
});

describe("the switch card", () => {
  test("lists usable agents, then workspaces with Personal first, numbered", () => {
    const options = teamsRouteOptions(
      directory({
        candidates: [
          { workspaceId: "home", label: "Home", personal: false },
          { workspaceId: "mine", label: "Personal", personal: true },
        ],
      }),
    );
    expect(options.map((option) => option.title)).toEqual(["Planner", "Personal", "Home"]);
    expect(teamsSwitchCardText(options, { workspaceLabel: "Home", agentName: null }, false)).toBe(
      [
        "This chat uses **Home**. Choose another workspace or agent.",
        "1. **Planner** · Agent in Research\n2. **Personal** · Your Personal workspace\n3. **Home** · Workspace",
        "Select one, or send **switch** and its number.",
      ].join("\n\n"),
    );
    expect(teamsRouteOptionNamed(directory(), "+Planner")).toEqual(
      expect.objectContaining({ agentId: "planner" }),
    );
    expect(teamsRouteOptionNamed(directory(), "Finance")).toBeNull();
  });

  test("an agent's replies say who answered and where", () => {
    expect(teamsAgentReplyHeader("Planner", "Research")).toBe("**Planner** · Research");
  });
});

describe("agents anyone in the organization may use", () => {
  const open = (overrides: Partial<TeamsRouteDirectory> = {}) => {
    const base = directory(overrides);
    return {
      ...base,
      agents: base.agents.map((agent) =>
        agent.id === "auditor" ? { ...agent, open: true, usable: true } : agent,
      ),
    };
  };
  const finance = { workspaceId: "finance", agentId: "auditor" };

  test("are offered, addressed and remembered outside the person's workspaces", () => {
    const d = open();
    expect(teamsRouteOptions(d).map((option) => option.title)).toContain("Auditor");
    expect(
      resolveTeamsRoute({
        text: "Auditor: check",
        appName: "Opengeni",
        directory: d,
        choice: null,
      }),
    ).toEqual(
      expect.objectContaining({ kind: "resolved", target: finance, workspaceLabel: "Finance" }),
    );
    expect(
      resolveTeamsRoute({
        text: "and the ledger?",
        appName: "Opengeni",
        directory: d,
        choice: finance,
      }),
    ).toEqual(
      expect.objectContaining({
        kind: "resolved",
        target: finance,
        workspaceLabel: "Finance",
        agentName: "Auditor",
        source: "choice",
      }),
    );
    // Closed again: the remembered agent is refused by its workspace's name.
    expect(route("and the ledger?", finance)).toEqual({
      kind: "denied",
      text: "You can no longer start chats in **Finance** from Teams. Send **switch** to choose another. No chat was started.",
      forgetChoice: true,
    });
  });

  test("the app's name leaves one for the person's own workspace, never the agent's", () => {
    const sole = open({ candidates: [{ workspaceId: "home", label: "Home", personal: false }] });
    expect(
      resolveTeamsRoute({
        text: "Opengeni: hello",
        appName: "Opengeni",
        directory: sole,
        choice: finance,
      }),
    ).toEqual(
      expect.objectContaining({ kind: "resolved", target: { workspaceId: "home", agentId: null } }),
    );
    expect(
      resolveTeamsRoute({
        text: "Opengeni: hello",
        appName: "Opengeni",
        directory: open(),
        choice: finance,
      }).kind,
    ).toBe("ask");
  });

  test("a switch card keeps room for workspaces however many agents there are", () => {
    const agents = Array.from({ length: 600 }, (_, n) => ({
      id: `agent-${n}`,
      name: `Agent ${n}`,
      nameKey: `agent ${n}`,
      targetAccountId: "org",
      targetWorkspaceId: "finance",
      targetWorkspaceLabel: "Finance",
      usable: true,
      member: false,
      open: true,
    }));
    const candidates = Array.from({ length: 80 }, (_, n) => ({
      workspaceId: `w${n}`,
      label: `W${n}`,
      personal: false,
    }));
    const d = directory({ agents, candidates });
    const options = teamsRouteOptions(d);
    expect(options).toHaveLength(100);
    expect(options.filter((option) => option.agentId === null)).toHaveLength(50);
    // Beyond the card, a name still finds it, and a stored pick of it is still offered.
    expect(teamsRouteOptionNamed(d, "Agent 599")).toEqual(
      expect.objectContaining({ agentId: "agent-599" }),
    );
    expect(teamsRouteTargetOffered(d, { workspaceId: "finance", agentId: "agent-599" })).toBe(true);
    expect(teamsRouteTargetOffered(d, { workspaceId: "w1", agentId: "agent-599" })).toBe(false);
  });

  test("only a full member of the connected tenant may ask, as Teams says", () => {
    const expected = { tenantId: "Tenant", actorId: "Actor" };
    expect(
      teamsFullTenantMember(
        { userRole: "user", tenantId: "tenant", aadObjectId: "actor" },
        expected,
      ),
    ).toBe(true);
    for (const facts of [
      null,
      { userRole: "guest", tenantId: "tenant", aadObjectId: "actor" },
      { userRole: "anonymous", tenantId: "tenant", aadObjectId: "actor" },
      { tenantId: "tenant", aadObjectId: "actor" },
      { userRole: "user", tenantId: "other", aadObjectId: "actor" },
      { userRole: "user", aadObjectId: "actor" },
      { userRole: "user", tenantId: "tenant", aadObjectId: "someone-else" },
    ])
      expect(teamsFullTenantMember(facts, expected)).toBe(false);
  });

  test("a reply's header names the agent and workspace, or the workspace alone", () => {
    expect(teamsReplyHeader({ agentName: "Auditor", workspaceName: "Finance" })).toBe(
      "**Auditor** · Finance",
    );
    expect(teamsReplyHeader({ agentName: null, workspaceName: "Home" })).toBe("**Home**");
    expect(teamsReplyHeader({ agentName: null, workspaceName: null })).toBeNull();
  });
});

describe("names shared by an organization agent and the person's own agent", () => {
  const openHelper = {
    id: "open-helper",
    name: "Planner",
    nameKey: "planner",
    targetAccountId: "org",
    targetWorkspaceId: "finance",
    targetWorkspaceLabel: "Finance",
    usable: true,
    member: false,
    open: true,
  };
  test("the person's own agent keeps its name", () => {
    const base = directory();
    const d = { ...base, agents: [...base.agents, openHelper] };
    const resolved = resolveTeamsRoute({
      text: "Planner: go",
      appName: "Opengeni",
      directory: d,
      choice: null,
    });
    expect(resolved).toEqual(
      expect.objectContaining({
        kind: "resolved",
        target: { workspaceId: "research", agentId: "planner" },
      }),
    );
    expect(teamsRouteOptionNamed(d, "Planner")).toEqual(
      expect.objectContaining({ agentId: "planner" }),
    );
  });
  test("switch <name> prefers the person's workspace to an organization agent of the same name", () => {
    const base = directory();
    const d = {
      ...base,
      agents: [...base.agents, { ...openHelper, name: "Home", nameKey: "home" }],
    };
    expect(teamsRouteOptionNamed(d, "Home")).toEqual(
      expect.objectContaining({ workspaceId: "home", agentId: null }),
    );
  });
  test("two organization agents with one name are ambiguous", () => {
    const d = directory({
      agents: [
        openHelper,
        { ...openHelper, id: "other", targetWorkspaceId: "sales", targetWorkspaceLabel: "Sales" },
      ],
    });
    expect(
      resolveTeamsRoute({ text: "Planner: go", appName: "Opengeni", directory: d, choice: null })
        .kind,
    ).toBe("denied");
    expect(teamsRouteOptionNamed(d, "Planner")).toBe("ambiguous");
  });
});
