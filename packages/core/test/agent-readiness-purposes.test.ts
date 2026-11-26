import { expect, mock, test } from "bun:test";

// The Agents list reads each agent's readiness for its own triggers: GitHub
// events only when one of them runs on GitHub events.
let tasks: unknown[] = [];
const actualDb = await import("@opengeni/db");
mock.module("@opengeni/db", () => ({
  ...actualDb,
  listScheduledTasks: async () => tasks,
  getEventSource: async () => null,
}));
const { agentsReadinessPurposes } = await import("../src/domain/ready-made-setup-readiness");

const db = {} as never;
const fixer = { id: "agent-fixer", templateKey: "bug-fixer" };
const custom = { id: "agent-custom", templateKey: null };

function task(agentId: string, sourceKind?: string) {
  return {
    agentConfig: { agentId },
    events: sourceKind ? { triggers: [{ sourceId: "source-1", sourceKind }] } : null,
  };
}

test("an agent with only a schedule isn't read for GitHub events", async () => {
  tasks = [task(fixer.id)];
  expect(await agentsReadinessPurposes(db, "ws", "user:a", [fixer, custom])).toEqual([
    { githubEvents: false },
    { githubEvents: false },
  ]);
});

test("one GitHub-event trigger makes it need the GitHub App", async () => {
  tasks = [task(fixer.id), task(fixer.id, "github")];
  expect(await agentsReadinessPurposes(db, "ws", "user:a", [fixer])).toEqual([
    { githubEvents: true },
  ]);
});

test("with no trigger yet, the one Enable turns on by default", async () => {
  // Bug fixer's default suggestion runs on a GitHub label.
  tasks = [task("someone-else", "github")];
  expect(await agentsReadinessPurposes(db, "ws", "user:a", [fixer])).toEqual([
    { githubEvents: true },
  ]);
});
