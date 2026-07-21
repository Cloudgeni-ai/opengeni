/**
 * Framework- and transport-agnostic speech-to-text capability contract.
 *
 * Audio transport, microphone access, credentials, and provider SDKs belong to
 * host-supplied adapters. This module deliberately contains no browser globals
 * and no provider implementation.
 */

export type TranscriptionCredentialMode = "managed" | "byok";

export type WorkspaceTranscriptionTarget = {
  provider: string;
  model: string | null;
  credentialMode: TranscriptionCredentialMode;
  /** Workspace-scoped connection reference. This is never a secret. */
  credentialConnectionId: string | null;
  region: string | null;
};

export type WorkspaceTranscriptionPolicy = {
  enabled: boolean;
  /** Exact admin-accepted policy identity; required whenever enabled. */
  acceptanceId: string | null;
  primary: WorkspaceTranscriptionTarget | null;
  language: string | null;
  retention: {
    mode: "none" | "provider-policy";
    maxDays: number | null;
  };
  privacy: {
    allowProviderLogging: boolean;
    allowProviderTraining: boolean;
  };
  fallback: {
    mode: "disabled" | "explicit";
    targets: WorkspaceTranscriptionTarget[];
  };
  cost: {
    currency: "USD";
    maxPerHour: number | null;
    maxPerMonth: number | null;
  };
};

export const DEFAULT_WORKSPACE_TRANSCRIPTION_POLICY: WorkspaceTranscriptionPolicy = {
  enabled: false,
  acceptanceId: null,
  primary: null,
  language: null,
  retention: { mode: "none", maxDays: null },
  privacy: { allowProviderLogging: false, allowProviderTraining: false },
  fallback: { mode: "disabled", targets: [] },
  cost: { currency: "USD", maxPerHour: null, maxPerMonth: null },
};

export type TranscriptionAdapterDescriptor = {
  provider: string;
  model: string | null;
  credentialMode: TranscriptionCredentialMode;
  region: string | null;
};

export type TranscriptionTargetSelection =
  | { kind: "primary" }
  | { kind: "fallback"; index: number };

export type TranscriptionPolicyBlockReason =
  | "disabled"
  | "unaccepted"
  | "target_missing"
  | "fallback_disabled"
  | "fallback_unaccepted"
  | "provider_mismatch"
  | "model_mismatch"
  | "credential_mode_mismatch"
  | "region_mismatch";

export type TranscriptionAuthorization =
  | {
      authorized: true;
      acceptanceId: string;
      target: WorkspaceTranscriptionTarget;
      selection: TranscriptionTargetSelection;
    }
  | { authorized: false; reason: TranscriptionPolicyBlockReason };

export type TranscriptionLifecycleStatus =
  | "idle"
  | "requesting-permission"
  | "listening"
  | "reconnecting"
  | "cancelling"
  | "closed"
  | "error";

export type TranscriptionErrorCode =
  | "permission_denied"
  | "not_supported"
  | "network"
  | "provider"
  | "policy_blocked"
  | "cancelled"
  | "unknown";

type TranscriptionEventBase = {
  /** Stable across reconnects and explicitly accepted fallback attempts. */
  localSessionId: string;
  /** Adapter-monotonic across the entire local session, including replay. */
  sequence: number;
  occurredAt: string;
};

export type TranscriptionEvent =
  | (TranscriptionEventBase & { type: "permission.requested" })
  | (TranscriptionEventBase & {
      type: "session.opened";
      providerSessionId: string;
    })
  | (TranscriptionEventBase & {
      type: "transcript.partial";
      segmentId: string;
      text: string;
    })
  | (TranscriptionEventBase & {
      type: "transcript.final";
      segmentId: string;
      text: string;
      /** Stable provider/coordinator acceptance identity used for dedupe. */
      providerAcceptanceId: string;
    })
  | (TranscriptionEventBase & {
      type: "usage";
      audioMilliseconds: number;
      costUsd: number | null;
    })
  | (TranscriptionEventBase & {
      type: "session.reconnecting";
      attempt: number;
      reason: string;
    })
  | (TranscriptionEventBase & {
      type: "session.error";
      code: TranscriptionErrorCode;
      message: string;
      recoverable: boolean;
    })
  | (TranscriptionEventBase & {
      type: "session.closed";
      reason: "completed" | "cancelled" | "error" | "replaced";
    });

export type TranscriptionSessionRequest = {
  localSessionId: string;
  policyAcceptanceId: string;
  selection: TranscriptionTargetSelection;
  target: WorkspaceTranscriptionTarget;
  language: string | null;
  retention: WorkspaceTranscriptionPolicy["retention"];
  privacy: WorkspaceTranscriptionPolicy["privacy"];
  cost: WorkspaceTranscriptionPolicy["cost"];
  /** A replacement/reconnect adapter must emit events above this floor. */
  sequenceFloor: number;
};

