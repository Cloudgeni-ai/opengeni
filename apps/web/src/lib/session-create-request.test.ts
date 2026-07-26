import { describe, expect, test } from "bun:test";
import { ResourceRefConflictError, type ResourceRef } from "@opengeni/contracts";
import {
  buildCreateSessionRequest,
  emptySessionDraft,
  newSessionDraftOptionsFromSessionDraft,
  prepareCreateSessionAttempt,
  sessionDraftFromNewSessionDraftOptions,
} from "./session-create";

const fileA = "00000000-0000-4000-8000-0000000000a1";
const fileB = "00000000-0000-4000-8000-0000000000b2";
const repository: ResourceRef = {
  kind: "repository",
  uri: "https://github.com/Cloudgeni-ai/opengeni.git",
  ref: "main",
  mountPath: "repos/Cloudgeni-ai/opengeni",
};

function build(
  currentResources: ResourceRef[],
  submissionResources: ResourceRef[],
  overrides: Partial<Parameters<typeof buildCreateSessionRequest>[0]> = {},
) {
  return buildCreateSessionRequest({
    currentResources,
    submission: { text: "start", resources: submissionResources },
    selectedTools: [{ kind: "mcp", id: "opengeni" }],
    defaultModel: "gpt-5.4",
    defaultReasoningEffort: "medium",
    clientEventId: "event-1",
    idempotencyKey: "create-1",
    ...overrides,
  });
}

describe("buildCreateSessionRequest", () => {
  test("deduplicates exact file and repository refs with first-seen stable order", () => {
    const firstFile: ResourceRef = {
      kind: "file",
      fileId: fileA,
      mountPath: `files/${fileA}`,
    };
    const secondFile: ResourceRef = {
      kind: "file",
      fileId: fileB,
      mountPath: `files/${fileB}`,
    };
    const result = build(
      [firstFile, repository, firstFile],
      [{ ...repository }, secondFile, { ...secondFile }],
    );

    expect(result.resources).toEqual([firstFile, repository, secondFile]);
  });

  test("rejects two resources claiming the same mount path", () => {
    expect(() =>
      build(
        [{ kind: "file", fileId: fileA, mountPath: "files/shared" }],
        [{ kind: "file", fileId: fileB, mountPath: "files/shared" }],
      ),
    ).toThrow(ResourceRefConflictError);
    expect(() =>
      build(
        [{ kind: "file", fileId: fileA, mountPath: "files/shared" }],
        [{ kind: "file", fileId: fileB, mountPath: "files/shared" }],
      ),
    ).toThrow("resource mount path is already attached: files/shared");
  });

  test("rejects one identity with different settings", () => {
    expect(() =>
      build(
        [{ kind: "file", fileId: fileA, mountPath: "files/first" }],
        [{ kind: "file", fileId: fileA, mountPath: "files/second" }],
      ),
    ).toThrow("resource is already attached with different settings");

    expect(() =>
      build(
        [repository],
        [{ ...repository, ref: "feature", mountPath: "repos/alternate-opengeni" }],
      ),
    ).toThrow("resource is already attached with different settings");
  });

  test("does not mutate inputs and forwards exact create/draft fences", () => {
    const currentResources: ResourceRef[] = [repository];
    const submissionResources: ResourceRef[] = [
      { kind: "file", fileId: fileA, mountPath: `files/${fileA}` },
    ];
    const currentBefore = structuredClone(currentResources);
    const submissionBefore = structuredClone(submissionResources);
    const tools = [{ kind: "mcp" as const, id: "opengeni" }];
    const result = build(currentResources, submissionResources, {
      selectedTools: tools,
      targetSandboxId: "00000000-0000-4000-8000-0000000000c3",
      workingDir: "/workspace/opengeni",
      expectedNewSessionDraftRevision: 7,
    });

    expect(currentResources).toEqual(currentBefore);
    expect(submissionResources).toEqual(submissionBefore);
    expect(result).toMatchObject({
      resources: [...currentBefore, ...submissionBefore],
      tools,
      targetSandboxId: "00000000-0000-4000-8000-0000000000c3",
      workingDir: "/workspace/opengeni",
      expectedNewSessionDraftRevision: 7,
    });
    expect(result.resources).not.toBe(currentResources);
    expect(result.tools).not.toBe(tools);
  });

  test("omits workspace resources for a connected machine but keeps attachments", () => {
    const attachment: ResourceRef = {
      kind: "file",
      fileId: fileA,
      mountPath: `files/${fileA}`,
    };
    expect(build([repository], [attachment], { omitWorkspaceResources: true }).resources).toEqual([
      attachment,
    ]);
  });

  test("reuses create keys only for the same client, workspace, and logical request", () => {
    const firstClient = {};
    const secondClient = {};
    const firstRequest = build([], [], {
      clientEventId: "event-first",
      idempotencyKey: "fresh-first",
      expectedNewSessionDraftRevision: 1,
    });
    const first = prepareCreateSessionAttempt({
      pending: null,
      client: firstClient,
      workspaceId: "workspace-a",
      request: firstRequest,
      freshIdempotencyKey: "fresh-first",
    });
    expect(first.request.idempotencyKey).toBe("fresh-first");

    const exactRetry = prepareCreateSessionAttempt({
      pending: first.pending,
      client: firstClient,
      workspaceId: "workspace-a",
      request: {
        ...firstRequest,
        clientEventId: "event-retry",
        idempotencyKey: "fresh-retry",
        expectedNewSessionDraftRevision: 2,
      },
      freshIdempotencyKey: "fresh-retry",
    });
    expect(exactRetry.request.idempotencyKey).toBe("fresh-first");

    for (const changed of [
      {
        client: firstClient,
        workspaceId: "workspace-a",
        request: { ...firstRequest, initialMessage: "edited" },
      },
      { client: firstClient, workspaceId: "workspace-b", request: firstRequest },
      { client: secondClient, workspaceId: "workspace-a", request: firstRequest },
    ]) {
      const next = prepareCreateSessionAttempt({
        pending: first.pending,
        ...changed,
        freshIdempotencyKey: "fresh-changed",
      });
      expect(next.request.idempotencyKey).toBe("fresh-changed");
    }
  });
});

