import { createHash } from "node:crypto";

declare const conversationProviderNamespaceBrand: unique symbol;
declare const conversationProviderOpaqueValueBrand: unique symbol;
declare const conversationEventIdentityBrand: unique symbol;
declare const conversationRouteIdentityBrand: unique symbol;
declare const conversationActorIdentityBrand: unique symbol;
declare const conversationOperationIdentityBrand: unique symbol;
declare const conversationRequestDigestBrand: unique symbol;

export const CONVERSATION_INTEGRATION_SCHEMA_VERSION = 1 as const;
export const CONVERSATION_PROVIDER_NAMESPACE_MAX_UTF8_BYTES = 128;
export const CONVERSATION_PROVIDER_OPAQUE_ID_MAX_UTF8_BYTES = 512;
export const CONVERSATION_TEXT_MAX_UTF8_BYTES = 32 * 1024;
export const CONVERSATION_ATTACHMENT_MAX_COUNT = 16;
export const CONVERSATION_ATTACHMENT_NAME_MAX_UTF8_BYTES = 1024;
export const CONVERSATION_ATTACHMENT_MEDIA_TYPE_MAX_UTF8_BYTES = 128;
export const CONVERSATION_OPERATION_KEY_MAX_UTF8_BYTES = 512;
export const CONVERSATION_OUTCOME_CODE_MAX_UTF8_BYTES = 128;

const PROVIDER_NAMESPACE_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;
const OUTCOME_CODE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ABSOLUTE_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;
const textEncoder = new TextEncoder();

export type ConversationProviderNamespace = string & {
  readonly [conversationProviderNamespaceBrand]: true;
};

export type ConversationProviderOpaqueValue = string & {
  readonly [conversationProviderOpaqueValueBrand]: true;
};

export type ConversationProviderOpaqueIdKind =
  | "installation"
  | "actor"
  | "conversation"
  | "thread"
  | "event"
  | "message"
  | "attachment"
  | "receipt";

export type ConversationProviderOpaqueId<
  TKind extends ConversationProviderOpaqueIdKind = ConversationProviderOpaqueIdKind,
> = Readonly<{
  provider: ConversationProviderNamespace;
  kind: TKind;
  value: ConversationProviderOpaqueValue;
}>;

export type ConversationInstallationIdentity = ConversationProviderOpaqueId<"installation">;
export type ConversationEventIdentity = `ciev1_${string}` & {
  readonly [conversationEventIdentityBrand]: true;
};
export type ConversationRouteIdentity = `cirt1_${string}` & {
  readonly [conversationRouteIdentityBrand]: true;
};
export type ConversationActorIdentity = `ciac1_${string}` & {
  readonly [conversationActorIdentityBrand]: true;
};
export type ConversationOperationIdentity = `ciop1_${string}` & {
  readonly [conversationOperationIdentityBrand]: true;
};
export type ConversationRequestDigest = `sha256:${string}` & {
  readonly [conversationRequestDigestBrand]: true;
};

export type ConversationActorKind = "human" | "bot" | "system";

export type ConversationActorInput = Readonly<{
  providerActorId: string;
  kind: ConversationActorKind;
}>;

export type ConversationActor = Readonly<{
  installation: ConversationInstallationIdentity;
  providerActorId: ConversationProviderOpaqueId<"actor">;
  kind: ConversationActorKind;
  identity: ConversationActorIdentity;
}>;

export type ConversationRoute = Readonly<{
  installation: ConversationInstallationIdentity;
  providerConversationId: ConversationProviderOpaqueId<"conversation">;
  providerThreadId: ConversationProviderOpaqueId<"thread"> | null;
  identity: ConversationRouteIdentity;
}>;

export type ConversationRouteInput = Readonly<{
  providerConversationId: string;
  providerThreadId?: string | null;
}>;

export type ConversationStartSignal = Readonly<{ kind: "start" }>;
export type ConversationContinueSignal = Readonly<{ kind: "continue" }>;
export type ConversationControlSignal = Readonly<{
  kind: "control";
  control: "stop" | "resume";
}>;
export type ConversationSignal =
  | ConversationStartSignal
  | ConversationContinueSignal
  | ConversationControlSignal;

export type ConversationAttachmentReference = Readonly<{
  providerAttachmentId: ConversationProviderOpaqueId<"attachment">;
  fileName: string | null;
  mediaType: string | null;
  byteSize: number | null;
  contentSha256: string | null;
}>;

export type ConversationAttachmentReferenceInput = Readonly<{
  providerAttachmentId: string;
  fileName?: string | null;
  mediaType?: string | null;
  byteSize?: number | null;
  contentSha256?: string | null;
}>;

export type ConversationInboundEnvelope = Readonly<{
  schemaVersion: typeof CONVERSATION_INTEGRATION_SCHEMA_VERSION;
  installation: ConversationInstallationIdentity;
  actor: ConversationActor;
  route: ConversationRoute;
  providerEventId: ConversationProviderOpaqueId<"event">;
  providerMessageId: ConversationProviderOpaqueId<"message">;
  eventIdentity: ConversationEventIdentity;
  occurredAt: string;
  signal: ConversationSignal;
  text: string;
  attachments: readonly ConversationAttachmentReference[];
}>;

