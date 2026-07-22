import type {
  TranscriptionEvent,
  TranscriptionEventSink,
  TranscriptionProvider,
  TranscriptionSession,
  TranscriptionSessionRequest,
  TranscriptionUsage,
} from "./types";

export type OpenAIClientSecretRequest = {
  /** Existing durable OpenGeni session being dictated into. */
  sessionId: string;
  /** One-use local attempt identity; reconnects use a fresh identity. */
  requestId: string;
  language?: string;
  diarization: boolean;
  privacy: TranscriptionSessionRequest["privacy"];
};

export type OpenAIClientSecret = {
  value: string;
  expiresAt: number;
  providerSessionId: string;
  grantId: string;
  maxSessionDurationSeconds: number;
};

export type OpenAIGrantUsageReport = {
  sessionId: string;
  grantId: string;
  providerSessionId: string;
  providerEventId: string;
  durationSeconds: number;
};

export type OpenAIGrantSettlement = {
  sessionId: string;
  grantId: string;
  providerSessionId: string;
  status: "completed" | "cancelled" | "error" | "provider_closed" | "replaced";
};

export interface OpenAIMediaTrackLike {
  stop(): void;
}

export interface OpenAIMediaStreamLike {
  getTracks(): OpenAIMediaTrackLike[];
}

export interface OpenAIMediaDevicesLike {
  getUserMedia(constraints: { audio: true }): Promise<OpenAIMediaStreamLike>;
}

export interface OpenAIDataChannelLike {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export interface OpenAIPeerConnectionLike {
  readonly connectionState: string;
  addTrack(track: OpenAIMediaTrackLike, stream?: OpenAIMediaStreamLike): unknown;
  createDataChannel(label: string): OpenAIDataChannelLike;
  createOffer(): Promise<{ type?: string; sdp?: string }>;
  setLocalDescription(description: unknown): Promise<void>;
  setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void>;
  addEventListener(type: "connectionstatechange", listener: () => void): void;
  removeEventListener(type: "connectionstatechange", listener: () => void): void;
  close(): void;
}

export type OpenAIFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type OpenAIRealtimeTranscriptionProviderOptions = {
  /** Existing durable OpenGeni session; never the local dictation attempt id. */
  sessionId: string;
  mintClientSecret: (
    request: OpenAIClientSecretRequest,
    signal?: AbortSignal,
  ) => Promise<OpenAIClientSecret>;
  reportUsage?: (report: OpenAIGrantUsageReport) => Promise<void>;
  settleGrant?: (settlement: OpenAIGrantSettlement, signal?: AbortSignal) => Promise<void>;
  mediaDevices?: OpenAIMediaDevicesLike;
  createPeerConnection?: () => OpenAIPeerConnectionLike;
  fetch?: OpenAIFetch;
  callsEndpoint?: string;
  reconnectDelayMs?: number;
  reconnectTimeoutMs?: number;
  maxReconnectAttempts?: number;
};

const DEFAULT_CALLS_ENDPOINT = "https://api.openai.com/v1/realtime/calls";
const DEFAULT_RECONNECT_DELAY_MS = 500;
const DEFAULT_RECONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 2;

type LocalTranscriptionEvent<Event = TranscriptionEvent> = Event extends TranscriptionEvent
  ? Omit<Event, "sessionId" | "providerId" | "sequence">
  : never;

type Transport = {
  generation: number;
  attempt: number;
  peer: OpenAIPeerConnectionLike;
  channel: OpenAIDataChannelLike;
  secret: OpenAIClientSecret;
  onMessage: (event: { data: unknown }) => void;
  onStateChange: () => void;
};

function browserMediaDevices(): OpenAIMediaDevicesLike {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    throw new Error("Voice dictation is not supported in this browser.");
  }
  return navigator.mediaDevices as OpenAIMediaDevicesLike;
}

