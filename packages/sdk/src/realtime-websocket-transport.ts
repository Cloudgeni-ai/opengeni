import type { CodexRealtimeAudibleOutputState, CodexRealtimeWebrtcSession } from "./codex-realtime";
import type {
  CodexRealtimeControllerClient,
  RealtimeControllerTransportStarter,
} from "./codex-realtime-controller";
import { withoutAudioTags } from "./realtime-transcript";
import type { RealtimeWebsocketProtocol } from "./types";
import { isRecord } from "@opengeni/contracts/values";
type RealtimeClientEvent = Record<string, unknown> & { type: string };
type RealtimeServerEvent = Record<string, unknown> & { type: string };

const AUDIO_SAMPLE_RATE = 24_000;
const DELEGATION_TOOL = "delegate_to_session";

/**
 * Client events of the two realtime WebSocket wire protocols. Everything else
 * (provider URL, credentials, session configuration) comes from the server, so
 * a new OpenAI-compatible provider needs no browser changes.
 */
type RealtimeWireCodec = {
  audioAppend(audio: string): RealtimeClientEvent;
  textItem(text: string): RealtimeClientEvent;
  functionOutput(callId: string, name: string | null, output: string): RealtimeClientEvent;
  truncate(itemId: string, audioEndMs: number): RealtimeClientEvent;
  responseCreate(): RealtimeClientEvent;
};

const REALTIME_WIRE_CODECS: Record<RealtimeWebsocketProtocol, RealtimeWireCodec> = {
  openai: {
    audioAppend: (audio) => ({ type: "input_audio_buffer.append", audio }),
    textItem: (text) => ({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    }),
    functionOutput: (callId, _name, output) => ({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output },
    }),
    truncate: (itemId, audioEndMs) => ({
      type: "conversation.item.truncate",
      item_id: itemId,
      content_index: 0,
      audio_end_ms: audioEndMs,
    }),
    responseCreate: () => ({ type: "response.create" }),
  },
  "ai-gateway": {
    audioAppend: (audio) => ({ type: "input-audio-append", audio }),
    textItem: (text) => ({
      type: "conversation-item-create",
      item: { type: "text-message", role: "user", text },
    }),
    functionOutput: (callId, name, output) => ({
      type: "conversation-item-create",
      item: { type: "function-call-output", callId, name, output },
    }),
    truncate: (itemId, audioEndMs) => ({
      type: "conversation-item-truncate",
      itemId,
      contentIndex: 0,
      audioEndMs,
    }),
    responseCreate: () => ({ type: "response-create" }),
  },
};

