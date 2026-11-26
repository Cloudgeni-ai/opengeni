import { expect, test } from "bun:test";

import { t } from "../src/app/lib/console-text";
import {
  agentTriggerAccess,
  agentTriggerConfirmation,
  agentTriggerDetails,
  agentTriggerOutcomeSuggestion,
  agentTriggerRepositoriesOf,
  agentTriggerRunsAs,
  agentTriggerSentence,
  agentTriggerShapeOfSuggestion,
  agentTriggerShapeOfTask,
} from "../src/app/components/agents/agent-trigger-words";
import { agentStartsWords, agentStatus } from "../src/app/components/agents/agent-status";
import { gitHubRepositoryResource } from "../src/app/lib/session-tools";

const NOW = new Date("2026-11-26T10:00:00.000Z");
const GITHUB = { id: "source-gh", name: "Platform GitHub", kind: "github" };
const context = { agentName: "Bug fixer", now: NOW };

function task(patch: Record<string, unknown>) {
  return {
    schedule: { type: "manual" },
    events: null,
    agentConfig: { agentId: "agent-1" },
    ownerSubjectId: "user-me",
    visibility: "workspace",
    creatorLocked: false,
    ...patch,
  } as never;
}

test("a trigger reads as a sentence in the catalog's plain words, never its event names", () => {
  const labelled = agentTriggerShapeOfTask(
    task({
      events: {
        triggers: [
          {
            sourceId: "source-gh",
            eventTypes: ["issues.labeled"],
            conditions: [
              { field: "data.label", op: "equals", value: "bug" },
              { field: "data.repository.full_name", op: "equals", value: "acme/api" },
            ],
          },
        ],
      },
    }),
    [GITHUB],
  );
  expect(agentTriggerSentence(t, labelled, context)).toBe(
    "When an issue in acme/api gets the label bug",
  );
  // The raw events are only in its details.
  expect(agentTriggerDetails(labelled)).toBe("issues.labeled from Platform GitHub");

  const pr = agentTriggerShapeOfSuggestion(
    agentTriggerOutcomeSuggestion("pull_request_opens", context)!,
  );
  expect(agentTriggerSentence(t, pr, context)).toBe("When a pull request opens");
  const mention = agentTriggerShapeOfSuggestion(
    agentTriggerOutcomeSuggestion("mentioned", context)!,
  );
  expect(agentTriggerSentence(t, mention, context)).toBe(
    "When someone mentions Bug fixer on a pull request",
  );

  // Anything else takes the event catalog's description.
  const failed = agentTriggerShapeOfTask(
    task({ events: { triggers: [{ sourceId: "source-ws", eventTypes: ["turn.failed"] }] } }),
    [{ id: "source-ws", name: "This workspace", kind: "workspace" }],
  );
  const sentence = agentTriggerSentence(t, failed, {
    ...context,
    eventDescription: (_source, type) =>
      type === "turn.failed" ? "A chat stopped with an error." : undefined,
  });
  expect(sentence).toBe("When a chat stopped with an error");
  expect(sentence).not.toContain("turn.failed");
  expect(agentTriggerSentence(t, failed, context)).toBe(
    "When an event arrives from This workspace",
  );
});

test("a schedule trigger names the repository its runs open, and reads it back", () => {
  const resource = gitHubRepositoryResource(
    {
      id: 1,
      fullName: "acme/api",
      cloneUrl: "https://github.com/acme/api.git",
      defaultBranch: "main",
    } as never,
    "",
  );
  const saved = task({
    schedule: {
      type: "calendar",
      hour: 9,
      minute: 0,
      daysOfWeek: ["MONDAY"],
      timeZone: "Europe/Oslo",
    },
    agentConfig: { agentId: "agent-1", resources: [resource] },
  });
  expect(agentTriggerRepositoriesOf(saved)).toEqual(["acme/api"]);
  const sentence = agentTriggerSentence(t, agentTriggerShapeOfTask(saved, []), context);
  expect(sentence).toStartWith("Every Monday");
  expect(sentence).toEndWith(", on acme/api");
});

