/**
 * Prompt-cache invariant: every provider caches a request by its prefix
 * (tools, system prompt, then the conversation), so a request must repeat the
 * previous request of its chat byte for byte and only append. Text an earlier
 * request sent must never change, whatever happens to the chat in between.
 *
 * Each case runs a chat through the production worker phases and the
 * production model clients of one provider wire, applies one mid-session
 * transition, runs the next turn, and compares the two requests. A transition
 * that legitimately starts a new prefix (compaction replaces the history) is
 * still held to an unchanged system prompt and tool list.
 */
import { describe, expect, test } from "bun:test";
import { storedToolResultView } from "@opengeni/runtime";
import {
  INITIAL_STATE,
  WIRES,
  agentConfig,
  prefixChat,
  type CapturedRequest,
  type SessionState,
  type TurnTrigger,
  type Wire,
} from "./fixtures/prefix-session";
import {
  chat as liveChat,
  claudeModel,
  liveBox,
  responsesModel,
} from "../../../packages/runtime/test/live-chat-fixture";

type Transition = {
  name: string;
  /** The chat's state before the transition (on top of the initial state). */
  before?: Partial<SessionState>;
  /** What the transition changes. */
  after?: Partial<SessionState>;
  /** What starts the turn after the transition. */
  trigger?: TurnTrigger;
  /** Something the transition does to the chat itself. */
  act?: (chat: ReturnType<typeof prefixChat>) => void;
  /** The conversation may start over (compaction); system and tools may not change. */
  conversationResets?: boolean;
};

const MESSAGE: TurnTrigger = { kind: "message", text: "What is the status?" };

/**
 * A result too large to show whole reaches history as its view, rendered
 * once when it arrived. One in the format sessions carried before the partial
 * marker and listed reader, one in the current format.
 */
const CUT_RESULT_ID = "77777777-7777-4777-8777-777777777777";
const CUT_HEAD = "row ".repeat(9_000);
const CUT_VIEWS = {
  "earlier format": `${CUT_HEAD}\n[Opengeni: this tool result is 68818 bytes, more than the 40000 bytes one result may show, so it is stored whole. Shown above: bytes 0 to 36000. Read on with tool_result_read {"resultId":"${CUT_RESULT_ID}","offset":36000}; load tool_result_read by that exact name with tool search first.]`,
  "current format": storedToolResultView({
    text: "row ".repeat(17_205),
    stored: {
      resultId: CUT_RESULT_ID,
      byteSize: 68_820,
      sandboxPath: null,
    },
    inlineMaxBytes: 40_000,
    readers: { reader: "listed", shell: false },
    shape: "head",
  }).text,
} as const;

export const TRANSITIONS: readonly Transition[] = [
  { name: "an ordinary next turn" },
  { name: "the first goal is set", after: { goal: "active" } },
  { name: "the goal is paused", before: { goal: "active" }, after: { goal: "paused" } },
  { name: "the goal is resumed", before: { goal: "paused" }, after: { goal: "active" } },
  { name: "the goal is completed", before: { goal: "active" }, after: { goal: "completed" } },
  {
    name: "a goal continuation wakes the chat",
    before: { goal: "active" },
    trigger: { kind: "goal_continuation" },
  },
  { name: "a scheduled run wakes the chat", trigger: { kind: "scheduled", text: "Daily check." } },
  {
    name: "a child session's result wakes the chat",
    trigger: { kind: "child_result", text: "The report is ready." },
  },
  {
    name: "a file is attached",
    trigger: { kind: "message", text: "Read this.", attachment: true },
  },
  { name: "the chat is compacted", act: (chat) => chat.compact(), conversationResets: true },
  { name: "a Connected Machine is attached", after: { machineAttached: true } },
  {
    name: "the Connected Machine is detached",
    before: { machineAttached: true },
    after: { machineAttached: false },
  },
  { name: "the turn's attempt restarts", act: (chat) => chat.restartAttempt() },
  // Every provider caches per model, so a switch starts a new cache whatever
  // the request says; the system prompt and tools must still not change.
  { name: "the model changes within the provider", after: { model: 1 }, conversationResets: true },
  { name: "another account of the provider serves the turn", after: { credential: "second" } },
  { name: "a connector is connected", after: { connectors: ["customer-crm"] } },
  {
    name: "a connector is disconnected",
    before: { connectors: ["customer-crm"] },
    after: { connectors: [] },
  },
  { name: "tool search was used", after: { toolRouterInHistory: true } },
  { name: "a Skill is installed", after: { skills: ["release-notes", "incident-review"] } },
  { name: "the last Skill is removed", after: { skills: [] } },
  { name: "workspace governance changes", after: { governance: "Write in plain Norwegian." } },
  { name: "the agent's instructions are edited", after: { agentInstructions: "Ship carefully." } },
  { name: "the chat gets a title", before: { titled: false }, after: { titled: true } },
  { name: "the chat is switched to work unattended", after: { unattendedNow: true } },
  { name: "the workspace turns off agent questions", after: { humanInputEnabled: false } },
  { name: "the workspace turns Knowledge learning off", after: { knowledgeLearning: "off" } },
];