/** One transport for every realtime voice provider reached over a WebSocket. */
export function createRealtimeWebsocketTransportStarter(): RealtimeControllerTransportStarter {
  return async (input) => {
    // Until a connection is returned, failures own all partially started resources.
    // Successful connections keep the existing controller-owned media lifetime.
    let cleanupStartup = (): void => {};
    try {
      const client = input.client as CodexRealtimeControllerClient;
      const negotiate =
        client.negotiateRealtimeWebsocket?.bind(client) ??
        client.negotiateGatewayRealtime?.bind(client) ??
        client.negotiateXaiSubscriptionRealtime?.bind(client);
      if (!negotiate) {
        throw new Error("The Opengeni client does not support WebSocket realtime voice");
      }
      // Microphone capture is prepared while the server mints the provider
      // session; audio flows once the socket is open and configured.
      let sendAudio: ((encoded: string) => void) | null = null;
      const audio = new RealtimeWebsocketAudio({
        onAudio: (encoded) => sendAudio?.(encoded),
        onAudibleOutputState: input.onAudibleOutputState,
      });
      cleanupStartup = () => audio.dispose();
      const capture = audio.startCapture(input.media);
      capture.catch(() => undefined);
      const answer = await negotiate(
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
          ...(input.language ? { language: input.language } : {}),
          ...(input.voiceSettings && Object.keys(input.voiceSettings).length > 0
            ? { voiceSettings: input.voiceSettings }
            : {}),
        },
        { signal: input.signal },
      );
      throwIfAborted(input.signal);

      const codec = REALTIME_WIRE_CODECS[answer.protocol];
      const websocket = new WebSocket(answer.url, answer.protocols);
      cleanupStartup = () => {
        try {
          audio.dispose();
        } finally {
          websocket.close(1000, "Opengeni realtime startup failed");
        }
      };
      const outbox = new RealtimeWebsocketContextOutbox(websocket, codec);
      const channel = new RealtimeWebsocketDataChannel((payload) => outbox.deliver(payload));
      const closeSocketAndAudio = cleanupStartup;
      cleanupStartup = () => {
        try {
          channel.close();
        } finally {
          closeSocketAndAudio();
        }
      };
      input.onEventsCreated(channel.asRtcDataChannel());
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
        handleRealtimeEvent({
          event: parsed as RealtimeServerEvent,
          codec,
          transcriptAudioTags: answer.transcriptAudioTags === true,
          channel,
          websocket,
          audio,
          outbox,
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

      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        input.signal.removeEventListener("abort", stop);
        websocket.removeEventListener("message", onMessage);
        websocket.removeEventListener("close", onClose);
        websocket.removeEventListener("error", onError);
        for (const track of microphoneTracks)
          track.removeEventListener?.("ended", onMicrophoneEnded);
        channel.close();
        audio.dispose();
        if (
          websocket.readyState === WebSocket.OPEN ||
          websocket.readyState === WebSocket.CONNECTING
        ) {
          websocket.close(1000, "Opengeni realtime connection retired");
        }
      };
      cleanupStartup = stop;
      input.signal.addEventListener("abort", stop, { once: true });

      await waitForWebSocketOpen(websocket, input.signal);
      channel.open();
      if (answer.sessionUpdate) send(websocket, answer.sessionUpdate as RealtimeClientEvent);
      sendAudio = (encoded) => send(websocket, codec.audioAppend(encoded));
      await capture;
      throwIfAborted(input.signal);
      input.onConnectionHealth("connected");
      throwIfAborted(input.signal);

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
        setOutputMuted: (muted) => audio.setMuted(muted),
        activateRemoteAudio: () => void audio.resume(),
        retryAudibleOutput: () => audio.resume(),
        stop,
      } satisfies CodexRealtimeWebrtcSession;
    } catch (error) {
      try {
        cleanupStartup();
      } catch {
        // Cleanup must not hide the startup error or leave other tracks running.
      }
      for (const track of input.media.getTracks()) {
        try {
          track.stop();
        } catch {
          // A faulty track must not prevent stopping the rest of this stream.
        }
      }
      throw error;
    }
  };
}

