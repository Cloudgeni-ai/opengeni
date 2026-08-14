import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_ATTACHMENT_MAX_COUNT,
  CONVERSATION_TEXT_MAX_UTF8_BYTES,
  assertConversationDeliveryCommand,
  assertConversationDeliveryCommandMatches,
  assertConversationDeliveryMayRetry,
  assertConversationInboundEnvelope,
  canonicalConversationDeliveryCommandJson,
  canonicalConversationDeliveryOutcomeJson,
  canonicalConversationInboundEnvelopeJson,
  canonicalConversationProviderReceiptJson,
  conversationDeliveryNextAction,
  normalizeConversationActor,
  normalizeConversationDeliveryCommand,
  normalizeConversationDeliveryOutcome,
  normalizeConversationInboundEnvelope,
  normalizeConversationInstallationIdentity,
  normalizeConversationProviderReceipt,
  normalizeConversationRoute,
  type ConversationInboundEnvelope,
  type ConversationSignal,
} from "../src";

type SlackLikeDelivery = Readonly<{
  team_id: string;
  type: "app_mention" | "message" | "control";
  user_id: string;
  channel_id: string;
  thread_ts?: string;
  event_id: string;
  message_ts: string;
  event_time: string;
  text: string;
  control?: "stop" | "resume";
  files?: readonly Readonly<{
    id: string;
    name: string;
    mimetype: string;
    size: number;
    sha256: string;
  }>[];
}>;

type TeamsLikeDelivery = Readonly<{
  tenantId: string;
  activityType: "invoke" | "message" | "command";
  member: Readonly<{ id: string }>;
  conversation: Readonly<{ id: string }>;
  replyToId?: string;
  activityId: string;
  messageId: string;
  timestamp: string;
  body: string;
  command?: "stop" | "resume";
  attachments?: readonly Readonly<{
    contentId: string;
    name: string;
    contentType: string;
    contentLength: number;
    digest: string;
  }>[];
}>;

class SlackLikeFakeAdapter {
  normalize(input: SlackLikeDelivery): ConversationInboundEnvelope {
    return normalizeConversationInboundEnvelope({
      provider: "slack-like.example",
      installationId: input.team_id,
      actor: { providerActorId: input.user_id, kind: "human" },
      route: {
        providerConversationId: input.channel_id,
        ...(input.thread_ts ? { providerThreadId: input.thread_ts } : {}),
      },
      providerEventId: input.event_id,
      providerMessageId: input.message_ts,
      occurredAt: input.event_time,
      signal:
        input.type === "app_mention"
          ? { kind: "start" }
          : input.type === "message"
            ? { kind: "continue" }
            : { kind: "control", control: input.control ?? "stop" },
      text: input.text,
      attachments: (input.files ?? []).map((file) => ({
        providerAttachmentId: file.id,
        fileName: file.name,
        mediaType: file.mimetype,
        byteSize: file.size,
        contentSha256: file.sha256,
      })),
    });
  }
}

class TeamsLikeFakeAdapter {
  normalize(input: TeamsLikeDelivery): ConversationInboundEnvelope {
    return normalizeConversationInboundEnvelope({
      provider: "teams-like.example",
      installationId: input.tenantId,
      actor: { providerActorId: input.member.id, kind: "human" },
      route: {
        providerConversationId: input.conversation.id,
        ...(input.replyToId ? { providerThreadId: input.replyToId } : {}),
      },
      providerEventId: input.activityId,
      providerMessageId: input.messageId,
      occurredAt: input.timestamp,
      signal:
        input.activityType === "invoke"
          ? { kind: "start" }
          : input.activityType === "message"
            ? { kind: "continue" }
            : { kind: "control", control: input.command ?? "stop" },
      text: input.body,
      attachments: (input.attachments ?? []).map((attachment) => ({
        providerAttachmentId: attachment.contentId,
        fileName: attachment.name,
        mediaType: attachment.contentType,
        byteSize: attachment.contentLength,
        contentSha256: attachment.digest,
      })),
    });
  }
}

const slackLike = new SlackLikeFakeAdapter();
const teamsLike = new TeamsLikeFakeAdapter();
const occurredAt = "2026-08-13T12:00:00.000Z";
const digest = "a".repeat(64);