/**
 * Known breaks, each with the change that fixes it. A listed case is expected
 * to fail; once its fix lands the case passes, `test.failing` fails, and the
 * entry must be removed. Never add an entry to make a new change pass.
 */
const KNOWN_BREAKS: Readonly<Record<string, string>> = {};

/**
 * Accepted changes: the request follows a real change in what the agent can
 * do, at the cost of one cold request when it happens. Each is rare enough
 * that a stable prefix is not worth offering a capability the turn lacks.
 * They are not open bugs. An entry here is a design decision: add one only
 * with that decision recorded, and remove it when the design changes.
 */
const ACCEPTED_CHANGES: Readonly<Record<string, string>> = {
  // Background-command tools and their sentence follow whether this turn has
  // compute (#3516), so attaching or detaching a machine changes both.
  "a Connected Machine is attached": "background-command tools follow compute",
  "the Connected Machine is detached": "background-command tools follow compute",
  // request_human_input follows the workspace setting at each turn.
  "the workspace turns off agent questions": "request_human_input follows the setting",
  // A learning mode set to Off drops its save guidance from the system prompt
  // (prompt-tool-availability.ts).
  "the workspace turns Knowledge learning off": "learning modes render into the system prompt",
};

/** How a case is expected to end: passing, a known break or an accepted change. */
function expectedBreak(...names: string[]): string | undefined {
  for (const name of names) {
    if (KNOWN_BREAKS[name]) return `known break: ${KNOWN_BREAKS[name]}`;
    if (ACCEPTED_CHANGES[name]) return `accepted change: ${ACCEPTED_CHANGES[name]}`;
  }
  return undefined;
}

function firstDifference(previous: readonly string[], next: readonly string[]) {
  for (let index = 0; index < previous.length; index++) {
    if (previous[index] !== next[index]) return index;
  }
  return -1;
}

function clip(text: string | undefined, at = 0) {
  if (text === undefined) return "(missing)";
  const start = Math.max(0, at - 80);
  return `${start ? "…" : ""}${text.slice(start, at + 240)}${text.length > at + 240 ? "…" : ""}`;
}

function charDifference(a: string, b: string) {
  let index = 0;
  while (index < a.length && a[index] === b[index]) index++;
  return index;
}

