import { describe, expect, test } from "bun:test";
import {
  argHint,
  defaultCommands,
  filterCommands,
  firstMissingRequiredArg,
  hasPermission,
  matchCommand,
  parseCommandLine,
} from "../src/commands/registry";
import type { CommandContext, SlashCommand } from "../src/commands/types";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";

const ALL_PERMS = ["sessions:control" as const];

function baseFilterCtx(overrides: Partial<{ sessionId: string | null; permissions: string[] }> = {}) {
  return {
    sessionId: overrides.sessionId === undefined ? SESSION_ID : overrides.sessionId,
    status: null,
    permissions: (overrides.permissions ?? ALL_PERMS) as never,
  };
}

describe("parseCommandLine", () => {
  test("returns null for plain chat (no leading slash)", () => {
    expect(parseCommandLine("hello world")).toBeNull();
    expect(parseCommandLine("")).toBeNull();
    expect(parseCommandLine(" /clear")).toBeNull();
  });

  test("parses a bare name token (palette filtering mode)", () => {
    expect(parseCommandLine("/cle")).toEqual({ name: "cle", rest: "", hasTrailingSpace: false, args: [] });
  });

  test("a trailing space closes the name and enters arg-hint mode", () => {
    expect(parseCommandLine("/goal ")).toEqual({ name: "goal", rest: "", hasTrailingSpace: true, args: [] });
  });

  test("splits args after the name", () => {
    expect(parseCommandLine("/goal pause")).toEqual({ name: "goal", rest: "pause", hasTrailingSpace: true, args: ["pause"] });
  });
});

describe("hasPermission", () => {
  test("no required permission is always satisfied", () => {
    expect(hasPermission(undefined, [])).toBe(true);
  });
  test("requires the exact permission, with workspace:admin as a superuser", () => {
    expect(hasPermission("sessions:control", ["sessions:control"])).toBe(true);
    expect(hasPermission("sessions:control", ["workspace:admin"])).toBe(true);
    expect(hasPermission("sessions:control", ["sessions:read"])).toBe(false);
  });
});

describe("filterCommands", () => {
  test("hides permission-gated commands entirely when the perm is absent", () => {
    const names = filterCommands(defaultCommands, "", baseFilterCtx({ permissions: [] })).map((c) => c.name);
    expect(names).toContain("help");
    expect(names).toContain("clear-view");
    expect(names).not.toContain("clear");
    expect(names).not.toContain("compact");
    expect(names).not.toContain("goal");
  });

  test("shows gated commands when the operator holds the permission", () => {
    const names = filterCommands(defaultCommands, "", baseFilterCtx()).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["help", "clear-view", "goal", "compact", "clear"]));
  });

  test("hides session-only commands until a session exists (available())", () => {
    const names = filterCommands(defaultCommands, "", baseFilterCtx({ sessionId: null })).map((c) => c.name);
    expect(names).toContain("help");
    expect(names).not.toContain("clear");
    expect(names).not.toContain("goal");
  });

  test("prefix-filters by name and alias", () => {
    expect(filterCommands(defaultCommands, "cl", baseFilterCtx()).map((c) => c.name)).toEqual(
      expect.arrayContaining(["clear", "clear-view"]),
    );
    // alias "?" resolves /help
    expect(filterCommands(defaultCommands, "?", baseFilterCtx()).map((c) => c.name)).toEqual(["help"]);
  });
});

describe("matchCommand + argHint", () => {
  test("matches by name and alias", () => {
    expect(matchCommand(defaultCommands, "/goal pause")?.name).toBe("goal");
    expect(matchCommand(defaultCommands, "/? ")?.name).toBe("help");
    expect(matchCommand(defaultCommands, "/nope")).toBeNull();
  });

  test("renders required/optional arg hints", () => {
    const goal = matchCommand(defaultCommands, "/goal pause")!;
    expect(argHint(goal.args)).toBe("<pause|resume>");
    expect(argHint(undefined)).toBe("");
  });
});

describe("firstMissingRequiredArg", () => {
  const goal = defaultCommands.find((c) => c.name === "goal")!;
  test("flags an absent required arg", () => {
    expect(firstMissingRequiredArg(goal, [])?.name).toBe("action");
  });
  test("passes once the required arg is present", () => {
    expect(firstMissingRequiredArg(goal, ["pause"])).toBeNull();
  });
});

// --- Command execution against a fake client + UI affordances ----------------

