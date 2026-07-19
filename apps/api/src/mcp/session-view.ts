/**
 * Model-facing projections for cross-session monitoring tools.
 *
 * `session_events` reads are selected tail/forward and filtered in PostgreSQL;
 * this module is the independent final guard before JSON enters a manager
 * model's context. It measures the exact pretty-printed MCP text, trims fat
 * payload fields, and—only if still required—removes rows from the pagination
 * edge while preserving a usable cursor. It never manufactures an event or
 * advances across an event it did not return.
 */

import type {
  Rig,
  Session,
  SessionEvent,
  SessionEventPayloadMode,
  SessionEventReadDirection,
  SessionEventReadMode,
} from "@opengeni/contracts";
import { measureSessionEventJson } from "@opengeni/contracts";

export const SESSION_EVENT_MCP_MAX_BYTES = 64 * 1024;
export const SESSION_EVENT_MCP_FIELD_MAX_CHARS = 4_000;
export const DEFAULT_SESSION_DETAIL_CHARS = 6_000;
export const SESSION_DETAIL_MCP_MAX_BYTES = 64 * 1024;
export const RIG_DETAIL_MCP_MAX_BYTES = 64 * 1024;

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncationMarker(droppedChars: number): string {
  return `…[${droppedChars} chars omitted from this model monitoring projection; request explicit forensic full mode for any retained audit preview; original source output may not have been retained]`;
}

function clampString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const dropped = value.length - maxChars;
  const headChars = Math.max(0, Math.floor(maxChars * 0.7));
  const tailChars = Math.max(0, maxChars - headChars);
  const tail = tailChars > 0 ? value.slice(value.length - tailChars) : "";
  return `${value.slice(0, headChars)}${truncationMarker(dropped)}${tail}`;
}

/** Recursively clamp fat leaves and collapse pathological containers. */
export function capPayloadValue(value: unknown, perFieldChars: number, depth = 0): unknown {
  if (typeof value === "string") return clampString(value, perFieldChars);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return clampString(safeStringify(value), perFieldChars);
  const serializedLength = safeStringify(value).length;
  if (serializedLength <= perFieldChars) return value;
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => capPayloadValue(entry, perFieldChars, depth + 1));
    return safeStringify(mapped).length <= perFieldChars * 2
      ? mapped
      : clampString(safeStringify(value), perFieldChars);
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = capPayloadValue(entry, perFieldChars, depth + 1);
  }
  return safeStringify(out).length <= perFieldChars * 4
    ? out
    : clampString(safeStringify(value), perFieldChars);
}

export function capEventPayload(event: SessionEvent, perFieldChars: number): SessionEvent {
  const cappedPayload = capPayloadValue(event.payload, perFieldChars);
  return cappedPayload === event.payload ? event : { ...event, payload: cappedPayload };
}

export type SessionEventMcpPageInput = {
  events: readonly SessionEvent[];
  mode: SessionEventReadMode;
  payloadMode: SessionEventPayloadMode;
  direction: SessionEventReadDirection;
  sourceHasMore: boolean;
  sourceTruncatedBy: "count" | "bytes" | null;
  after: number;
  before: number | null;
  maxBytes?: number | undefined;
};

export type SessionEventMcpPage = {
  mode: SessionEventReadMode;
  payloadMode: SessionEventPayloadMode;
  direction: SessionEventReadDirection;
  events: SessionEvent[];
  coveredSequence: { first: number; last: number } | null;
  nextAfter: number | null;
  nextBefore: number | null;
  hasMore: boolean;
  truncated: boolean;
  truncation?: {
    reasons: Array<"source_count" | "source_bytes" | "model_payload" | "model_bytes">;
    omittedSide: "before" | "after";
    resumeCursor: number | null;
  };
  bytes: number;
  maxBytes: number;
};

function prettyJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
}

function setMeasuredBytes(page: SessionEventMcpPage): number {
  let measured = page.bytes;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    page.bytes = measured;
    const next = prettyJsonBytes(page);
    if (next === measured) return next;
    measured = next;
  }
  page.bytes = measured;
  return prettyJsonBytes(page);
}