export type ConversationInboundEnvelopeInput = Readonly<{
  provider: string;
  installationId: string;
  actor: ConversationActorInput;
  route: ConversationRouteInput;
  providerEventId: string;
  providerMessageId: string;
  occurredAt: string;
  signal: ConversationSignal;
  text: string;
  attachments?: readonly ConversationAttachmentReferenceInput[];
}>;

type ConversationDeliveryCommandBase = Readonly<{
  schemaVersion: typeof CONVERSATION_INTEGRATION_SCHEMA_VERSION;
  operationId: ConversationOperationIdentity;
  logicalOperationKey: string;
  requestDigest: ConversationRequestDigest;
  installation: ConversationInstallationIdentity;
  route: ConversationRoute;
}>;

export type ConversationPostCommand = ConversationDeliveryCommandBase &
  Readonly<{
    kind: "post";
    targetProviderMessageId: null;
    text: string;
  }>;

export type ConversationUpdateCommand = ConversationDeliveryCommandBase &
  Readonly<{
    kind: "update";
    targetProviderMessageId: ConversationProviderOpaqueId<"message">;
    text: string;
  }>;

export type ConversationDeleteCommand = ConversationDeliveryCommandBase &
  Readonly<{
    kind: "delete";
    targetProviderMessageId: ConversationProviderOpaqueId<"message">;
    text: null;
  }>;

export type ConversationDeliveryCommand =
  | ConversationPostCommand
  | ConversationUpdateCommand
  | ConversationDeleteCommand;

export type ConversationDeliveryCommandInput =
  | Readonly<{
      kind: "post";
      logicalOperationKey: string;
      installation: ConversationInstallationIdentity;
      route: ConversationRoute;
      text: string;
    }>
  | Readonly<{
      kind: "update";
      logicalOperationKey: string;
      installation: ConversationInstallationIdentity;
      route: ConversationRoute;
      targetProviderMessageId: string;
      text: string;
    }>
  | Readonly<{
      kind: "delete";
      logicalOperationKey: string;
      installation: ConversationInstallationIdentity;
      route: ConversationRoute;
      targetProviderMessageId: string;
    }>;

export type ConversationProviderReceipt = Readonly<{
  schemaVersion: typeof CONVERSATION_INTEGRATION_SCHEMA_VERSION;
  operationId: ConversationOperationIdentity;
  requestDigest: ConversationRequestDigest;
  installation: ConversationInstallationIdentity;
  providerMessageId: ConversationProviderOpaqueId<"message">;
  providerReceiptId: ConversationProviderOpaqueId<"receipt"> | null;
  observedAt: string;
}>;

export type ConversationProviderReceiptInput = Readonly<{
  command: ConversationDeliveryCommand;
  providerMessageId: string;
  providerReceiptId?: string | null;
  observedAt: string;
}>;

export type ConversationDeliveryNotStarted = Readonly<{
  status: "not_started";
  code: string;
}>;
export type ConversationDeliveryUnknown = Readonly<{
  status: "unknown";
  code: string;
}>;
export type ConversationDeliveryRetryableFailure = Readonly<{
  status: "retryable_failure";
  code: string;
  retryAfterMs: number | null;
}>;
export type ConversationDeliveryPermanentFailure = Readonly<{
  status: "permanent_failure";
  code: string;
}>;
export type ConversationDeliverySuccess = Readonly<{
  status: "success";
  receipt: ConversationProviderReceipt;
}>;

export type ConversationDeliveryOutcome =
  | ConversationDeliveryNotStarted
  | ConversationDeliveryUnknown
  | ConversationDeliveryRetryableFailure
  | ConversationDeliveryPermanentFailure
  | ConversationDeliverySuccess;

export type ConversationDeliveryOutcomeInput =
  | ConversationDeliveryNotStarted
  | ConversationDeliveryUnknown
  | Readonly<{
      status: "retryable_failure";
      code: string;
      retryAfterMs?: number | null;
    }>
  | ConversationDeliveryPermanentFailure
  | ConversationDeliverySuccess;

export type ConversationDeliveryNextAction =
  | "retry_same_operation"
  | "reconcile"
  | "stop"
  | "complete";

export function normalizeConversationInboundEnvelope(
  input: ConversationInboundEnvelopeInput,
): ConversationInboundEnvelope {
  assertExactObject(input, "inbound envelope", [
    "provider",
    "installationId",
    "actor",
    "route",
    "providerEventId",
    "providerMessageId",
    "occurredAt",
    "signal",
    "text",
    "attachments",
  ]);
  const provider = normalizeConversationProviderNamespace(input.provider);
  const installation = normalizeConversationInstallationIdentity({
    provider,
    providerInstallationId: input.installationId,
  });
  const actor = normalizeConversationActor(installation, input.actor);
  const route = normalizeConversationRoute(installation, input.route);
  const providerEventId = providerOpaqueId(provider, "event", input.providerEventId);
  const providerMessageId = providerOpaqueId(provider, "message", input.providerMessageId);
  const occurredAt = canonicalTimestamp(input.occurredAt, "inbound occurredAt");
  const signal = normalizeSignal(input.signal);
  const text = boundedExactText(input.text, "inbound text", true);
  const rawAttachments = input.attachments ?? [];
  if (!Array.isArray(rawAttachments)) throw new TypeError("inbound attachments must be an array");
  if (rawAttachments.length > CONVERSATION_ATTACHMENT_MAX_COUNT) {
    throw new RangeError(
      `inbound attachments must contain at most ${CONVERSATION_ATTACHMENT_MAX_COUNT} entries`,
    );
  }
  const attachments = Object.freeze(
    rawAttachments.map((attachment) => normalizeAttachment(provider, attachment)),
  );
  if ((signal.kind === "start" || signal.kind === "continue") && !text && !attachments.length) {
    throw new TypeError("start and continue signals require text or an attachment reference");
  }
  return Object.freeze({
    schemaVersion: CONVERSATION_INTEGRATION_SCHEMA_VERSION,
    installation,
    actor,
    route,
    providerEventId,
    providerMessageId,
    eventIdentity: deriveConversationEventIdentity(installation, providerEventId),
    occurredAt,
    signal,
    text,
    attachments,
  });
}

