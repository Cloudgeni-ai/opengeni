import type { CodexRealtimeAudibleOutputState, CodexRealtimeWebrtcSession } from "./codex-realtime";
import type {
  CodexRealtimeControllerClient,
  RealtimeControllerTransportStarter,
} from "./codex-realtime-controller";

type GatewayClientEvent = Record<string, unknown> & { type: string };
type GatewayServerEvent = Record<string, unknown> & { type: string };

const AUDIO_SAMPLE_RATE = 24_000;
const DELEGATION_TOOL = "delegate_to_session";

export function createGatewayRealtimeTransportStarter(): RealtimeControllerTransportStarter {
  return async (input) => {
    const client = input.client as CodexRealtimeControllerClient;
    if (!client.negotiateGatewayRealtime) {
      throw new Error("The OpenGeni client does not support AI Gateway realtime");
    }
    const answer = await client.negotiateGatewayRealtime(
      input.workspaceId,
      input.sessionId,
      {
        realtimeId: input.realtimeId,
        operationId: input.operationId,
        browserInstanceId: input.browserInstanceId,
        ownerKey: input.ownerKey,
        expectedVersion: input.expectedVersion,
        expectedConnectionEpoch: input.expectedConnectionEpoch,
        rotate: input.rotate,
      },
      { signal: input.signal },
    );
    throwIfAborted(input.signal);

    const websocket = new WebSocket(answer.url, [
      "ai-gateway-realtime.v1",
      `ai-gateway-auth.${answer.token}`,
    ]);
    const channel = new GatewayRealtimeDataChannel((payload) =>
      handleBridgeOutbound(websocket, payload),
    );
    input.onEventsCreated(channel.asRtcDataChannel());
    const audio = new GatewayRealtimeAudio({
      onAudio: (encoded) => send(websocket, { type: "input-audio-append", audio: encoded }),
      onAudibleOutputState: input.onAudibleOutputState,
    });
    let stopped = false;
    let currentOutputItemId: string | null = null;
    const finalizedAssistantItems = new Set<string>();
    const microphoneTracks = input.media.getAudioTracks();
    const onMicrophoneEnded = (): void => {
      if (!stopped) input.onMicrophoneEnded();
    };
    for (const track of microphoneTracks) track.addEventListener?.("ended", onMicrophoneEnded);

    const onMessage = (event: MessageEvent): void => {
      if (typeof event.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isRecord(parsed) || typeof parsed.type !== "string") return;
      handleGatewayEvent({
        event: parsed as GatewayServerEvent,
        channel,
        websocket,
        audio,
        finalizedAssistantItems,
        getCurrentOutputItemId: () => currentOutputItemId,
        setCurrentOutputItemId: (value) => {
          currentOutputItemId = value;
        },
      });
    };
    const onClose = (): void => {
      if (!stopped) input.onConnectionHealth("closed");
    };
    const onError = (): void => {
      if (!stopped) input.onConnectionHealth("failed");
    };
    websocket.addEventListener("message", onMessage);
    websocket.addEventListener("close", onClose);
    websocket.addEventListener("error", onError);

    await waitForWebSocketOpen(websocket, input.signal);
    channel.open();
    send(websocket, {
      type: "session-update",
      config: {
        instructions: answer.instructions,
        outputModalities: ["audio"],
        inputAudioFormat: { type: "audio/pcm", rate: AUDIO_SAMPLE_RATE },
        outputAudioFormat: { type: "audio/pcm", rate: AUDIO_SAMPLE_RATE },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        turnDetection: {
          type: "server-vad",
          prefixPaddingMs: 300,
          silenceDurationMs: 500,
        },
        tools: [
          {
            type: "function",
            name: DELEGATION_TOOL,
            description:
              "Pass execution work, actions, and session tasks to the underlying session agent. Include the complete standalone request and relevant conversational context.",
            parameters: {
              type: "object",
              properties: {
                request: {
                  type: "string",
                  description: "Complete standalone task for the session agent",
                },
              },
              required: ["request"],
              additionalProperties: false,
            },
          },
        ],
      },
    });
    for (const item of answer.initialItems) {
      send(websocket, {
        type: "conversation-item-create",
        item: {
          type: "text-message",
          role: "user",
          text: `<session_initial_item role="${item.role}">\n${item.text}\n</session_initial_item>`,
        },
      });
    }
    await audio.startCapture(input.media);
    input.onConnectionHealth("connected");

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      input.signal.removeEventListener("abort", stop);
      websocket.removeEventListener("message", onMessage);
      websocket.removeEventListener("close", onClose);
      websocket.removeEventListener("error", onError);
      for (const track of microphoneTracks) track.removeEventListener?.("ended", onMicrophoneEnded);
      channel.close();
      audio.dispose();
      if (
        websocket.readyState === WebSocket.OPEN ||
        websocket.readyState === WebSocket.CONNECTING
      ) {
        websocket.close(1000, "OpenGeni realtime connection retired");
      }
    };
    input.signal.addEventListener("abort", stop, { once: true });

    return {
      peerConnection: null as unknown as RTCPeerConnection,
      events: channel.asRtcDataChannel(),
      media: input.media,
      operationId: input.operationId,
      connectionId: answer.connectionId,
      connectionEpoch: answer.connectionEpoch,
      startupFenceSequence: answer.startupFenceSequence,
      modeVersion: answer.modeVersion,
      microphoneHealthy: () =>
        microphoneTracks.length > 0 &&
        microphoneTracks.every((track) => track.readyState !== "ended"),
      audibleOutputState: () => audio.audibleOutputState(),
      activateRemoteAudio: () => void audio.resume(),
      retryAudibleOutput: () => audio.resume(),
      stop,
    } satisfies CodexRealtimeWebrtcSession;
  };
}