function browserPeerConnection(): OpenAIPeerConnectionLike {
  if (typeof RTCPeerConnection === "undefined") {
    throw new Error("WebRTC is not supported in this browser.");
  }
  return new RTCPeerConnection() as OpenAIPeerConnectionLike;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numericalRecord(value: unknown): Record<string, number> | undefined {
  const input = record(value);
  if (!input) return undefined;
  const output = Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, number] => number(entry[1]) !== null),
  );
  return Object.keys(output).length > 0 ? output : undefined;
}

function providerErrorCode(value: unknown, fallback: string): string {
  const code = string(value);
  return code && /^[a-zA-Z0-9_.-]{1,80}$/u.test(code) ? code : fallback;
}

function assertSupportedPrivacy(request: TranscriptionSessionRequest): void {
  if (
    request.privacy.retainAudio !== false ||
    request.privacy.retainTranscript !== false ||
    request.privacy.trainingAllowed !== false
  ) {
    throw new Error(
      "The OpenAI transcription prototype requires no-retention and no-training privacy settings.",
    );
  }
  if (request.privacy.region || request.privacy.dataResidency) {
    throw new Error(
      "The OpenAI transcription prototype cannot guarantee a requested region or data residency.",
    );
  }
}

function usageFrom(value: unknown): TranscriptionUsage | null {
  const usage = record(value);
  if (!usage) return null;
  if (usage.type === "duration") {
    const seconds = number(usage.seconds);
    return seconds === null ? null : { unit: "duration_seconds", seconds };
  }
  if (usage.type === "tokens") {
    const totalTokens = number(usage.total_tokens);
    if (totalTokens === null) return null;
    const inputTokens = number(usage.input_tokens);
    const outputTokens = number(usage.output_tokens);
    const inputTokenDetails = numericalRecord(usage.input_token_details);
    return {
      unit: "tokens",
      totalTokens,
      ...(inputTokens === null ? {} : { inputTokens }),
      ...(outputTokens === null ? {} : { outputTokens }),
      ...(inputTokenDetails ? { inputTokenDetails } : {}),
    };
  }
  return null;
}

class OpenAIRealtimeTranscriptionSession implements TranscriptionSession {
  readonly id: string;
  readonly providerId = "openai";
  private sequence = 0;
  private started = false;
  private cancelled = false;
  private closed = false;
  private closedEmitted = false;
  private stream: OpenAIMediaStreamLike | null = null;
  private transport: Transport | null = null;
  private transportGeneration = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectRunning = false;
  private setupController: AbortController | null = null;
  private readonly partialByItem = new Map<string, string>();
  private readonly completedItems = new Set<string>();

  constructor(
    private readonly request: TranscriptionSessionRequest,
    private readonly emitEvent: TranscriptionEventSink,
    private readonly options: Required<
      Pick<
        OpenAIRealtimeTranscriptionProviderOptions,
        | "sessionId"
        | "mintClientSecret"
        | "reportUsage"
        | "settleGrant"
        | "fetch"
        | "callsEndpoint"
        | "reconnectDelayMs"
        | "reconnectTimeoutMs"
        | "maxReconnectAttempts"
      >
    > & {
      mediaDevices: () => OpenAIMediaDevicesLike;
      createPeerConnection: () => OpenAIPeerConnectionLike;
    },
  ) {
    this.id = request.sessionId;
  }

  private emit(event: LocalTranscriptionEvent): void {
    this.emitEvent({
      ...event,
      sessionId: this.id,
      providerId: this.providerId,
      sequence: ++this.sequence,
    } as TranscriptionEvent);
  }

  private handleMessage(messageEvent: { data: unknown }, generation: number): void {
    if (
      this.closed ||
      this.transport?.generation !== generation ||
      typeof messageEvent.data !== "string"
    ) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(messageEvent.data);
    } catch {
      return;
    }
    const event = record(parsed);
    if (!event) return;
    const attempt = this.transport.attempt;
    const type = string(event.type);
    const providerEventId = string(event.event_id) ?? undefined;