export function normalizeConversationProviderNamespace(
  value: string,
): ConversationProviderNamespace {
  return providerNamespace(value);
}

export function normalizeConversationInstallationIdentity(input: {
  provider: string | ConversationProviderNamespace;
  providerInstallationId: string;
}): ConversationInstallationIdentity {
  assertExactObject(input, "installation identity", ["provider", "providerInstallationId"]);
  return providerOpaqueId(
    providerNamespace(input.provider),
    "installation",
    input.providerInstallationId,
  );
}

export function normalizeConversationActor(
  installation: ConversationInstallationIdentity,
  input: ConversationActorInput,
): ConversationActor {
  assertConversationInstallationIdentity(installation);
  assertExactObject(input, "inbound actor", ["providerActorId", "kind"]);
  if (input.kind !== "human" && input.kind !== "bot" && input.kind !== "system") {
    throw new TypeError("inbound actor kind is unsupported");
  }
  const providerActorId = providerOpaqueId(installation.provider, "actor", input.providerActorId);
  return Object.freeze({
    installation,
    providerActorId,
    kind: input.kind,
    identity: deriveConversationActorIdentity(installation, providerActorId),
  });
}

export function normalizeConversationRoute(
  installation: ConversationInstallationIdentity,
  input: ConversationRouteInput,
): ConversationRoute {
  assertConversationInstallationIdentity(installation);
  assertExactObject(input, "inbound route", ["providerConversationId", "providerThreadId"]);
  const providerConversationId = providerOpaqueId(
    installation.provider,
    "conversation",
    input.providerConversationId,
  );
  const providerThreadId =
    input.providerThreadId === undefined || input.providerThreadId === null
      ? null
      : providerOpaqueId(installation.provider, "thread", input.providerThreadId);
  const identity = deriveConversationRouteIdentity(
    installation,
    providerConversationId,
    providerThreadId,
  );
  return Object.freeze({ installation, providerConversationId, providerThreadId, identity });
}

export function normalizeConversationDeliveryCommand(
  input: ConversationDeliveryCommandInput,
): ConversationDeliveryCommand {
  const keys =
    input.kind === "post"
      ? ["kind", "logicalOperationKey", "installation", "route", "text"]
      : input.kind === "update"
        ? [
            "kind",
            "logicalOperationKey",
            "installation",
            "route",
            "targetProviderMessageId",
            "text",
          ]
        : ["kind", "logicalOperationKey", "installation", "route", "targetProviderMessageId"];
  assertExactObject(input, "delivery command", keys);
  if (input.kind !== "post" && input.kind !== "update" && input.kind !== "delete") {
    throw new TypeError("delivery command kind is unsupported");
  }
  assertConversationInstallationIdentity(input.installation);
  assertConversationRoute(input.route);
  assertSameInstallation(input.installation, input.route.installation, "delivery route");
  const logicalOperationKey = boundedOpaqueString(
    input.logicalOperationKey,
    "logical operation key",
    CONVERSATION_OPERATION_KEY_MAX_UTF8_BYTES,
  );
  const operationId = deriveConversationOperationIdentity(input.installation, logicalOperationKey);
  const targetProviderMessageId =
    input.kind === "post"
      ? null
      : providerOpaqueId(input.installation.provider, "message", input.targetProviderMessageId);
  const text =
    input.kind === "delete" ? null : boundedExactText(input.text, "delivery text", false);
  const requestDigest = deliveryRequestDigest({
    kind: input.kind,
    installation: input.installation,
    route: input.route,
    targetProviderMessageId,
    text,
  });
  return Object.freeze({
    schemaVersion: CONVERSATION_INTEGRATION_SCHEMA_VERSION,
    operationId,
    logicalOperationKey,
    requestDigest,
    installation: input.installation,
    route: input.route,
    kind: input.kind,
    targetProviderMessageId,
    text,
  }) as ConversationDeliveryCommand;
}

