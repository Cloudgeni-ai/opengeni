import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { CODEX_PHYSICAL_REQUEST, type CodexPhysicalRequestInit } from "@opengeni/codex";
import type { ModelEvidencePurpose, ModelRequestEvidence } from "@opengeni/contracts";

const LIMIT = 4 * 1024 * 1024;
type Draft = Omit<ModelRequestEvidence, "version" | "scopeId" | "ordinal" | "purpose"> & {
  purpose?: ModelEvidencePurpose;
};
type Store = { recorder: EvidenceRecorder; purpose: ModelEvidencePurpose };
const storage = new AsyncLocalStorage<Store>();
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Register only actual injected credential values, never name/content heuristics. */
export function registerModelEvidenceSecrets(values: readonly (string | null | undefined)[]) {
  const recorder = storage.getStore()?.recorder;
  if (recorder) for (const value of values) if (value) recorder.secrets.add(value);
}

export function withModelEvidencePurpose<T>(purpose: ModelEvidencePurpose, fn: () => T): T {
  const current = storage.getStore();
  return current ? storage.run({ ...current, purpose }, fn) : fn();
}

/** The worker calls this before its exact-attempt settlement fence closes. */
export async function finishModelRequestEvidence(): Promise<void> {
  await storage.getStore()?.recorder.finish();
}

export async function startModelRequestEvidence(): Promise<void> {
  const recorder = storage.getStore()?.recorder;
  await recorder?.start();
}

/** Optional sink owns durability. Failures remain observable gaps, never inference retries. */
export async function withModelRequestEvidence<T>(
  sink: ((record: ModelRequestEvidence) => Promise<void>) | undefined,
  fn: () => Promise<T>,
  options: { sinkTimeoutMs?: number } = {},
): Promise<T> {
  if (!sink) return await fn();
  const recorder = new EvidenceRecorder(sink, options.sinkTimeoutMs ?? 5_000);
  return await storage.run({ recorder, purpose: "main" }, async () => {
    try {
      return await fn();
    } finally {
      await recorder.finish();
    }
  });
}

class EvidenceRecorder {
  readonly scopeId = randomUUID();
  readonly secrets = new Set<string>();
  physicalRequests = 0;
  private ordinal = 0;
  private errors = 0;
  private tail: Promise<void> = Promise.resolve();
  private readers = new Map<Promise<void>, () => void>();
  private closed = false;
  private finishing?: Promise<void>;
  constructor(
    private readonly sink: (record: ModelRequestEvidence) => Promise<void>,
    private readonly sinkTimeoutMs: number,
  ) {}

  start(): Promise<void> {
    return this.ordinal
      ? this.tail
      : this.emit({ kind: "scope_open", status: "captured", content: null }, "main");
  }

  emit(draft: Draft, purpose: ModelEvidencePurpose): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.ordinal === 0 && draft.kind !== "scope_open") {
      void this.emit({ kind: "scope_open", status: "captured", content: null }, "main");
    }
    const record: ModelRequestEvidence = {
      ...draft,
      version: 1,
      scopeId: this.scopeId,
      ordinal: ++this.ordinal,
      purpose: draft.purpose ?? purpose,
    };
    const write = this.tail.then(async () => {
      let changed = false;
      const redact = (value: unknown): unknown => {
        if (typeof value === "string") {
          let result = value;
          for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
            for (const needle of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
              if (needle && result.includes(needle)) {
                result = result.split(needle).join("[REDACTED:injected-credential]");
                changed = true;
              }
            }
          }
          return result;
        }
        if (Array.isArray(value)) return value.map(redact);
        if (value && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [redact(key), redact(item)]),
          );
        return value;
      };
      const content = redact(record.content);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.sink({ ...record, content, ...(changed ? { redacted: true } : {}) }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Model evidence sink timed out")),
              this.sinkTimeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    this.tail = write.catch(() => {
      this.errors++;
    });
    return this.tail;
  }

  track(promise: Promise<void>, cancel: () => void) {
    this.readers.set(promise, cancel);
    void promise
      .catch(() => {
        this.errors++;
      })
      .finally(() => this.readers.delete(promise));
  }

  finish(): Promise<void> {
    return (this.finishing ??= this.finishOnce());
  }

  private async finishOnce() {
    // Inference has exited. Do not keep a turn alive for an unconsumed upload or
    // provider stream: any unfinished observer records an explicit unavailable fact.
    await Promise.resolve();
    for (const cancel of this.readers.values()) cancel();
    await Promise.allSettled([...this.readers.keys()]);
    await this.tail;
    if (this.ordinal) {
      await this.emit(
        {
          kind: "scope_close",
          status: "captured",
          content: null,
          details: { errors: this.errors, physicalRequests: this.physicalRequests },
        },
        "main",
      );
    }
    this.closed = true;
    this.secrets.clear();
  }
}