    if (type === "conversation.item.input_audio_transcription.delta") {
      const itemId = string(event.item_id);
      const itemKey = itemId ? `${attempt}:${itemId}` : null;
      if (!itemId || !itemKey || this.completedItems.has(itemKey)) return;
      const delta = typeof event.delta === "string" ? event.delta : "";
      const text = `${this.partialByItem.get(itemKey) ?? ""}${delta}`;
      this.partialByItem.set(itemKey, text);
      this.emit({
        type: "transcript.partial",
        ...(providerEventId ? { providerEventId } : {}),
        attempt,
        segmentId: itemId,
        logicalSegmentId: `${this.id}:${attempt}:${itemId}`,
        text,
      });
      return;
    }

    if (type === "conversation.item.input_audio_transcription.completed") {
      const itemId = string(event.item_id);
      const itemKey = itemId ? `${attempt}:${itemId}` : null;
      const acceptanceId = string(event.event_id);
      const transcript = typeof event.transcript === "string" ? event.transcript : "";
      if (!itemId || !itemKey || !acceptanceId || this.completedItems.has(itemKey)) return;
      this.completedItems.add(itemKey);
      this.partialByItem.delete(itemKey);
      this.emit({
        type: "transcript.final",
        providerEventId: acceptanceId,
        providerAcceptanceId: acceptanceId,
        attempt,
        segmentId: itemId,
        logicalSegmentId: `${this.id}:${attempt}:${itemId}`,
        text: transcript,
      });
      const usage = usageFrom(event.usage);
      if (usage) {
        this.emit({
          type: "usage",
          providerEventId: `${acceptanceId}:usage`,
          usage,
        });
        if (usage.unit === "duration_seconds") {
          const active = this.transport;
          if (active) {
            void this.options
              .reportUsage({
                sessionId: this.options.sessionId,
                grantId: active.secret.grantId,
                providerSessionId: active.secret.providerSessionId,
                providerEventId: acceptanceId,
                durationSeconds: usage.seconds,
              })
              .catch(() => undefined);
          }
        }
      }
      return;
    }

    if (type === "conversation.item.input_audio_transcription.failed") {
      const itemId = string(event.item_id);
      if (itemId) this.partialByItem.delete(`${attempt}:${itemId}`);
      const providerError = record(event.error);
      this.emit({
        type: "error",
        ...(providerEventId ? { providerEventId } : {}),
        code: providerErrorCode(providerError?.code, "transcription_failed"),
        message: "Voice dictation could not transcribe this audio. Please retry.",
        retryable: true,
      });
      void this.finish("error");
      return;
    }

