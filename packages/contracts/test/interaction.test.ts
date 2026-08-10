import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AuthRun,
  BrowserActionCommand,
  BrowserActionRequest,
  BrowserActionReceipt,
  BrowserClipboard,
  BrowserDiagnosticBatch,
  BrowserIdentity,
  BrowserObservation,
  BrowserRevision,
  BrowserRevisionMaterialization,
  BrowserSessionAttachment,
  BrowserWorkspaceFileStageRequest,
  ComputerActionCommand,
  ComputerActionRequest,
  ComputerActionReceipt,
  ComputerClipboard,
  ComputerSessionAttachment,
  ComputerSessionAttachmentRequest,
  ComputerTargetListResponse,
  CreateNetworkRouteRequest,
  CreateSiteAuthConnectionRequest,
  CreateBrowserSessionRequest,
  CreateComputerSessionRequest,
  InteractionActor,
  InteractionError,
  PublishBrowserRevisionRequest,
  ReportAuthRunRequest,
} from "../src";

const browserSessionId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const computerSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function observation() {
  return {
    protocolVersion: 1 as const,
    observationId: "observation-7",
    browserSessionId,
    target: {
      id: "target-1",
      browserSessionId,
      controllerGeneration: "controller-2",
      targetGeneration: "target-4",
      documentGeneration: "document-9",
      kind: "page" as const,
      title: "Fixture",
      url: "http://fixture.test/",
      selected: true,
      attached: true,
      createdAt: "2026-08-09T12:00:00.000Z",
    },
    frameId: "frame-12",
    semantic: {
      kind: "snapshot" as const,
      roots: [
        {
          ref: "e1",
          role: "button",
          name: "Save",
          states: ["enabled"],
          actions: ["click"],
        },
      ],
      nodeCount: 1,
    },
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    diagnostics: {
      consoleErrorCount: 0,
      failedRequestCount: 0,
      downloadCount: 0,
      pageErrorCount: 0,
    },
    dialog: null,
    observedAt: "2026-08-09T12:00:00.000Z",
  };
}

