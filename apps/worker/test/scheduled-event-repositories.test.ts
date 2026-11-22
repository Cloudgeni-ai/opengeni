import { expect, test } from "bun:test";

import {
  SCHEDULED_EVENT_REPOSITORY_LIMIT,
  attachesEventRepositories,
  confirmedEventRepositoryResources,
  githubEventRepositories,
  githubEventRepositoryResource,
  sessionResourcesMatchEventRun,
} from "../src/scheduled-event-repositories";

const repository = (id: unknown, fullName: unknown, defaultBranch: unknown = "main") => ({
  sourceKind: "github" as const,
  data: { repository: { id, full_name: fullName, default_branch: defaultBranch } },
});

test("a run's GitHub events name their distinct, well-formed repositories", () => {
  expect(
    githubEventRepositories([
      repository(42, "acme/api"),
      repository(42, "acme/api"),
      repository(7, "acme/web", "trunk"),
      // Not GitHub, no id, a path or a branch GitHub never sends: left out.
      { sourceKind: "slack" as const, data: { repository: { id: 9, full_name: "a/b" } } },
      repository(undefined, "acme/old"),
      repository(8, "acme/../etc"),
      repository(10, "acme/x", "bad branch"),
      { sourceKind: "github" as const, data: {} },
    ]),
  ).toEqual([
    { id: 42, fullName: "acme/api", defaultBranch: "main" },
    { id: 7, fullName: "acme/web", defaultBranch: "trunk" },
  ]);
  expect(SCHEDULED_EVENT_REPOSITORY_LIMIT).toBe(5);
});

test("an event repository binds like the picker: App ids, default branch, best effort", () => {
  expect(
    githubEventRepositoryResource({ id: 42, fullName: "acme/api", defaultBranch: "main" }, 3),
  ).toEqual({
    kind: "repository",
    uri: "https://github.com/acme/api.git",
    ref: "main",
    provider: "github",
    mountPath: expect.any(String),
    githubRepositoryId: 42,
    githubInstallationId: 3,
    optional: true,
  });
});

test("a recovered event run's chat may add only its events' repositories to the task's", () => {
  const task = [{ kind: "file", fileId: "f-1" }];
  const attached = githubEventRepositoryResource(
    { id: 42, fullName: "acme/api", defaultBranch: "main" },
    3,
  );
  const ids = new Set([42]);
  const match = (sessionResources: unknown[]) =>
    sessionResourcesMatchEventRun({
      sessionResources,
      taskResources: task,
      eventRepositoryIds: ids,
    });
  expect(match(task)).toBe(true);
  expect(match([...task, attached])).toBe(true);
  expect(match([attached, ...task])).toBe(false);
  expect(match([...task, { ...attached, githubRepositoryId: 43 }])).toBe(false);
  expect(match([...task, { kind: "file", fileId: "f-2" }])).toBe(false);
  expect(match([])).toBe(false);
});

test("only an agent's event runs in a new chat take their events' repositories", () => {
  const agentTask = { runMode: "new_session_per_run", agentConfig: { agentId: "agent-1" } };
  expect(attachesEventRepositories(agentTask, { triggerType: "event" })).toBe(true);
  expect(attachesEventRepositories(agentTask, { triggerType: "schedule" })).toBe(false);
  expect(
    attachesEventRepositories(
      { ...agentTask, runMode: "existing_session" },
      { triggerType: "event" },
    ),
  ).toBe(false);
  expect(
    attachesEventRepositories(
      { runMode: "new_session_per_run", agentConfig: {} },
      { triggerType: "event" },
    ),
  ).toBe(false);
  // A task with a repository of its own keeps exactly that one.
  expect(
    attachesEventRepositories(
      {
        ...agentTask,
        agentConfig: { ...agentTask.agentConfig, resources: [{ kind: "repository" }] },
      },
      { triggerType: "event" },
    ),
  ).toBe(false);
});

test("an event's repository is attached only as GitHub names the allowlisted id", async () => {
  const github = new Map([
    ["acme/api", { id: 42, fullName: "acme/api", defaultBranch: "main" }],
    ["acme/old-name", { id: 7, fullName: "acme/new-name", defaultBranch: "trunk" }],
    ["other/public", { id: 99, fullName: "other/public", defaultBranch: "main" }],
  ]);
  const asked: string[] = [];
  const lookup = async (input: { installationId: number; owner: string; name: string }) => {
    asked.push(`${input.installationId}:${input.owner}/${input.name}`);
    if (input.name === "boom") throw new Error("GitHub timed out");
    const found = github.get(`${input.owner}/${input.name}`);
    return found ? ({ ...found, installationId: input.installationId } as never) : null;
  };
  const resources = await confirmedEventRepositoryResources(
    [
      { id: 42, fullName: "acme/api", defaultBranch: "evil" },
      // An allowlisted id with another repository's name: refused.
      { id: 43, fullName: "other/public", defaultBranch: "main" },
      // Renamed since: GitHub's current name and branch are attached.
      { id: 7, fullName: "acme/old-name", defaultBranch: "main" },
      // Not allowlisted: GitHub isn't even asked.
      { id: 99, fullName: "other/public", defaultBranch: "main" },
      { id: 44, fullName: "acme/boom", defaultBranch: "main" },
      { id: 45, fullName: "acme/gone", defaultBranch: "main" },
    ],
    new Map([
      [42, 3],
      [43, 3],
      [7, 4],
      [44, 3],
      [45, 3],
    ]),
    lookup,
    "run-1",
  );
  expect(
    resources.map((resource) => [
      resource.uri,
      resource.ref,
      resource.githubRepositoryId,
      resource.githubInstallationId,
    ]),
  ).toEqual([
    ["https://github.com/acme/api.git", "main", 42, 3],
    ["https://github.com/acme/new-name.git", "trunk", 7, 4],
  ]);
  expect(asked.filter((each) => each.endsWith("other/public"))).toEqual(["3:other/public"]);
});
