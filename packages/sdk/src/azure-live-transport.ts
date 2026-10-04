import { startCodexRealtimeWebrtc, type StartCodexRealtimeWebrtcOptions } from "./codex-realtime";
import type { RealtimeControllerTransportStarter } from "./codex-realtime-controller";

type Envelope = Record<string, unknown>;
const MAX_FRAGMENT_BYTES = 64_000;

/** Azure Live has timed transcript fragments, not provider-finalized turns. */
export class AzureLiveDataChannel extends EventTarget {
  private pending: {
    role: "user" | "assistant";
    text: string;
    startMs: number;
    endMs: number;
  } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ordinal = 0;
  private readonly prefix = crypto.randomUUID();
  private closed = false;
  private closeSent = false;
  private providerClosed = false;
  private readonly delegations = new Set<string>();
  private draining: Promise<void> | null = null;
  private finishDrain: ((error?: Error) => void) | null = null;
  private readonly onOpen = () => this.dispatchEvent(new Event("open"));
  private readonly onClose = () => {
    this.providerClosed = true;
    this.flush();
    this.finishDrain?.();
    this.dispatchEvent(new Event("close"));
  };
  private readonly onError = () => this.dispatchEvent(new Event("error"));
  private readonly onMessage = (event: MessageEvent) => {
    if (typeof event.data !== "string" || event.data.length > 1_048_576) return;
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!value || typeof value !== "object") return;
    this.receive(value as Envelope);
  };
  constructor(
    private readonly raw: RTCDataChannel,
    private readonly drainTimeoutMs = 5_000,
  ) {
    super();
    raw.addEventListener("open", this.onOpen);
    raw.addEventListener("close", this.onClose);
    raw.addEventListener("error", this.onError);
    raw.addEventListener("message", this.onMessage);
  }
  get readyState(): RTCDataChannelState {
    return this.closed || this.providerClosed
      ? "closed"
      : this.closeSent
        ? "closing"
        : this.raw.readyState;
  }
  asRtcDataChannel(): RTCDataChannel {
    return this as unknown as RTCDataChannel;
  }
  private emit(value: Envelope): void {
    if (!this.closed)
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    this.pending = null;
    if (!pending?.text) return;
    this.emit({
      type: "transcript.segment",
      turn: {
        id: `${this.prefix}:${++this.ordinal}`,
        role: pending.role,
        transcript: pending.text,
      },
      start_ms: pending.startMs,
      end_ms: pending.endMs,
    });
  }
  private receive(value: Envelope): void {
    if (this.closed) return;
    if (
      value.type === "session.input_transcript.delta" ||
      value.type === "session.output_transcript.delta"
    ) {
      if (
        typeof value.delta !== "string" ||
        typeof value.start_ms !== "number" ||
        typeof value.end_ms !== "number"
      )
        return;
      const role = value.type === "session.input_transcript.delta" ? "user" : "assistant";
      if (
        this.pending &&
        (this.pending.role !== role ||
          new TextEncoder().encode(this.pending.text + value.delta).byteLength > MAX_FRAGMENT_BYTES)
      )
        this.flush();
      if (new TextEncoder().encode(value.delta).byteLength > MAX_FRAGMENT_BYTES) {
        this.emit({
          type: "error",
          error: { message: "Voice transcript fragment exceeded the supported size" },
        });
        return;
      }
      this.pending = {
        role,
        text: (this.pending?.text ?? "") + value.delta,
        startMs: this.pending?.startMs ?? value.start_ms,
        endMs: value.end_ms,
      };
      // Application grouping only: never present silence as a provider turn boundary.
      if (!this.timer) this.timer = setTimeout(() => this.flush(), 1_000);
      return;
    }
    if (value.type === "session.delegation.created") {
      const delegation = value.delegation as Envelope | undefined;
      if (delegation?.target !== "client" || typeof delegation.id !== "string") return;
      this.delegations.add(delegation.id);
      this.flush();
      this.emit({
        type: "delegation.created",
        item: { id: delegation.id, type: "delegation", target: "client", content: [] },
        offset_ms: value.offset_ms,
      });
      return;
    }
    if (value.type === "session.closed") {
      this.providerClosed = true;
      this.flush();
      this.finishDrain?.();
      return;
    }
    if (
      value.type === "session.started" ||
      value.type === "session.updated" ||
      value.type === "error"
    )
      this.emit(value);
  }
  send(payload: string): void {
    if (this.readyState !== "open") throw Error("Hosted voice channel is not open");
    const value = JSON.parse(payload) as Envelope;
    if (value.type !== "session.context.append" && value.type !== "delegation.context.append")
      throw Error("Unsupported hosted voice context event");
    const content = Array.isArray(value.content)
      ? value.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
      : "";
    // Existing bridge chunks are <=500 UTF-8 bytes, below Live's 500-token bound.
    this.raw.send(
      JSON.stringify({
        type:
          value.channel === "speakable" ? "session.commentary.append" : "session.thinking.append",
        content,
        // Replayed tasks from an earlier provider session are general context.
        delegation_id:
          value.type === "delegation.context.append" &&
          typeof value.delegation_item_id === "string" &&
          this.delegations.has(value.delegation_item_id)
            ? value.delegation_item_id
            : null,
      }),
    );
  }
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    if (this.providerClosed || this.raw.readyState === "closed") {
      this.flush();
      return Promise.resolve();
    }
    if (this.closed || this.raw.readyState !== "open") {
      return Promise.reject(new Error("Hosted voice close is not confirmed"));
    }
    const pending = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.flush();
        this.finishDrain?.(
          new Error("Hosted voice is still closing; retry to preserve final speech"),
        );
      }, this.drainTimeoutMs);
      this.finishDrain = (error) => {
        clearTimeout(timeout);
        this.finishDrain = null;
        if (error) reject(error);
        else resolve();
      };
      if (!this.closeSent) {
        this.closeSent = true;
        try {
          this.raw.send(JSON.stringify({ type: "session.close" }));
        } catch {
          this.finishDrain(new Error("Hosted voice close could not be sent"));
        }
      }
    });
    this.draining = pending;
    // An uncertain close remains retryable; never resend the provider mutation.
    void pending.then(
      () => {
        if (this.draining === pending) this.draining = null;
      },
      () => {
        if (this.draining === pending) this.draining = null;
      },
    );
    return pending;
  }
  close(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.finishDrain?.(new Error("Hosted voice channel was disposed before close confirmation"));
    this.closed = true;
    this.raw.removeEventListener("open", this.onOpen);
    this.raw.removeEventListener("close", this.onClose);
    this.raw.removeEventListener("error", this.onError);
    this.raw.removeEventListener("message", this.onMessage);
    this.dispatchEvent(new Event("close"));
  }
}

export function createAzureLiveTransportStarter(
  options: Pick<StartCodexRealtimeWebrtcOptions, "remoteAudio" | "createPeerConnection"> = {},
): RealtimeControllerTransportStarter {
  return async (input) => {
    let channel: AzureLiveDataChannel | undefined;
    try {
      const transport = await startCodexRealtimeWebrtc({
        ...input,
        ...options,
        activateRemoteAudio: false,
        expectedModel: "opengeni-azure/gpt-live-1",
        onEventsCreated(raw) {
          channel = new AzureLiveDataChannel(raw);
          input.onEventsCreated(channel.asRtcDataChannel());
        },
        negotiate: (request, requestOptions) =>
          input.client.negotiateCodexRealtimeWebrtc(
            input.workspaceId,
            input.sessionId,
            request,
            requestOptions,
          ),
      });
      const events = channel!;
      return {
        ...transport,
        events: events.asRtcDataChannel(),
        drain: () => events.drain(),
        stop() {
          events.close();
          transport.stop();
        },
      };
    } catch (error) {
      channel?.close();
      throw error;
    }
  };
}