function handleGatewayEvent(input: {
  event: GatewayServerEvent;
  channel: GatewayRealtimeDataChannel;
  websocket: WebSocket;
  audio: GatewayRealtimeAudio;
  finalizedAssistantItems: Set<string>;
  getCurrentOutputItemId(): string | null;
  setCurrentOutputItemId(value: string | null): void;
}): void {
  const event = input.event;
  const eventId = providerEventId(event);
  if (event.type === "session-created") {
    const sessionId = stringValue(event.sessionId) ?? `gateway-${crypto.randomUUID()}`;
    input.channel.providerEvent({
      type: "session.started",
      event_id: eventId,
      session: { id: sessionId },
    });
    return;
  }
  if (event.type === "speech-started") {
    const itemId = input.getCurrentOutputItemId();
    if (itemId && input.audio.isPlaying()) {
      const audioEndMs = input.audio.playbackOffsetMs();
      input.audio.stopPlayback();
      send(input.websocket, {
        type: "conversation-item-truncate",
        itemId,
        contentIndex: 0,
        audioEndMs: Math.max(0, Math.round(audioEndMs)),
      });
    }
    return;
  }
  if (event.type === "input-transcription-completed") {
    const transcript = stringValue(event.transcript) ?? "";
    const itemId = stringValue(event.itemId) ?? crypto.randomUUID();
    if (transcript.trim()) {
      input.channel.providerEvent({
        type: "turn.done",
        event_id: eventId,
        turn: { id: itemId, role: "user", transcript },
      });
    }
    return;
  }
  if (event.type === "audio-delta") {
    const delta = stringValue(event.delta);
    if (!delta) return;
    const itemId = stringValue(event.itemId);
    if (itemId) input.setCurrentOutputItemId(itemId);
    input.audio.play(delta);
    input.channel.providerEvent({ type: "output_audio.delta", event_id: eventId, audio: delta });
    return;
  }
  if (event.type === "audio-transcript-done" || event.type === "text-done") {
    const itemId = stringValue(event.itemId) ?? crypto.randomUUID();
    const transcript = stringValue(event.transcript) ?? stringValue(event.text) ?? "";
    if (transcript.trim() && !input.finalizedAssistantItems.has(itemId)) {
      input.finalizedAssistantItems.add(itemId);
      input.channel.providerEvent({
        type: "turn.done",
        event_id: eventId,
        turn: { id: itemId, role: "assistant", transcript },
      });
    }
    return;
  }
  if (event.type === "audio-done") return;
  if (event.type === "function-call-arguments-done") {
    const callId = stringValue(event.callId) ?? stringValue(event.itemId) ?? crypto.randomUUID();
    const name = stringValue(event.name);
    if (name !== DELEGATION_TOOL) {
      send(input.websocket, {
        type: "conversation-item-create",
        item: {
          type: "function-call-output",
          callId,
          name,
          output: JSON.stringify({ error: "Unsupported realtime tool" }),
        },
      });
      send(input.websocket, { type: "response-create" });
      return;
    }
    const request = delegationRequest(stringValue(event.arguments) ?? "");
    input.channel.providerEvent({
      type: "delegation.created",
      event_id: eventId,
      item: {
        id: callId,
        type: "delegation",
        target: "client",
        content: [{ type: "input_text", text: request }],
      },
    });
    return;
  }
  if (event.type === "error") {
    input.channel.providerEvent({
      type: "error",
      event_id: eventId,
      message: stringValue(event.message) ?? "AI Gateway realtime provider error",
    });
  }
}

class GatewayRealtimeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  private pendingOutbound: Array<Record<string, unknown>> = [];
  private outboundScheduled = false;

  constructor(private readonly outbound: (messages: Array<Record<string, unknown>>) => void) {
    super();
  }

  asRtcDataChannel(): RTCDataChannel {
    return this as unknown as RTCDataChannel;
  }

  open(): void {
    this.readyState = "open";
    this.dispatchEvent(new Event("open"));
  }

  send(payload: string): void {
    if (this.readyState !== "open") throw new Error("Gateway realtime channel is not open");
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    this.pendingOutbound.push(parsed);
    if (this.outboundScheduled) return;
    this.outboundScheduled = true;
    queueMicrotask(() => {
      this.outboundScheduled = false;
      const messages = this.pendingOutbound;
      this.pendingOutbound = [];
      if (messages.length > 0 && this.readyState === "open") this.outbound(messages);
    });
  }

  providerEvent(event: Record<string, unknown>): void {
    if (this.readyState === "closed") return;
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }

  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.pendingOutbound = [];
    this.dispatchEvent(new Event("close"));
  }
}

function handleBridgeOutbound(
  websocket: WebSocket,
  messages: Array<Record<string, unknown>>,
): void {
  const groups = new Map<
    string,
    { type: string; id: string | null; channel: string; text: string }
  >();
  for (const message of messages) {
    const type = stringValue(message.type);
    if (type !== "session.context.append" && type !== "delegation.context.append") continue;
    const id = stringValue(message.delegation_item_id) ?? null;
    const channel = stringValue(message.channel) ?? "commentary";
    const key = `${type}:${id ?? "session"}:${channel}`;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter(isRecord)
      .map((part) => stringValue(part.text) ?? "")
      .join("");
    const existing = groups.get(key);
    groups.set(key, {
      type,
      id,
      channel,
      text: `${existing?.text ?? ""}${text}`,
    });
  }
  for (const group of groups.values()) {
    if (group.type === "delegation.context.append" && group.id && group.channel === "speakable") {
      send(websocket, {
        type: "conversation-item-create",
        item: {
          type: "function-call-output",
          callId: group.id,
          name: DELEGATION_TOOL,
          output: JSON.stringify({ result: group.text }),
        },
      });
      send(websocket, { type: "response-create" });
      continue;
    }
    const wrapper =
      group.type === "delegation.context.append"
        ? group.channel === "commentary"
          ? "execution_progress"
          : "execution_result"
        : "session_update";
    send(websocket, {
      type: "conversation-item-create",
      item: {
        type: "text-message",
        role: "user",
        text: `<${wrapper}>\n${group.text}\n</${wrapper}>`,
      },
    });
    if (group.channel === "speakable") send(websocket, { type: "response-create" });
  }
}

class GatewayRealtimeAudio {
  private captureContext: AudioContext | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureProcessor: ScriptProcessorNode | null = null;
  private playbackContext: AudioContext | null = null;
  private playbackTime = 0;
  private playbackStartedAt = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private outputState: CodexRealtimeAudibleOutputState = "inactive";

  constructor(
    private readonly options: {
      onAudio(audio: string): void;
      onAudibleOutputState(state: CodexRealtimeAudibleOutputState): void;
    },
  ) {}

