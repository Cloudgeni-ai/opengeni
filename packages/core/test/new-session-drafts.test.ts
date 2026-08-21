import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessGrant, ResourceRef, ToolRef } from "@opengeni/contracts";
import {
  bindAuthorizedGitHubInstallationRepositories,
  createDb,
  saveNewSessionDraftInTransaction,
  type Database,
  type DbClient,
  withWorkspaceSubjectRls,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiRouteDeps, SessionWorkflowClient } from "../src";
import { createSessionForRequest } from "../src/domain/sessions";
import {
  getActorNewSessionDraft,
  saveActorNewSessionDraft,
} from "../src/application/new-session-drafts";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-new-session-drafts");
  if (!shared) {
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function fixture(): Promise<{ grant: AccessGrant; subjectId: string }> {
  const subjectId = `user:core-new-session-${crypto.randomUUID()}`;
  const suffix = crypto.randomUUID();
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`core draft account ${suffix}`}) returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`core draft workspace ${suffix}`}) returning id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  await shared!.admin`
    insert into workspace_memberships (workspace_id, account_id, subject_id, role)
    values (${workspace!.id}, ${account!.id}, ${subjectId}, 'owner')`;
  return {
    subjectId,
    grant: {
      accountId: account!.id,
      workspaceId: workspace!.id,
      subjectId,
      permissions: ["sessions:read", "sessions:create", "variable-sets:use"],
    },
  };
}

const settings = testSettings({
  mcpServers: [
    { id: "opengeni", url: "https://opengeni.example/mcp", cacheToolsList: false },
    { id: "docs", url: "https://docs.example/mcp", cacheToolsList: false },
  ],
});

const mcp = (id: string): ToolRef => ({ kind: "mcp", id });

describe("core new-session draft hydration", () => {
  test("accepts the exact saved visibility when creating the first session turn", async () => {
    if (!available) return;
    const { grant } = await fixture();
    const saved = await saveActorNewSessionDraft(
      { db, settings, objectStorage: null },
      grant,
      grant.workspaceId!,
      {
        expectedRevision: 0,
        text: "Start a private-by-choice session",
        resources: [],
        tools: [],
        toolsProvided: true,
        model: settings.openaiModel,
        reasoningEffort: settings.openaiReasoningEffort,
        latencyMode: "standard",
        options: { visibility: "workspace" },
      },
    );
    const noop = async () => undefined;
    const deps = {
      settings,
      db,
      bus: new MemoryEventBus(),
      workflowClient: {
        signalUserMessage: noop,
        wakeSessionWorkflow: noop,
        requestSessionWorkflowWakeDispatch: noop,
        signalApprovalDecision: noop,
        signalSessionControl: noop,
        syncScheduledTask: noop,
        deleteScheduledTaskSchedule: noop,
        triggerScheduledTask: noop,
      } as unknown as SessionWorkflowClient,
      objectStorage: null,
      githubStateSecret: "test",
      documentIndexer: { indexDocument: noop },
      getDocumentServices: () => ({}) as never,
    } as unknown as ApiRouteDeps;

    const session = await createSessionForRequest(deps, grant, grant.workspaceId!, {
      initialMessage: saved.text,
      visibility: "workspace",
      resources: [],
      tools: [],
      model: saved.model,
      reasoningEffort: saved.reasoningEffort,
      latencyMode: saved.latencyMode,
      expectedNewSessionDraftRevision: saved.revision,
      idempotencyKey: crypto.randomUUID(),
    });

    expect(session.id).toBeString();
    expect(session.initialTurnId).toBeString();
  }, 180_000);

  test("treats a markerless old-client save, including [], as explicit tools", async () => {
    if (!available) return;
    const { grant } = await fixture();
    const deps = { db, settings, objectStorage: null };
    const base = {
      expectedRevision: 0,
      text: "legacy client",
      resources: [],
      model: "scripted-model",
      reasoningEffort: "high" as const,
      latencyMode: "priority" as const,
      options: {},
    };

    const narrowed = await saveActorNewSessionDraft(deps, grant, grant.workspaceId!, {
      ...base,
      tools: [mcp("docs")],
    });
    expect(narrowed.toolsProvided).toBe(true);
    expect(narrowed.tools).toEqual([mcp("docs")]);

    const empty = await saveActorNewSessionDraft(deps, grant, grant.workspaceId!, {
      ...base,
      expectedRevision: narrowed.revision,
      tools: [],
    });
    expect(empty.toolsProvided).toBe(true);
    expect(empty.tools).toEqual([]);
  }, 180_000);

  test("retains authorized repositories, drops revoked resources/tools, and invalidates stale targets", async () => {
    if (!available) return;
    const { grant, subjectId } = await fixture();
    const workspaceId = grant.workspaceId!;
    const authorityCheckedAt = new Date();
    await bindAuthorizedGitHubInstallationRepositories(db, {
      accountId: grant.accountId,
      workspaceId,
      installationId: 71,
      githubAccountId: 7_100,
      accountLogin: "acme-owner",
      accountType: "User",
      linkedBySubjectId: subjectId,
      githubActorId: 7_100,
      githubActorLogin: "acme-owner",
      authorityKind: "personal_owner",
      authorityCheckedAt,
      authorityExpiresAt: new Date(authorityCheckedAt.getTime() + 10 * 60_000),
      authorityNonce: `core-new-session-drafts-${crypto.randomUUID()}`,
      repositoryIds: [42],
    });

    const resources: ResourceRef[] = [
      {
        kind: "repository",
        uri: "https://github.com/acme/kept.git",
        ref: "main",
        mountPath: "repos/kept",
        githubInstallationId: 71,
        githubRepositoryId: 42,
      },
      {
        kind: "repository",
        uri: "https://github.com/acme/revoked.git",
        ref: "main",
        mountPath: "repos/revoked",
        githubInstallationId: 71,
        githubRepositoryId: 99,
      },
      {
        kind: "repository",
        uri: "https://git.example.com/acme/manual.git",
        ref: "develop",
        mountPath: "repos/manual",
      },
    ];
    await withWorkspaceSubjectRls(db, workspaceId, subjectId, (scoped) =>
      saveNewSessionDraftInTransaction(scoped, {
        accountId: grant.accountId,
        workspaceId,
        subjectId,
        expectedRevision: 0,
        text: "private prompt is still editable state",
        resources,
        tools: [mcp("opengeni"), mcp("revoked")],
        toolsProvided: true,
        model: "scripted-model",
        reasoningEffort: "high",
        latencyMode: "fast",
        options: {
          sandboxBackend: "selfhosted",
          targetSandboxId: crypto.randomUUID(),
          workingDir: "projects/opengeni",
          variableSetId: crypto.randomUUID(),
          rigId: crypto.randomUUID(),
        },
      }),
    );

    const hydrated = await getActorNewSessionDraft({ db, settings }, grant, workspaceId);
    expect(hydrated.text).toBe("private prompt is still editable state");
    expect(hydrated.resources).toEqual([resources[0], resources[2]]);
    expect(hydrated.tools).toEqual([mcp("opengeni")]);
    expect(hydrated.toolsProvided).toBe(true);
    expect(hydrated.options).toEqual({});
    expect(hydrated.model).toBe("scripted-model");
    expect(hydrated.reasoningEffort).toBe("high");
    expect(hydrated.latencyMode).toBe("fast");
  }, 180_000);
});