describe("interaction contracts", () => {
  test("keeps public actions actor-free and defaults new browsers to headless", () => {
    expect(
      CreateBrowserSessionRequest.parse({
        operationId,
        sessionId: "33333333-3333-4333-8333-333333333333",
      }).headless,
    ).toBe(true);
    expect(
      CreateBrowserSessionRequest.safeParse({
        operationId,
        sessionId: "33333333-3333-4333-8333-333333333333",
        initialUrl: "not an absolute URL",
      }).success,
    ).toBe(false);
    const linkedComputerSessionId = "55555555-5555-4555-8555-555555555555";
    expect(
      CreateBrowserSessionRequest.safeParse({
        operationId,
        sessionId: "33333333-3333-4333-8333-333333333333",
        linkedComputerSessionId,
      }).success,
    ).toBe(false);
    expect(
      CreateBrowserSessionRequest.parse({
        operationId,
        sessionId: "33333333-3333-4333-8333-333333333333",
        headless: false,
        linkedComputerSessionId,
      }).linkedComputerSessionId,
    ).toBe(linkedComputerSessionId);
    expect(
      CreateBrowserSessionRequest.safeParse({
        operationId,
        sessionId: "33333333-3333-4333-8333-333333333333",
        headless: false,
        linkedComputerSessionId,
        placement: {
          kind: "attached_device",
          deviceId: "66666666-6666-4666-8666-666666666666",
        },
      }).success,
    ).toBe(false);
    expect(
      CreateBrowserSessionRequest.safeParse({
        operationId,
        sessionId: "33333333-3333-4333-8333-333333333333",
        baseRevisionId: "44444444-4444-4444-8444-444444444444",
      }).success,
    ).toBe(false);
    expect(
      BrowserActionRequest.safeParse({
        operationId,
        targetId: "target-1",
        expectedTargetGeneration: "target-4",
        expectedDocumentGeneration: "document-9",
        expectedFrameId: "frame-12",
        actor: { kind: "agent", subjectId: "forged" },
        action: { type: "click", locator: { kind: "ref", ref: "e1" } },
      }).success,
    ).toBe(false);
  });

  test("binds browser actions to controller, target, document, frame, and actor generations", () => {
    const parsed = BrowserActionCommand.parse({
      protocolVersion: 1,
      operationId,
      browserSessionId,
      controllerGeneration: "controller-2",
      targetId: "target-1",
      expectedTargetGeneration: "target-4",
      expectedDocumentGeneration: "document-9",
      expectedFrameId: "frame-12",
      actor: {
        kind: "agent",
        subjectId: "agent:worker",
        sessionId: "33333333-3333-4333-8333-333333333333",
        turnId: "44444444-4444-4444-8444-444444444444",
        attemptId: "55555555-5555-4555-8555-555555555555",
        executionGeneration: 3,
      },
      action: {
        type: "click",
        locator: { kind: "role", role: "button", name: "Save" },
      },
    });
    expect(parsed.expectedDocumentGeneration).toBe("document-9");
    expect(parsed.actor.attemptId).toBe("55555555-5555-4555-8555-555555555555");
  });

  test("requires complete attempt provenance", () => {
    expect(
      InteractionActor.safeParse({
        kind: "agent",
        subjectId: "agent:worker",
        sessionId: "33333333-3333-4333-8333-333333333333",
        attemptId: "55555555-5555-4555-8555-555555555555",
      }).success,
    ).toBe(false);
  });

  test("keeps public computer creation and actions provider-neutral and actor-free", () => {
    expect(
      CreateComputerSessionRequest.parse({
        operationId,
        sessionId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toEqual({
      operationId,
      sessionId: "33333333-3333-4333-8333-333333333333",
    });
    expect(
      CreateComputerSessionRequest.safeParse({
        operationId,
        sessionId: "33333333-3333-4333-8333-333333333333",
        platform: "linux",
        adapter: "x11",
        displayId: ":99",
      }).success,
    ).toBe(false);
    expect(
      ComputerActionRequest.safeParse({
        operationId,
        targetId: "window-1",
        expectedTargetGeneration: "target-3",
        expectedObservationId: "observation-5",
        expectedFrameId: null,
        actor: { kind: "agent", subjectId: "forged" },
        action: {
          type: "semantic",
          locator: { kind: "ref", ref: "e1" },
          action: "invoke",
        },
      }).success,
    ).toBe(false);
  });

  test("fences computer semantic and pixel actions to exact observations and frames", () => {
    const semantic = {
      operationId,
      targetId: "window-1",
      expectedTargetGeneration: "target-3",
      expectedObservationId: "observation-5",
      expectedFrameId: null,
      action: {
        type: "semantic" as const,
        locator: { kind: "ref" as const, ref: "e1" },
        action: "invoke" as const,
      },
    };
    expect(ComputerActionRequest.parse(semantic)).toEqual(semantic);
    expect(
      ComputerActionRequest.safeParse({
        ...semantic,
        expectedObservationId: null,
      }).success,
    ).toBe(false);

    const pointer = {
      operationId,
      targetId: "window-1",
      expectedTargetGeneration: "target-3",
      expectedObservationId: null,
      expectedFrameId: "frame-8",
      action: {
        type: "pointer" as const,
        frameId: "frame-8",
        action: "click" as const,
        x: 80,
        y: 40,
      },
    };
    expect(ComputerActionRequest.parse(pointer)).toEqual(pointer);
    expect(
      ComputerActionRequest.safeParse({
        ...pointer,
        expectedFrameId: "frame-7",
      }).success,
    ).toBe(false);
    expect(ComputerSessionAttachmentRequest.parse({ targetId: "window-1" }).expiresInSeconds).toBe(
      120,
    );
  });

  test("keeps Browser and Computer relay channels truthfully distinct", () => {
    const shared = {
      controllerGeneration: "controller-2",
      targetId: "window-1",
      expiresAt: "2026-08-10T10:02:00.000Z",
    };
    const relay = {
      kind: "relay" as const,
      url: "https://relay.example.test/stream",
      token: "r".repeat(32),
      channel: {
        channelId: "channel-1",
        workspaceId: operationId,
        agentId: "agent-1",
        port: 20_001,
      },
    };
    expect(
      BrowserSessionAttachment.safeParse({
        ...shared,
        browserSessionId,
        stream: { ...relay, channel: { ...relay.channel, kind: 3 } },
      }).success,
    ).toBe(true);
    expect(
      BrowserSessionAttachment.safeParse({
        ...shared,
        browserSessionId,
        stream: { ...relay, channel: { ...relay.channel, kind: 4 } },
      }).success,
    ).toBe(false);
    expect(
      ComputerSessionAttachment.safeParse({
        ...shared,
        computerSessionId,
        stream: { ...relay, channel: { ...relay.channel, kind: 4 } },
      }).success,
    ).toBe(true);
    expect(
      ComputerSessionAttachment.safeParse({
        ...shared,
        computerSessionId,
        stream: { ...relay, channel: { ...relay.channel, kind: 3 } },
      }).success,
    ).toBe(false);
  });

  test("binds controller computer commands and receipts to durable causal authority", () => {
    expect(
      ComputerActionCommand.parse({
        protocolVersion: 1,
        operationId,
        computerSessionId,
        controllerGeneration: "controller-2",
        targetId: "window-1",
        expectedTargetGeneration: "target-3",
        expectedObservationId: "observation-5",
        expectedFrameId: null,
        actor: { kind: "human", subjectId: "user:test" },
        action: {
          type: "semantic",
          locator: { kind: "ref", ref: "e1" },
          action: "invoke",
        },
      }).computerSessionId,
    ).toBe(computerSessionId);
    expect(
      ComputerTargetListResponse.parse({
        computerSessionId,
        controllerGeneration: "controller-2",
        targets: [],
      }).targets,
    ).toEqual([]);
    expect(
      ComputerActionReceipt.safeParse({
        protocolVersion: 1,
        operationId,
        computerSessionId,
        controllerGeneration: "controller-2",
        targetId: "window-1",
        state: "completed",
        dispatchedAt: "2026-08-10T12:00:00.000Z",
        settledAt: null,
        observation: null,
        error: null,
      }).success,
    ).toBe(false);
  });

  test("keeps native computer clipboard reads bounded and mutations causal", () => {
    expect(
      ComputerClipboard.parse({
        computerSessionId,
        controllerGeneration: "controller-2",
        text: "native clipboard",
        truncated: false,
        observedAt: "2026-08-10T12:00:00.000Z",
      }),
    ).toMatchObject({ text: "native clipboard", truncated: false });
    expect(
      ComputerClipboard.safeParse({
        computerSessionId,
        controllerGeneration: "controller-2",
        text: null,
        truncated: true,
        observedAt: "2026-08-10T12:00:00.000Z",
      }).success,
    ).toBe(false);

    const base = {
      operationId,
      targetId: "screen-1",
      expectedTargetGeneration: "target-4",
      expectedObservationId: null,
      expectedFrameId: null,
    };
    expect(
      ComputerActionRequest.parse({
        ...base,
        action: { type: "clipboard", operation: "write", text: "hello" },
      }).action,
    ).toEqual({ type: "clipboard", operation: "write", text: "hello" });
    for (const action of [
      { type: "clipboard", operation: "write" },
      { type: "clipboard", operation: "clear", text: "unexpected" },
      { type: "clipboard", operation: "copy", text: "unexpected" },
      { type: "clipboard", operation: "paste", text: "unexpected" },
    ]) {
      expect(ComputerActionRequest.safeParse({ ...base, action }).success).toBe(false);
    }
  });

  test("validates generation-fenced human pointer actions", () => {
    const base = {
      operationId,
      targetId: "target-1",
      expectedTargetGeneration: "target-4",
      expectedDocumentGeneration: "document-9",
      expectedFrameId: "frame-12",
    };
    expect(
      BrowserActionRequest.parse({
        ...base,
        action: { type: "pointer", action: "click", x: 120, y: 80 },
      }).action,
    ).toMatchObject({ type: "pointer", action: "click", x: 120, y: 80 });
    expect(
      BrowserActionRequest.safeParse({
        ...base,
        action: { type: "pointer", action: "drag", x: 1, y: 2, endX: 3 },
      }).success,
    ).toBe(false);
    expect(
      BrowserActionRequest.safeParse({
        ...base,
        action: { type: "pointer", action: "click", x: 1, y: 2, deltaY: 40 },
      }).success,
    ).toBe(false);
  });

  test("keeps browser clipboard state private, bounded, and action-fenced", () => {
    expect(
      BrowserClipboard.parse({
        browserSessionId,
        controllerGeneration: "controller-2",
        revision: 0,
        text: "",
        source: "empty",
        sourceTargetId: null,
        updatedAt: null,
      }),
    ).toMatchObject({ revision: 0, source: "empty" });
    expect(
      BrowserClipboard.safeParse({
        browserSessionId,
        controllerGeneration: "controller-2",
        revision: 0,
        text: "stale",
        source: "write",
        sourceTargetId: "target-1",
        updatedAt: "2026-08-10T12:00:00.000Z",
      }).success,
    ).toBe(false);

    const base = {
      operationId,
      targetId: "target-1",
      expectedTargetGeneration: "target-4",
      expectedDocumentGeneration: "document-9",
      expectedFrameId: "frame-12",
    };
    expect(
      BrowserActionRequest.parse({
        ...base,
        action: { type: "clipboard", operation: "paste", text: "hello" },
      }).action,
    ).toMatchObject({ type: "clipboard", operation: "paste", text: "hello" });
    for (const action of [
      { type: "clipboard", operation: "write" },
      { type: "clipboard", operation: "clear", text: "unexpected" },
      { type: "clipboard", operation: "copy", content: "value" },
      { type: "clipboard", operation: "paste", content: "text" },
    ]) {
      expect(BrowserActionRequest.safeParse({ ...base, action }).success).toBe(false);
    }
  });

  test("bounds browser web-permission control to typed origin-fenced settings", () => {
    const base = {
      operationId,
      targetId: "target-1",
      expectedTargetGeneration: "target-4",
      expectedDocumentGeneration: "document-9",
      expectedFrameId: "frame-12",
    };
    expect(
      BrowserActionRequest.parse({
        ...base,
        action: { type: "permission", permission: "geolocation", setting: "denied" },
      }).action,
    ).toEqual({ type: "permission", permission: "geolocation", setting: "denied" });
    for (const action of [
      { type: "permission", permission: "unknown", setting: "granted" },
      { type: "permission", permission: "camera", setting: "reset" },
      {
        type: "permission",
        permission: "notifications",
        setting: "prompt",
        origin: "https://unfenced.example",
      },
    ]) {
      expect(BrowserActionRequest.safeParse({ ...base, action }).success).toBe(false);
    }
  });

  test("bounds browser workspace-file staging and aggregate upload batches", () => {
    const fileId = randomUUID();
    const authority = {
      fileId,
      safeFilename: "report.txt",
      sizeBytes: 12,
      sha256: "a".repeat(64),
      download: {
        url: "https://objects.example.test/file?signature=private",
        expiresAt: "2026-08-10T12:05:00.000Z",
      },
    };
    expect(
      BrowserWorkspaceFileStageRequest.safeParse({
        operationId,
        files: [authority, authority],
      }).success,
    ).toBe(false);
    expect(
      BrowserWorkspaceFileStageRequest.safeParse({
        operationId,
        files: [{ ...authority, safeFilename: "../secret" }],
      }).success,
    ).toBe(false);

    const fileIds = Array.from({ length: 101 }, () => randomUUID());
    expect(
      BrowserActionRequest.safeParse({
        operationId,
        targetId: "target-1",
        expectedTargetGeneration: "target-4",
        expectedDocumentGeneration: "document-9",
        expectedFrameId: "frame-12",
        action: {
          type: "batch",
          actions: [
            {
              type: "upload",
              locator: { kind: "css", selector: "#one" },
              workspaceFileIds: fileIds.slice(0, 100),
            },
            {
              type: "upload",
              locator: { kind: "css", selector: "#two" },
              workspaceFileIds: fileIds.slice(100),
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  test("models blocking dialogs and bounded diagnostic cursors", () => {
    expect(
      BrowserActionCommand.parse({
        protocolVersion: 1,
        operationId,
        browserSessionId,
        controllerGeneration: "controller-2",
        targetId: "target-1",
        expectedTargetGeneration: "target-4",
        expectedDocumentGeneration: "document-9",
        expectedFrameId: "frame-12",
        actor: { kind: "human", subjectId: "user:test" },
        action: {
          type: "handle_dialog",
          response: "accept",
          promptText: "Grace",
        },
      }).action,
    ).toMatchObject({ type: "handle_dialog", promptText: "Grace" });
    expect(
      BrowserDiagnosticBatch.parse({
        browserSessionId,
        controllerGeneration: "controller-2",
        targetId: "target-1",
        targetGeneration: "target-4",
        entries: [],
        cursor: 0,
        truncated: false,
      }),
    ).toMatchObject({ cursor: 0, entries: [] });
  });

  test("accepts compact semantic observations and enforces terminal receipt truth", () => {
    expect(BrowserObservation.parse(observation()).semantic).toMatchObject({
      nodeCount: 1,
    });
    expect(
      BrowserActionReceipt.safeParse({
        protocolVersion: 1,
        operationId,
        browserSessionId,
        controllerGeneration: "controller-2",
        targetId: "target-1",
        state: "completed",
        dispatchedAt: "2026-08-09T12:00:00.000Z",
        settledAt: null,
        observation: observation(),
        error: null,
      }).success,
    ).toBe(false);
    expect(
      BrowserActionReceipt.safeParse({
        protocolVersion: 1,
        operationId,
        browserSessionId,
        controllerGeneration: "controller-2",
        targetId: "target-1",
        state: "outcome_unknown",
        dispatchedAt: "2026-08-09T12:00:00.000Z",
        settledAt: "2026-08-09T12:00:01.000Z",
        observation: null,
        error: {
          code: "controller_lost",
          message: "controller disconnected after dispatch",
          retryable: false,
        },
      }).success,
    ).toBe(true);
  });

  test("keeps browser identity lineage immutable, bounded, and storage-secret-free", () => {
    const materialization = BrowserRevisionMaterialization.parse({
      portability: "portable",
      reason: null,
      platform: "linux",
      architecture: "arm64",
      engine: "chromium",
      engineVersion: "151.0.0",
      driverId: "opengeni.cdp.v1",
      driverSchemaVersion: 1,
      profileCrypto: "chromium_basic",
      providerId: null,
      placement: null,
    });
    expect(
      BrowserRevisionMaterialization.safeParse({
        ...materialization,
        portability: "provider_bound",
      }).success,
    ).toBe(false);
    expect(
      BrowserRevisionMaterialization.safeParse({
        ...materialization,
        profileCrypto: "platform_bound",
      }).success,
    ).toBe(false);
    expect(
      BrowserRevisionMaterialization.safeParse({
        ...materialization,
        portability: "placement_bound",
        reason: "Authentication is bound to this device.",
        placement: {
          kind: "sandbox_group",
          sandboxGroupId: "55555555-5555-4555-8555-555555555555",
        },
      }).success,
    ).toBe(true);
    expect(
      BrowserRevisionMaterialization.safeParse({
        ...materialization,
        portability: "placement_bound",
        reason: "Browser state is device-bound",
        providerId: "provider:unexpected",
        placement: { kind: "attached_device", deviceId: browserSessionId },
      }).success,
    ).toBe(false);

    const identityId = "66666666-6666-4666-8666-666666666666";
    const revisionId = "77777777-7777-4777-8777-777777777777";
    const identity = BrowserIdentity.parse({
      id: identityId,
      accountId: "88888888-8888-4888-8888-888888888888",
      workspaceId: "99999999-9999-4999-8999-999999999999",
      name: "Work",
      status: "active",
      defaultRevisionId: revisionId,
      headGeneration: 4,
      revisionCount: 4,
      createdBySubjectId: "user:test",
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:01.000Z",
    });
    expect(identity.name).toBe("Work");

    const revision = BrowserRevision.parse({
      id: revisionId,
      accountId: identity.accountId,
      workspaceId: identity.workspaceId,
      identityId,
      parentRevisionId: null,
      ordinal: 4,
      sourceBrowserSessionId: browserSessionId,
      manifestDigest: "a".repeat(64),
      components: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          kind: "chromium_profile",
          format: "opengeni.chromium-profile.tar.gz.aesgcm.v1",
          artifactDigest: "b".repeat(64),
          sizeBytes: 1024,
          materialization,
        },
      ],
      createdBySubjectId: "user:test",
      createdAt: "2026-08-09T12:00:01.000Z",
    });
    expect(revision).not.toHaveProperty("objectKey");
    expect(revision.components[0]).not.toHaveProperty("encryptedDataKey");
    expect(
      InteractionError.parse({
        code: "outcome_unknown",
        message: "external upload may have completed",
        retryable: false,
      }).code,
    ).toBe("outcome_unknown");

    expect(
      PublishBrowserRevisionRequest.parse({
        operationId,
        identityId,
        expectedHeadGeneration: 4,
      }).advanceDefault,
    ).toBe(true);
  });

  test("separates canonical network routes, login authority, and auth-run state", () => {
    const credential = {
      connectionId: "33333333-3333-4333-8333-333333333333",
      connectionSubjectId: "user:test",
      providerDomain: "example.com",
    };
    expect(
      CreateNetworkRouteRequest.parse({
        operationId,
        name: "Office proxy",
        configuration: {
          kind: "proxy",
          protocol: "https",
          host: "proxy.example.com",
          port: 443,
          credential,
        },
        consistency: {
          dns: "proxy",
          expectedPublicIp: null,
          expectedRegion: "NO",
          locale: "nb-NO",
          timezone: "Europe/Oslo",
          geolocation: null,
          webRtc: "proxy_only",
          stability: "sticky",
        },
      }).configuration.kind,
    ).toBe("proxy");

    const auth = CreateSiteAuthConnectionRequest.parse({
      operationId,
      name: "Example work account",
      accountLabel: "jorgen@example.com",
      origins: ["https://example.com", "https://login.example.com"],
      loginUrl: "https://login.example.com/sign-in",
      verificationUrlPrefixes: ["https://example.com/app"],
      authorities: [
        {
          id: "password-authority",
          kind: "connection_fields",
          label: "Workspace connection",
          credential,
          fields: [
            { id: "email", purpose: "identifier", credentialKey: "email" },
            { id: "password", purpose: "password", credentialKey: "password" },
          ],
        },
      ],
      methods: [
        {
          id: "password",
          kind: "password",
          label: "Email and password",
          authorityIds: ["password-authority"],
        },
      ],
      preferredIdentityId: null,
      preferredPlacement: null,
      preferredNetworkRouteId: null,
      healthPolicy: { mode: "on_use", intervalSeconds: null, automaticRepair: false },
    });
    expect(auth.origins).toEqual(["https://example.com", "https://login.example.com"]);
    expect(
      CreateSiteAuthConnectionRequest.safeParse({
        ...auth,
        origins: ["https://example.com/path"],
      }).success,
    ).toBe(false);
    expect(
      CreateSiteAuthConnectionRequest.safeParse({
        ...auth,
        origins: ["https://example.com"],
      }).success,
    ).toBe(false);

    const baseRun = {
      id: "44444444-4444-4444-8444-444444444444",
      accountId: "55555555-5555-4555-8555-555555555555",
      workspaceId: "66666666-6666-4666-8666-666666666666",
      siteAuthConnectionId: "77777777-7777-4777-8777-777777777777",
      browserSessionId,
      targetId: "target-1",
      controllerGeneration: "controller-1",
      targetGeneration: "target-1",
      documentGeneration: "document-1",
      methodId: null,
      authorityId: null,
      choices: [],
      pendingFields: [],
      externalAction: null,
      interventionId: null,
      verifiedUrl: null,
      failureCode: null,
      version: 1,
      operationId,
      createdBySubjectId: "user:test",
      createdAt: "2026-08-09T12:00:00.000Z",
      updatedAt: "2026-08-09T12:00:00.000Z",
      settledAt: null,
    };
    expect(AuthRun.parse({ ...baseRun, state: "discovering" }).state).toBe("discovering");
    expect(AuthRun.safeParse({ ...baseRun, state: "awaiting_secret" }).success).toBe(false);
    expect(
      ReportAuthRunRequest.safeParse({
        operationId,
        expectedVersion: 1,
        state: "awaiting_choice",
        choices: [],
      }).success,
    ).toBe(false);
    expect(
      ReportAuthRunRequest.safeParse({
        operationId,
        expectedVersion: 1,
        state: "awaiting_choice",
        choices: [{ id: "password", label: "Password", methodId: "password" }],
      }).success,
    ).toBe(true);
  });
});