/** Called only after the canonical usage event committed under the exact attempt. */
export async function captureModelUsageEvidence(input: {
  sourceKey: string;
  purpose: ModelEvidencePurpose;
  eventId: string;
  sequence: number;
  payload: unknown;
}) {
  const store = storage.getStore();
  if (!store) return;
  await store.recorder.emit(
    {
      kind: "usage",
      purpose: input.purpose,
      responseId: input.sourceKey,
      status: "captured",
      content: input.payload,
      details: {
        sourceKey: input.sourceKey,
        usageEventId: input.eventId,
        usageEventSequence: input.sequence,
      },
    },
    input.purpose,
  );
}

type PublicResponse = {
  events: unknown[];
  responseId?: string;
  terminal: string;
  unsupported: boolean;
};
function publicOutputItem(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  if (v.type === "reasoning")
    return {
      type: v.type,
      id: v.id,
      summary: v.summary ?? [],
      opaqueStatePresent: typeof v.encrypted_content === "string",
    };
  if (v.type === "compaction") return { type: v.type, id: v.id, opaqueStatePresent: true };
  if (v.type === "message" && v.channel === "analysis")
    return { type: v.type, id: v.id, channel: "analysis", publicTextUnavailable: true };
  return v;
}

function publicResponse(value: Record<string, any>) {
  const response: Record<string, unknown> = {};
  for (const key of [
    "id",
    "model",
    "status",
    "usage",
    "service_tier",
    "error",
    "incomplete_details",
  ])
    if (value[key] !== undefined) response[key] = value[key];
  if (Array.isArray(value.output)) response.output = value.output.map(publicOutputItem);
  return response;
}