export function normalizeConversationProviderReceipt(
  input: ConversationProviderReceiptInput,
): ConversationProviderReceipt {
  assertExactObject(input, "provider receipt", [
    "command",
    "providerMessageId",
    "providerReceiptId",
    "observedAt",
  ]);
  assertConversationDeliveryCommand(input.command);
  const providerMessageId = providerOpaqueId(
    input.command.installation.provider,
    "message",
    input.providerMessageId,
  );
  if (
    input.command.targetProviderMessageId &&
    providerMessageId.value !== input.command.targetProviderMessageId.value
  ) {
    throw new TypeError("provider receipt message does not match the mutation target");
  }
  const providerReceiptId =
    input.providerReceiptId === undefined || input.providerReceiptId === null
      ? null
      : providerOpaqueId(input.command.installation.provider, "receipt", input.providerReceiptId);
  return Object.freeze({
    schemaVersion: CONVERSATION_INTEGRATION_SCHEMA_VERSION,
    operationId: input.command.operationId,
    requestDigest: input.command.requestDigest,
    installation: input.command.installation,
    providerMessageId,
    providerReceiptId,
    observedAt: canonicalTimestamp(input.observedAt, "provider receipt observedAt"),
  });
}

export function normalizeConversationDeliveryOutcome(
  input: ConversationDeliveryOutcomeInput,
): ConversationDeliveryOutcome {
  if (input.status === "success") {
    assertExactObject(input, "delivery success", ["status", "receipt"]);
    assertConversationProviderReceipt(input.receipt);
    return Object.freeze({ status: "success", receipt: input.receipt });
  }
  if (input.status === "retryable_failure") {
    assertExactObject(input, "retryable delivery failure", ["status", "code", "retryAfterMs"]);
    const retryAfterMs = input.retryAfterMs ?? null;
    if (retryAfterMs !== null && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)) {
      throw new RangeError("retryAfterMs must be a non-negative safe integer or null");
    }
    return Object.freeze({
      status: "retryable_failure",
      code: outcomeCode(input.code),
      retryAfterMs,
    });
  }
  if (
    input.status !== "not_started" &&
    input.status !== "unknown" &&
    input.status !== "permanent_failure"
  ) {
    throw new TypeError("delivery outcome status is unsupported");
  }
  assertExactObject(input, "delivery outcome", ["status", "code"]);
  return Object.freeze({ status: input.status, code: outcomeCode(input.code) });
}

export function conversationDeliveryNextAction(
  outcome: ConversationDeliveryOutcome,
): ConversationDeliveryNextAction {
  assertConversationDeliveryOutcome(outcome);
  if (outcome.status === "unknown") return "reconcile";
  if (outcome.status === "not_started" || outcome.status === "retryable_failure") {
    return "retry_same_operation";
  }
  return outcome.status === "success" ? "complete" : "stop";
}

export function assertConversationDeliveryMayRetry(
  outcome: ConversationDeliveryOutcome,
): asserts outcome is ConversationDeliveryNotStarted | ConversationDeliveryRetryableFailure {
  const action = conversationDeliveryNextAction(outcome);
  if (action === "retry_same_operation") return;
  if (action === "reconcile") {
    throw new Error("unknown delivery outcome must be reconciled before retry");
  }
  throw new Error(`delivery outcome ${outcome.status} may not be retried`);
}

export function assertConversationDeliveryCommandMatches(
  expected: ConversationDeliveryCommand,
  candidate: ConversationDeliveryCommand,
): void {
  assertConversationDeliveryCommand(expected);
  assertConversationDeliveryCommand(candidate);
  if (expected.operationId !== candidate.operationId) {
    throw new Error("delivery operation identity does not match");
  }
  if (expected.requestDigest !== candidate.requestDigest) {
    throw new Error("delivery operation identity was reused for different request content");
  }
}

