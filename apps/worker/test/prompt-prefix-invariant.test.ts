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
import {
  INITIAL_STATE,
  WIRES,
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
];

/**
 * Known breaks, each with the change that fixes it. A listed case is expected
 * to fail; once its fix lands the case passes, `test.failing` fails, and the
 * entry must be removed. Never add an entry to make a new change pass.
 */
const KNOWN_BREAKS: Readonly<Record<string, string>> = {
  // goal_resume and its sentence appear with a chat's first goal (#7163).
  "the first goal is set": "fixed by #7919",
  // The system prompt's last line names the machine's workspace root.
  "the chat moves to another machine": "fixed by #7918",
  // Background-command tools and their sentence follow whether this turn has
  // compute (#3516), so attaching or detaching a machine changes both.
  "a Connected Machine is attached": "background-command tools follow compute",
  "the Connected Machine is detached": "background-command tools follow compute",
  // request_human_input follows the workspace setting at each turn.
  "the workspace turns off agent questions": "request_human_input follows the setting",
};

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
      const known = KNOWN_BREAKS[`${wire.name}: ${transition.name}`] ?? KNOWN_BREAKS[transition.name];
      const run = known ? test.failing : test;
      run(
        `after ${transition.name}${known ? ` (known break: ${known})` : ""}`,
        async () => {
          expect(await runTransition(wire, transition)).toEqual([]);
        },
        60_000,
      );
    }
  });
}

// Where a chat runs is the other half of its state: a sandbox restarts, or the
// chat moves to another machine. These cases run real boxes (the runtime's
// live-chat fixture), each with its own workspace root, on the Claude and
// Responses wire adapters.
describe.each([
  ["anthropic", claudeModel],
  ["responses", responsesModel],
] as const)("%s: a request repeats the previous request's prefix when the chat's machine changes", (name, wire) => {
  const placements = [
    { name: "the sandbox restarts on the same machine", moves: false },
    { name: "the chat moves to another machine", moves: true },
  ] as const;
  for (const placement of placements) {
    const known = KNOWN_BREAKS[`${name}: ${placement.name}`] ?? KNOWN_BREAKS[placement.name];
    (known ? test.failing : test)(
      `after ${placement.name}${known ? ` (known break: ${known})` : ""}`,
      async () => {
        const first = await liveBox("/home/person");
        const second = placement.moves ? await liveBox("/Users/person") : first;
        const { api, model, bodies, system, conversation } = wire(["text", "text", "text"]);
        const conversationChat = liveChat(first, model, api);
        // A Connected Machine reports its own workspace root; each box has
        // its own, so a move lands on another root as it does in production.
        const on = (box: typeof first) => ({
          box,
          build: {
            activeSandboxBackend: "selfhosted" as const,
            sandboxWorkspaceRoot: box.session.state.manifest!.root!,
          },
        });
        await conversationChat.turn("Hello.", on(first));
        await conversationChat.turn("What is the status?", on(first));
        await conversationChat.turn("And now?", on(second));
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
});