function slackDelivery(
  type: SlackLikeDelivery["type"],
  overrides: Partial<SlackLikeDelivery> = {},
): SlackLikeDelivery {
  return {
    team_id: "installation-1",
    type,
    user_id: "actor-1",
    channel_id: "conversation-1",
    thread_ts: "thread-1",
    event_id: `event-${type}`,
    message_ts: `message-${type}`,
    event_time: occurredAt,
    text: type === "control" ? "stop" : "  Preserve this exact text.  ",
    ...(type === "control" ? { control: "stop" } : {}),
    ...overrides,
  };
}

function teamsDelivery(
  activityType: TeamsLikeDelivery["activityType"],
  overrides: Partial<TeamsLikeDelivery> = {},
): TeamsLikeDelivery {
  return {
    tenantId: "installation-1",
    activityType,
    member: { id: "actor-1" },
    conversation: { id: "conversation-1" },
    replyToId: "thread-1",
    activityId: `event-${activityType}`,
    messageId: `message-${activityType}`,
    timestamp: occurredAt,
    body: activityType === "command" ? "stop" : "  Preserve this exact text.  ",
    ...(activityType === "command" ? { command: "stop" } : {}),
    ...overrides,
  };
}

function semanticProjection(envelope: ConversationInboundEnvelope) {
  return {
    signal: envelope.signal,
    text: envelope.text,
    actorKind: envelope.actor.kind,
    hasThread: envelope.route.providerThreadId !== null,
    attachments: envelope.attachments.map((attachment) => ({
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
      byteSize: attachment.byteSize,
      contentSha256: attachment.contentSha256,
    })),
  };
}

function routeFixture() {
  return slackLike.normalize(slackDelivery("app_mention"));
}

describe("conversation integration adapter conformance", () => {
  test("Slack-like and Teams-like adapters normalize identical start, continue, and stop behavior", () => {
    const pairs: readonly [SlackLikeDelivery, TeamsLikeDelivery, ConversationSignal][] = [
      [slackDelivery("app_mention"), teamsDelivery("invoke"), { kind: "start" }],
      [slackDelivery("message"), teamsDelivery("message"), { kind: "continue" }],
      [slackDelivery("control"), teamsDelivery("command"), { kind: "control", control: "stop" }],
    ];

    for (const [slackInput, teamsInput, signal] of pairs) {
      const fromSlack = slackLike.normalize(slackInput);
      const fromTeams = teamsLike.normalize(teamsInput);
      expect(semanticProjection(fromSlack)).toEqual(semanticProjection(fromTeams));
      expect(fromSlack.signal).toEqual(signal);
      expect(fromTeams.signal).toEqual(signal);
      assertConversationInboundEnvelope(fromSlack);
      assertConversationInboundEnvelope(fromTeams);
    }
  });

  test("both adapters produce the same metadata-only attachment semantics", () => {
    const fromSlack = slackLike.normalize(
      slackDelivery("app_mention", {
        files: [
          { id: "file-1", name: "diagram.png", mimetype: "image/png", size: 42, sha256: digest },
        ],
      }),
    );
    const fromTeams = teamsLike.normalize(
      teamsDelivery("invoke", {
        attachments: [
          {
            contentId: "file-1",
            name: "diagram.png",
            contentType: "image/png",
            contentLength: 42,
            digest,
          },
        ],
      }),
    );
    expect(semanticProjection(fromSlack).attachments).toEqual(
      semanticProjection(fromTeams).attachments,
    );
    expect(Object.keys(fromSlack.attachments[0] ?? {})).toEqual([
      "providerAttachmentId",
      "fileName",
      "mediaType",
      "byteSize",
      "contentSha256",
    ]);
  });
});

