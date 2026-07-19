import type {
  TranscriptionEvent,
  TranscriptionEventSink,
  TranscriptionProvider,
  TranscriptionSession,
  TranscriptionSessionRequest,
  TranscriptionUsage,
} from "./types";

export type OpenAIClientSecretRequest = {
  sessionId: string;
  language?: string;
  diarization: boolean;
  privacy: TranscriptionSessionRequest["privacy"];
};

export type OpenAIClientSecret = {
  value: string;
  expiresAt: number;
  providerSessionId: string;
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
  mintClientSecret: (request: OpenAIClientSecretRequest) => Promise<OpenAIClientSecret>;
  mediaDevices?: OpenAIMediaDevicesLike;
  createPeerConnection?: () => OpenAIPeerConnectionLike;
  fetch?: OpenAIFetch;
  callsEndpoint?: string;
};

const DEFAULT_CALLS_ENDPOINT = "https://api.openai.com/v1/realtime/calls";

type LocalTranscriptionEvent<Event = TranscriptionEvent> = Event extends TranscriptionEvent
  ? Omit<Event, "sessionId" | "providerId" | "sequence">
  : never;

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
  private peer: OpenAIPeerConnectionLike | null = null;
  private channel: OpenAIDataChannelLike | null = null;
  private providerSessionId: string | undefined;
  private expiresAt: number | undefined;
  private reconnectAttempt = 0;
  private readonly partialByItem = new Map<string, string>();
  private readonly completedItems = new Set<string>();

  constructor(
    private readonly request: TranscriptionSessionRequest,
    private readonly emitEvent: TranscriptionEventSink,
    private readonly options: Required<
      Pick<
        OpenAIRealtimeTranscriptionProviderOptions,
        "mintClientSecret" | "fetch" | "callsEndpoint"
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

  private readonly onMessage = (messageEvent: { data: unknown }): void => {
    if (this.closed || typeof messageEvent.data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(messageEvent.data);
    } catch {
      return;
    }
    const event = record(parsed);
    if (!event) return;
    const type = string(event.type);
    const providerEventId = string(event.event_id) ?? undefined;

    if (type === "conversation.item.input_audio_transcription.delta") {
      const itemId = string(event.item_id);
      if (!itemId || this.completedItems.has(itemId)) return;
      const delta = typeof event.delta === "string" ? event.delta : "";
      const text = `${this.partialByItem.get(itemId) ?? ""}${delta}`;
      this.partialByItem.set(itemId, text);
      this.emit({
        type: "transcript.partial",
        ...(providerEventId ? { providerEventId } : {}),
        attempt: this.reconnectAttempt,
        segmentId: itemId,
        logicalSegmentId: `${this.id}:${itemId}`,
        text,
      });
      return;
    }

    if (type === "conversation.item.input_audio_transcription.completed") {
      const itemId = string(event.item_id);
      const acceptanceId = string(event.event_id);
      const transcript = typeof event.transcript === "string" ? event.transcript : "";
      if (!itemId || !acceptanceId || this.completedItems.has(itemId)) return;
      this.completedItems.add(itemId);
      this.partialByItem.delete(itemId);
      this.emit({
        type: "transcript.final",
        providerEventId: acceptanceId,
        providerAcceptanceId: acceptanceId,
        attempt: this.reconnectAttempt,
        segmentId: itemId,
        logicalSegmentId: `${this.id}:${itemId}`,
        text: transcript,
      });
      const usage = usageFrom(event.usage);
      if (usage) {
        this.emit({
          type: "usage",
          providerEventId: `${acceptanceId}:usage`,
          usage,
        });
      }
      return;
    }

    if (type === "conversation.item.input_audio_transcription.failed") {
      const itemId = string(event.item_id);
      if (itemId) this.partialByItem.delete(itemId);
      const providerError = record(event.error);
      this.emit({
        type: "error",
        ...(providerEventId ? { providerEventId } : {}),
        code: providerErrorCode(providerError?.code, "transcription_failed"),
        message: "Voice dictation could not transcribe this audio. Please retry.",
        retryable: true,
      });
      this.cleanup();
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
      this.cleanup();
    }
  };

  private readonly onConnectionStateChange = (): void => {
    const state = this.peer?.connectionState;
    if (this.closed || !state) return;
    if (state === "disconnected") {
      this.reconnectAttempt += 1;
      this.partialByItem.clear();
      this.emit({
        type: "reconnecting",
        attempt: this.reconnectAttempt,
        reason: "webrtc_disconnected",
      });
      return;
    }
    if (state === "connected" && this.reconnectAttempt > 0) {
      this.emit({
        type: "session.ready",
        ...(this.providerSessionId ? { providerSessionId: this.providerSessionId } : {}),
        ...(this.expiresAt === undefined ? {} : { expiresAt: this.expiresAt }),
      });
      return;
    }
    if (state === "failed") {
      this.partialByItem.clear();
      this.emit({
        type: "error",
        code: "webrtc_failed",
        message: "The voice connection failed. Please retry.",
        retryable: true,
      });
      this.cleanup();
      return;
    }
    if (state === "closed") {
      this.emitClosed("provider_closed");
      this.cleanup();
    }
  };

  private assertActive(): void {
    if (this.cancelled) {
      throw new Error("Voice dictation was cancelled");
    }
    if (this.closed) {
      throw new Error("Voice dictation was closed");
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("OpenAI transcription session already started");
    }
    this.started = true;
    try {
      const stream = await this.options.mediaDevices().getUserMedia({ audio: true });
      if (this.cancelled || this.closed) {
        for (const track of stream.getTracks()) track.stop();
        this.assertActive();
      }
      this.stream = stream;
      const secret = await this.options.mintClientSecret({
        sessionId: this.id,
        ...(this.request.language ? { language: this.request.language } : {}),
        diarization: this.request.diarization ?? false,
        privacy: this.request.privacy,
      });
      this.assertActive();
      this.providerSessionId = secret.providerSessionId;
      this.expiresAt = secret.expiresAt;

      const peer = this.options.createPeerConnection();
      const channel = peer.createDataChannel("oai-events");
      this.peer = peer;
      this.channel = channel;
      channel.addEventListener("message", this.onMessage);
      peer.addEventListener("connectionstatechange", this.onConnectionStateChange);
      for (const track of this.stream.getTracks()) {
        peer.addTrack(track, this.stream);
      }
      const offer = await peer.createOffer();
      this.assertActive();
      if (!offer.sdp) throw new Error("OpenAI Realtime WebRTC offer did not include SDP");
      await peer.setLocalDescription(offer);
      this.assertActive();
      const response = await this.options.fetch(this.options.callsEndpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret.value}`,
          "content-type": "application/sdp",
        },
        body: offer.sdp,
      });
      this.assertActive();
      if (!response.ok) {
        throw new Error(`OpenAI Realtime SDP exchange failed (${response.status})`);
      }
      const answerSdp = await response.text();
      this.assertActive();
      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
      this.assertActive();
      this.emit({
        type: "session.ready",
        providerSessionId: secret.providerSessionId,
        expiresAt: secret.expiresAt,
      });
    } catch (error) {
      this.cleanup();
      throw error;
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.cleanup();
    this.emitClosed("cancelled");
  }

  async close(): Promise<void> {
    this.cleanup();
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel?.removeEventListener("message", this.onMessage);
    this.peer?.removeEventListener("connectionstatechange", this.onConnectionStateChange);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.channel?.close();
    this.peer?.close();
    this.channel = null;
    this.peer = null;
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
      mintClientSecret: options.mintClientSecret,
      fetch: options.fetch ?? globalThis.fetch,
      callsEndpoint: options.callsEndpoint ?? DEFAULT_CALLS_ENDPOINT,
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
