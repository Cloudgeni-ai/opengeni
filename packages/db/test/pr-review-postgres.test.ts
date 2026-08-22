import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CapabilityPack, stableJson, type AutomationSessionTemplate } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  assertAutomationRunAuthorityInTransaction,
  claimAutomationRun,
  claimSessionWorkForAttempt,
  createAutomationRun,
  createDb,
  createPrReviewAppRegistration,
  createPrReviewRepositoryBinding,
  createSession,
  deletePrReviewAppRegistration,
  deleteWorkspace,
  enablePackInstallation,
  ensureManagedAccessForUser,
  initializeSessionStartAtomically,
  listAutomationSources,
  listAutomationTriggers,
  listPrReviewAppRegistrations,
  listPrReviewRepositoryBindings,
  PrReviewDispatchAuthorityError,
  recordAutomationEvent,
  resolvePrReviewGitCredential,
  updateAutomationTrigger,
  updatePrReviewRepositoryBinding,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const workspaceIds: string[] = [];

const sessionTemplate: AutomationSessionTemplate = {
  prompt: "Review the pull request",
  instructions: "Follow the pr-review skill.",
  resources: [],
  skills: [
    {
      name: "pr-review",
      files: [
        {
          path: "SKILL.md",
          content: "---\nname: pr-review\ndescription: Review pull requests.\n---\n\n# Review\n",
        },
      ],
    },
  ],
  tools: [],
  firstPartyMcpTools: [],
  firstPartyMcpPermissions: [],
  model: null,
  reasoningEffort: null,
  sandboxBackend: null,
  policyRole: "pull_request_review",
  metadata: { role: "pull_request_review" },
};

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("pr-review-postgres");
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