function makeCtx(overrides: Partial<CommandContext> & { client: CommandContext["client"] }): CommandContext {
  const notices: Parameters<CommandContext["notice"]>[0][] = [];
  const ctx: CommandContext = {
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    status: null,
    permissions: ALL_PERMS as never,
    notice: (n) => notices.push(n),
    openHelp: () => {},
    clearView: () => {},
    confirm: async () => true,
    ...overrides,
  };
  (ctx as unknown as { _notices: typeof notices })._notices = notices;
  return ctx;
}

function run(command: SlashCommand, args: string[], ctx: CommandContext) {
  return command.run(args, ctx);
}

describe("default command handlers", () => {
  const goal = defaultCommands.find((c) => c.name === "goal")!;
  const clear = defaultCommands.find((c) => c.name === "clear")!;
  const compact = defaultCommands.find((c) => c.name === "compact")!;
  const help = defaultCommands.find((c) => c.name === "help")!;
  const clearView = defaultCommands.find((c) => c.name === "clear-view")!;

  test("/goal pause calls updateGoal with paused", async () => {
    const calls: unknown[] = [];
    const ctx = makeCtx({ client: fakeClient({ updateGoal: async (ws, sid, req) => { calls.push([ws, sid, req]); return {} as never; } }) });
    const result = await run(goal, ["pause"], ctx);
    expect(result.status).toBe("ok");
    expect(calls[0]).toEqual([WORKSPACE_ID, SESSION_ID, { status: "paused" }]);
  });

  test("/goal resume calls updateGoal with active", async () => {
    const calls: unknown[] = [];
    const ctx = makeCtx({ client: fakeClient({ updateGoal: async (_ws, _sid, req) => { calls.push(req); return {} as never; } }) });
    await run(goal, ["resume"], ctx);
    expect(calls[0]).toEqual({ status: "active" });
  });

  test("/goal maps a 404 to a 'no goal' error notice", async () => {
    const ctx = makeCtx({ client: fakeClient({ updateGoal: async () => { throw Object.assign(new Error("nope"), { status: 404 }); } }) });
    const result = await run(goal, ["pause"], ctx);
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/no goal/i);
  });

  test("/clear confirms first, then calls clearSessionContext", async () => {
    let confirmed = false;
    let cleared = false;
    const ctx = makeCtx({
      client: fakeClient({ clearSessionContext: async () => { cleared = true; } }),
      confirm: async () => { confirmed = true; return true; },
    });
    const result = await run(clear, [], ctx);
    expect(confirmed).toBe(true);
    expect(cleared).toBe(true);
    expect(result.status).toBe("ok");
  });

  test("/clear aborts (no server call) when the operator cancels the confirm", async () => {
    let cleared = false;
    const ctx = makeCtx({
      client: fakeClient({ clearSessionContext: async () => { cleared = true; } }),
      confirm: async () => false,
    });
    const result = await run(clear, [], ctx);
    expect(cleared).toBe(false);
    expect(result.status).toBe("ok");
  });

  test("/clear maps a 409 to a 'stop the turn first' error", async () => {
    const ctx = makeCtx({
      client: fakeClient({ clearSessionContext: async () => { throw Object.assign(new Error("busy"), { status: 409 }); } }),
      confirm: async () => true,
    });
    const result = await run(clear, [], ctx);
    expect(result.status).toBe("error");
    expect(result.message).toMatch(/stop the current turn/i);
  });

  test("/compact surfaces the server result message", async () => {
    const ctx = makeCtx({ client: fakeClient({ compactSessionContext: async () => ({ status: "queued", message: "Compaction will run before the next turn." }) }) });
    const result = await run(compact, [], ctx);
    expect(result).toEqual({ status: "ok", message: "Compaction will run before the next turn." });
  });

  test("/help and /clear-view are client-only (no client calls)", async () => {
    let helped = false;
    let cleared = false;
    const ctx = makeCtx({ client: fakeClient({}), openHelp: () => { helped = true; }, clearView: () => { cleared = true; } });
    expect((await run(help, [], ctx)).status).toBe("ok");
    expect((await run(clearView, [], ctx)).status).toBe("ok");
    expect(helped).toBe(true);
    expect(cleared).toBe(true);
  });

  test("extensibility: a new command is one object literal the registry renders from", () => {
    const ping: SlashCommand = { name: "ping", description: "Ping.", run: () => ({ status: "ok", message: "pong" }) };
    const commands = [...defaultCommands, ping];
    expect(filterCommands(commands, "pi", baseFilterCtx()).map((c) => c.name)).toEqual(["ping"]);
    expect(matchCommand(commands, "/ping")?.name).toBe("ping");
  });
});