function handleRealtimeEvent(input: {
  event: RealtimeServerEvent;
  codec: RealtimeWireCodec;
  transcriptAudioTags: boolean;
  channel: RealtimeWebsocketDataChannel;
  websocket: WebSocket;
  audio: RealtimeWebsocketAudio;
  outbox: RealtimeWebsocketContextOutbox;
  finalizedAssistantItems: Set<string>;
  getCurrentOutputItemId(): string | null;
  setCurrentOutputItemId(value: string | null): void;
}): void {
  const event = input.event;
  const eventId = providerEventId(event);
  if (event.type === "session-created" || event.type === "session.created") {
    const session = isRecord(event.session) ? event.session : null;
    const sessionId =
      stringValue(event.sessionId) ?? stringValue(session?.id) ?? `realtime-${crypto.randomUUID()}`;
    input.channel.providerEvent({
      type: "session.started",
      event_id: eventId,
      session: { id: sessionId },
    });
    return;
  }
  if (event.type === "speech-started" || event.type === "input_audio_buffer.speech_started") {
    const itemId = input.getCurrentOutputItemId();
    if (itemId && input.audio.isPlaying()) {
      const audioEndMs = input.audio.playbackOffsetMs();
      input.audio.stopPlayback();
      send(input.websocket, input.codec.truncate(itemId, Math.max(0, Math.round(audioEndMs))));
    }
    // The reply to this speech is the next moment the model reads context.
    input.outbox.flush();
    return;
  }
  if (
    event.type === "input-transcription-completed" ||
    event.type === "conversation.item.input_audio_transcription.completed"
  ) {
    const transcript = stringValue(event.transcript) ?? "";
    const itemId = stringValue(event.itemId) ?? stringValue(event.item_id) ?? crypto.randomUUID();
    if (transcript.trim()) {
      input.channel.providerEvent({
        type: "turn.done",
        event_id: eventId,
        turn: { id: itemId, role: "user", transcript },
      });
    }
    return;
  }
  if (
    event.type === "audio-delta" ||
    event.type === "response.output_audio.delta" ||
    event.type === "response.audio.delta"
  ) {
    const delta = stringValue(event.delta);
    if (!delta) return;
    const itemId = stringValue(event.itemId) ?? stringValue(event.item_id);
    if (itemId) input.setCurrentOutputItemId(itemId);
    input.audio.play(delta);
    input.channel.providerEvent({ type: "output_audio.delta", event_id: eventId, audio: delta });
    return;
  }
  if (
    event.type === "audio-transcript-done" ||
    event.type === "text-done" ||
    event.type === "response.output_audio_transcript.done" ||
    event.type === "response.audio_transcript.done" ||
    event.type === "response.output_text.done"
  ) {
    const itemId = stringValue(event.itemId) ?? stringValue(event.item_id) ?? crypto.randomUUID();
    const spoken = stringValue(event.transcript) ?? stringValue(event.text) ?? "";
    const transcript = input.transcriptAudioTags ? withoutAudioTags(spoken) : spoken;
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
  if (event.type === "audio-done" || event.type === "response.output_audio.done") return;
  if (
    event.type === "function-call-arguments-done" ||
    event.type === "response.function_call_arguments.done"
  ) {
    const callId =
      stringValue(event.callId) ??
      stringValue(event.call_id) ??
      stringValue(event.itemId) ??
      stringValue(event.item_id) ??
      crypto.randomUUID();
    const name = stringValue(event.name);
    if (name !== DELEGATION_TOOL) {
      send(
        input.websocket,
        input.codec.functionOutput(
          callId,
          name,
          JSON.stringify({ error: "Unsupported realtime tool" }),
        ),
      );
      send(input.websocket, input.codec.responseCreate());
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
    const nested = isRecord(event.error) ? event.error : null;
    input.channel.providerEvent({
      type: "error",
      event_id: eventId,
      message:
        stringValue(event.message) ?? stringValue(nested?.message) ?? "Realtime provider error",
    });
  }
}

class RealtimeWebsocketDataChannel extends EventTarget {
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
    if (this.readyState !== "open") throw new Error("Realtime WebSocket channel is not open");
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

/** Newest unspoken context kept for the voice model; older text is dropped first. */
const HELD_CONTEXT_MAX_CHARS = 32_768;
const HELD_CONTEXT_TRUNCATION_MARKER = "…[earlier progress truncated]\n";

/**
 * Delivers the session's context to the voice model. A speakable update goes
 * out at once with a response request. Progress and other unspoken context is
 * held and sent as one item at the two moments the model reads it: when the
 * person starts speaking, and just before a response this client requests.
 * Sending every streamed progress fragment as its own item as it arrived
 * flooded providers that keep user items unread until a response is
 * requested; Eleven Realtime rejects more than ten.
 */
class RealtimeWebsocketContextOutbox {
  private held: Array<{ key: string; wrapper: string; text: string }> = [];

  constructor(
    private readonly websocket: WebSocket,
    private readonly codec: RealtimeWireCodec,
  ) {}

  deliver(messages: Array<Record<string, unknown>>): void {
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
    for (const [key, group] of groups) {
      const wrapper =
        group.type === "delegation.context.append"
          ? group.channel === "commentary"
            ? "execution_progress"
            : "execution_result"
          : "session_update";
      if (group.channel !== "speakable") {
        this.hold(key, wrapper, group.text);
        continue;
      }
      this.flush();
      if (group.type === "delegation.context.append" && group.id) {
        send(
          this.websocket,
          this.codec.functionOutput(
            group.id,
            DELEGATION_TOOL,
            JSON.stringify({ result: group.text }),
          ),
        );
      } else {
        send(this.websocket, this.codec.textItem(`<${wrapper}>\n${group.text}\n</${wrapper}>`));
      }
      send(this.websocket, this.codec.responseCreate());
    }
  }

  /** Sends everything held as one item. */
  flush(): void {
    if (this.held.length === 0) return;
    let text = this.held
      .map((entry) => `<${entry.wrapper}>\n${entry.text}\n</${entry.wrapper}>`)
      .join("\n");
    this.held = [];
    if (text.length > HELD_CONTEXT_MAX_CHARS) {
      text = `${HELD_CONTEXT_TRUNCATION_MARKER}${text.slice(text.length - HELD_CONTEXT_MAX_CHARS)}`;
    }
    send(this.websocket, this.codec.textItem(text));
  }

  // Streamed fragments of one update continue its text.
  private hold(key: string, wrapper: string, text: string): void {
    if (text.length === 0) return;
    const last = this.held.at(-1);
    if (last?.key === key) last.text += text;
    else this.held.push({ key, wrapper, text });
  }
}

class RealtimeWebsocketAudio {
  private captureContext: AudioContext | null = null;
  private captureSource: MediaStreamAudioSourceNode | null = null;
  private captureNode: AudioNode | null = null;
  private playbackContext: AudioContext | null = null;
  private playbackGain: GainNode | null = null;
  private playbackTime = 0;
  private playbackStartedAt = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private outputState: CodexRealtimeAudibleOutputState = "inactive";
  private muted = false;

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
    this.captureSource = source;
    const emit = (samples: Float32Array): void => {
      this.options.onAudio(encodePcm16(resample(samples, context.sampleRate, AUDIO_SAMPLE_RATE)));
    };
    const node =
      (await createCaptureWorklet(context, emit)) ?? createCaptureScriptProcessor(context, emit);
    if (this.captureContext !== context) {
      // Disposed while the capture module loaded.
      node.disconnect();
      return;
    }
    this.captureNode = node;
    source.connect(node);
    node.connect(context.destination);
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
    source.connect(this.outputNode(context));
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

  setMuted(muted: boolean): void {
    this.muted = muted;
    const context = this.playbackContext;
    const gain = this.playbackGain;
    if (context && gain) gain.gain.setValueAtTime(muted ? 0 : 1, context.currentTime);
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
    this.captureNode?.disconnect();
    this.captureSource?.disconnect();
    void this.captureContext?.close();
    this.captureNode = null;
    this.captureSource = null;
    this.captureContext = null;
    this.stopPlayback();
    this.playbackGain?.disconnect();
    void this.playbackContext?.close();
    this.playbackGain = null;
    this.playbackContext = null;
  }

  private outputNode(context: AudioContext): GainNode {
    if (!this.playbackGain) {
      this.playbackGain = context.createGain();
      this.playbackGain.gain.value = this.muted ? 0 : 1;
      this.playbackGain.connect(context.destination);
    }
    return this.playbackGain;
  }

  private publish(state: CodexRealtimeAudibleOutputState): void {
    if (state === this.outputState) return;
    this.outputState = state;
    this.options.onAudibleOutputState(state);
  }
}

function send(websocket: WebSocket, event: RealtimeClientEvent): void {
  if (websocket.readyState !== WebSocket.OPEN) return;
  websocket.send(JSON.stringify(event));
}

/**
 * Microphone audio leaves the browser in 20 ms frames, so the provider hears the
 * end of a sentence (and can answer) without waiting for a large capture block.
 */
const CAPTURE_FRAME_SECONDS = 0.02;
const CAPTURE_PROCESSOR_NAME = "opengeni-realtime-capture";
const CAPTURE_PROCESSOR_SOURCE = `class OpengeniRealtimeCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = options.processorOptions.frameSamples;
    this.frame = new Float32Array(this.size);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const count = Math.min(channel.length - offset, this.size - this.filled);
      this.frame.set(channel.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.size) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(CAPTURE_PROCESSOR_NAME)}, OpengeniRealtimeCapture);
`;

/** The capture worklet, or null where AudioWorklet or blob modules are unavailable. */
async function createCaptureWorklet(
  context: AudioContext,
  emit: (samples: Float32Array) => void,
): Promise<AudioNode | null> {
  if (typeof AudioWorkletNode === "undefined" || !context.audioWorklet) return null;
  const url = URL.createObjectURL(
    new Blob([CAPTURE_PROCESSOR_SOURCE], { type: "application/javascript" }),
  );
  try {
    await context.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      processorOptions: {
        frameSamples: Math.max(128, Math.round(context.sampleRate * CAPTURE_FRAME_SECONDS)),
      },
    });
    node.port.onmessage = (event: MessageEvent) => {
      if (event.data instanceof Float32Array) emit(event.data);
    };
    return node;
  } catch {
    // A host content security policy can refuse blob modules.
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function createCaptureScriptProcessor(
  context: AudioContext,
  emit: (samples: Float32Array) => void,
): AudioNode {
  const processor = context.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    emit(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  return processor;
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
    stringValue(event.event_id) ??
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
      reject(new Error("Realtime WebSocket failed to open"));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Realtime WebSocket closed before opening"));
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
