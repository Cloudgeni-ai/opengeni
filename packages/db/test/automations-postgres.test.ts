import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  AutomationDeliveryConflictError,
  createAutomationRun,
  createAutomationSource,
  createAutomationTrigger,
  createDb,
  deleteWorkspace,
  enablePackInstallation,
  ensureManagedAccessForUser,
  listAutomationRuns,
  listAutomationSources,
  listAutomationTriggers,
  recordAutomationEvent,
  updateAutomationSource,
  updateAutomationTrigger,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { AutomationAcceptedExecution, AutomationNormalizedEvent } from "@opengeni/contracts";

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
    expect(source).toMatchObject({
      packInstallationId: null,
      packConnectorId: null,
    });
    const packSessionTemplate = {
      prompt: "Review",
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
    };
    const packInstallation = await enablePackInstallation(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      packId: "automation-test-pack",
      installedBySubjectId: grant.subjectId,
      manifestSnapshot: {
        id: "automation-test-pack",
        name: "Automation test",
        description: "Tests Pack-owned automation authority",
        role: "engineering",
        category: "development",
        version: "1.0.0",
        skills: [],
        components: [],
        tools: [],
        connectors: [],
        knowledge: [],
        scheduledTaskTemplates: [],
        automationTemplates: [
          {
            id: "review",
            name: "Review",
            description: "Review a Pack event",
            adapterId: "signed-json.v1",
            eventTypes: ["pack.event"],
            configuration: {},
            sessionTemplate: packSessionTemplate,
            connectionRequirement: "test-connection",
          },
        ],
        metadata: {},
      },
    });
    const packSource = await createAutomationSource(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBySubjectId: grant.subjectId,
      webhookSecretEncrypted: "pack-test-ciphertext",
      packInstallationId: packInstallation.id,
      packConnectorId: "events",
      request: {
        name: "Pack events",
        adapterId: "signed-json.v1",
        webhookSecret: "not-stored-in-plaintext",
        configuration: {},
      },
    });
    expect(packSource).toMatchObject({
      packInstallationId: packInstallation.id,
      packConnectorId: "events",
    });
    await expect(
      updateAutomationSource(client.db, {
        workspaceId: grant.workspaceId,
        sourceId: packSource.id,
        request: { status: "disabled" },
      }),
    ).resolves.toBeNull();
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
        packInstallationId: null,
        packTemplateId: null,
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
    expect(await listAutomationSources(client.db, grant.workspaceId)).toHaveLength(2);
    expect(await listAutomationTriggers(client.db, grant.workspaceId)).toHaveLength(1);
    expect(await listAutomationRuns(client.db, grant.workspaceId)).toHaveLength(1);
    const packTriggerRequest = {
      sourceId: packSource.id,
      name: "Pack-owned trigger",
      eventTypes: ["pack.event"],
      configuration: {},
      parameters: { protected: true },
      sessionTemplate: packSessionTemplate,
      status: "active" as const,
      packInstallationId: packInstallation.id,
      packTemplateId: "review",
    };
    await expect(
      createAutomationTrigger(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        createdBySubjectId: grant.subjectId,
        adapterId: packSource.adapterId,
        request: {
          ...packTriggerRequest,
          packInstallationId: null,
          packTemplateId: null,
        },
      }),
    ).rejects.toThrow("Automation source and trigger Pack ownership do not match");
    const packTrigger = await createAutomationTrigger(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBySubjectId: grant.subjectId,
      adapterId: packSource.adapterId,
      request: packTriggerRequest,
    });
    await expect(
      updateAutomationTrigger(client.db, {
        workspaceId: grant.workspaceId,
        triggerId: packTrigger.id,
        subjectId: grant.subjectId,
        request: {
          expectedRevision: packTrigger.revision,
          parameters: { protected: false },
        },
      }),
    ).rejects.toThrow("Pack-owned automation triggers must be managed");
  }, 60_000);
});