/** Every way `next` fails to repeat `previous`, in plain words. */
export function prefixBreaks(
  previous: CapturedRequest,
  next: CapturedRequest,
  options: { conversationResets?: boolean } = {},
): string[] {
  const breaks: string[] = [];
  if (previous.prefix.system !== next.prefix.system) {
    const at = charDifference(previous.prefix.system, next.prefix.system);
    breaks.push(
      `system prompt changed at character ${at}:\n  before: ${clip(previous.prefix.system, at)}\n  after:  ${clip(next.prefix.system, at)}`,
    );
  }
  const tools = firstDifference(previous.prefix.tools, next.prefix.tools);
  if (tools >= 0 || previous.prefix.tools.length !== next.prefix.tools.length) {
    const names = (list: readonly string[]) =>
      list.map((tool) => {
        const parsed = JSON.parse(tool) as { name?: string; type?: string };
        return parsed.name ?? parsed.type ?? "?";
      });
    const before = new Set(names(previous.prefix.tools));
    const after = new Set(names(next.prefix.tools));
    const added = [...after].filter((name) => !before.has(name));
    const removed = [...before].filter((name) => !after.has(name));
    breaks.push(
      `tools changed at position ${tools >= 0 ? tools : previous.prefix.tools.length}` +
        (added.length ? `; added ${added.join(", ")}` : "") +
        (removed.length ? `; removed ${removed.join(", ")}` : "") +
        (!added.length && !removed.length && tools >= 0
          ? `:\n  before: ${clip(previous.prefix.tools[tools])}\n  after:  ${clip(next.prefix.tools[tools])}`
          : ""),
    );
  }
  if (!options.conversationResets) {
    const items = firstDifference(previous.prefix.items, next.prefix.items);
    if (items >= 0) {
      const before = previous.prefix.items[items]!;
      const after = next.prefix.items[items];
      const at = after === undefined ? 0 : charDifference(before, after);
      breaks.push(
        `conversation item ${items} of ${previous.prefix.items.length} changed:\n  before: ${clip(before, at)}\n  after:  ${clip(after, at)}`,
      );
    }
  }
  return breaks;
}

async function runTransition(wire: Wire, transition: Transition) {
  const chat = prefixChat(wire);
  const before: SessionState = { ...INITIAL_STATE, ...transition.before };
  // Two turns before the transition, so the compared request carries a
  // conversation of earlier turns, not only the first message.
  await chat.turn(before, { kind: "message", text: "Hello." });
  await chat.turn(before, MESSAGE);
  chat.transition(transition.name);
  transition.act?.(chat);
  await chat.turn({ ...before, ...transition.after }, transition.trigger ?? MESSAGE);
  const transitioned = chat.requests.findIndex((request) => request.transition === transition.name);
  expect(transitioned).toBeGreaterThan(0);
  return prefixBreaks(chat.requests[transitioned - 1]!, chat.requests[transitioned]!, transition);
}

for (const wire of WIRES) {
  describe(`${wire.name}: a request repeats the previous request's prefix`, () => {
    for (const transition of TRANSITIONS) {
      const known = expectedBreak(`${wire.name}: ${transition.name}`, transition.name);
      const run = known ? test.failing : test;
      run(
        `after ${transition.name}${known ? ` (${known})` : ""}`,
        async () => {
          expect(await runTransition(wire, transition)).toEqual([]);
        },
        60_000,
      );
    }
    test("a new child capacity explanation appends without changing a delivered notice", async () => {
      const chat = prefixChat(wire);
      const before =
        "Worker is blocked: no Codex subscription has capacity and no reset time is known.";
      const after = "The Codex account “Primary” needs a new sign-in. An admin must reconnect it.";
      await chat.turn(INITIAL_STATE, { kind: "message", text: "Check on the worker." });
      await chat.turn(INITIAL_STATE, {
        kind: "child_capacity_wait",
        noticeId: "old-wait",
        summary: before,
      });
      await chat.turn(INITIAL_STATE, {
        kind: "child_capacity_wait",
        noticeId: "new-wait",
        summary: after,
      });
      const previous = chat.requests.at(-2)!;
      const next = chat.requests.at(-1)!;
      expect(prefixBreaks(previous, next)).toEqual([]);
      expect(next.prefix.items.join("\n")).toContain(before);
      expect(next.prefix.items.join("\n")).toContain(after);
    }, 60_000);
    for (const [format, view] of Object.entries(CUT_VIEWS)) {
      test(`a cut tool result in history (${format}) replays byte for byte; the tools stay`, async () => {
        const chat = prefixChat(wire);
        await chat.turn(INITIAL_STATE, { kind: "message", text: "Hello." });
        await chat.turn(INITIAL_STATE, MESSAGE);
        chat.addToolResult("call-cut-result", "knowledge_search", view);
        await chat.turn(INITIAL_STATE, { kind: "message", text: "Use the list." });
        await chat.turn(INITIAL_STATE, MESSAGE);
        const [first, second, third] = chat.requests.slice(-3);
        expect(prefixBreaks(first!, second!)).toEqual([]);
        expect(prefixBreaks(second!, third!)).toEqual([]);
        // The view reaches both later requests whole, as it was stored.
        const marker = JSON.stringify(view).slice(1, -1);
        for (const request of [second!, third!])
          expect(request.prefix.items.join("\n")).toContain(marker);
        expect(third!.prefix.tools).toEqual(first!.prefix.tools);
        // A new chat carries the reader the view names from its first request.
        expect(first!.prefix.tools.some((tool) => tool.includes('"tool_result_read"'))).toBe(true);
      }, 60_000);
    }
  });
}