  async startCapture(media: MediaStream): Promise<void> {
    const context = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
    this.captureContext = context;
    const source = context.createMediaStreamSource(media);
    const processor = context.createScriptProcessor(4096, 1, 1);
    this.captureSource = source;
    this.captureProcessor = processor;
    processor.onaudioprocess = (event) => {
      const samples = resample(
        new Float32Array(event.inputBuffer.getChannelData(0)),
        context.sampleRate,
        AUDIO_SAMPLE_RATE,
      );
      this.options.onAudio(encodePcm16(samples));
    };
    source.connect(processor);
    processor.connect(context.destination);
    await context.resume();
  }

  play(encoded: string): void {
    const context = (this.playbackContext ??= new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE }));
    if (context.state !== "running") {
      void this.resume().then((resumed) => {
        if (resumed) this.schedule(encoded);
      });
      return;
    }
    this.schedule(encoded);
  }

  private schedule(encoded: string): void {
    const context = this.playbackContext;
    if (!context) return;
    const samples = decodePcm16(encoded);
    const buffer = context.createBuffer(1, samples.length, AUDIO_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime, this.playbackTime);
    if (this.activeSources.size === 0) this.playbackStartedAt = startAt;
    source.start(startAt);
    this.playbackTime = startAt + buffer.duration;
    this.activeSources.add(source);
    this.publish("audible");
    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0) this.publish("inactive");
    };
  }

  stopPlayback(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.activeSources.clear();
    if (this.playbackContext) this.playbackTime = this.playbackContext.currentTime;
    this.publish("inactive");
  }

  playbackOffsetMs(): number {
    return this.playbackContext
      ? Math.max(0, (this.playbackContext.currentTime - this.playbackStartedAt) * 1000)
      : 0;
  }

  audibleOutputState(): CodexRealtimeAudibleOutputState {
    return this.outputState;
  }

  isPlaying(): boolean {
    return this.activeSources.size > 0;
  }

  async resume(): Promise<boolean> {
    const context = (this.playbackContext ??= new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE }));
    this.publish("pending");
    try {
      await context.resume();
      this.publish(this.activeSources.size > 0 ? "audible" : "inactive");
      return true;
    } catch {
      this.publish("blocked");
      return false;
    }
  }

  dispose(): void {
    this.captureProcessor?.disconnect();
    this.captureSource?.disconnect();
    void this.captureContext?.close();
    this.captureProcessor = null;
    this.captureSource = null;
    this.captureContext = null;
    this.stopPlayback();
    void this.playbackContext?.close();
    this.playbackContext = null;
  }

  private publish(state: CodexRealtimeAudibleOutputState): void {
    if (state === this.outputState) return;
    this.outputState = state;
    this.options.onAudibleOutputState(state);
  }
}

function send(websocket: WebSocket, event: GatewayClientEvent): void {
  if (websocket.readyState !== WebSocket.OPEN) return;
  websocket.send(JSON.stringify(event));
}

function delegationRequest(argumentsJson: string): string {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (isRecord(parsed) && typeof parsed.request === "string" && parsed.request.trim()) {
      return parsed.request.trim();
    }
  } catch {
    // Fall through to the provider's raw argument string.
  }
  return argumentsJson.trim() || "Continue the user's current request.";
}

function providerEventId(event: Record<string, unknown>): string {
  const raw = isRecord(event.raw) ? event.raw : null;
  return (
    stringValue(event.eventId) ??
    stringValue(raw?.event_id) ??
    stringValue(raw?.id) ??
    crypto.randomUUID()
  );
}

function encodePcm16(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

function decodePcm16(encoded: string): Float32Array {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }
  return samples;
}

function resample(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.round(input.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const source = index * ratio;
    const floor = Math.floor(source);
    const ceil = Math.min(floor + 1, input.length - 1);
    const fraction = source - floor;
    output[index] = (input[floor] ?? 0) * (1 - fraction) + (input[ceil] ?? 0) * fraction;
  }
  return output;
}

async function waitForWebSocketOpen(websocket: WebSocket, signal: AbortSignal): Promise<void> {
  if (websocket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      websocket.removeEventListener("open", onOpen);
      websocket.removeEventListener("error", onError);
      websocket.removeEventListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("AI Gateway realtime WebSocket failed to open"));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("AI Gateway realtime WebSocket closed before opening"));
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    websocket.addEventListener("open", onOpen, { once: true });
    websocket.addEventListener("error", onError, { once: true });
    websocket.addEventListener("close", onClose, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