describe("new-session draft option mapping", () => {
  test("round-trips managed compute, goal, and exact custom permissions", () => {
    const draft = {
      ...emptySessionDraft(),
      compute: { kind: "sandbox" as const, backend: "modal" as const },
      variableSetId: "00000000-0000-4000-8000-000000000011",
      rigId: "00000000-0000-4000-8000-000000000012",
      goalText: "  durable goal  ",
      goalSuccessCriteria: "  accepted live  ",
      goalMaxAutoContinuations: "8",
      customMcpPermissions: true,
      mcpPermissions: new Set(["workspace:read", "sessions:read"]),
    };

    const options = newSessionDraftOptionsFromSessionDraft(draft);
    expect(options).toEqual({
      sandboxBackend: "modal",
      variableSetId: "00000000-0000-4000-8000-000000000011",
      rigId: "00000000-0000-4000-8000-000000000012",
      goal: {
        text: "durable goal",
        successCriteria: "accepted live",
        maxAutoContinuations: 8,
      },
      firstPartyMcpPermissions: ["workspace:read", "sessions:read"],
    });
    expect(sessionDraftFromNewSessionDraftOptions(options)).toMatchObject({
      compute: { kind: "sandbox", backend: "modal" },
      variableSetId: draft.variableSetId,
      rigId: draft.rigId,
      goalText: "durable goal",
      goalSuccessCriteria: "accepted live",
      goalMaxAutoContinuations: "8",
      customMcpPermissions: true,
      mcpPermissions: new Set(["workspace:read", "sessions:read"]),
    });
  });

  test("round-trips machine placement and restores default permissions when absent", () => {
    const options = newSessionDraftOptionsFromSessionDraft({
      ...emptySessionDraft(),
      compute: {
        kind: "machine",
        sandboxId: "00000000-0000-4000-8000-000000000021",
        folder: { kind: "path", path: "  /srv/opengeni  " },
      },
    });
    expect(options).toEqual({
      targetSandboxId: "00000000-0000-4000-8000-000000000021",
      workingDir: "/srv/opengeni",
    });

    const restored = sessionDraftFromNewSessionDraftOptions(options);
    expect(restored.compute).toEqual({
      kind: "machine",
      sandboxId: "00000000-0000-4000-8000-000000000021",
      folder: { kind: "path", path: "/srv/opengeni" },
    });
    expect(restored.customMcpPermissions).toBe(false);
    expect(restored.mcpPermissions.size).toBeGreaterThan(0);
  });
});