export type TranscriptionEventListener = (event: TranscriptionEvent) => void;

export type TranscriptionSession = {
  readonly localSessionId: string;
  cancel(reason?: string): Promise<void>;
  close(): Promise<void>;
};

export type TranscriptionAdapter = {
  readonly descriptor: TranscriptionAdapterDescriptor;
  start(
    request: TranscriptionSessionRequest,
    listener: TranscriptionEventListener,
  ): Promise<TranscriptionSession>;
};

/** Invalid or absent settings always resolve to the fail-closed default. */
export function resolveWorkspaceTranscriptionPolicy(
  settings: unknown,
): WorkspaceTranscriptionPolicy {
  if (!isRecord(settings)) return cloneDefaultPolicy();
  const candidate = settings.transcription;
  if (!isWorkspaceTranscriptionPolicy(candidate)) return cloneDefaultPolicy();
  return {
    ...candidate,
    primary: candidate.primary ? normalizeTarget(candidate.primary) : null,
    language: candidate.language?.trim() ?? null,
    retention: { ...candidate.retention },
    privacy: { ...candidate.privacy },
    fallback: {
      mode: candidate.fallback.mode,
      targets: candidate.fallback.targets.map(normalizeTarget),
    },
    cost: { ...candidate.cost },
  };
}

/**
 * Speech authorization is intentionally independent from turn model policy.
 * Every selected adapter must match one exact admin-accepted target.
 */
export function authorizeTranscriptionAdapter(
  policy: WorkspaceTranscriptionPolicy,
  descriptor: TranscriptionAdapterDescriptor,
  selection: TranscriptionTargetSelection = { kind: "primary" },
): TranscriptionAuthorization {
  if (!isWorkspaceTranscriptionPolicy(policy)) {
    return { authorized: false, reason: "unaccepted" };
  }
  if (!policy.enabled) return { authorized: false, reason: "disabled" };
  if (!policy.acceptanceId) return { authorized: false, reason: "unaccepted" };
  let target: WorkspaceTranscriptionTarget | null | undefined;
  if (selection.kind === "primary") {
    target = policy.primary;
  } else {
    if (policy.fallback.mode !== "explicit") {
      return { authorized: false, reason: "fallback_disabled" };
    }
    target = policy.fallback.targets[selection.index];
    if (!target) return { authorized: false, reason: "fallback_unaccepted" };
  }
  if (!target) return { authorized: false, reason: "target_missing" };
  const acceptedTarget = normalizeTarget(target);
  if (acceptedTarget.provider !== descriptor.provider) {
    return { authorized: false, reason: "provider_mismatch" };
  }
  if (acceptedTarget.model !== descriptor.model) {
    return { authorized: false, reason: "model_mismatch" };
  }
  if (acceptedTarget.credentialMode !== descriptor.credentialMode) {
    return { authorized: false, reason: "credential_mode_mismatch" };
  }
  if (acceptedTarget.region !== descriptor.region) {
    return { authorized: false, reason: "region_mismatch" };
  }
  return {
    authorized: true,
    acceptanceId: policy.acceptanceId,
    target: acceptedTarget,
    selection,
  };
}

export function createTranscriptionSessionRequest(input: {
  policy: WorkspaceTranscriptionPolicy;
  adapter: TranscriptionAdapter;
  localSessionId: string;
  selection?: TranscriptionTargetSelection | undefined;
  sequenceFloor?: number | undefined;
}): TranscriptionSessionRequest | null {
  const sequenceFloor = input.sequenceFloor ?? 0;
  if (!Number.isSafeInteger(sequenceFloor) || sequenceFloor < 0) return null;
  const authorization = authorizeTranscriptionAdapter(
    input.policy,
    input.adapter.descriptor,
    input.selection,
  );
  if (!authorization.authorized) return null;
  return {
    localSessionId: input.localSessionId,
    policyAcceptanceId: authorization.acceptanceId,
    selection: authorization.selection,
    target: { ...authorization.target },
    language: input.policy.language?.trim() ?? null,
    retention: { ...input.policy.retention },
    privacy: { ...input.policy.privacy },
    cost: { ...input.policy.cost },
    sequenceFloor,
  };
}

function cloneDefaultPolicy(): WorkspaceTranscriptionPolicy {
  return {
    ...DEFAULT_WORKSPACE_TRANSCRIPTION_POLICY,
    retention: { ...DEFAULT_WORKSPACE_TRANSCRIPTION_POLICY.retention },
    privacy: { ...DEFAULT_WORKSPACE_TRANSCRIPTION_POLICY.privacy },
    fallback: { mode: "disabled", targets: [] },
    cost: { ...DEFAULT_WORKSPACE_TRANSCRIPTION_POLICY.cost },
  };
}