/** Retain source event order, not a second model-output graph or invented history. */
export function publicResponsesEvidence(text: string): PublicResponse {
  const result: PublicResponse = { events: [], terminal: "unknown", unsupported: false };
  const analysisItems = new Set<string>();
  const analysisIndices = new Set<number>();
  const normalized = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  for (const block of normalized.split(/\n\n/)) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      result.unsupported = true;
      continue;
    }
    if (!raw || typeof raw !== "object") throw new Error("Invalid provider event");
    const event = raw as Record<string, any>;
    if (typeof event.type !== "string") throw new Error("Missing provider event type");
    // Raw/hidden reasoning text and encrypted material are never public summaries.
    if (event.type.startsWith("response.reasoning_text.")) continue;
    if (event.item?.type === "message" && event.item.channel === "analysis") {
      if (typeof event.item.id === "string") analysisItems.add(event.item.id);
      if (typeof event.output_index === "number") analysisIndices.add(event.output_index);
    }
    if (
      event.type.startsWith("response.output_text.") &&
      (analysisItems.has(event.item_id) || analysisIndices.has(event.output_index))
    )
      continue;
    if (event.type.includes("reasoning") && !event.type.startsWith("response.reasoning_summary_")) {
      result.unsupported = true;
      continue;
    }
    if (!event.type.startsWith("response.") && event.type !== "error") {
      result.unsupported = true;
      continue;
    }
    const publicType =
      /^(response\.(created|queued|in_progress|completed|done|failed|incomplete|error)|error)$/.test(
        event.type,
      ) ||
      /^response\.(output_item|content_part|output_text|refusal|function_call_arguments|custom_tool_call_input|reasoning_summary_part|reasoning_summary_text)\./.test(
        event.type,
      );
    if (!publicType) {
      result.unsupported = true;
      result.events.push({ type: event.type, publicPayloadUnavailable: true });
      continue;
    }
    const projected: Record<string, unknown> = { type: event.type };
    for (const key of [
      "sequence_number",
      "response_id",
      "item_id",
      "output_index",
      "content_index",
      "summary_index",
      "delta",
      "text",
      "arguments",
      "name",
      "call_id",
      "error",
    ])
      if (event[key] !== undefined) projected[key] = event[key];
    if (event.part !== undefined)
      projected.part =
        analysisItems.has(event.item_id) || analysisIndices.has(event.output_index)
          ? { publicTextUnavailable: true }
          : publicOutputItem(event.part);
    if (event.item !== undefined) projected.item = publicOutputItem(event.item);
    if (event.response && typeof event.response === "object") {
      const r = event.response;
      if (Array.isArray(r.output))
        for (const [index, output] of r.output.entries()) {
          if (output?.type === "message" && output.channel === "analysis") {
            analysisIndices.add(index);
            if (typeof output.id === "string") analysisItems.add(output.id);
          }
        }
      projected.response = publicResponse(r);
      if (typeof r.id === "string") {
        if (result.responseId && result.responseId !== r.id) result.unsupported = true;
        result.responseId = r.id;
      }
    }
    if (
      [
        "response.completed",
        "response.done",
        "response.failed",
        "response.incomplete",
        "response.error",
        "error",
      ].includes(event.type)
    ) {
      if (result.terminal !== "unknown") result.unsupported = true;
      result.terminal = ["response.completed", "response.done"].includes(event.type)
        ? "completed"
        : "failed";
    }
    result.events.push(projected);
  }
  // Some transports reveal item channels only in a late item/terminal event.
  // Remove earlier analysis text too, before any public projection is persisted.
  result.events = result.events.filter((value) => {
    const event = value as Record<string, any>;
    if (!analysisItems.has(event.item_id) && !analysisIndices.has(event.output_index)) return true;
    if (event.type.startsWith("response.output_text.")) return false;
    if (event.part !== undefined) event.part = { publicTextUnavailable: true };
    return true;
  });
  return result;
}