/**
 * Build the exact model-visible page. Returned `bytes` includes all metadata
 * and pretty-printing used by the MCP JSON adapter.
 */
export function boundSessionEventMcpPage(input: SessionEventMcpPageInput): SessionEventMcpPage {
  const maxBytes = Math.max(8 * 1024, input.maxBytes ?? SESSION_EVENT_MCP_MAX_BYTES);
  let payloadTrimmed = false;
  const events = input.events.map((event) => {
    const capped = capEventPayload(event, SESSION_EVENT_MCP_FIELD_MAX_CHARS);
    if (capped !== event) payloadTrimmed = true;
    return capped;
  });
  let modelRowsDropped = false;

  const build = (): SessionEventMcpPage => {
    const first = events[0]?.sequence ?? null;
    const last = events.at(-1)?.sequence ?? null;
    const reasons: NonNullable<SessionEventMcpPage["truncation"]>["reasons"] = [];
    if (input.sourceHasMore) {
      reasons.push(input.sourceTruncatedBy === "bytes" ? "source_bytes" : "source_count");
    }
    if (payloadTrimmed) reasons.push("model_payload");
    if (modelRowsDropped) reasons.push("model_bytes");
    const nextAfter = input.direction === "after" ? (last ?? input.after) : null;
    const nextBefore = input.direction === "before" ? (first ?? input.before) : null;
    const page: SessionEventMcpPage = {
      mode: input.mode,
      payloadMode: input.payloadMode,
      direction: input.direction,
      events: [...events],
      coveredSequence: first === null || last === null ? null : { first, last },
      nextAfter,
      nextBefore,
      hasMore: input.sourceHasMore || modelRowsDropped,
      truncated: reasons.length > 0,
      ...(reasons.length > 0
        ? {
            truncation: {
              reasons,
              omittedSide: input.direction,
              resumeCursor: input.direction === "after" ? nextAfter : nextBefore,
            },
          }
        : {}),
      bytes: 0,
      maxBytes,
    };
    setMeasuredBytes(page);
    return page;
  };

  let page = build();
  while (page.bytes > maxBytes && events.length > 0) {
    if (input.direction === "before") events.shift();
    else events.pop();
    modelRowsDropped = true;
    page = build();
  }
  if (page.bytes > maxBytes) {
    throw new RangeError(`Session-event MCP metadata exceeds its ${maxBytes}-byte envelope`);
  }
  return page;
}

type MonitoringPreviewState = {
  remainingStringBytes: number;
  remainingNodes: number;
  truncated: boolean;
  details: string[];
};

type SessionDetailFieldFact = {
  truncated: boolean;
  originalBytes: number | null;
  deliveredBytes: number;
  originalCount?: number;
  deliveredCount?: number;
  measurementBounded?: boolean;
};

function modelStringProjection(
  value: string,
  maxBytes: number,
): {
  value: string;
  fact: SessionDetailFieldFact & { originalChars: number };
} {
  const originalBytes = Buffer.byteLength(value, "utf8");
  if (originalBytes <= maxBytes) {
    return {
      value,
      fact: {
        truncated: false,
        originalBytes,
        deliveredBytes: originalBytes,
        originalChars: value.length,
      },
    };
  }
  let omittedBytes = originalBytes - maxBytes;
  let head = "";
  let tail = "";
  let marker = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    marker = `…[${omittedBytes} UTF-8 bytes omitted from model monitoring projection]…`;
    const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
    head = utf8Prefix(value, Math.floor(contentBudget * 0.7));
    tail = utf8Suffix(value, contentBudget - Buffer.byteLength(head, "utf8"));
    const exact = Math.max(
      0,
      originalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"),
    );
    if (exact === omittedBytes) break;
    omittedBytes = exact;
  }
  const projected = `${head}${marker}${tail}`;
  return {
    value: projected,
    fact: {
      truncated: true,
      originalBytes,
      deliveredBytes: Buffer.byteLength(projected, "utf8"),
      originalChars: value.length,
    },
  };
}

