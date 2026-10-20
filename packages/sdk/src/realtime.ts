import { createAzureLiveTransportStarter } from "./azure-live-transport";
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
import {
  createGatewayRealtimeTransportStarter,
  createXaiSubscriptionRealtimeTransportStarter,
} from "./gateway-realtime-transport";
import { createRealtimeWebsocketTransportStarter } from "./realtime-websocket-transport";
import type { SessionRealtimeModel, WorkspaceRealtimeModelCatalogResponse } from "./types";

/** Exact backend-facing methods required by the batteries-included realtime SDK. */
export type SessionRealtimeClientLike = CodexRealtimeControllerClient & {
  getWorkspaceRealtimeModelCatalog(
    workspaceId: string,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<WorkspaceRealtimeModelCatalogResponse>;
};

/**
 * Codex Live and Azure live voice negotiate WebRTC; every other voice model is
 * reached over one provider WebSocket. `gateway` and `xai-subscription` are
 * deprecated names that are no longer returned.
 */
export type SessionRealtimeTransportKind =
  | "codex"
  | "azure-live"
  | "websocket"
  | "gateway"
  | "xai-subscription";

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
  if (model === "opengeni-azure/gpt-live-1") return "azure-live";
  if (model === "gpt-live-1-boulder-alpha") return "codex";
  return "websocket";
}

/**
 * Compose the controller with the model's transport. Wire, ledger, delegation,
 * recovery, and lifecycle semantics are shared by every transport.
 */
export function createSessionRealtimeController(
  options: CreateSessionRealtimeControllerOptions,
): SessionRealtimeController {
  const transport = sessionRealtimeTransportKind(options.model);
  return createCodexRealtimeController({
    ...options,
    ownerStorageNamespace: sessionRealtimeOwnerStorageNamespace(options.model),
    ...(transport === "azure-live"
      ? {
          startTransport: createAzureLiveTransportStarter({
            remoteAudio: options.remoteAudio,
            createPeerConnection: options.createPeerConnection,
          }),
        }
      : transport === "codex"
        ? {}
        : { startTransport: createRealtimeWebsocketTransportStarter() }),
  });
}

export {
  createCodexRealtimeController,
  createGatewayRealtimeTransportStarter,
  createRealtimeWebsocketTransportStarter,
  createXaiSubscriptionRealtimeTransportStarter,
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
  RealtimeWebsocketProtocol,
  RenewSessionRealtimeRequest,
  SessionRealtimeEndReason,
  SessionRealtimeLedgerEntry,
  SessionRealtimeMode,
  SessionRealtimeModel,
  SessionRealtimeMutationResponse,
  SessionRealtimeState,
  SessionRealtimeWebsocketInitialItem,
  SessionRealtimeWebsocketRequest,
  SessionRealtimeWebsocketResponse,
  SyncSessionRealtimeLedgerRequest,
  SyncSessionRealtimeLedgerResponse,
  WorkspaceRealtimeModelCatalogItem,
  WorkspaceRealtimeModelCatalogResponse,
} from "./types";
