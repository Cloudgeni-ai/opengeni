import { describe, expect, test } from "bun:test";
import { ResourceRefConflictError, type ResourceRef } from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";
import {
  buildCreateSessionRequest,
  classifyCreateSessionFailure,
  emptySessionDraft,
  newSessionCreateVisibility,
  newSessionDraftOptionsFromSessionDraft,
  prepareCreateSessionAttempt,
  rememberedMachineFolder,
  rememberedProjectCompute,
  retainCreateSessionAttemptAfterFailure,
  sessionDraftFromNewSessionDraftOptions,
  submissionFromSessionDraft,
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
    selectedTools: [],
    defaultModel: "gpt-5.4",
    defaultReasoningEffort: "medium",
    defaultLatencyMode: "standard",
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
        [
          {
            ...repository,
            ref: "feature",
            mountPath: "repos/alternate-opengeni",
          },
        ],
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
      instructions: "Hidden session guidance",
      installedSkillIds: ["skill:pack-inline/opengeni-product-integration@abc"],
      selectedTools: tools,
      targetSandboxId: "00000000-0000-4000-8000-0000000000c3",
      workingDir: "/workspace/opengeni",
      channelId: "00000000-0000-4000-8000-0000000000d4",
      expectedNewSessionDraftRevision: 7,
    });

    expect(currentResources).toEqual(currentBefore);
    expect(submissionResources).toEqual(submissionBefore);
    expect(result).toMatchObject({
      resources: [...currentBefore, ...submissionBefore],
      instructions: "Hidden session guidance",
      installedSkillIds: ["skill:pack-inline/opengeni-product-integration@abc"],
      tools,
      targetSandboxId: "00000000-0000-4000-8000-0000000000c3",
      workingDir: "/workspace/opengeni",
      channelId: "00000000-0000-4000-8000-0000000000d4",
      expectedNewSessionDraftRevision: 7,
    });
    expect(result.resources).not.toBe(currentResources);
    expect(result.tools).not.toBe(tools);
  });

  test("threads the selected latency mode into session creation", () => {
    expect(
      build([], [], {
        submission: { text: "start", resources: [], latencyMode: "fast" },
      }).latencyMode,
    ).toBe("fast");
  });

  test("threads the selected session visibility and defaults to workspace access", () => {
    expect(build([], []).visibility).toBe("workspace");
    expect(build([], [], { visibility: "private" }).visibility).toBe("private");
  });

  test("threads one atomic personal-resource command into create identity", () => {
    const personalResourceAttachment = {
      mode: "once" as const,
      workspaceSharedAcknowledged: true,
      sharedOutputWarningVersion: 1 as const,
    };
    const request = build([], [], {
      submission: { text: "start", resources: [], personalResourceAttachment },
    });
    expect(request.personalResourceAttachment).toEqual(personalResourceAttachment);

    const first = prepareCreateSessionAttempt({
      pending: null,
      client: {},
      workspaceId: "workspace-a",
      request,
      freshIdempotencyKey: "first",
    });
    const changedMode = prepareCreateSessionAttempt({
      pending: first.pending,
      client: first.pending.client,
      workspaceId: "workspace-a",
      request: {
        ...request,
        personalResourceAttachment: { ...personalResourceAttachment, mode: "session" },
      },
      freshIdempotencyKey: "second",
    });
    expect(changedMode.request.idempotencyKey).toBe("second");
  });

  test("creates a realtime-first session without an initial user message", () => {
    const request = build([], [], {
      submission: { text: "", resources: [] },
      startMode: "realtime",
      expectedNewSessionDraftRevision: 7,
    });

    expect(request.startMode).toBe("realtime");
    expect(request).not.toHaveProperty("initialMessage");
    expect(request.expectedNewSessionDraftRevision).toBe(7);
  });

  test("omits tools only when the ready catalog selection equals workspace defaults", () => {
    const result = build([], [], {
      selectedTools: [{ kind: "mcp", id: "docs" }],
      workspaceDefaultMcpServerIds: ["docs"],
      workspaceMcpCatalogReady: true,
    });

    expect(result).not.toHaveProperty("tools");
  });

  test("keeps explicit empty, subset, and partially hydrated selections on the wire", () => {
    const common = {
      workspaceDefaultMcpServerIds: ["docs"],
      workspaceMcpCatalogReady: true,
    };
    expect(
      build([], [], {
        ...common,
        selectedTools: [],
      }).tools,
    ).toEqual([]);
    expect(
      build([], [], {
        ...common,
        selectedTools: [{ kind: "mcp", id: "linear" }],
      }).tools,
    ).toEqual([{ kind: "mcp", id: "linear" }]);
    expect(
      build([], [], {
        ...common,
        selectedTools: [{ kind: "mcp", id: "docs" }],
        workspaceMcpCatalogReady: false,
      }).tools,
    ).toEqual([{ kind: "mcp", id: "docs" }]);
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

  test("a connected-machine route request strips managed resources but keeps personal intent", () => {
    const personalResourceAttachment = {
      mode: "session" as const,
      workspaceSharedAcknowledged: true,
      sharedOutputWarningVersion: 1 as const,
    };
    const draft = {
      ...emptySessionDraft(),
      compute: {
        kind: "machine" as const,
        sandboxId: "00000000-0000-4000-8000-0000000000c3",
        folder: { kind: "root" as const },
      },
      variableSetId: "00000000-0000-4000-8000-000000000011",
      rigId: "00000000-0000-4000-8000-000000000012",
    };
    const submission = submissionFromSessionDraft(draft, undefined, personalResourceAttachment);
    const request = build([], [], {
      submission: { text: "run on my machine", ...submission.extras },
      targetSandboxId: submission.options.targetSandboxId,
      workingDir: submission.options.workingDir,
      omitWorkspaceResources: submission.omitWorkspaceResources,
    });

    expect(request.targetSandboxId).toBe(draft.compute.sandboxId);
    expect(request).not.toHaveProperty("variableSetId");
    expect(request).not.toHaveProperty("rigId");
    expect(request.personalResourceAttachment).toEqual(personalResourceAttachment);
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
    expect(exactRetry.request.clientEventId).toBe("event-first");

    for (const changed of [
      {
        client: firstClient,
        workspaceId: "workspace-a",
        request: { ...firstRequest, initialMessage: "edited" },
      },
      {
        client: firstClient,
        workspaceId: "workspace-b",
        request: firstRequest,
      },
      {
        client: secondClient,
        workspaceId: "workspace-a",
        request: firstRequest,
      },
    ]) {
      const next = prepareCreateSessionAttempt({
        pending: first.pending,
        ...changed,
        freshIdempotencyKey: "fresh-changed",
      });
      expect(next.request.idempotencyKey).toBe("fresh-changed");
    }
  });

  test("retains an exact create key only while the mutation outcome is unknown", () => {
    const client = {};
    const request = build([], [], {
      clientEventId: "event-first",
      idempotencyKey: "fresh-first",
    });
    const first = prepareCreateSessionAttempt({
      pending: null,
      client,
      workspaceId: "workspace-a",
      request,
      freshIdempotencyKey: "fresh-first",
    });

    const uncertain = new OpenGeniApiError(503, "gateway unavailable", {
      mutation: true,
      outcomeUnknown: true,
    });
    expect(classifyCreateSessionFailure(uncertain)).toMatchObject({
      error: uncertain,
      outcomeUnknown: true,
    });
    const retained = retainCreateSessionAttemptAfterFailure({
      current: first.pending,
      attempted: first.pending,
      outcomeUnknown: uncertain.outcomeUnknown,
    });
    const exactRetry = prepareCreateSessionAttempt({
      pending: retained,
      client,
      workspaceId: "workspace-a",
      request: { ...request, clientEventId: "event-retry" },
      freshIdempotencyKey: "fresh-retry",
    });
    expect(exactRetry.request.idempotencyKey).toBe("fresh-first");
    expect(exactRetry.request.clientEventId).toBe("event-first");

    const definitive = new OpenGeniApiError(409, "personal authority changed", {
      mutation: true,
    });
    expect(classifyCreateSessionFailure(definitive)).toMatchObject({
      error: definitive,
      outcomeUnknown: false,
    });
    const cleared = retainCreateSessionAttemptAfterFailure({
      current: exactRetry.pending,
      attempted: exactRetry.pending,
      outcomeUnknown: definitive.outcomeUnknown,
    });
    const reconfirmed = prepareCreateSessionAttempt({
      pending: cleared,
      client,
      workspaceId: "workspace-a",
      request: { ...request, clientEventId: "event-reconfirmed" },
      freshIdempotencyKey: "fresh-reconfirmed",
    });
    expect(reconfirmed.request.idempotencyKey).toBe("fresh-reconfirmed");
  });
});

