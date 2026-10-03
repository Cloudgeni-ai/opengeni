import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  AutomationSessionTemplate,
  AutomationNormalizedEvent,
  AutomationAcceptedExecution,
  type AutomationTrigger,
  type CreateAutomationTriggerRequest,
} from "@opengeni/contracts";
import {
  createAutomationTrigger,
  getAutomationTriggerRevisions,
  updateAutomationTrigger,
  recordAutomationEvent,
  createAutomationRun,
  AutomationCredentialRestrictionConflictError,
} from "../src/automations";
import * as database from "../src/database";
import * as schema from "../src/schema";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const triggerId = "44444444-4444-4444-8444-444444444444";
const template = AutomationSessionTemplate.parse({ prompt: "Process the event" });
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

function fixture() {
  const revisions: Array<Record<string, unknown>> = [];
  let head: Record<string, unknown> = {
    id: triggerId,
    accountId,
    workspaceId,
    sourceId,
    name: "Fixture",
    status: "active",
    currentRevision: 1,
    createdBySubjectId: "service:fixture",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const handle = {
    transaction: async (run: (tx: unknown) => unknown) => run(handle),
    select: () => ({
      from: (table: unknown) => {
        const query = {
          innerJoin: () => query,
          where: () => query,
          for: () => query,
          limit: async () =>
            table === schema.automationSources
              ? [{ id: sourceId, adapterId: "signed-json.v1", status: "active" }]
              : revisions.length
                ? [{ head, revision: revisions.at(-1) }]
                : [],
          then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(revisions.map((revision) => ({ head, revision }))).then(
              resolve,
              reject,
            ),
        };
        return query;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          if (table === schema.automationTriggers) {
            head = { ...head, ...values };
            return [head];
          }
          const revision = { ...values, createdAt: new Date(0) };
          revisions.push(revision);
          return [revision];
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            head = { ...head, ...values };
            return [head];
          },
        }),
      }),
    }),
  } as unknown as database.Database;
  const scope = spyOn(database, "withWorkspaceRls").mockImplementation(
    async (_db, _workspace, run) => run(handle),
  );
  restores.push(() => scope.mockRestore());
  return { db: handle, revisions };
}

function request(): CreateAutomationTriggerRequest {
  return {
    sourceId,
    name: "Fixture",
    eventTypes: ["fixture.event"],
    configuration: {},
    parameters: {},
    sessionTemplate: template,
    status: "active",
  };
}

function createInput(credentialRestriction?: "developer_setup") {
  return {
    accountId,
    workspaceId,
    createdBySubjectId: "service:fixture",
    adapterId: "signed-json.v1",
    request: request(),
    ...(credentialRestriction ? { credentialRestriction } : {}),
  };
}

