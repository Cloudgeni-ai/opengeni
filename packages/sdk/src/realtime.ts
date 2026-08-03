/**
 * Public, provider-neutral realtime browser SDK.
 *
 * Import this subpath lazily in browser applications. The base `@opengeni/sdk`
 * entry remains free of eager realtime transport initialization.
 */
import {
  createCodexRealtimeController,
  hasStoredSessionRealtimeOwnerProof,
  sessionRealtimeOwnerStorageKey,
  sessionRealtimeOwnerStorageNamespace,
  type CodexRealtimeController,
  type CodexRealtimeControllerClient,
  type CodexRealtimeControllerSnapshot,
  type CodexRealtimeControllerStatus,
  type CodexRealtimeDiagnostic,
  type CodexRealtimeDiagnosticKind,
  type CodexRealtimeMicrophoneState,
  type CodexRealtimeOwnerStorage,
  type CreateCodexRealtimeControllerOptions,
  type RealtimeControllerTransportStarter,
} from "./codex-realtime-controller";
import { createGatewayRealtimeTransportStarter } from "./gateway-realtime-transport";
import type { SessionRealtimeModel, WorkspaceRealtimeModelCatalogResponse } from "./types";

/** Exact backend-facing methods required by the batteries-included realtime SDK. */
export type SessionRealtimeClientLike = CodexRealtimeControllerClient & {
  getWorkspaceRealtimeModelCatalog(
    workspaceId: string,
  ): Promise<WorkspaceRealtimeModelCatalogResponse>;
};

export type SessionRealtimeTransportKind = "codex" | "gateway";

/** Provider-neutral names for the existing, battle-tested controller projection. */
export type SessionRealtimeController = CodexRealtimeController;
export type SessionRealtimeControllerSnapshot = CodexRealtimeControllerSnapshot;
export type SessionRealtimeControllerStatus = CodexRealtimeControllerStatus;
export type SessionRealtimeDiagnostic = CodexRealtimeDiagnostic;
export type SessionRealtimeDiagnosticKind = CodexRealtimeDiagnosticKind;
export type SessionRealtimeMicrophoneState = CodexRealtimeMicrophoneState;
export type SessionRealtimeOwnerStorage = CodexRealtimeOwnerStorage;

export type CreateSessionRealtimeControllerOptions = Omit<
  CreateCodexRealtimeControllerOptions,
  "client" | "model" | "ownerStorageNamespace" | "startTransport"
> & {
  client: CodexRealtimeControllerClient;
  model: SessionRealtimeModel;
};

/** Select the existing transport without exposing provider mechanics to hosts. */
export function sessionRealtimeTransportKind(
  model: SessionRealtimeModel,
): SessionRealtimeTransportKind {
  return model === "gpt-live-1-boulder-alpha" ? "codex" : "gateway";
}

/**
 * Compose the exact current controller with its existing Codex Live or AI
 * Gateway transport. Wire, ledger, delegation, recovery, and lifecycle
 * semantics remain owned by the existing implementations below this facade.
 */
export function createSessionRealtimeController(
  options: CreateSessionRealtimeControllerOptions,
): SessionRealtimeController {
  const transport = sessionRealtimeTransportKind(options.model);
  return createCodexRealtimeController({
    ...options,
    ownerStorageNamespace: sessionRealtimeOwnerStorageNamespace(options.model),
    ...(transport === "gateway" ? { startTransport: createGatewayRealtimeTransportStarter() } : {}),
  });
}

export {
  createCodexRealtimeController,
  createGatewayRealtimeTransportStarter,
  hasStoredSessionRealtimeOwnerProof,
  sessionRealtimeOwnerStorageKey,
  sessionRealtimeOwnerStorageNamespace,
};
export type {
  CodexRealtimeController,
  CodexRealtimeControllerClient,
  CodexRealtimeControllerSnapshot,
  CodexRealtimeControllerStatus,
  CodexRealtimeDiagnostic,
  CodexRealtimeDiagnosticKind,
  CodexRealtimeMicrophoneState,
  CodexRealtimeOwnerStorage,
  CreateCodexRealtimeControllerOptions,
  RealtimeControllerTransportStarter,
};

export {
  CODEX_REALTIME_NEGOTIATION_TIMEOUT_MS,
  projectSessionRealtimeLifecycle,
} from "./codex-realtime-controller";
export type { SessionRealtimeLifecycleProjection } from "./codex-realtime-lifecycle";

export {
  CodexRealtimeMicrophoneError,
  acquireCodexRealtimeMicrophone,
  codexRealtimeMicrophoneHealthy,
  startCodexRealtimeWebrtc,
} from "./codex-realtime";
export type {
  AcquireCodexRealtimeMicrophoneOptions,
  CodexRealtimeAudibleOutputState,
  CodexRealtimeConnectionHealth,
  CodexRealtimeMicrophoneErrorCode,
  CodexRealtimeNegotiator,
  CodexRealtimeWebrtcSession,
  StartCodexRealtimeWebrtcOptions,
} from "./codex-realtime";

export {
  CODEX_REALTIME_CONTEXT_APPEND_MAX_BYTES,
  CODEX_REALTIME_V3_MAX_EVENT_BYTES,
  CODEX_REALTIME_V3_MAX_IDENTIFIER_BYTES,
  CODEX_REALTIME_V3_MAX_TEXT_BYTES,
  CODEX_REALTIME_V3_PENDING_MAX_BYTES,
  CODEX_REALTIME_V3_PENDING_MAX_ENTRIES,
  CODEX_REALTIME_V3_SYNC_MAX_ENTRIES,
  contextAppendChunks,
  createCodexRealtimeV3Bridge,
  encodeCodexRealtimeV3DelegationContextAppend,
  encodeCodexRealtimeV3SessionContextAppend,
  parseCodexRealtimeV3Event,
} from "./codex-realtime-v3";
export type {
  CodexRealtimeV3Bridge,
  CodexRealtimeV3BridgeFatal,
  CodexRealtimeV3BridgeOptions,
  CodexRealtimeV3BridgeSnapshot,
  CodexRealtimeV3ContextAppendChannel,
  CodexRealtimeV3DelegationContextAppend,
  CodexRealtimeV3Event,
  CodexRealtimeV3ParseFailure,
  CodexRealtimeV3ParseResult,
  CodexRealtimeV3SessionContextAppend,
} from "./codex-realtime-v3";

export {
  CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT,
  CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS,
} from "./codex-realtime-v3-wire";
export type { CodexRealtimeInitialItem } from "./codex-realtime-v3-wire";

export type {
  ActivateCodexRealtimeConnectionRequest,
  BeginSessionRealtimeRequest,
  CodexRealtimeVoice,
  CodexRealtimeWebrtcRequest,
  CodexRealtimeWebrtcResponse,
  CodexRealtimeWebrtcVersion,
  EndSessionRealtimeRequest,
  GatewayRealtimeConnectRequest,
  GatewayRealtimeConnectResponse,
  GatewayRealtimeInitialItem,
  RenewSessionRealtimeRequest,
  SessionRealtimeEndReason,
  SessionRealtimeLedgerEntry,
  SessionRealtimeMode,
  SessionRealtimeModel,
  SessionRealtimeMutationResponse,
  SessionRealtimeState,
  SyncSessionRealtimeLedgerRequest,
  SyncSessionRealtimeLedgerResponse,
  WorkspaceRealtimeModelCatalogItem,
  WorkspaceRealtimeModelCatalogResponse,
} from "./types";