describe("successful-create selection history", () => {
  const project = "00000000-0000-4000-8000-000000000031";
  const machineA = "00000000-0000-4000-8000-000000000041";
  const machineB = "00000000-0000-4000-8000-000000000042";
  const history = {
    projects: [
      {
        channelId: project,
        targetSandboxId: machineA,
        machines: [
          { sandboxId: machineA, workingDir: "/workspace/opengeni" },
          { sandboxId: machineB, workingDir: "repos/cloudgeni" },
        ],
      },
      { channelId: null, targetSandboxId: null, machines: [] },
    ],
  };

  test("restores the last compute target for each project", () => {
    expect(rememberedProjectCompute(history, project)).toEqual({
      kind: "machine",
      sandboxId: machineA,
      folder: { kind: "path", path: "/workspace/opengeni" },
    });
    expect(rememberedProjectCompute(history, null)).toEqual({ kind: "sandbox", backend: "" });
    expect(rememberedProjectCompute(history, null, "selfhosted")).toEqual({
      kind: "machine",
      sandboxId: null,
      folder: { kind: "root" },
    });
  });

  test("restores paths only within the exact project and machine pair", () => {
    expect(rememberedMachineFolder(history, project, machineB)).toEqual({
      kind: "path",
      path: "repos/cloudgeni",
    });
    expect(rememberedMachineFolder(history, null, machineB)).toEqual({ kind: "root" });
  });
});