describe("automation immutable creator restriction persistence", () => {
  test("a trusted create seam persists marker in existing revision JSON and every read view", async () => {
    const state = fixture();
    const created = await createAutomationTrigger(state.db, createInput("developer_setup"));
    expect(created.sessionTemplate).toEqual({
      ...template,
      credentialRestriction: "developer_setup",
    });
    expect(state.revisions[0]?.sessionTemplate).toEqual(created.sessionTemplate);
    const historical = await getAutomationTriggerRevisions(state.db, {
      workspaceId,
      refs: [{ triggerId, revision: 1 }],
    });
    expect(historical[0]?.sessionTemplate).toEqual(created.sessionTemplate);
  });

  test("ordinary creation is unchanged and request-template metadata cannot manufacture marker", async () => {
    const state = fixture();
    const input = createInput();
    input.request.sessionTemplate = {
      ...template,
      credentialRestriction: "developer_setup",
      metadata: { credentialRestriction: "developer_setup" },
    } as CreateAutomationTriggerRequest["sessionTemplate"];
    const created = await createAutomationTrigger(state.db, input);
    expect(created.sessionTemplate).not.toHaveProperty("credentialRestriction");
    expect(created.sessionTemplate.firstPartyMcpPermissions).toEqual([]);
    expect(created.sessionTemplate.firstPartyMcpTools).toEqual([]);
  });

  test("non-setup replacement, omitted-template revisions and status cloning cannot clear marker", async () => {
    const state = fixture();
    const created = await createAutomationTrigger(state.db, createInput("developer_setup"));
    const original = structuredClone(state.revisions[0]);
    let revision = 1;
    for (const changes of [
      {
        sessionTemplate: {
          ...template,
          metadata: { credentialRestriction: "none" },
        },
      },
      { name: "Renamed" },
      { status: "disabled" as const },
    ]) {
      const requested = { expectedRevision: revision, ...changes };
      const updated = await updateAutomationTrigger(state.db, {
        workspaceId,
        triggerId,
        subjectId: "owner:ordinary",
        request: requested as never,
      });
      expect(updated?.sessionTemplate.credentialRestriction).toBe("developer_setup");
      revision++;
    }
    expect(state.revisions[0]).toEqual(original);
    const history = await getAutomationTriggerRevisions(state.db, {
      workspaceId,
      refs: [
        { triggerId, revision: 1 },
        { triggerId, revision: 4 },
      ],
    });
    expect(history[0]?.sessionTemplate).toEqual(created.sessionTemplate);
    expect(history[1]?.sessionTemplate.credentialRestriction).toBe("developer_setup");
  });

  test("setup-authorized updates add an immutable ceiling while ordinary revisions keep exact defaults", async () => {
    const state = fixture();
    const created = await createAutomationTrigger(state.db, createInput());
    const ordinary = await updateAutomationTrigger(state.db, {
      workspaceId,
      triggerId,
      subjectId: "owner:ordinary",
      request: { expectedRevision: 1, name: "Renamed" },
    });
    expect(ordinary?.sessionTemplate).toEqual(created.sessionTemplate);
    const restricted = await updateAutomationTrigger(state.db, {
      workspaceId,
      triggerId,
      subjectId: "service:setup",
      credentialRestriction: "developer_setup",
      request: { expectedRevision: 2, name: "Restricted" },
    });
    expect(restricted?.sessionTemplate).toEqual({
      ...template,
      credentialRestriction: "developer_setup",
    });
    expect(state.revisions[0]?.sessionTemplate).toEqual(template);
  });

  test("a trusted clone copies the frozen marker through the separate server-only seam", async () => {
    const state = fixture();
    const original: AutomationTrigger = await createAutomationTrigger(
      state.db,
      createInput("developer_setup"),
    );
    const cloned = await createAutomationTrigger(state.db, {
      ...createInput(original.sessionTemplate.credentialRestriction),
      request: { ...request(), sessionTemplate: original.sessionTemplate },
    });
    expect(cloned.sessionTemplate).toEqual(original.sessionTemplate);
  });
});

function eventRunFixture() {
  const events = new Map<string, Record<string, unknown>>();
  const runs = new Map<string, Record<string, unknown>>();
  const links: Array<Record<string, unknown>> = [];
  let attemptedKey = "";
  const handle = {
    transaction: async (run: (tx: unknown) => unknown) => run(handle),
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            const row = (table === schema.automationTriggerEvents ? events : runs).get(
              attemptedKey,
            );
            return row ? [row] : [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => {
          if (table === schema.automationRunEventLinks) links.push(values);
          attemptedKey = String(
            table === schema.automationTriggerEvents ? values.deliveryKey : values.occurrenceKey,
          );
          return {
            returning: async () => {
              const rows = table === schema.automationTriggerEvents ? events : runs;
              if (rows.has(attemptedKey)) return [];
              const row = {
                ...values,
                id: crypto.randomUUID(),
                status: table === schema.automationRuns ? "queued" : values.status,
                sessionId: null,
                ignoredReason: null,
                errorCode: null,
                createdAt: new Date(0),
                updatedAt: new Date(0),
              };
              rows.set(attemptedKey, row);
              return [row];
            },
          };
        },
      }),
    }),
  } as unknown as database.Database;
  const scope = spyOn(database, "withWorkspaceRls").mockImplementation(
    async (_db, _workspace, run) => run(handle),
  );
  restores.push(() => scope.mockRestore());
  return { db: handle, events, runs, links };
}

function eventInput(credentialRestriction?: "developer_setup") {
  return {
    accountId,
    workspaceId,
    sourceId,
    sourceVersion: 1,
    sourceConfiguration: {},
    matchedTriggerRevisions: [{ triggerId, revision: 1 }],
    deliveryKey: "delivery:one",
    requestDigest: "a".repeat(64),
    normalizedEvent: AutomationNormalizedEvent.parse({
      adapterId: "signed-json.v1",
      eventType: "fixture.event",
      occurrenceKey: "fixture:one",
      payload: {},
    }),
    ...(credentialRestriction ? { credentialRestriction } : {}),
  };
}

function runInput(eventId: string, credentialRestriction?: "developer_setup") {
  return {
    accountId,
    workspaceId,
    sourceId,
    triggerId,
    triggerRevision: 1,
    eventId,
    occurrenceKey: "fixture:one",
    acceptedExecution: AutomationAcceptedExecution.parse({
      version: 1,
      accountId,
      workspaceId,
      sourceId,
      sourceVersion: 1,
      triggerId,
      triggerRevision: 1,
      eventId,
      adapterId: "signed-json.v1",
      occurrenceKey: "fixture:one",
      initialMessage: "Process the event",
      sessionTemplate: {
        ...template,
        ...(credentialRestriction ? { credentialRestriction } : {}),
      },
      serviceSubjectId: `automation:${triggerId}`,
      serviceLabel: "Fixture",
      provenance: {},
    }),
  };
}