export function assertConversationInboundEnvelope(
  value: unknown,
): asserts value is ConversationInboundEnvelope {
  assertExactObject(value, "normalized inbound envelope", [
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
  if (value.schemaVersion !== CONVERSATION_INTEGRATION_SCHEMA_VERSION) {
    throw new TypeError("inbound envelope schema version is unsupported");
  }
  assertConversationInstallationIdentity(value.installation);
  assertConversationActor(value.actor);
  assertConversationRoute(value.route);
  assertProviderOpaqueId(value.providerEventId, "event");
  assertProviderOpaqueId(value.providerMessageId, "message");
  assertSameInstallation(value.installation, value.actor.installation, "inbound actor");
  assertSameInstallation(value.installation, value.route.installation, "inbound route");
  assertSameProvider(value.installation.provider, value.providerEventId.provider, "event id");
  assertSameProvider(value.installation.provider, value.providerMessageId.provider, "message id");
  const expectedEventIdentity = deriveConversationEventIdentity(
    value.installation,
    value.providerEventId,
  );
  if (value.eventIdentity !== expectedEventIdentity) {
    throw new TypeError("inbound event identity is not canonical");
  }
  canonicalTimestamp(value.occurredAt, "inbound occurredAt");
  const signal = normalizeSignal(value.signal);
  const text = boundedExactText(value.text, "inbound text", true);
  if (!Array.isArray(value.attachments))
    throw new TypeError("inbound attachments must be an array");
  if (value.attachments.length > CONVERSATION_ATTACHMENT_MAX_COUNT) {
    throw new RangeError("inbound attachment count exceeds the contract bound");
  }
  for (const attachment of value.attachments) {
    assertConversationAttachmentReference(attachment);
    assertSameProvider(
      value.installation.provider,
      attachment.providerAttachmentId.provider,
      "attachment id",
    );
  }
  if (
    (signal.kind === "start" || signal.kind === "continue") &&
    !text &&
    !value.attachments.length
  ) {
    throw new TypeError("start and continue signals require text or an attachment reference");
  }
}

export function assertConversationDeliveryCommand(
  value: unknown,
): asserts value is ConversationDeliveryCommand {
  assertExactObject(value, "normalized delivery command", [
    "schemaVersion",
    "operationId",
    "logicalOperationKey",
    "requestDigest",
    "installation",
    "route",
    "kind",
    "targetProviderMessageId",
    "text",
  ]);
  if (value.schemaVersion !== CONVERSATION_INTEGRATION_SCHEMA_VERSION) {
    throw new TypeError("delivery command schema version is unsupported");
  }
  if (value.kind !== "post" && value.kind !== "update" && value.kind !== "delete") {
    throw new TypeError("delivery command kind is unsupported");
  }
  assertConversationInstallationIdentity(value.installation);
  assertConversationRoute(value.route);
  assertSameInstallation(value.installation, value.route.installation, "delivery route");
  const logicalOperationKey = boundedOpaqueString(
    value.logicalOperationKey,
    "logical operation key",
    CONVERSATION_OPERATION_KEY_MAX_UTF8_BYTES,
  );
  if (
    value.operationId !==
    deriveConversationOperationIdentity(value.installation, logicalOperationKey)
  ) {
    throw new TypeError("delivery operation identity is not canonical");
  }
  let target: ConversationProviderOpaqueId<"message"> | null;
  let text: string | null;
  if (value.kind === "post") {
    if (value.targetProviderMessageId !== null) {
      throw new TypeError("post command cannot carry a target message");
    }
    target = null;
    text = boundedExactText(value.text, "delivery text", false);
  } else {
    assertProviderOpaqueId(value.targetProviderMessageId, "message");
    target = value.targetProviderMessageId;
    assertSameProvider(value.installation.provider, target.provider, "delivery target");
    if (value.kind === "delete") {
      if (value.text !== null) throw new TypeError("delete command cannot carry text");
      text = null;
    } else {
      text = boundedExactText(value.text, "delivery text", false);
    }
  }
  const expectedDigest = deliveryRequestDigest({
    kind: value.kind,
    installation: value.installation,
    route: value.route,
    targetProviderMessageId: target,
    text,
  });
  if (value.requestDigest !== expectedDigest) {
    throw new TypeError("delivery request digest is not canonical");
  }
}

export function assertConversationProviderReceipt(
  value: unknown,
): asserts value is ConversationProviderReceipt {
  assertExactObject(value, "normalized provider receipt", [
    "schemaVersion",
    "operationId",
    "requestDigest",
    "installation",
    "providerMessageId",
    "providerReceiptId",
    "observedAt",
  ]);
  if (value.schemaVersion !== CONVERSATION_INTEGRATION_SCHEMA_VERSION) {
    throw new TypeError("provider receipt schema version is unsupported");
  }
  assertIdentity(value.operationId, /^ciop1_[0-9a-f]{64}$/u, "provider receipt operation id");
  assertIdentity(value.requestDigest, /^sha256:[0-9a-f]{64}$/u, "provider receipt request digest");
  assertConversationInstallationIdentity(value.installation);
  assertProviderOpaqueId(value.providerMessageId, "message");
  assertSameProvider(
    value.installation.provider,
    value.providerMessageId.provider,
    "receipt message",
  );
  if (value.providerReceiptId !== null) {
    assertProviderOpaqueId(value.providerReceiptId, "receipt");
    assertSameProvider(
      value.installation.provider,
      value.providerReceiptId.provider,
      "provider receipt id",
    );
  }
  canonicalTimestamp(value.observedAt, "provider receipt observedAt");
}

export function assertConversationDeliveryOutcome(
  value: unknown,
): asserts value is ConversationDeliveryOutcome {
  normalizeConversationDeliveryOutcome(value as ConversationDeliveryOutcomeInput);
}

export function canonicalConversationInboundEnvelopeJson(
  envelope: ConversationInboundEnvelope,
): string {
  assertConversationInboundEnvelope(envelope);
  return JSON.stringify({
    schemaVersion: envelope.schemaVersion,
    installation: providerIdWire(envelope.installation),
    actor: actorWire(envelope.actor),
    route: routeWire(envelope.route),
    providerEventId: providerIdWire(envelope.providerEventId),
    providerMessageId: providerIdWire(envelope.providerMessageId),
    eventIdentity: envelope.eventIdentity,
    occurredAt: envelope.occurredAt,
    signal: signalWire(envelope.signal),
    text: envelope.text,
    attachments: envelope.attachments.map(attachmentWire),
  });
}

export function canonicalConversationDeliveryCommandJson(
  command: ConversationDeliveryCommand,
): string {
  assertConversationDeliveryCommand(command);
  return JSON.stringify(deliveryCommandWire(command));
}

export function canonicalConversationProviderReceiptJson(
  receipt: ConversationProviderReceipt,
): string {
  assertConversationProviderReceipt(receipt);
  return JSON.stringify(providerReceiptWire(receipt));
}

export function canonicalConversationDeliveryOutcomeJson(
  outcome: ConversationDeliveryOutcome,
): string {
  assertConversationDeliveryOutcome(outcome);
  if (outcome.status === "success") {
    return JSON.stringify({ status: "success", receipt: providerReceiptWire(outcome.receipt) });
  }
  if (outcome.status === "retryable_failure") {
    return JSON.stringify({
      status: outcome.status,
      code: outcome.code,
      retryAfterMs: outcome.retryAfterMs,
    });
  }
  return JSON.stringify({ status: outcome.status, code: outcome.code });
}

function normalizeSignal(input: unknown): ConversationSignal {
  assertExactObject(input, "conversation signal", ["kind", "control"]);
  if (input.kind === "start" || input.kind === "continue") {
    assertExactObject(input, "conversation signal", ["kind"]);
    return Object.freeze({ kind: input.kind });
  }
  if (input.kind === "control") {
    assertExactObject(input, "conversation control signal", ["kind", "control"]);
    if (input.control !== "stop" && input.control !== "resume") {
      throw new TypeError("conversation control signal is unsupported");
    }
    return Object.freeze({ kind: "control", control: input.control });
  }
  throw new TypeError("conversation signal is unsupported");
}

function normalizeAttachment(
  provider: ConversationProviderNamespace,
  input: ConversationAttachmentReferenceInput,
): ConversationAttachmentReference {
  assertExactObject(input, "attachment reference", [
    "providerAttachmentId",
    "fileName",
    "mediaType",
    "byteSize",
    "contentSha256",
  ]);
  if (
    ABSOLUTE_URL_PATTERN.test(input.providerAttachmentId) ||
    input.providerAttachmentId.startsWith("//")
  ) {
    throw new TypeError("attachment references cannot contain provider URLs");
  }
  const providerAttachmentId = providerOpaqueId(provider, "attachment", input.providerAttachmentId);
  const fileName = nullableBoundedString(
    input.fileName,
    "attachment fileName",
    CONVERSATION_ATTACHMENT_NAME_MAX_UTF8_BYTES,
  );
  if (fileName?.includes("/") || fileName?.includes("\\")) {
    throw new TypeError("attachment fileName must not contain a path");
  }
  const mediaType = nullableBoundedString(
    input.mediaType,
    "attachment mediaType",
    CONVERSATION_ATTACHMENT_MEDIA_TYPE_MAX_UTF8_BYTES,
  );
  if (mediaType !== null && !MEDIA_TYPE_PATTERN.test(mediaType)) {
    throw new TypeError("attachment mediaType is invalid");
  }
  const byteSize = input.byteSize ?? null;
  if (byteSize !== null && (!Number.isSafeInteger(byteSize) || byteSize < 0)) {
    throw new RangeError("attachment byteSize must be a non-negative safe integer or null");
  }
  const contentSha256 = input.contentSha256 ?? null;
  if (contentSha256 !== null && !SHA256_PATTERN.test(contentSha256)) {
    throw new TypeError("attachment contentSha256 must be 64 lowercase hexadecimal characters");
  }
  return Object.freeze({
    providerAttachmentId,
    fileName,
    mediaType,
    byteSize,
    contentSha256,
  });
}

function providerNamespace(value: string): ConversationProviderNamespace {
  const bounded = boundedOpaqueString(
    value,
    "provider namespace",
    CONVERSATION_PROVIDER_NAMESPACE_MAX_UTF8_BYTES,
  );
  if (!PROVIDER_NAMESPACE_PATTERN.test(bounded)) {
    throw new TypeError("provider namespace must be canonical lowercase segments");
  }
  return bounded as ConversationProviderNamespace;
}

function providerOpaqueId<TKind extends ConversationProviderOpaqueIdKind>(
  provider: ConversationProviderNamespace,
  kind: TKind,
  value: string,
): ConversationProviderOpaqueId<TKind> {
  return Object.freeze({
    provider,
    kind,
    value: boundedOpaqueString(
      value,
      `provider ${kind} id`,
      CONVERSATION_PROVIDER_OPAQUE_ID_MAX_UTF8_BYTES,
    ) as ConversationProviderOpaqueValue,
  });
}

function deriveConversationEventIdentity(
  installation: ConversationInstallationIdentity,
  providerEventId: ConversationProviderOpaqueId<"event">,
): ConversationEventIdentity {
  return `ciev1_${hashParts("opengeni:conversation-event:v1", [
    installation.provider,
    installation.value,
    providerEventId.value,
  ])}` as ConversationEventIdentity;
}

function deriveConversationRouteIdentity(
  installation: ConversationInstallationIdentity,
  conversationId: ConversationProviderOpaqueId<"conversation">,
  threadId: ConversationProviderOpaqueId<"thread"> | null,
): ConversationRouteIdentity {
  return `cirt1_${hashParts("opengeni:conversation-route:v1", [
    installation.provider,
    installation.value,
    conversationId.value,
    threadId?.value ?? null,
  ])}` as ConversationRouteIdentity;
}

function deriveConversationActorIdentity(
  installation: ConversationInstallationIdentity,
  actorId: ConversationProviderOpaqueId<"actor">,
): ConversationActorIdentity {
  return `ciac1_${hashParts("opengeni:conversation-actor:v1", [
    installation.provider,
    installation.value,
    actorId.value,
  ])}` as ConversationActorIdentity;
}

function deriveConversationOperationIdentity(
  installation: ConversationInstallationIdentity,
  logicalOperationKey: string,
): ConversationOperationIdentity {
  return `ciop1_${hashParts("opengeni:conversation-operation:v1", [
    installation.provider,
    installation.value,
    logicalOperationKey,
  ])}` as ConversationOperationIdentity;
}

function deliveryRequestDigest(input: {
  kind: ConversationDeliveryCommand["kind"];
  installation: ConversationInstallationIdentity;
  route: ConversationRoute;
  targetProviderMessageId: ConversationProviderOpaqueId<"message"> | null;
  text: string | null;
}): ConversationRequestDigest {
  return `sha256:${createHash("sha256")
    .update("opengeni:conversation-delivery-request:v1\0", "utf8")
    .update(
      JSON.stringify({
        kind: input.kind,
        installation: providerIdWire(input.installation),
        route: routeWire(input.route),
        targetProviderMessageId: input.targetProviderMessageId
          ? providerIdWire(input.targetProviderMessageId)
          : null,
        text: input.text,
      }),
      "utf8",
    )
    .digest("hex")}` as ConversationRequestDigest;
}

function hashParts(domain: string, parts: readonly (string | null)[]): string {
  const hash = createHash("sha256");
  hash.update(domain, "utf8").update("\0", "utf8");
  for (const part of parts) {
    if (part === null) {
      hash.update("n:", "utf8");
      continue;
    }
    const bytes = textEncoder.encode(part);
    hash.update(`s:${bytes.byteLength}:`, "utf8").update(bytes);
  }
  return hash.digest("hex");
}

function assertConversationInstallationIdentity(
  value: unknown,
): asserts value is ConversationInstallationIdentity {
  assertProviderOpaqueId(value, "installation");
}

function assertConversationActor(value: unknown): asserts value is ConversationActor {
  assertExactObject(value, "normalized conversation actor", [
    "installation",
    "providerActorId",
    "kind",
    "identity",
  ]);
  assertConversationInstallationIdentity(value.installation);
  assertProviderOpaqueId(value.providerActorId, "actor");
  if (value.kind !== "human" && value.kind !== "bot" && value.kind !== "system") {
    throw new TypeError("conversation actor kind is unsupported");
  }
  assertSameProvider(value.installation.provider, value.providerActorId.provider, "actor id");
  if (
    value.identity !== deriveConversationActorIdentity(value.installation, value.providerActorId)
  ) {
    throw new TypeError("conversation actor identity is not canonical");
  }
}

function assertConversationRoute(value: unknown): asserts value is ConversationRoute {
  assertExactObject(value, "normalized conversation route", [
    "installation",
    "providerConversationId",
    "providerThreadId",
    "identity",
  ]);
  assertConversationInstallationIdentity(value.installation);
  assertProviderOpaqueId(value.providerConversationId, "conversation");
  if (value.providerThreadId !== null) assertProviderOpaqueId(value.providerThreadId, "thread");
  assertSameProvider(
    value.installation.provider,
    value.providerConversationId.provider,
    "conversation id",
  );
  if (value.providerThreadId) {
    assertSameProvider(value.installation.provider, value.providerThreadId.provider, "thread id");
  }
  if (
    value.identity !==
    deriveConversationRouteIdentity(
      value.installation,
      value.providerConversationId,
      value.providerThreadId,
    )
  ) {
    throw new TypeError("conversation route identity is not canonical");
  }
}

function assertConversationAttachmentReference(
  value: unknown,
): asserts value is ConversationAttachmentReference {
  assertExactObject(value, "normalized attachment reference", [
    "providerAttachmentId",
    "fileName",
    "mediaType",
    "byteSize",
    "contentSha256",
  ]);
  assertProviderOpaqueId(value.providerAttachmentId, "attachment");
  if (
    ABSOLUTE_URL_PATTERN.test(value.providerAttachmentId.value) ||
    value.providerAttachmentId.value.startsWith("//")
  ) {
    throw new TypeError("attachment references cannot contain provider URLs");
  }
  const fileName = nullableBoundedString(
    value.fileName,
    "attachment fileName",
    CONVERSATION_ATTACHMENT_NAME_MAX_UTF8_BYTES,
  );
  if (fileName?.includes("/") || fileName?.includes("\\")) {
    throw new TypeError("attachment fileName must not contain a path");
  }
  const mediaType = nullableBoundedString(
    value.mediaType,
    "attachment mediaType",
    CONVERSATION_ATTACHMENT_MEDIA_TYPE_MAX_UTF8_BYTES,
  );
  if (mediaType !== null && !MEDIA_TYPE_PATTERN.test(mediaType)) {
    throw new TypeError("attachment mediaType is invalid");
  }
  const byteSize = value.byteSize;
  if (byteSize !== null) {
    if (typeof byteSize !== "number" || !Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new RangeError("attachment byteSize must be a non-negative safe integer or null");
    }
  }
  const contentSha256 = value.contentSha256;
  if (contentSha256 !== null) {
    if (typeof contentSha256 !== "string" || !SHA256_PATTERN.test(contentSha256)) {
      throw new TypeError("attachment contentSha256 must be 64 lowercase hexadecimal characters");
    }
  }
}

function assertProviderOpaqueId<TKind extends ConversationProviderOpaqueIdKind>(
  value: unknown,
  kind: TKind,
): asserts value is ConversationProviderOpaqueId<TKind> {
  assertExactObject(value, `provider ${kind} id`, ["provider", "kind", "value"]);
  providerNamespace(value.provider as string);
  if (value.kind !== kind) throw new TypeError(`provider id must have kind ${kind}`);
  boundedOpaqueString(
    value.value,
    `provider ${kind} id`,
    CONVERSATION_PROVIDER_OPAQUE_ID_MAX_UTF8_BYTES,
  );
}

function assertSameProvider(
  expected: ConversationProviderNamespace,
  actual: ConversationProviderNamespace,
  label: string,
): void {
  if (expected !== actual) throw new TypeError(`${label} provider namespace does not match`);
}

function assertSameInstallation(
  expected: ConversationInstallationIdentity,
  actual: ConversationInstallationIdentity,
  label: string,
): void {
  if (expected.provider !== actual.provider || expected.value !== actual.value) {
    throw new TypeError(`${label} installation identity does not match`);
  }
}

function boundedExactText(value: unknown, label: string, allowEmpty: boolean): string {
  return boundedString(value, label, allowEmpty ? 0 : 1, CONVERSATION_TEXT_MAX_UTF8_BYTES, true);
}

function boundedOpaqueString(value: unknown, label: string, maxBytes: number): string {
  const result = boundedString(value, label, 1, maxBytes, false);
  if (result !== result.trim())
    throw new TypeError(`${label} must not have surrounding whitespace`);
  return result;
}

function nullableBoundedString(value: unknown, label: string, maxBytes: number): string | null {
  if (value === undefined || value === null) return null;
  return boundedString(value, label, 1, maxBytes, false);
}

function boundedString(
  value: unknown,
  label: string,
  minBytes: number,
  maxBytes: number,
  allowNewlines: boolean,
): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (!isWellFormedUnicode(value)) throw new TypeError(`${label} must be well-formed Unicode`);
  if (value.includes("\0")) throw new TypeError(`${label} must not contain NUL`);
  if (!allowNewlines && /[\u0001-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must not contain control characters`);
  }
  const byteLength = textEncoder.encode(value).byteLength;
  if (byteLength < minBytes || byteLength > maxBytes) {
    throw new RangeError(`${label} must contain ${minBytes}-${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 20, 32, false);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  return timestamp;
}

function outcomeCode(value: unknown): string {
  const code = boundedOpaqueString(
    value,
    "delivery outcome code",
    CONVERSATION_OUTCOME_CODE_MAX_UTF8_BYTES,
  );
  if (!OUTCOME_CODE_PATTERN.test(code)) {
    throw new TypeError("delivery outcome code must use canonical lowercase segments");
  }
  return code;
}

function assertExactObject(
  value: unknown,
  label: string,
  allowedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`${label} contains an unsupported field`);
    }
  }
}

