import { expect, test } from "bun:test";

import {
  SCHEDULED_EVENT_REPOSITORY_LIMIT,
  attachesEventRepositories,
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
});