describe("conversation integration deterministic identities", () => {
  test("duplicate provider deliveries converge on one canonical event identity", () => {
    const original = slackDelivery("message");
    const retry = { ...original };
    expect(slackLike.normalize(original).eventIdentity).toBe(
      slackLike.normalize(retry).eventIdentity,
    );

    const teamsOriginal = teamsDelivery("message");
    expect(teamsLike.normalize(teamsOriginal).eventIdentity).toBe(
      teamsLike.normalize({ ...teamsOriginal }).eventIdentity,
    );
  });

  test("provider, installation, actor, conversation, and thread namespaces cannot collide", () => {
    const base = slackLike.normalize(slackDelivery("message"));
    const otherProvider = teamsLike.normalize(
      teamsDelivery("message", {
        activityId: "event-message",
        messageId: "message-message",
      }),
    );
    const otherInstallation = slackLike.normalize(
      slackDelivery("message", { team_id: "installation-2" }),
    );
    const otherConversation = slackLike.normalize(
      slackDelivery("message", { channel_id: "conversation-2" }),
    );
    const otherThread = slackLike.normalize(slackDelivery("message", { thread_ts: "thread-2" }));
    const noThread = slackLike.normalize(slackDelivery("message", { thread_ts: undefined }));
    const otherActor = slackLike.normalize(slackDelivery("message", { user_id: "actor-2" }));

    expect(
      new Set([base.eventIdentity, otherProvider.eventIdentity, otherInstallation.eventIdentity])
        .size,
    ).toBe(3);
    expect(
      new Set([
        base.route.identity,
        otherProvider.route.identity,
        otherInstallation.route.identity,
        otherConversation.route.identity,
        otherThread.route.identity,
        noThread.route.identity,
      ]).size,
    ).toBe(6);
    expect(
      new Set([
        base.actor.identity,
        otherProvider.actor.identity,
        otherInstallation.actor.identity,
        otherActor.actor.identity,
      ]).size,
    ).toBe(4);
  });

  test("standalone installation, actor, and route normalizers preserve exact provider namespaces", () => {
    const installation = normalizeConversationInstallationIdentity({
      provider: "discord-like.example",
      providerInstallationId: "guild/tenant:42",
    });
    const actor = normalizeConversationActor(installation, {
      providerActorId: "member:42",
      kind: "human",
    });
    const route = normalizeConversationRoute(installation, {
      providerConversationId: "channel:42",
      providerThreadId: "thread:42",
    });
    expect(installation).toEqual({
      provider: "discord-like.example",
      kind: "installation",
      value: "guild/tenant:42",
    });
    expect(actor.providerActorId.provider).toBe(installation.provider);
    expect(route.providerThreadId?.provider).toBe(installation.provider);
  });
});