function utf8Prefix(value: string, maxBytes: number): string {
  let index = 0;
  let bytes = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    index += character.length;
  }
  return value.slice(0, index);
}

function utf8Suffix(value: string, maxBytes: number): string {
  let index = value.length;
  let bytes = 0;
  while (index > 0) {
    const last = value.charCodeAt(index - 1);
    const width = last >= 0xdc00 && last <= 0xdfff && index > 1 ? 2 : 1;
    const character = value.slice(index - width, index);
    const nextBytes = Buffer.byteLength(character, "utf8");
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    index -= width;
  }
  return value.slice(index);
}

function previewMonitoringValue(
  value: unknown,
  state: MonitoringPreviewState,
  path = "$",
  depth = 0,
): unknown {
  if (state.remainingNodes <= 0 || depth >= 8) {
    state.truncated = true;
    if (state.details.length < 24) state.details.push(`${path}: traversal boundary`);
    return "[nested value omitted from model monitoring projection]";
  }
  state.remainingNodes -= 1;
  if (typeof value === "string") {
    const projected = modelStringProjection(value, Math.min(1_000, state.remainingStringBytes));
    state.remainingStringBytes = Math.max(
      0,
      state.remainingStringBytes - projected.fact.deliveredBytes,
    );
    if (projected.fact.truncated) {
      state.truncated = true;
      if (state.details.length < 24) state.details.push(`${path}: string truncated`);
    }
    return projected.value;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value !== "object") {
    state.truncated = true;
    if (state.details.length < 24) state.details.push(`${path}: non-JSON value omitted`);
    return `[${typeof value} value omitted from model monitoring projection]`;
  }
  if (Array.isArray(value)) {
    const keep = Math.min(24, value.length);
    const out = value
      .slice(0, keep)
      .map((entry, index) => previewMonitoringValue(entry, state, `${path}[${index}]`, depth + 1));
    if (keep < value.length) {
      state.truncated = true;
      if (state.details.length < 24) {
        state.details.push(`${path}: ${value.length - keep} array entries omitted`);
      }
      out.push({ omittedEntries: value.length - keep });
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  const keep = Math.min(24, entries.length);
  for (let index = 0; index < keep; index += 1) {
    const [rawKey, entry] = entries[index]!;
    const keyProjection = modelStringProjection(rawKey, 128).value;
    const key = Object.prototype.hasOwnProperty.call(out, keyProjection)
      ? `${keyProjection}#${index}`
      : keyProjection;
    out[key] = previewMonitoringValue(entry, state, `${path}.${keyProjection}`, depth + 1);
  }
  if (keep < entries.length) {
    state.truncated = true;
    if (state.details.length < 24) {
      state.details.push(`${path}: ${entries.length - keep} object fields omitted`);
    }
    out.omittedFields = entries.length - keep;
  }
  return out;
}

function projectMonitoringContainer(
  value: unknown,
  stringBytes: number,
): { value: unknown; fact: SessionDetailFieldFact; details: string[] } {
  const measurement = measureSessionEventJson(value);
  const state: MonitoringPreviewState = {
    remainingStringBytes: stringBytes,
    remainingNodes: 128,
    truncated: false,
    details: [],
  };
  const preview = previewMonitoringValue(value, state);
  const deliveredBytes = Buffer.byteLength(JSON.stringify(preview), "utf8");
  const originalCount = Array.isArray(value)
    ? value.length
    : value !== null && typeof value === "object"
      ? Object.keys(value).length
      : undefined;
  const deliveredCount = originalCount === undefined ? undefined : Math.min(24, originalCount);
  const originalBytes = measurement.bytes;
  const truncated =
    state.truncated || originalBytes === null || (originalBytes ?? 0) !== deliveredBytes;
  return {
    value: preview,
    fact: {
      truncated,
      originalBytes,
      deliveredBytes,
      ...(originalCount === undefined ? {} : { originalCount }),
      ...(deliveredCount === undefined ? {} : { deliveredCount }),
      ...(measurement.bytes === null ? { measurementBounded: true } : {}),
    },
    details: state.details,
  };
}

/** Purpose-built, flat, model-facing detail projection for `session_get`. */
export function boundSessionDetailMcp(
  session: Session,
  effectiveControl: unknown = session.effectiveControl,
  maxBytes = SESSION_DETAIL_MCP_MAX_BYTES,
) {
  const title = session.title === null ? null : modelStringProjection(session.title, 512);
  const initialMessage = modelStringProjection(session.initialMessage, 4_000);
  const instructions =
    session.instructions === null ? null : modelStringProjection(session.instructions, 4_000);
  const metadata = projectMonitoringContainer(session.metadata, 3_000);
  const resources = projectMonitoringContainer(session.resources, 3_000);
  const tools = projectMonitoringContainer(session.tools, 4_000);
  const mcpServers = projectMonitoringContainer(session.mcpServers, 3_000);
  const permissions = projectMonitoringContainer(session.firstPartyMcpPermissions, 1_500);
  const control = projectMonitoringContainer(effectiveControl, 2_000);
  const fieldFacts: Record<string, SessionDetailFieldFact> = {
    title: title?.fact ?? {
      truncated: false,
      originalBytes: 0,
      deliveredBytes: 0,
    },
    initialMessage: initialMessage.fact,
    instructions: instructions?.fact ?? {
      truncated: false,
      originalBytes: 0,
      deliveredBytes: 0,
    },
    metadata: metadata.fact,
    resources: resources.fact,
    tools: tools.fact,
    mcpServers: mcpServers.fact,
    firstPartyMcpPermissions: permissions.fact,
    effectiveControl: control.fact,
  };
  const details = [
    ...metadata.details,
    ...resources.details,
    ...tools.details,
    ...mcpServers.details,
    ...permissions.details,
    ...control.details,
  ].slice(0, 32);
  const result = {
    id: session.id,
    workspaceId: session.workspaceId,
    accountId: session.accountId,
    status: session.status,
    title: title?.value ?? null,
    titleSource: session.titleSource,
    initialMessage: initialMessage.value,
    instructions: instructions?.value ?? null,
    resources: resources.value,
    tools: tools.value,
    metadata: metadata.value,
    model: modelStringProjection(session.model, 512).value,
    sandboxBackend: modelStringProjection(session.sandboxBackend, 128).value,
    sandboxOs: session.sandboxOs,
    sandboxGroupId: session.sandboxGroupId,
    activeSandboxId: session.activeSandboxId,
    activeEpoch: session.activeEpoch,
    variableSetId: session.variableSetId,
    environmentId: session.environmentId,
    rigId: session.rigId,
    rigVersionId: session.rigVersionId,
    firstPartyMcpPermissions: permissions.value,
    mcpServers: mcpServers.value,
    parentSessionId: session.parentSessionId,
    createIdempotencyKey:
      session.createIdempotencyKey === null
        ? null
        : modelStringProjection(session.createIdempotencyKey, 512).value,
    temporalWorkflowId:
      session.temporalWorkflowId === null
        ? null
        : modelStringProjection(session.temporalWorkflowId, 512).value,
    activeTurnId: session.activeTurnId,
    lastInputTokens: session.lastInputTokens,
    queueVersion: session.queueVersion,
    queueHeadPosition: session.queueHeadPosition,
    queueTailPosition: session.queueTailPosition,
    effectiveControl: control.value,
    lastSequence: session.lastSequence,
    codexPinnedCredentialId: session.codexPinnedCredentialId,
    codexLastCredentialId: session.codexLastCredentialId,
    pinned: session.pinned,
    pinnedAt: session.pinnedAt,
    pinVersion: session.pinVersion,
    ...(session.treeStats === undefined ? {} : { treeStats: session.treeStats }),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    projection: {
      truncated: Object.values(fieldFacts).some((fact) => fact.truncated),
      fields: fieldFacts,
      details,
      bytes: 0,
      maxBytes,
    },
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const measured = prettyJsonBytes(result);
    if (result.projection.bytes === measured) break;
    result.projection.bytes = measured;
  }
  const mutable = result as Record<string, any> & {
    projection: typeof result.projection;
  };
  const fallbackContainers: Array<[string, SessionDetailFieldFact]> = [
    ["tools", fieldFacts.tools!],
    ["resources", fieldFacts.resources!],
    ["metadata", fieldFacts.metadata!],
    ["mcpServers", fieldFacts.mcpServers!],
    ["effectiveControl", fieldFacts.effectiveControl!],
    ["firstPartyMcpPermissions", fieldFacts.firstPartyMcpPermissions!],
  ];
  for (const [field, fact] of fallbackContainers) {
    if (result.projection.bytes <= maxBytes) break;
    const omission = {
      preview: `[${field} preview omitted at final session_get byte boundary]`,
      ...(fact.originalCount === undefined ? {} : { originalCount: fact.originalCount }),
    };
    mutable[field] = omission;
    fact.truncated = true;
    fact.deliveredBytes = Buffer.byteLength(JSON.stringify(omission), "utf8");
    fact.deliveredCount = 0;
    result.projection.truncated = true;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const measured = prettyJsonBytes(result);
      if (result.projection.bytes === measured) break;
      result.projection.bytes = measured;
    }
  }
  if (result.projection.bytes > maxBytes) {
    throw new RangeError(`session_get projection exceeds its ${maxBytes}-byte envelope`);
  }
  return result;
}

/** @deprecated use boundSessionDetailMcp for the actual MCP response. */
export function capSessionDetail<T extends { metadata?: unknown; initialMessage?: unknown }>(
  session: T,
  perFieldChars: number = DEFAULT_SESSION_DETAIL_CHARS,
): T {
  let changed = false;
  const out: T = { ...session };
  if (session.metadata !== undefined) {
    const capped = capPayloadValue(session.metadata, perFieldChars);
    if (capped !== session.metadata) {
      (out as { metadata?: unknown }).metadata = capped;
      changed = true;
    }
  }
  if (typeof session.initialMessage === "string" && session.initialMessage.length > perFieldChars) {
    (out as { initialMessage?: unknown }).initialMessage = clampString(
      session.initialMessage,
      perFieldChars,
    );
    changed = true;
  }
  return changed ? out : session;
}

/** Bounded current definition plus compact-by-query historical rig summaries. */
export function boundRigDetailMcp(
  rig: Rig,
  versionsPage: { versions: unknown[]; total: number; hasMore: boolean },
  changesPage: { changes: unknown[]; total: number; hasMore: boolean },
  maxBytes = RIG_DETAIL_MCP_MAX_BYTES,
) {
  const name = modelStringProjection(rig.name, 512);
  const description =
    rig.description === null ? null : modelStringProjection(rig.description, 2_000);
  const active = rig.activeVersion;
  const activeSetup =
    active?.setupScript === null || active?.setupScript === undefined
      ? null
      : modelStringProjection(active.setupScript, 8_000);
  const activeImage =
    active?.image === null || active?.image === undefined
      ? null
      : modelStringProjection(active.image, 1_000);
  const activeChangelog =
    active?.changelog === null || active?.changelog === undefined
      ? null
      : modelStringProjection(active.changelog, 2_000);
  const activeChecks = projectMonitoringContainer(active?.checks ?? [], 5_000);
  const activeHooks = projectMonitoringContainer(active?.credentialHooks ?? [], 1_500);
  const activeVariableSets = projectMonitoringContainer(active?.defaultVariableSetIds ?? [], 1_500);
  const versions = projectMonitoringContainer(versionsPage.versions, 4_000);
  const changes = projectMonitoringContainer(changesPage.changes, 4_000);
  const fieldFacts: Record<string, SessionDetailFieldFact> = {
    name: name.fact,
    description: description?.fact ?? {
      truncated: false,
      originalBytes: 0,
      deliveredBytes: 0,
    },
    activeSetupScript: activeSetup?.fact ?? {
      truncated: false,
      originalBytes: 0,
      deliveredBytes: 0,
    },
    activeImage: activeImage?.fact ?? {
      truncated: false,
      originalBytes: 0,
      deliveredBytes: 0,
    },
    activeChangelog: activeChangelog?.fact ?? {
      truncated: false,
      originalBytes: 0,
      deliveredBytes: 0,
    },
    activeChecks: activeChecks.fact,
    activeCredentialHooks: activeHooks.fact,
    activeDefaultVariableSetIds: activeVariableSets.fact,
    versions: versions.fact,
    changes: changes.fact,
  };
  const result = {
    rig: {
      id: rig.id,
      accountId: rig.accountId,
      workspaceId: rig.workspaceId,
      name: name.value,
      description: description?.value ?? null,
      createdBy: rig.createdBy === null ? null : modelStringProjection(rig.createdBy, 512).value,
      activeVersion: active
        ? {
            id: active.id,
            rigId: active.rigId,
            version: active.version,
            image: activeImage?.value ?? null,
            setupScript: activeSetup?.value ?? null,
            checks: activeChecks.value,
            credentialHooks: activeHooks.value,
            defaultVariableSetIds: activeVariableSets.value,
            changelog: activeChangelog?.value ?? null,
            createdBy:
              active.createdBy === null ? null : modelStringProjection(active.createdBy, 512).value,
            active: active.active,
            createdAt: active.createdAt,
          }
        : null,
      activeVersionHealth: rig.activeVersionHealth,
      versionCount: rig.versionCount,
      createdAt: rig.createdAt,
      updatedAt: rig.updatedAt,
    },
    versions: versions.value,
    versionsTotal: versionsPage.total,
    versionsTruncated: versionsPage.hasMore || versions.fact.truncated,
    changes: changes.value,
    changesTotal: changesPage.total,
    changesTruncated: changesPage.hasMore || changes.fact.truncated,
    projection: {
      truncated:
        versionsPage.hasMore ||
        changesPage.hasMore ||
        Object.values(fieldFacts).some((fact) => fact.truncated),
      fields: fieldFacts,
      details: [
        ...activeChecks.details,
        ...activeHooks.details,
        ...activeVariableSets.details,
        ...versions.details,
        ...changes.details,
      ].slice(0, 32),
      bytes: 0,
      maxBytes,
    },
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const measured = prettyJsonBytes(result);
    if (result.projection.bytes === measured) break;
    result.projection.bytes = measured;
  }
  const mutable = result as Record<string, any> & {
    projection: typeof result.projection;
  };
  const rigFallbacks: Array<{
    target: Record<string, unknown>;
    field: string;
    fact: SessionDetailFieldFact;
  }> = [
    {
      target: mutable.rig.activeVersion ?? {},
      field: "checks",
      fact: fieldFacts.activeChecks!,
    },
    { target: mutable, field: "versions", fact: fieldFacts.versions! },
    { target: mutable, field: "changes", fact: fieldFacts.changes! },
    {
      target: mutable.rig.activeVersion ?? {},
      field: "credentialHooks",
      fact: fieldFacts.activeCredentialHooks!,
    },
    {
      target: mutable.rig.activeVersion ?? {},
      field: "defaultVariableSetIds",
      fact: fieldFacts.activeDefaultVariableSetIds!,
    },
  ];
  for (const fallback of rigFallbacks) {
    if (result.projection.bytes <= maxBytes) break;
    const omission = {
      preview: `[${fallback.field} preview omitted at final rig_get byte boundary]`,
      ...(fallback.fact.originalCount === undefined
        ? {}
        : { originalCount: fallback.fact.originalCount }),
    };
    fallback.target[fallback.field] = omission;
    fallback.fact.truncated = true;
    fallback.fact.deliveredBytes = Buffer.byteLength(JSON.stringify(omission), "utf8");
    fallback.fact.deliveredCount = 0;
    result.projection.truncated = true;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const measured = prettyJsonBytes(result);
      if (result.projection.bytes === measured) break;
      result.projection.bytes = measured;
    }
  }
  if (result.projection.bytes > maxBytes) {
    throw new RangeError(`rig_get projection exceeds its ${maxBytes}-byte envelope`);
  }
  return result;
}