export function beginModelRequestEvidence(provider: string, init?: RequestInit) {
  const store = storage.getStore();
  if (!store) return undefined;
  const { recorder, purpose } = store;
  recorder.physicalRequests++;
  const headers = new Headers(init?.headers);
  const authorization = headers.get("authorization");
  registerModelEvidenceSecrets([
    authorization,
    authorization?.match(/^Bearer\s+(.+)$/i)?.[1],
    headers.get("x-api-key"),
  ]);
  const identity = (init as CodexPhysicalRequestInit | undefined)?.[CODEX_PHYSICAL_REQUEST];
  const physical = identity
    ? {
        requestId: identity.requestId,
        transportAttempt: identity.transportAttempt,
        identitySource: "codex_custody" as const,
      }
    : { requestId: randomUUID(), transportAttempt: 1, identitySource: "local_fetch" as const };
  const common = { provider, physical };
  let transport = "http";
  let responseObserved = false;
  if (identity)
    identity.onWebSocketPacket = (packet) => {
      transport = "websocket";
      void recorder.emit(
        {
          ...common,
          kind: "wire_request",
          status: Buffer.byteLength(packet) <= LIMIT ? "captured" : "unavailable",
          sourceSha256: hash(packet),
          content:
            Buffer.byteLength(packet) <= LIMIT
              ? { body: packet, encoding: "websocket_response_create" }
              : null,
          ...(Buffer.byteLength(packet) > LIMIT
            ? { reason: "wire_packet_exceeds_capture_limit" }
            : {}),
        },
        purpose,
      );
    };
  return {
    requestBody: async (body: string | null, reason?: string) => {
      await recorder.emit(
        {
          ...common,
          kind: "request",
          status: body !== null && identity ? "captured" : "unavailable",
          ...(body !== null ? { sourceSha256: hash(body) } : {}),
          content: body === null ? null : { body, encoding: "normalized_fetch_body" },
          ...(!identity || reason
            ? { reason: reason ?? "physical_custody_identity_unsupported" }
            : {}),
        },
        purpose,
      );
    },
    track: (promise: Promise<void>, cancel: () => void) => recorder.track(promise, cancel),
    failed: async () => {
      if (!responseObserved)
        await recorder.emit(
          {
            ...common,
            kind: "response",
            status: "unavailable",
            content: null,
            reason: "transport_failed_before_response",
            details: { terminal: "unknown", transport },
          },
          purpose,
        );
    },
    observeResponse: (response: Response): Response => {
      responseObserved = true;
      const contentType = response.headers.get("content-type") ?? "";
      const isSse = contentType.includes("text/event-stream");
      const isJson = contentType.includes("application/json");
      if (!response.body || (!isSse && !isJson)) {
        void recorder.emit(
          {
            ...common,
            kind: "response",
            status: "unavailable",
            content: null,
            reason: "response_protocol_unsupported_or_refused",
            details: { terminal: "unknown", transport, httpStatus: response.status },
          },
          purpose,
        );
        return response;
      }
      const [sent, inspected] = response.body.tee();
      const reader = inspected.getReader();
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        void reader.cancel().catch(() => {});
      };
      const captured = (async () => {
        let bytes = 0;
        let text = "";
        let reason: string | undefined;
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > LIMIT) {
              reason = "response_exceeds_capture_limit";
              cancel();
              break;
            }
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
          if (cancelled) reason ??= "response_capture_cancelled";
          const json = isJson ? JSON.parse(text) : null;
          const projected = isSse
            ? publicResponsesEvidence(text)
            : {
                response: publicResponse(json),
                responseId: typeof json.id === "string" ? json.id : undefined,
                terminal:
                  json.status === "completed"
                    ? "completed"
                    : json.status === "failed" || json.status === "incomplete"
                      ? "failed"
                      : "unknown",
                unsupported: !Array.isArray(json.output),
              };
          if (projected.unsupported) reason ??= "unsupported_or_contradictory_provider_events";
          if (!projected.responseId || projected.terminal === "unknown")
            reason ??= "response_identity_or_terminal_missing";
          await recorder.emit(
            {
              ...common,
              kind: "response",
              status: reason ? "unavailable" : "captured",
              ...(reason ? { reason } : {}),
              ...(projected.responseId ? { responseId: projected.responseId } : {}),
              sourceSha256: hash(text),
              content: {
                encoding: isJson
                  ? "provider_json_response"
                  : transport === "websocket"
                    ? "codex_websocket_events_as_sse"
                    : "provider_sse_json",
                ...projected,
              },
              details: {
                terminal: projected.terminal,
                transport,
                httpStatus: response.status,
                bytes,
              },
            },
            purpose,
          );
        } catch {
          let partial: PublicResponse | undefined;
          if (isSse)
            try {
              partial = publicResponsesEvidence(text);
            } catch {
              /* Unparseable source is not reconstructed. */
            }
          await recorder.emit(
            {
              ...common,
              kind: "response",
              status: "unavailable",
              ...(partial?.responseId ? { responseId: partial.responseId } : {}),
              sourceSha256: hash(text),
              content: partial
                ? {
                    encoding:
                      transport === "websocket"
                        ? "codex_websocket_events_as_sse"
                        : "provider_sse_json",
                    ...partial,
                    capturedPrefixOnly: true,
                  }
                : null,
              reason: "response_capture_invalid_or_failed",
              details: {
                terminal: partial?.terminal ?? "unknown",
                transport,
                bytes,
                capturedPrefixOnly: true,
              },
            },
            purpose,
          );
        } finally {
          reader.releaseLock();
        }
      })();
      recorder.track(captured, cancel);
      return new Response(sent, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
}