describe("PR Review Pack persistence", () => {
  test("creates generic source and trigger authority atomically with Pack setup", async () => {
    if (!client) return;
    const access = await ensureManagedAccessForUser(client.db, {
      userId: `pr-review-${crypto.randomUUID()}`,
      email: `pr-review-${crypto.randomUUID()}@example.test`,
      name: "PR Review owner",
    });
    workspaceIds.push(...access.workspaceGrants.map((grant) => grant.workspaceId));
    const grant = access.workspaceGrants.find(
      (candidate) => candidate.workspaceId === access.defaultWorkspaceId,
    )!;
    const pack = CapabilityPack.parse({
      id: "pr-review",
      name: "PR Review",
      description: "Review pull requests.",
      role: "software-engineering",
      category: "code-review",
      version: "1.0.0",
      skills: [],
      components: [],
      tools: [],
      connectors: [],
      knowledge: [],
      scheduledTaskTemplates: [],
      automationTemplates: [
        {
          id: "review-pull-request",
          name: "Review pull requests",
          description: "Review exact pull-request heads.",
          adapterId: "source-control.pull-request.v1",
          eventTypes: ["pull_request.review_requested"],
          sessionTemplate,
          configuration: {},
          connectionRequirement: "source-control-provider",
        },
      ],
      metadata: {},
    });
    const installation = await enablePackInstallation(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      packId: pack.id,
      manifestSnapshot: pack,
      manifestDigest: createHash("sha256").update(stableJson(pack)).digest("hex"),
      installedBySubjectId: grant.subjectId,
      metadata: {},
    });
    const registration = await createPrReviewAppRegistration(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "OpenGeni Review Bot",
      provider: "github",
      providerBaseUrl: "https://github.com",
      appId: "12345",
      credentialKind: "github_app",
      credentialEncrypted: "encrypted-private-key",
      accessTokenExpiresAt: null,
      webhookAuthKind: "hmac_sha256",
      webhookSecretEncrypted: "encrypted-webhook-secret",
      webhookUsername: null,
      createdBySubjectId: grant.subjectId,
      packInstallationId: installation.id,
      packConnectorId: "github",
    });
    expect(registration.webhookPath).toMatch(/^\/v1\/webhooks\/automations\/[0-9a-f-]+$/u);
    const binding = await createPrReviewRepositoryBinding(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      registrationId: registration.id,
      provider: "github",
      repositoryUri: "https://github.com/example/repository.git",
      repositoryFullName: "example/repository",
      providerRepositoryId: "101",
      installationId: "202",
      projectId: null,
      model: null,
      additionalInstructions: null,
      status: "active",
      createdBySubjectId: grant.subjectId,
      packInstallationId: installation.id,
      packTemplateId: "review-pull-request",
      adapterId: "source-control.pull-request.v1",
      eventTypes: ["pull_request.review_requested"],
      configuration: {},
      sessionTemplate,
    });
    expect(binding.triggerId).not.toBe(registration.sourceId);
    expect(await listAutomationSources(client.db, grant.workspaceId)).toEqual([
      expect.objectContaining({
        packInstallationId: installation.id,
        packConnectorId: "github",
      }),
    ]);
    const [trigger] = await listAutomationTriggers(client.db, grant.workspaceId);
    expect(trigger).toMatchObject({
      id: binding.triggerId,
      sourceId: registration.sourceId,
      packInstallationId: installation.id,
      packTemplateId: "review-pull-request",
      parameters: {
        registrationId: registration.id,
        repositoryBindingId: binding.id,
        providerRepositoryId: "101",
      },
    });
    await expect(
      updateAutomationTrigger(client.db, {
        workspaceId: grant.workspaceId,
        triggerId: binding.triggerId,
        subjectId: grant.subjectId,
        request: { expectedRevision: trigger!.revision, status: "disabled" },
      }),
    ).rejects.toThrow("Pack-owned automation triggers must be managed");

    const headSha = "e".repeat(40);
    const source = (await listAutomationSources(client.db, grant.workspaceId))[0]!;
    const normalizedEvent = {
      adapterId: "source-control.pull-request.v1",
      eventType: "pull_request.review_requested",
      occurrenceKey: `github:101:17:${headSha}`,
      occurredAt: null,
      subject: "17",
      resource: "101",
      payload: {
        provider: "github",
        providerRepositoryId: "101",
        pullRequestId: "17",
        headSha,
      },
    } as const;
    const recorded = await recordAutomationEvent(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceId: source.id,
      sourceVersion: source.version,
      sourceConfiguration: source.configuration,
      matchedTriggerRevisions: [{ triggerId: binding.triggerId, revision: 1 }],
      deliveryKey: `credential-${crypto.randomUUID()}`,
      requestDigest: "f".repeat(64),
      normalizedEvent,
    });
    const repositoryResource = {
      kind: "repository" as const,
      uri: binding.repositoryUri,
      ref: headSha,
      expectedCommitSha: headSha,
      provider: "github" as const,
      credentialBindingId: `pr-review:${registration.id}`,
      access: "write" as const,
      repositoryId: binding.providerRepositoryId,
      installationId: binding.installationId!,
      githubRepositoryId: Number(binding.providerRepositoryId),
      githubInstallationId: Number(binding.installationId),
    };
    const acceptedTemplate = { ...sessionTemplate, resources: [repositoryResource] };
    const createdRun = await createAutomationRun(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceId: source.id,
      triggerId: binding.triggerId,
      triggerRevision: 1,
      eventId: recorded.event.id,
      occurrenceKey: normalizedEvent.occurrenceKey,
      acceptedExecution: {
        version: 1,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sourceId: source.id,
        sourceVersion: source.version,
        triggerId: binding.triggerId,
        triggerRevision: 1,
        eventId: recorded.event.id,
        adapterId: normalizedEvent.adapterId,
        occurrenceKey: normalizedEvent.occurrenceKey,
        initialMessage: "Review pull request 17",
        sessionTemplate: acceptedTemplate,
        serviceSubjectId: `automation:${binding.triggerId}`,
        serviceLabel: "OpenGeni Review Bot",
        provenance: { repositoryBindingId: binding.id, headSha },
      },
    });
    await claimAutomationRun(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      runId: createdRun.run.id,
    });
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Review pull request 17",
      resources: [repositoryResource],
      metadata: {
        role: "pull_request_review",
        prReviewRegistrationId: registration.id,
        prReviewRepositoryBindingId: binding.id,
        prReviewProviderRepositoryId: binding.providerRepositoryId,
        prReviewPullRequestId: "17",
        prReviewHeadSha: headSha,
        automationRunId: createdRun.run.id,
        automationSourceId: source.id,
        automationTriggerId: binding.triggerId,
        automationTriggerRevision: 1,
      },
      createdBy: { kind: "service", subjectId: `automation:${binding.triggerId}` },
      createdByContext: { automationRunId: createdRun.run.id },
      policyRole: "pull_request_review",
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      beforeCreateCommit: async (tx, sessionId) => {
        await assertAutomationRunAuthorityInTransaction(tx, {
          workspaceId: grant.workspaceId,
          runId: createdRun.run.id,
          triggerId: binding.triggerId,
          triggerRevision: 1,
          sourceId: source.id,
          sourceVersion: source.version,
          sessionId,
        });
      },
    });
    const started = await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    });
    if (!started.turn) throw new Error("PR Review session did not create its initial turn");
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`PR Review claim failed: ${claimed.reason}`);
    const credentialRequest = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      registrationId: registration.id,
      provider: "github" as const,
      sessionId: session.id,
      rootSessionId: session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
      repositoryRefs: [
        {
          uri: binding.repositoryUri,
          expectedCommitSha: headSha,
          repositoryId: binding.providerRepositoryId,
          installationId: binding.installationId!,
        },
      ],
    };
    await expect(resolvePrReviewGitCredential(client.db, credentialRequest)).resolves.toMatchObject(
      {
        credentialKind: "github_app",
        appId: "12345",
        credentialEncrypted: "encrypted-private-key",
      },
    );
    await expect(
      resolvePrReviewGitCredential(client.db, {
        ...credentialRequest,
        repositoryRefs: [
          {
            ...credentialRequest.repositoryRefs[0]!,
            uri: "https://github.com/example/other.git",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(PrReviewDispatchAuthorityError);

    const updated = await updatePrReviewRepositoryBinding(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      bindingId: binding.id,
      subjectId: grant.subjectId,
      model: "gpt-5.4",
      status: "disabled",
    });
    expect(updated).toMatchObject({ model: "gpt-5.4", status: "disabled" });
    expect((await listAutomationTriggers(client.db, grant.workspaceId))[0]).toMatchObject({
      revision: 2,
      status: "disabled",
      parameters: { model: "gpt-5.4" },
    });
    await expect(resolvePrReviewGitCredential(client.db, credentialRequest)).rejects.toBeInstanceOf(
      PrReviewDispatchAuthorityError,
    );

    expect(
      await deletePrReviewAppRegistration(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        registrationId: registration.id,
      }),
    ).toBe(true);
    expect((await listAutomationSources(client.db, grant.workspaceId))[0]?.status).toBe("disabled");
    expect(
      await listPrReviewAppRegistrations(client.db, grant.accountId, grant.workspaceId),
    ).toHaveLength(1);
    expect(
      await listPrReviewRepositoryBindings(client.db, grant.accountId, grant.workspaceId),
    ).toHaveLength(1);
  }, 60_000);
});