function assertIdentity(value: unknown, pattern: RegExp, label: string): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function providerIdWire<TKind extends ConversationProviderOpaqueIdKind>(
  id: ConversationProviderOpaqueId<TKind>,
): { provider: string; kind: TKind; value: string } {
  return { provider: id.provider, kind: id.kind, value: id.value };
}

function actorWire(actor: ConversationActor) {
  return {
    installation: providerIdWire(actor.installation),
    providerActorId: providerIdWire(actor.providerActorId),
    kind: actor.kind,
    identity: actor.identity,
  };
}

function routeWire(route: ConversationRoute) {
  return {
    installation: providerIdWire(route.installation),
    providerConversationId: providerIdWire(route.providerConversationId),
    providerThreadId: route.providerThreadId ? providerIdWire(route.providerThreadId) : null,
    identity: route.identity,
  };
}

function signalWire(signal: ConversationSignal) {
  return signal.kind === "control"
    ? { kind: "control" as const, control: signal.control }
    : { kind: signal.kind };
}

function attachmentWire(attachment: ConversationAttachmentReference) {
  return {
    providerAttachmentId: providerIdWire(attachment.providerAttachmentId),
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    byteSize: attachment.byteSize,
    contentSha256: attachment.contentSha256,
  };
}

function deliveryCommandWire(command: ConversationDeliveryCommand) {
  return {
    schemaVersion: command.schemaVersion,
    operationId: command.operationId,
    logicalOperationKey: command.logicalOperationKey,
    requestDigest: command.requestDigest,
    installation: providerIdWire(command.installation),
    route: routeWire(command.route),
    kind: command.kind,
    targetProviderMessageId: command.targetProviderMessageId
      ? providerIdWire(command.targetProviderMessageId)
      : null,
    text: command.text,
  };
}

function providerReceiptWire(receipt: ConversationProviderReceipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    operationId: receipt.operationId,
    requestDigest: receipt.requestDigest,
    installation: providerIdWire(receipt.installation),
    providerMessageId: providerIdWire(receipt.providerMessageId),
    providerReceiptId: receipt.providerReceiptId ? providerIdWire(receipt.providerReceiptId) : null,
    observedAt: receipt.observedAt,
  };
}