test("Runs as says whose access a trigger uses", () => {
  const nameOf = (subjectId: string) => (subjectId === "user-ada" ? "Ada Berg" : null);
  expect(agentTriggerRunsAs(task({ ownerSubjectId: "user-me" }), "user-me", nameOf)).toBe(
    "Runs as you",
  );
  expect(agentTriggerRunsAs(task({ ownerSubjectId: "user-ada" }), "user-me", nameOf)).toBe(
    "Runs as Ada Berg",
  );
  expect(
    agentTriggerRunsAs(
      task({ ownerSubjectId: "user-kari", createdBy: { subjectId: "user-kari", label: "Kari" } }),
      "user-me",
      nameOf,
    ),
  ).toBe("Runs as Kari");
  expect(agentTriggerRunsAs(task({ ownerSubjectId: "user-x" }), "user-me", nameOf)).toBe(
    "Runs as its owner",
  );
  expect(agentTriggerRunsAs(task({ ownerSubjectId: null }), "user-me")).toBe(
    "Runs as the workspace",
  );
});

test("only its owner switches and removes a trigger; an admin may only switch a shared one", () => {
  const member = { subjectId: "user-me", canManage: true, isAdmin: false };
  const admin = { subjectId: "user-admin", canManage: true, isAdmin: true };
  const reader = { subjectId: "user-me", canManage: false, isAdmin: false };
  const own = task({ ownerSubjectId: "user-me" });
  const someoneElses = task({ ownerSubjectId: "user-ada" });
  expect(agentTriggerAccess(own, member)).toMatchObject({ canToggle: true, canRemove: true });
  expect(agentTriggerAccess(someoneElses, member)).toMatchObject({
    canToggle: false,
    canRemove: false,
  });
  expect(agentTriggerAccess(someoneElses, member).reason).toBeTruthy();
  expect(agentTriggerAccess(someoneElses, admin)).toMatchObject({
    canToggle: true,
    canRemove: false,
  });
  expect(
    agentTriggerAccess(task({ ownerSubjectId: "user-ada", visibility: "private" }), admin),
  ).toMatchObject({ canToggle: false });
  expect(agentTriggerAccess(own, reader)).toMatchObject({ canToggle: false, canRemove: false });
  expect(
    agentTriggerAccess(task({ ownerSubjectId: "user-me", creatorLocked: true }), member),
  ).toMatchObject({ canToggle: false, canRemove: false });
});

test("Add trigger's outcomes save as GitHub triggers, and the confirmation says who and whose access", () => {
  const labelled = agentTriggerOutcomeSuggestion("issue_labelled", { ...context, label: "p1" })!;
  expect(labelled.triggers[0]).toMatchObject({
    source: { kind: "github" },
    eventTypes: ["issues.labeled"],
    conditions: [{ field: "data.label", op: "equals", value: "p1" }],
  });
  expect(agentTriggerOutcomeSuggestion("schedule", context)).toBeNull();
  const confirmation = agentTriggerConfirmation({
    agentName: "Bug fixer",
    sentence: "When a pull request opens",
    outcome: "pull_request_opens",
  });
  expect(confirmation.headline).toBe("Bug fixer starts when a pull request opens.");
  expect(confirmation.detail).toContain("Anyone who can open a pull request there can start it.");
  expect(confirmation.detail).toContain("uses your GitHub access");
});

test("one status per agent: working, what it needs, steps left, ready, off or on call", () => {
  const on = [{ status: "active" }] as never;
  const off = [{ status: "paused" }] as never;
  expect(agentStatus({ triggers: on, working: true })?.label).toBe("Working now");
  expect(
    agentStatus({
      triggers: on,
      readiness: { ready: false, missingConnections: ["PostHog"], stepsLeft: 1 },
    })?.label,
  ).toBe("Needs PostHog");
  expect(
    agentStatus({ triggers: on, readiness: { ready: false, missingConnections: [], stepsLeft: 1 } })
      ?.label,
  ).toBe("1 step left");
  expect(
    agentStatus({
      triggers: on,
      readiness: { ready: false, missingConnections: ["GitHub", "Linear"], stepsLeft: 3 },
    })?.label,
  ).toBe("3 steps left");
  expect(
    agentStatus({ triggers: on, readiness: { ready: true, missingConnections: [], stepsLeft: 0 } })
      ?.label,
  ).toBe("Ready");
  expect(agentStatus({ triggers: off })?.label).toBe("Off");
  expect(agentStatus({ triggers: off, inSlack: true })?.label).toBe("On call");
  expect(agentStatus({ triggers: [] })?.label).toBe("On call");
  expect(agentStatus({ triggers: null })).toBeNull();
  expect(agentStartsWords(["When a pull request opens"])).toBe("When a pull request opens");
  expect(agentStartsWords(["a", "b"])).toBe("2 triggers");
  expect(agentStartsWords([], { inSlack: true })).toBe("Answers when asked here or in Slack");
});
