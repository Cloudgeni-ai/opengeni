import { expect, mock, test } from "bun:test";

// The Agents list reads each agent's readiness for its own triggers: GitHub
// events only when one of them runs on GitHub events.
let tasks: unknown[] = [];
const reads: unknown[] = [];
const actualDb = await import("@opengeni/db");
mock.module("@opengeni/db", () => ({
  ...actualDb,
  listScheduledTasks: async (...args: unknown[]) => {
    reads.push(args[6]);
    return tasks;
  },
  getEventSource: async () => null,
  // A stored binding that looks fine: its owner's proof and repositories.
  listGitHubInstallationAccessForWorkspace: async () => [{ installationId: 1 }],
  hasAuditableGitHubInstallationAuthority: () => true,
}));
const {
  agentsReadinessPurposes,
  githubSetupFacts,
  ownerMissingMessage,
  setGitHubAppBindingReader,
} = await import("../src/domain/ready-made-setup-readiness");

const db = {} as never;
const fixer = { id: "agent-fixer", templateKey: "bug-fixer" };
const custom = { id: "agent-custom", templateKey: null };

function task(agentId: string, sourceKind?: string, status = "active") {
  return {
    status,
    agentConfig: { agentId },
    events: sourceKind ? { triggers: [{ sourceId: "source-1", sourceKind }] } : null,
  };
}

test("an agent with only a schedule isn't read for GitHub events", async () => {
  tasks = [task(fixer.id)];
  reads.length = 0;
  expect(await agentsReadinessPurposes(db, "ws", "user:a", [fixer, custom])).toEqual([
    { githubEvents: false },
    { githubEvents: false },
  ]);
  // One read, filtered to the listed ready-made agents.
  expect(reads).toEqual([{ agentIds: [fixer.id], activeFirst: true }]);
});

test("one GitHub-event trigger makes it need the GitHub App", async () => {
  tasks = [task(fixer.id), task(fixer.id, "github")];
  expect(await agentsReadinessPurposes(db, "ws", "user:a", [fixer])).toEqual([
    { githubEvents: true },
  ]);
});

test("with only paused triggers, those decide what it needs", async () => {
  tasks = [task(fixer.id, "github", "paused")];
  expect(await agentsReadinessPurposes(db, "ws", "user:a", [fixer])).toEqual([
    { githubEvents: true },
  ]);
  tasks = [task(fixer.id, undefined, "paused")];
  expect(await agentsReadinessPurposes(db, "ws", "user:a", [fixer])).toEqual([
    { githubEvents: false },
  ]);
});

test("a paused GitHub-event trigger doesn't count beside an active one", async () => {
  tasks = [task(fixer.id), task(fixer.id, "github", "paused")];
  expect(await agentsReadinessPurposes(db, "ws", "user:a", [fixer])).toEqual([
    { githubEvents: false },
  ]);
});

test("with no trigger yet, the one Enable turns on by default", async () => {
  // Bug fixer's default suggestion runs on a GitHub label.
  tasks = [task("someone-else", "github")];
  expect(await agentsReadinessPurposes(db, "ws", "user:a", [fixer])).toEqual([
    { githubEvents: true },
  ]);
});

test("the registered live GitHub reader wins over the stored binding", async () => {
  const settings = {
    githubAppId: "1",
    githubClientId: "client",
    githubClientSecret: "secret",
    githubAppSlug: "opengeni",
    githubAppPrivateKey: "key",
    githubPersonalOauthEnabled: false,
  } as never;
  const grant = { accountId: "acc", workspaceId: "ws", subjectId: null } as never;
  const appDb = {} as never;
  const otherDb = {} as never;
  const installed = async (database: never) =>
    (await githubSetupFacts({ db: database, settings }, grant, { githubManage: true }))
      .appInstalled;
  // No reader: the stored binding counts.
  expect(await installed(appDb)).toBe(true);
  // The live read says suspended: not connected, on every path using this database.
  setGitHubAppBindingReader(appDb, async () => false);
  expect(await installed(appDb)).toBe(false);
  // Another app's database keeps its own answer.
  expect(await installed(otherDb)).toBe(true);
  // GitHub unreachable (the live reader can't check, or throws): the stored
  // binding answers, so an outage never blocks.
  setGitHubAppBindingReader(appDb, async () => null);
  expect(await installed(appDb)).toBe(true);
  setGitHubAppBindingReader(appDb, async () => {
    throw new Error("GitHub 502");
  });
  expect(await installed(appDb)).toBe(true);
  setGitHubAppBindingReader(appDb, null);
  expect(await installed(appDb)).toBe(true);
});

test("an admin resuming someone's trigger is told who must connect what", () => {
  const github = {
    kind: "connection",
    provider: "github.com",
    name: "GitHub",
    reason: "x",
  } as never;
  const readiness = (canConnect: boolean) =>
    ({ connections: [{ provider: "github.com", canConnect }] }) as never;
  expect(ownerMissingMessage(readiness(true), github, false)).toBe(
    "Its owner needs to connect GitHub.",
  );
  // The owner can't connect it either.
  expect(ownerMissingMessage(readiness(false), github, false)).toBe(
    "Connect GitHub; its owner can't.",
  );
  expect(ownerMissingMessage(readiness(true), github, true)).toBe(
    "A GitHub admin needs to install the GitHub App.",
  );
});