    if (type === "error") {
      const providerError = record(event.error);
      this.emit({
        type: "error",
        ...(providerEventId ? { providerEventId } : {}),
        code: providerErrorCode(providerError?.code, "provider_error"),
        message: "The voice dictation provider returned an error. Please retry.",
        retryable: true,
      });
      void this.finish("error");
    }
  }

  private handleConnectionState(generation: number): void {
    const active = this.transport;
    if (this.closed || !active || active.generation !== generation) return;
    const state = active.peer.connectionState;
    if (state === "disconnected") {
      this.partialByItem.clear();
      this.scheduleReconnect();
      return;
    }
    if (state === "failed") {
      this.partialByItem.clear();
      this.scheduleReconnect();
      return;
    }
    if (state === "closed") {
      this.emitClosed("provider_closed");
      void this.finish("provider_closed");
    }
  }

  private assertActive(generation?: number): void {
    if (this.cancelled) throw new Error("Voice dictation was cancelled");
    if (this.closed) throw new Error("Voice dictation was closed");
    if (generation !== undefined && generation !== this.transportGeneration) {
      throw new Error("Voice connection setup was superseded");
    }
  }

  private requestId(attempt: number): string {
    return `${this.id}:${attempt}`;
  }

  private async connectTransport(attempt: number): Promise<void> {
    const generation = ++this.transportGeneration;
    let secret: OpenAIClientSecret | null = null;
    const controller = new AbortController();
    this.setupController = controller;
    const setupError = new Error("Voice connection setup timed out. Please retry.");
    let rejectSetup!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectSetup = reject;
    });
    const onAbort = () => {
      rejectSetup(
        controller.signal.reason instanceof Error ? controller.signal.reason : setupError,
      );
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(setupError), this.options.reconnectTimeoutMs);
    const wait = async <Value>(operation: Promise<Value>): Promise<Value> =>
      await Promise.race([operation, stopped]);
    try {
      const minting = this.options
        .mintClientSecret(
          {
            sessionId: this.options.sessionId,
            requestId: this.requestId(attempt),
            ...(this.request.language ? { language: this.request.language } : {}),
            diarization: this.request.diarization ?? false,
            privacy: this.request.privacy,
          },
          controller.signal,
        )
        .then(async (candidate) => {
          if (
            controller.signal.aborted ||
            this.closed ||
            this.cancelled ||
            generation !== this.transportGeneration
          ) {
            await this.settleSecret(candidate, "error", false);
            throw controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error("Voice connection setup was superseded");
          }
          return candidate;
        });
      secret = await wait(minting);
      this.assertActive(generation);

      const peer = this.options.createPeerConnection();
      const channel = peer.createDataChannel("oai-events");
      const onMessage = (event: { data: unknown }) => this.handleMessage(event, generation);
      const onStateChange = () => this.handleConnectionState(generation);
      const transport: Transport = {
        generation,
        attempt,
        peer,
        channel,
        secret,
        onMessage,
        onStateChange,
      };
      this.transport = transport;
      channel.addEventListener("message", onMessage);
      peer.addEventListener("connectionstatechange", onStateChange);
      for (const track of this.stream?.getTracks() ?? []) {
        peer.addTrack(track, this.stream ?? undefined);
      }
      const offer = await wait(peer.createOffer());
      this.assertActive(generation);
      if (!offer.sdp) throw new Error("OpenAI Realtime WebRTC offer did not include SDP");
      await wait(peer.setLocalDescription(offer));
      this.assertActive(generation);
      const response = await wait(
        this.options.fetch(this.options.callsEndpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret.value}`,
            "content-type": "application/sdp",
          },
          body: offer.sdp,
          signal: controller.signal,
        }),
      );
      this.assertActive(generation);
      if (!response.ok) {
        throw new Error(`OpenAI Realtime SDP exchange failed (${response.status})`);
      }
      const answerSdp = await wait(response.text());
      this.assertActive(generation);
      await wait(peer.setRemoteDescription({ type: "answer", sdp: answerSdp }));
      this.assertActive(generation);
      this.armDurationLimit(secret.maxSessionDurationSeconds, generation);
      this.emit({
        type: "session.ready",
        providerSessionId: secret.providerSessionId,
        expiresAt: secret.expiresAt,
      });
    } catch (error) {
      if (this.transport?.generation === generation) {
        await this.disposeTransport("error", false);
      } else if (secret) {
        await this.settleSecret(secret, "error", false);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      if (this.setupController === controller) this.setupController = null;
    }
  }

  private armDurationLimit(seconds: number, generation: number): void {
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.durationTimer = setTimeout(
      () => {
        if (this.closed || this.transport?.generation !== generation) return;
        this.emit({
          type: "error",
          code: "session_duration_limit",
          message: "Voice dictation reached the workspace duration limit. Start again to continue.",
          retryable: true,
        });
        void this.finish("completed");
      },
      Math.max(1, seconds) * 1_000,
    );
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectRunning || this.reconnectTimer) return;
    if (this.reconnectAttempt >= this.options.maxReconnectAttempts) {
      this.emit({
        type: "error",
        code: "webrtc_reconnect_exhausted",
        message: "The voice connection could not recover. Please retry.",
        retryable: true,
      });
      void this.finish("error");
      return;
    }
    this.reconnectAttempt += 1;
    this.emit({
      type: "reconnecting",
      attempt: this.reconnectAttempt,
      reason: "webrtc_disconnected",
      retryInMs: this.options.reconnectDelayMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.runReconnect();
    }, this.options.reconnectDelayMs);
  }

  private async runReconnect(): Promise<void> {
    if (this.closed || this.reconnectRunning) return;
    this.reconnectRunning = true;
    try {
      await this.disposeTransport("replaced", true);
      this.assertActive();
      await this.connectTransport(this.reconnectAttempt);
    } catch {
      if (!this.closed) this.scheduleReconnect();
    } finally {
      this.reconnectRunning = false;
      // A failed attempt called scheduleReconnect while reconnectRunning was
      // true. Schedule it once after releasing that fence.
      if (!this.closed && !this.transport && !this.reconnectTimer) {
        this.scheduleReconnect();
      }
    }
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("OpenAI transcription session already started");
    this.started = true;
    try {
      const stream = await this.options.mediaDevices().getUserMedia({ audio: true });
      if (this.cancelled || this.closed) {
        for (const track of stream.getTracks()) track.stop();
        this.assertActive();
      }
      this.stream = stream;
      await this.connectTransport(0);
    } catch (error) {
      await this.finish("error");
      throw error;
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    await this.finish("cancelled");
    this.emitClosed("cancelled");
  }

  async close(): Promise<void> {
    await this.finish(this.cancelled ? "cancelled" : "completed");
  }

  private async settleSecret(
    secret: OpenAIClientSecret,
    status: OpenAIGrantSettlement["status"],
    strict: boolean,
  ): Promise<void> {
    const controller = new AbortController();
    const timeoutError = new Error("Transcription grant settlement timed out");
    let rejectTimeout!: (error: Error) => void;
    const timedOut = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const onAbort = () => rejectTimeout(timeoutError);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(timeoutError),
      this.options.reconnectTimeoutMs,
    );
    try {
      await Promise.race([
        this.options.settleGrant(
          {
            sessionId: this.options.sessionId,
            grantId: secret.grantId,
            providerSessionId: secret.providerSessionId,
            status,
          },
          controller.signal,
        ),
        timedOut,
      ]);
    } catch (error) {
      if (strict) throw error;
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  private async disposeTransport(
    status: OpenAIGrantSettlement["status"],
    strict: boolean,
  ): Promise<void> {
    const active = this.transport;
    this.transport = null;
    if (!active) return;
    active.channel.removeEventListener("message", active.onMessage);
    active.peer.removeEventListener("connectionstatechange", active.onStateChange);
    active.channel.close();
    active.peer.close();
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
    await this.settleSecret(active.secret, status, strict);
  }

  private async finish(status: OpenAIGrantSettlement["status"]): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.transportGeneration += 1;
    this.setupController?.abort(new Error("Voice dictation was closed"));
    this.setupController = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.durationTimer) {
      clearTimeout(this.durationTimer);
      this.durationTimer = null;
    }
    await this.disposeTransport(status, false);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.partialByItem.clear();
  }

  private emitClosed(reason: Extract<TranscriptionEvent, { type: "closed" }>["reason"]): void {
    if (this.closedEmitted) return;
    this.closedEmitted = true;
    this.emit({ type: "closed", reason });
  }
}

export class OpenAIRealtimeTranscriptionProvider implements TranscriptionProvider {
  readonly id = "openai";
  private readonly options: ConstructorParameters<typeof OpenAIRealtimeTranscriptionSession>[2];

  constructor(options: OpenAIRealtimeTranscriptionProviderOptions) {
    this.options = {
      sessionId: options.sessionId,
      mintClientSecret: options.mintClientSecret,
      reportUsage: options.reportUsage ?? (async () => undefined),
      settleGrant: options.settleGrant ?? (async () => undefined),
      fetch: options.fetch ?? globalThis.fetch,
      callsEndpoint: options.callsEndpoint ?? DEFAULT_CALLS_ENDPOINT,
      reconnectDelayMs: options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
      reconnectTimeoutMs: options.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS,
      maxReconnectAttempts: options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      mediaDevices: options.mediaDevices ? () => options.mediaDevices! : browserMediaDevices,
      createPeerConnection: options.createPeerConnection ?? browserPeerConnection,
    };
  }

  createSession(
    request: TranscriptionSessionRequest,
    emit: TranscriptionEventSink,
  ): TranscriptionSession {
    assertSupportedPrivacy(request);
    return new OpenAIRealtimeTranscriptionSession(request, emit, this.options);
  }
}