describe("conversation integration delivery reliability", () => {
  test("post, update, and delete operation identities survive retries and restarts", () => {
    const envelope = routeFixture();
    const inputs = [
      {
        kind: "post",
        logicalOperationKey: "result:post:42",
        installation: envelope.installation,
        route: envelope.route,
        text: "Result",
      },
      {
        kind: "update",
        logicalOperationKey: "result:update:42",
        installation: envelope.installation,
        route: envelope.route,
        targetProviderMessageId: "provider-message-42",
        text: "Updated result",
      },
      {
        kind: "delete",
        logicalOperationKey: "result:delete:42",
        installation: envelope.installation,
        route: envelope.route,
        targetProviderMessageId: "provider-message-42",
      },
    ] as const;
    const firstProcess = inputs.map(normalizeConversationDeliveryCommand);
    const restartedProcess = inputs.map((input) =>
      normalizeConversationDeliveryCommand({ ...input }),
    );

    expect(firstProcess.map((command) => command.operationId)).toEqual(
      restartedProcess.map((command) => command.operationId),
    );
    expect(firstProcess.map((command) => command.requestDigest)).toEqual(
      restartedProcess.map((command) => command.requestDigest),
    );
    expect(new Set(firstProcess.map((command) => command.operationId)).size).toBe(3);
    for (let index = 0; index < firstProcess.length; index += 1) {
      assertConversationDeliveryCommand(firstProcess[index]!);
      assertConversationDeliveryCommandMatches(firstProcess[index]!, restartedProcess[index]!);
    }
  });

  test("stable operation identity plus request digest detects conflicting reuse", () => {
    const envelope = routeFixture();
    const first = normalizeConversationDeliveryCommand({
      kind: "post",
      logicalOperationKey: "one-logical-post",
      installation: envelope.installation,
      route: envelope.route,
      text: "first bytes",
    });
    const conflicting = normalizeConversationDeliveryCommand({
      kind: "post",
      logicalOperationKey: "one-logical-post",
      installation: envelope.installation,
      route: envelope.route,
      text: "different bytes",
    });
    expect(conflicting.operationId).toBe(first.operationId);
    expect(conflicting.requestDigest).not.toBe(first.requestDigest);
    expect(() => assertConversationDeliveryCommandMatches(first, conflicting)).toThrow(
      "reused for different request content",
    );
  });

  test("provider receipts remain namespaced and bind the exact operation request", () => {
    const envelope = routeFixture();
    const command = normalizeConversationDeliveryCommand({
      kind: "update",
      logicalOperationKey: "update-42",
      installation: envelope.installation,
      route: envelope.route,
      targetProviderMessageId: "message-42",
      text: "updated",
    });
    const receipt = normalizeConversationProviderReceipt({
      command,
      providerMessageId: "message-42",
      providerReceiptId: "receipt-42",
      observedAt: occurredAt,
    });
    expect(receipt).toMatchObject({
      operationId: command.operationId,
      requestDigest: command.requestDigest,
      installation: command.installation,
      providerMessageId: { provider: command.installation.provider, value: "message-42" },
      providerReceiptId: { provider: command.installation.provider, value: "receipt-42" },
    });
    expect(() =>
      normalizeConversationProviderReceipt({
        command,
        providerMessageId: "different-message",
        observedAt: occurredAt,
      }),
    ).toThrow("does not match the mutation target");
  });

  test("unknown is reconcile-first, safe failures retry the same operation, and permanent failure stops", () => {
    const notStarted = normalizeConversationDeliveryOutcome({
      status: "not_started",
      code: "admission_rejected",
    });
    const unknown = normalizeConversationDeliveryOutcome({
      status: "unknown",
      code: "response_lost",
    });
    const retryable = normalizeConversationDeliveryOutcome({
      status: "retryable_failure",
      code: "provider_unavailable",
      retryAfterMs: 2_000,
    });
    const permanent = normalizeConversationDeliveryOutcome({
      status: "permanent_failure",
      code: "permission_denied",
    });

    expect(conversationDeliveryNextAction(notStarted)).toBe("retry_same_operation");
    expect(conversationDeliveryNextAction(retryable)).toBe("retry_same_operation");
    expect(conversationDeliveryNextAction(unknown)).toBe("reconcile");
    expect(conversationDeliveryNextAction(permanent)).toBe("stop");
    expect(() => assertConversationDeliveryMayRetry(notStarted)).not.toThrow();
    expect(() => assertConversationDeliveryMayRetry(retryable)).not.toThrow();
    expect(() => assertConversationDeliveryMayRetry(unknown)).toThrow(
      "must be reconciled before retry",
    );
    expect(() => assertConversationDeliveryMayRetry(permanent)).toThrow("may not be retried");
  });

  test("success completes with the exact provider receipt", () => {
    const envelope = routeFixture();
    const command = normalizeConversationDeliveryCommand({
      kind: "post",
      logicalOperationKey: "post-success",
      installation: envelope.installation,
      route: envelope.route,
      text: "done",
    });
    const receipt = normalizeConversationProviderReceipt({
      command,
      providerMessageId: "provider-message-success",
      observedAt: occurredAt,
    });
    const success = normalizeConversationDeliveryOutcome({ status: "success", receipt });
    expect(conversationDeliveryNextAction(success)).toBe("complete");
    expect(success).toEqual({ status: "success", receipt });
  });
});