// Where a chat runs is the other half of its state: a sandbox restarts, or the
// chat moves to another machine. These cases run real boxes (the runtime's
// live-chat fixture), each with its own backend and workspace root, on the
// Claude and Responses wire adapters.
describe.each([
  ["anthropic", claudeModel, "plain chat"],
  ["responses", responsesModel, "plain chat"],
  ["anthropic", claudeModel, "configured agent"],
  ["responses", responsesModel, "configured agent"],
] as const)(
  "%s, %s: a request repeats the previous request's prefix when the chat's machine changes",
  (wireName, wire, agentKind) => {
    const name = `${wireName}, ${agentKind}`;
    // A configured agent composes its system prompt from modules that read
    // the turn's resources; a plain chat uses the static operational text.
    const agent = agentKind === "configured agent" ? { agentConfig: agentConfig() } : {};
    // Each side is where a turn runs: its sandbox backend and workspace root.
    // A managed sandbox and a Connected Machine render different resources.
    const managed = { backend: "docker", root: "/workspace" } as const;
    const machine = { backend: "selfhosted", root: "/home/user" } as const;
    const otherMachine = { backend: "selfhosted", root: "/Users/user" } as const;
    const placements = [
      { name: "the sandbox restarts on the same machine", from: machine, to: machine },
      { name: "the chat moves to another machine", from: machine, to: otherMachine },
      { name: "the managed sandbox restarts", from: managed, to: managed },
      {
        name: "the chat moves from a managed sandbox to a Connected Machine",
        from: managed,
        to: machine,
      },
      {
        name: "the chat moves from a Connected Machine to a managed sandbox",
        from: machine,
        to: managed,
      },
    ] as const;
    for (const placement of placements) {
      const known = expectedBreak(`${name}: ${placement.name}`, placement.name);
      (known ? test.failing : test)(
        `after ${placement.name}${known ? ` (${known})` : ""}`,
        async () => {
          const first = await liveBox(placement.from.root);
          const second = placement.to === placement.from ? first : await liveBox(placement.to.root);
          const { api, model, bodies, system, conversation } = wire(["text", "text", "text"]);
          const conversationChat = liveChat(first, model, api);
          // Each box reports its own workspace root, so a move lands on another
          // root and backend as it does in production.
          const on = (
            box: typeof first,
            side: (typeof placement)["from"] | (typeof placement)["to"],
          ) => ({
            box,
            build: {
              ...agent,
              activeSandboxBackend: side.backend,
              sandboxWorkspaceRoot: box.session.state.manifest!.root!,
            },
          });
          await conversationChat.turn("Hello.", on(first, placement.from));
          await conversationChat.turn("What is the status?", on(first, placement.from));
          await conversationChat.turn("And now?", on(second, placement.to));
          expect(bodies).toHaveLength(3);
          const breaks: string[] = [];
          if (system(bodies[1]) !== system(bodies[2])) {
            const at = charDifference(system(bodies[1]), system(bodies[2]));
            breaks.push(
              `system prompt changed at character ${at}:\n  before: ${clip(system(bodies[1]), at)}\n  after:  ${clip(system(bodies[2]), at)}`,
            );
          }
          const previous = conversation(bodies[1]).map((item) => JSON.stringify(item));
          const next = conversation(bodies[2]).map((item) => JSON.stringify(item));
          const item = firstDifference(previous, next);
          if (item >= 0) breaks.push(`conversation item ${item} changed`);
          expect(breaks).toEqual([]);
        },
        60_000,
      );
    }
  },
);
