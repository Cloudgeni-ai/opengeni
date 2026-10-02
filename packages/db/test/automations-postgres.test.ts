import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  AutomationDeliveryConflictError,
  AutomationCredentialRestrictionConflictError,
  createAutomationRun,
  createAutomationSource,
  createAutomationTrigger,
  createDb,
  deleteWorkspace,
  ensureManagedAccessForUser,
  listAutomationRuns,
  listAutomationSources,
  listAutomationTriggers,
  getAutomationTriggerRevisions,
  updateAutomationTrigger,
  recordAutomationEvent,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import {
  AutomationAcceptedExecution,
  AutomationNormalizedEvent,
  AutomationSessionTemplate,
} from "@opengeni/contracts";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const workspaceIds: string[] = [];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("automations-postgres");
  if (!shared) return;
  await migrate(shared.adminUrl);
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  if (client) {
    for (const workspaceId of workspaceIds) {
      await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
    }
  }
  await client?.close();
  await shared?.release();
}, 180_000);

describe("automation persistence", () => {
  test("setup restriction survives real revision replacement, historical reads and accepted-run persistence", async () => {
    if (!client || !shared) return;
    const suffix = crypto.randomUUID();
    const access = await ensureManagedAccessForUser(client.db, {
      userId: `automation-ceiling-${suffix}`,
      email: `automation-ceiling-${suffix}@example.test`,
      name: "Automation ceiling fixture",
    });
    workspaceIds.push(...access.workspaceGrants.map((grant) => grant.workspaceId));
    const grant = access.workspaceGrants.find(
      (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
    )!;
    const source = await createAutomationSource(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBySubjectId: grant.subjectId,
      webhookSecretEncrypted: "test-ciphertext",
      request: {
        name: "Ceiling source",
        adapterId: "signed-json.v1",
        webhookSecret: "fixture-secret-not-plaintext-storage",
        configuration: {},
      },
    });
    const sessionTemplate = AutomationSessionTemplate.parse({ prompt: "Process the event" });
    const trigger = await createAutomationTrigger(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBySubjectId: grant.subjectId,
      adapterId: source.adapterId,
      credentialRestriction: "developer_setup",
      request: {
        sourceId: source.id,
        name: "Ceiling trigger",
        eventTypes: ["fixture.event"],
        configuration: {},
        parameters: {},
        status: "active",
        sessionTemplate,
      },
    });
    const updated = await updateAutomationTrigger(client.db, {
      workspaceId: grant.workspaceId,
      triggerId: trigger.id,
      subjectId: grant.subjectId,
      request: {
        expectedRevision: 1,
        sessionTemplate: { ...sessionTemplate, prompt: "Updated ordinary-owner prompt" },
      },
    });
    expect(updated?.sessionTemplate.credentialRestriction).toBe("developer_setup");
    const history = await getAutomationTriggerRevisions(client.db, {
      workspaceId: grant.workspaceId,
      refs: [
        { triggerId: trigger.id, revision: 1 },
        { triggerId: trigger.id, revision: 2 },
      ],
    });
    expect(history.map((revision) => revision.sessionTemplate.credentialRestriction)).toEqual([
      "developer_setup",
      "developer_setup",
    ]);
    expect(history[0]?.sessionTemplate.prompt).toBe(sessionTemplate.prompt);
    const [stored] = await shared.admin<Array<{ session_template: unknown }>>`
      select session_template from automation_trigger_revisions where trigger_id = ${trigger.id} and revision = 2`;
    expect(stored!.session_template).toMatchObject({
      credentialRestriction: "developer_setup",
      firstPartyMcpTools: [],
      firstPartyMcpPermissions: [],
    });
    const normalizedEvent = AutomationNormalizedEvent.parse({
      adapterId: source.adapterId,
      eventType: "fixture.event",
      occurrenceKey: `fixture:${suffix}`,
      payload: {},
    });
    const { event } = await recordAutomationEvent(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceId: source.id,
      sourceVersion: source.version,
      sourceConfiguration: source.configuration,
      matchedTriggerRevisions: [{ triggerId: trigger.id, revision: 2 }],
      deliveryKey: `delivery:${suffix}`,
      requestDigest: "a".repeat(64),
      normalizedEvent,
    });
    const acceptedExecution = AutomationAcceptedExecution.parse({
      version: 1,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceId: source.id,
      sourceVersion: source.version,
      triggerId: trigger.id,
      triggerRevision: 2,
      eventId: event.id,
      adapterId: source.adapterId,
      occurrenceKey: normalizedEvent.occurrenceKey,
      initialMessage: "Process the event",
      sessionTemplate: updated!.sessionTemplate,
      serviceSubjectId: `automation:${trigger.id}`,
      serviceLabel: "Ceiling fixture",
      provenance: {},
    });
    const { run } = await createAutomationRun(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceId: source.id,
      triggerId: trigger.id,
      triggerRevision: 2,
      eventId: event.id,
      occurrenceKey: normalizedEvent.occurrenceKey,
      acceptedExecution,
    });
    expect(run.acceptedExecution.sessionTemplate.credentialRestriction).toBe("developer_setup");
  }, 60_000);

  test("deduplicates delivery and logical occurrence independently under workspace RLS", async () => {
    if (!client) return;
    const access = await ensureManagedAccessForUser(client.db, {
      userId: `automation-${crypto.randomUUID()}`,
      email: `automation-${crypto.randomUUID()}@example.test`,
      name: "Automation owner",
    });
    workspaceIds.push(...access.workspaceGrants.map((grant) => grant.workspaceId));
    const grant = access.workspaceGrants.find(
      (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
    )!;
    const source = await createAutomationSource(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBySubjectId: grant.subjectId,
      webhookSecretEncrypted: "test-ciphertext",
      request: {
        name: "Build events",
        adapterId: "signed-json.v1",
        webhookSecret: "not-stored-in-plaintext",
        configuration: {},
      },
    });
    expect(source.adapterId).toBe("signed-json.v1");

    const trigger = await createAutomationTrigger(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBySubjectId: grant.subjectId,
      adapterId: source.adapterId,
      request: {
        sourceId: source.id,
        name: "Build failure",
        eventTypes: ["build.failed"],
        configuration: {},
        parameters: {},
        sessionTemplate: {
          prompt: "Investigate",
          instructions: null,
          resources: [],
          skills: [],
          tools: [],
          firstPartyMcpTools: [],
          firstPartyMcpPermissions: [],
          model: null,
          reasoningEffort: null,
          sandboxBackend: null,
          policyRole: null,
          metadata: {},
        },
        status: "active",
      },
    });
    const normalizedEvent = AutomationNormalizedEvent.parse({
      adapterId: source.adapterId,
      eventType: "build.failed",
      occurrenceKey: "repository:main:abc123",
      occurredAt: null,
      subject: "main",
      resource: "repository",
      payload: { head: "abc123" },
    });
    const first = await recordAutomationEvent(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceId: source.id,
      sourceVersion: source.version,
      sourceConfiguration: source.configuration,
      matchedTriggerRevisions: [{ triggerId: trigger.id, revision: trigger.revision }],
      deliveryKey: "delivery-1",
      requestDigest: "a".repeat(64),
      normalizedEvent,
    });
    const replay = await recordAutomationEvent(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceId: source.id,
      sourceVersion: source.version + 1,
      sourceConfiguration: { changedAfterAcceptance: true },
      matchedTriggerRevisions: [],
      deliveryKey: "delivery-1",
      requestDigest: "a".repeat(64),
      normalizedEvent,
    });
    expect(replay).toMatchObject({
      duplicate: true,
      event: {
        id: first.event.id,
        sourceVersion: source.version,
        sourceConfiguration: source.configuration,
        matchedTriggerRevisions: [{ triggerId: trigger.id, revision: trigger.revision }],
      },
    });
    await expect(
      recordAutomationEvent(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sourceId: source.id,
        sourceVersion: source.version,
        sourceConfiguration: source.configuration,
        matchedTriggerRevisions: [{ triggerId: trigger.id, revision: trigger.revision }],
        deliveryKey: "delivery-1",
        requestDigest: "b".repeat(64),
        normalizedEvent,
      }),
    ).rejects.toBeInstanceOf(AutomationDeliveryConflictError);

    const acceptedExecution = AutomationAcceptedExecution.parse({
      version: 1,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceId: source.id,
      sourceVersion: source.version,
      triggerId: trigger.id,
      triggerRevision: trigger.revision,
      eventId: first.event.id,
      adapterId: source.adapterId,
      occurrenceKey: normalizedEvent.occurrenceKey,
      initialMessage: "Investigate",
      sessionTemplate: trigger.sessionTemplate,
      serviceSubjectId: `automation:${trigger.id}`,
      serviceLabel: "Build automation",
      provenance: {},
    });
    const firstRun = await createAutomationRun(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceId: source.id,
      triggerId: trigger.id,
      triggerRevision: trigger.revision,
      eventId: first.event.id,
      occurrenceKey: normalizedEvent.occurrenceKey,
      acceptedExecution,
    });
    const secondDelivery = await recordAutomationEvent(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceId: source.id,
      sourceVersion: source.version,
      sourceConfiguration: source.configuration,
      matchedTriggerRevisions: [{ triggerId: trigger.id, revision: trigger.revision }],
      deliveryKey: "delivery-2",
      requestDigest: "c".repeat(64),
      normalizedEvent,
    });
    const sameRun = await createAutomationRun(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceId: source.id,
      triggerId: trigger.id,
      triggerRevision: trigger.revision,
      eventId: secondDelivery.event.id,
      occurrenceKey: normalizedEvent.occurrenceKey,
      acceptedExecution,
    });
    expect(sameRun).toMatchObject({
      duplicate: true,
      run: { id: firstRun.run.id },
    });
    await expect(
      recordAutomationEvent(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sourceId: source.id,
        sourceVersion: source.version,
        sourceConfiguration: source.configuration,
        matchedTriggerRevisions: [{ triggerId: trigger.id, revision: trigger.revision }],
        deliveryKey: "delivery-1",
        requestDigest: "a".repeat(64),
        normalizedEvent,
        credentialRestriction: "developer_setup",
      }),
    ).rejects.toBeInstanceOf(AutomationCredentialRestrictionConflictError);
    const restrictedEventInput = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceId: source.id,
      sourceVersion: source.version,
      sourceConfiguration: source.configuration,
      matchedTriggerRevisions: [{ triggerId: trigger.id, revision: trigger.revision }],
      deliveryKey: "delivery-restricted",
      requestDigest: "d".repeat(64),
      normalizedEvent,
      credentialRestriction: "developer_setup" as const,
    };
    const restricted = await recordAutomationEvent(client.db, restrictedEventInput);
    const { credentialRestriction: _restriction, ...ordinaryReplayInput } = restrictedEventInput;
    const replayRestricted = await recordAutomationEvent(client.db, ordinaryReplayInput);
    expect(replayRestricted.event.normalizedEvent.credentialRestriction).toBe("developer_setup");
    await expect(
      createAutomationRun(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sourceId: source.id,
        triggerId: trigger.id,
        triggerRevision: trigger.revision,
        eventId: restricted.event.id,
        occurrenceKey: normalizedEvent.occurrenceKey,
        acceptedExecution: {
          ...acceptedExecution,
          eventId: restricted.event.id,
          sessionTemplate: { ...trigger.sessionTemplate, credentialRestriction: "developer_setup" },
        },
      }),
    ).rejects.toBeInstanceOf(AutomationCredentialRestrictionConflictError);
    expect(await listAutomationSources(client.db, grant.workspaceId)).toHaveLength(1);
    expect(await listAutomationTriggers(client.db, grant.workspaceId)).toHaveLength(1);
    expect(await listAutomationRuns(client.db, grant.workspaceId)).toHaveLength(1);
  }, 60_000);
});