describe("new-session draft option mapping", () => {
  test("restores an empty older draft to the required machine path on selfhosted-primary", () => {
    expect(sessionDraftFromNewSessionDraftOptions({}, undefined, "selfhosted").compute).toEqual({
      kind: "machine",
      sandboxId: null,
      folder: { kind: "root" },
    });
  });

  test("creates Only-me Personal-workspace sessions with private tenancy", () => {
    expect(newSessionCreateVisibility(true, "workspace")).toBe("private");
    expect(newSessionCreateVisibility(true, "private")).toBe("private");
    expect(newSessionCreateVisibility(false, "workspace")).toBe("workspace");
  });

  test("preserves ordered Variable Set precedence through create and draft persistence", () => {
    const variableSetIds = [
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000013",
    ];
    const draft = {
      ...emptySessionDraft(),
      variableSetIds,
      variableSetId: variableSetIds.at(-1)!,
    };
    const personalResourceAttachment = {
      mode: "session" as const,
      workspaceSharedAcknowledged: false,
      sharedOutputWarningVersion: 1 as const,
    };
    const submission = submissionFromSessionDraft(draft, undefined, personalResourceAttachment);
    expect(submission.extras).toMatchObject({
      variableSetIds,
      variableSetId: variableSetIds.at(-1),
      personalResourceAttachment,
    });
    const visibility = newSessionCreateVisibility(true, draft.visibility);
    const request = build([], [], {
      submission: { text: "start privately", ...submission.extras },
      visibility,
    });
    expect(request).toMatchObject({
      visibility: "private",
      variableSetIds,
      variableSetId: variableSetIds.at(-1),
      personalResourceAttachment,
    });
    const options = newSessionDraftOptionsFromSessionDraft(draft, undefined, visibility);
    expect(options).toMatchObject({
      visibility: "private",
      variableSetIds,
      variableSetId: variableSetIds.at(-1),
    });
    expect(options.visibility).toBe(request.visibility);
    expect(sessionDraftFromNewSessionDraftOptions(options)).toMatchObject({
      variableSetIds,
      variableSetId: variableSetIds.at(-1),
    });
  });

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
      visibility: "workspace",
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
      // Composer no longer restores managed-backend overrides into the draft.
      compute: { kind: "sandbox", backend: "" },
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
      visibility: "workspace",
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
