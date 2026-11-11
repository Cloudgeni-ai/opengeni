import { describe, expect, test } from "bun:test";
import {
  resolveTeamsRoute,
  teamsAgentReplyHeader,
  teamsRouteOptionNamed,
  teamsRouteOptions,
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
    },
    {
      id: "auditor",
      name: "Auditor",
      nameKey: "auditor",
      targetAccountId: "org",
      targetWorkspaceId: "finance",
      targetWorkspaceLabel: "Finance",
      usable: false,
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
    expect(teamsSwitchCommand("use +planner")).toEqual({ kind: "named", name: "+planner" });
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