function isWorkspaceTranscriptionPolicy(value: unknown): value is WorkspaceTranscriptionPolicy {
  if (!isRecord(value) || typeof value.enabled !== "boolean") return false;
  if (
    !hasOnlyKeys(value, [
      "enabled",
      "acceptanceId",
      "primary",
      "language",
      "retention",
      "privacy",
      "fallback",
      "cost",
    ])
  ) {
    return false;
  }
  if (!(value.acceptanceId === null || isUuid(value.acceptanceId))) return false;
  if (!(value.primary === null || isTarget(value.primary))) return false;
  if (!(value.language === null || isBoundedString(value.language, 64))) return false;
  if (!isRecord(value.retention) || !hasOnlyKeys(value.retention, ["mode", "maxDays"])) {
    return false;
  }
  if (value.retention.mode !== "none" && value.retention.mode !== "provider-policy") return false;
  if (!(value.retention.maxDays === null || isBoundedInteger(value.retention.maxDays, 3650))) {
    return false;
  }
  if (
    !isRecord(value.privacy) ||
    !hasOnlyKeys(value.privacy, ["allowProviderLogging", "allowProviderTraining"]) ||
    typeof value.privacy.allowProviderLogging !== "boolean" ||
    typeof value.privacy.allowProviderTraining !== "boolean"
  ) {
    return false;
  }
  if (!isRecord(value.fallback) || !hasOnlyKeys(value.fallback, ["mode", "targets"])) {
    return false;
  }
  if (value.fallback.mode !== "disabled" && value.fallback.mode !== "explicit") return false;
  if (
    !Array.isArray(value.fallback.targets) ||
    value.fallback.targets.length > 8 ||
    !value.fallback.targets.every(isTarget)
  ) {
    return false;
  }
  if (value.fallback.mode === "disabled" && value.fallback.targets.length !== 0) return false;
  if (value.fallback.mode === "explicit" && value.fallback.targets.length === 0) return false;
  if (
    !isRecord(value.cost) ||
    !hasOnlyKeys(value.cost, ["currency", "maxPerHour", "maxPerMonth"]) ||
    value.cost.currency !== "USD"
  ) {
    return false;
  }
  if (!isNullableBoundedNumber(value.cost.maxPerHour, 10_000)) return false;
  if (!isNullableBoundedNumber(value.cost.maxPerMonth, 1_000_000)) return false;
  if (value.enabled && (!value.acceptanceId || !value.primary)) return false;
  const targets = [value.primary, ...value.fallback.targets].filter(
    (target): target is WorkspaceTranscriptionTarget => target !== null,
  );
  if (new Set(targets.map(targetKey)).size !== targets.length) return false;
  return true;
}

function targetKey(target: WorkspaceTranscriptionTarget): string {
  return [
    target.provider.trim(),
    target.model?.trim() ?? "",
    target.credentialMode,
    target.credentialConnectionId ?? "",
    target.region?.trim() ?? "",
  ].join("\u0000");
}

function isTarget(value: unknown): value is WorkspaceTranscriptionTarget {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, ["provider", "model", "credentialMode", "credentialConnectionId", "region"])
  ) {
    return false;
  }
  if (!isBoundedString(value.provider, 128)) return false;
  if (!(value.model === null || isBoundedString(value.model, 256))) return false;
  if (value.credentialMode !== "managed" && value.credentialMode !== "byok") return false;
  if (value.provider.trim() === "azure-speech" && value.credentialMode !== "byok") return false;
  if (!(value.credentialConnectionId === null || isUuid(value.credentialConnectionId))) {
    return false;
  }
  if (!(value.region === null || isBoundedString(value.region, 128))) return false;
  if (value.credentialMode === "byok" && value.credentialConnectionId === null) return false;
  if (value.credentialMode === "managed" && value.credentialConnectionId !== null) return false;
  return true;
}

function normalizeTarget(target: WorkspaceTranscriptionTarget): WorkspaceTranscriptionTarget {
  return {
    provider: target.provider.trim(),
    model: target.model?.trim() ?? null,
    credentialMode: target.credentialMode,
    credentialConnectionId: target.credentialConnectionId,
    region: target.region?.trim() ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const accepted = new Set(keys);
  return Object.keys(value).every((key) => accepted.has(key));
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isBoundedInteger(value: unknown, maximum: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function isNullableBoundedNumber(value: unknown, maximum: number): boolean {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum)
  );
}
