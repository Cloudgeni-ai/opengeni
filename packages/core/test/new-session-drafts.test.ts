import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessGrant, ResourceRef, ToolRef } from "@opengeni/contracts";
import {
  bindGitHubInstallationRepositories,
  createDb,
  saveNewSessionDraftInTransaction,
  type Database,
  type DbClient,
  withWorkspaceSubjectRls,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
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
    await bindGitHubInstallationRepositories(db, {
      accountId: grant.accountId,
      workspaceId,
      installationId: 71,
      linkedBySubjectId: subjectId,
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
  }, 180_000);
});