describe("immutable manual automation caller restriction", () => {
  test("trusted caller flag persists in existing event JSON and survives ordinary duplicate replay", async () => {
    const state = eventRunFixture();
    const first = await recordAutomationEvent(state.db, eventInput("developer_setup"));
    const frozen = structuredClone(state.events.get("delivery:one"));
    const replay = await recordAutomationEvent(state.db, eventInput());
    expect(first.event.normalizedEvent.credentialRestriction).toBe("developer_setup");
    expect(replay).toEqual({ event: first.event, duplicate: true });
    expect(state.events.get("delivery:one")).toEqual(frozen);
  });

  test("normalized JSON and payload forgery cannot manufacture or downgrade the server marker", async () => {
    const state = eventRunFixture();
    const input = eventInput();
    input.normalizedEvent.credentialRestriction = "developer_setup";
    input.normalizedEvent.payload = { credentialRestriction: "developer_setup" };
    const ordinary = await recordAutomationEvent(state.db, input);
    expect(ordinary.event.normalizedEvent).not.toHaveProperty("credentialRestriction");
    const restricted = await recordAutomationEvent(state.db, {
      ...eventInput("developer_setup"),
      deliveryKey: "delivery:two",
      normalizedEvent: {
        ...input.normalizedEvent,
        credentialRestriction: null,
      } as never,
    });
    expect(restricted.event.normalizedEvent.credentialRestriction).toBe("developer_setup");
  });

  test("restricted replay cannot adopt an existing unmarked event or mutate its frozen snapshot", async () => {
    const state = eventRunFixture();
    await recordAutomationEvent(state.db, eventInput());
    const frozen = structuredClone(state.events.get("delivery:one"));
    await expect(
      recordAutomationEvent(state.db, eventInput("developer_setup")),
    ).rejects.toBeInstanceOf(AutomationCredentialRestrictionConflictError);
    expect(state.events.get("delivery:one")).toEqual(frozen);
  });

  test("restricted occurrence collision cannot adopt or link a previously unrestricted run", async () => {
    const state = eventRunFixture();
    const first = await recordAutomationEvent(state.db, eventInput());
    await createAutomationRun(state.db, runInput(first.event.id));
    const frozen = structuredClone(state.runs.get("fixture:one"));
    const second = await recordAutomationEvent(state.db, {
      ...eventInput("developer_setup"),
      deliveryKey: "delivery:two",
    });
    await expect(
      createAutomationRun(state.db, runInput(second.event.id, "developer_setup")),
    ).rejects.toBeInstanceOf(AutomationCredentialRestrictionConflictError);
    expect(state.runs.get("fixture:one")).toEqual(frozen);
    expect(state.links).toHaveLength(1);
  });

  test("ordinary new delivery deduplicates to the original restricted accepted run without stripping it", async () => {
    const state = eventRunFixture();
    const first = await recordAutomationEvent(state.db, eventInput("developer_setup"));
    const original = await createAutomationRun(
      state.db,
      runInput(first.event.id, "developer_setup"),
    );
    const second = await recordAutomationEvent(state.db, {
      ...eventInput(),
      deliveryKey: "delivery:two",
    });
    const replay = await createAutomationRun(state.db, runInput(second.event.id));
    expect(replay).toEqual({ run: original.run, duplicate: true });
    expect(replay.run.acceptedExecution.sessionTemplate.credentialRestriction).toBe(
      "developer_setup",
    );
    expect(state.links).toHaveLength(2);
  });

  test("a later native occurrence remains unrestricted after a setup-only run", async () => {
    const state = eventRunFixture();
    const first = await recordAutomationEvent(state.db, eventInput("developer_setup"));
    await createAutomationRun(state.db, runInput(first.event.id, "developer_setup"));
    const ordinary = eventInput();
    ordinary.deliveryKey = "delivery:ordinary";
    ordinary.normalizedEvent.occurrenceKey = "fixture:ordinary";
    const { event } = await recordAutomationEvent(state.db, ordinary);
    const input = runInput(event.id);
    input.occurrenceKey = ordinary.normalizedEvent.occurrenceKey;
    input.acceptedExecution.occurrenceKey = ordinary.normalizedEvent.occurrenceKey;
    const { run } = await createAutomationRun(state.db, input);
    expect(event.normalizedEvent).not.toHaveProperty("credentialRestriction");
    expect(run.acceptedExecution.sessionTemplate).not.toHaveProperty("credentialRestriction");
    expect(state.runs.size).toBe(2);
  });
});