describe("conversation integration validation and wire projection", () => {
  test("preserves exact accepted user text without credential-shaped rewriting", () => {
    const exactText =
      "  Bearer abcdefghijklmnopqrstuvwxyz012345 and https://private.example/path?token=same  \n";
    const normalized = slackLike.normalize(slackDelivery("message", { text: exactText }));
    expect(normalized.text).toBe(exactText);
    expect(JSON.parse(canonicalConversationInboundEnvelopeJson(normalized)).text).toBe(exactText);
  });

  test("invalid and oversized input fails closed", () => {
    expect(() =>
      normalizeConversationInboundEnvelope({
        ...slackLikeInput(),
        provider: "Not Canonical",
      }),
    ).toThrow("canonical lowercase segments");
    expect(() =>
      normalizeConversationInboundEnvelope({
        ...slackLikeInput(),
        occurredAt: "2026-08-13T12:00:00Z",
      }),
    ).toThrow("canonical UTC timestamp");
    expect(() =>
      normalizeConversationInboundEnvelope({
        ...slackLikeInput(),
        text: "x".repeat(CONVERSATION_TEXT_MAX_UTF8_BYTES + 1),
      }),
    ).toThrow("UTF-8 bytes");
    expect(() =>
      normalizeConversationInboundEnvelope({ ...slackLikeInput(), text: "bad\ud800" }),
    ).toThrow("well-formed Unicode");
    expect(() =>
      normalizeConversationInboundEnvelope({ ...slackLikeInput(), text: "bad\0text" }),
    ).toThrow("must not contain NUL");
    expect(() =>
      normalizeConversationInboundEnvelope({
        ...slackLikeInput(),
        attachments: Array.from({ length: CONVERSATION_ATTACHMENT_MAX_COUNT + 1 }, (_, index) => ({
          providerAttachmentId: `attachment-${index}`,
        })),
      }),
    ).toThrow("at most");
    expect(() =>
      normalizeConversationInboundEnvelope({
        ...slackLikeInput(),
        unexpected: true,
      } as never),
    ).toThrow("unsupported field");
  });

  test("credential-bearing and private provider URL fields cannot enter attachment data", () => {
    for (const attachment of [
      { providerAttachmentId: "file-1", privateUrl: "https://private.example/file" },
      { providerAttachmentId: "file-1", accessToken: "provider-token" },
      { providerAttachmentId: "https://private.example/file" },
      { providerAttachmentId: "//private.example/file" },
      { providerAttachmentId: "file-1", fileName: "private/path.png" },
    ]) {
      expect(() =>
        normalizeConversationInboundEnvelope({
          ...slackLikeInput(),
          attachments: [attachment as never],
        }),
      ).toThrow();
    }
  });

  test("canonical JSON projections are deterministic and reject forged normalized values", () => {
    const input = slackLikeInput();
    const reordered = {
      text: input.text,
      signal: input.signal,
      occurredAt: input.occurredAt,
      providerMessageId: input.providerMessageId,
      providerEventId: input.providerEventId,
      route: {
        providerThreadId: input.route.providerThreadId,
        providerConversationId: input.route.providerConversationId,
      },
      actor: { kind: input.actor.kind, providerActorId: input.actor.providerActorId },
      installationId: input.installationId,
      provider: input.provider,
      attachments: input.attachments,
    } as const;
    const first = normalizeConversationInboundEnvelope(input);
    const second = normalizeConversationInboundEnvelope(reordered);
    const firstJson = canonicalConversationInboundEnvelopeJson(first);
    expect(firstJson).toBe(canonicalConversationInboundEnvelopeJson(second));
    expect(Object.keys(JSON.parse(firstJson))).toEqual([
      "schemaVersion",
      "installation",
      "actor",
      "route",
      "providerEventId",
      "providerMessageId",
      "eventIdentity",
      "occurredAt",
      "signal",
      "text",
      "attachments",
    ]);

    const command = normalizeConversationDeliveryCommand({
      kind: "post",
      logicalOperationKey: "wire-post",
      installation: first.installation,
      route: first.route,
      text: "wire text",
    });
    expect(canonicalConversationDeliveryCommandJson(command)).toBe(
      canonicalConversationDeliveryCommandJson(
        normalizeConversationDeliveryCommand({
          text: "wire text",
          route: first.route,
          installation: first.installation,
          logicalOperationKey: "wire-post",
          kind: "post",
        }),
      ),
    );
    const receipt = normalizeConversationProviderReceipt({
      command,
      providerMessageId: "wire-message",
      observedAt: occurredAt,
    });
    expect(canonicalConversationProviderReceiptJson(receipt)).toBe(
      canonicalConversationProviderReceiptJson({ ...receipt }),
    );
    expect(
      canonicalConversationDeliveryOutcomeJson(
        normalizeConversationDeliveryOutcome({
          status: "retryable_failure",
          code: "provider_unavailable",
        }),
      ),
    ).toBe('{"status":"retryable_failure","code":"provider_unavailable","retryAfterMs":null}');

    const forged = { ...command, requestDigest: `sha256:${"0".repeat(64)}` };
    expect(() => assertConversationDeliveryCommand(forged)).toThrow("not canonical");
  });
});

function slackLikeInput() {
  return {
    provider: "slack-like.example",
    installationId: "installation-1",
    actor: { providerActorId: "actor-1", kind: "human" as const },
    route: {
      providerConversationId: "conversation-1",
      providerThreadId: "thread-1",
    },
    providerEventId: "event-1",
    providerMessageId: "message-1",
    occurredAt,
    signal: { kind: "start" as const },
    text: "exact text",
    attachments: [
      {
        providerAttachmentId: "file-1",
        fileName: "diagram.png",
        mediaType: "image/png",
        byteSize: 42,
        contentSha256: digest,
      },
    ],
  };
}
