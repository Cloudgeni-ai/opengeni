import type {
  RealtimeVoiceAdapter,
  RealtimeVoiceAdapterEvent,
  RealtimeVoiceAdapterSession,
  SessionVoiceGrant,
} from "@opengeni/sdk";

type BrowserRealtimeVoiceAdapterOptions = {
  mediaDevices?: Pick<MediaDevices, "getUserMedia"> | undefined;
  createSocket?: ((url: string, protocol: string) => WebSocket) | undefined;
  createRecorder?: ((stream: MediaStream) => MediaRecorder) | undefined;
  playAudio?: ((data: ArrayBuffer) => Promise<void> | void) | undefined;
  chunkMilliseconds?: number | undefined;
};

/**
 * Browser media transport for the provider-neutral OpenGeni voice gateway.
 * Construction has no side effects. `getUserMedia` is called only from
 * `connect`, which the React controller invokes only after receiving a grant.
 */
export function createBrowserRealtimeVoiceAdapter(
  options: BrowserRealtimeVoiceAdapterOptions = {},
): RealtimeVoiceAdapter {
  return {
    connect: async (grant, listener, context) =>
      await connectBrowserVoice(grant, listener, context.signal, options),
  };
}

async function connectBrowserVoice(
  grant: SessionVoiceGrant,
  listener: (event: RealtimeVoiceAdapterEvent) => void,
  signal: AbortSignal,
  options: BrowserRealtimeVoiceAdapterOptions,
): Promise<RealtimeVoiceAdapterSession> {
  const mediaDevices =
    options.mediaDevices ??
    (typeof globalThis.navigator === "undefined" ? undefined : globalThis.navigator.mediaDevices);
  const createSocket =
    options.createSocket ??
    ((url: string, protocol: string) => new globalThis.WebSocket(url, protocol));
  const createRecorder =
    options.createRecorder ?? ((stream: MediaStream) => new globalThis.MediaRecorder(stream));
  if (
    !mediaDevices?.getUserMedia ||
    (!options.createSocket && typeof globalThis.WebSocket === "undefined") ||
    (!options.createRecorder && typeof globalThis.MediaRecorder === "undefined")
  ) {
    listener({ type: "error", code: "not_supported", recoverable: false });
    throw new Error("Realtime voice is not supported by this browser");
  }
  if (signal.aborted) throw signal.reason;

  let stream: MediaStream;
  try {
    stream = await mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (error) {
    const code =
      error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name)
        ? "permission_denied"
        : "unknown";
    listener({ type: "error", code, recoverable: false });
    throw error;
  }
  let socket: WebSocket | null = null;
  let recorder: MediaRecorder | null = null;
  let closed = false;
  let activeAudio: HTMLAudioElement | null = null;
  let activeAudioUrl: string | null = null;
  let activeSpeechMessageId: string | null = null;
  const requestedSpeechMessageIds = new Set<string>();

  const stopAudio = () => {
    activeAudio?.pause();
    activeAudio = null;
    if (activeAudioUrl) URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  };
  const stopTracks = () => {
    try {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Cleanup must continue when one browser track rejects stopping.
        }
      }
    } catch {
      // A hostile or partially torn-down MediaStream must not block cleanup.
    }
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      recorder?.stop();
    } catch {
      // Recorder shutdown is best effort; microphone tracks still need stopping.
    }
    recorder = null;
    stopTracks();
    requestedSpeechMessageIds.clear();
    activeSpeechMessageId = null;
    stopAudio();
    if (socket && (socket.readyState === 1 || socket.readyState === 0)) {
      try {
        socket.close(1000, "client closed");
      } catch {
        // Socket teardown is best effort after media ownership is released.
      }
    }
  };

  if (signal.aborted) {
    cleanup();
    throw signal.reason;
  }

  try {
    socket = createSocket(grant.gatewayUrl, grant.protocol);
    socket.binaryType = "arraybuffer";
    const activeSocket = socket;
    await waitForSocketOpen(activeSocket, signal);
    if (signal.aborted) throw signal.reason;
    activeSocket.send(
      JSON.stringify({
        type: "session.start",
        grantId: grant.id,
        target: grant.target,
      }),
    );

    activeSocket.onmessage = (message) => {
      if (closed) return;
      if (message.data instanceof ArrayBuffer) {
        // Audio is eligible only after the client requested speech for a
        // completed durable message and the gateway acknowledged that exact
        // message. Unsolicited/provider-only audio is never session truth.
        if (!activeSpeechMessageId) return;
        if (options.playAudio) {
          void Promise.resolve(options.playAudio(message.data)).catch(() => {
            listener({ type: "error", code: "provider", recoverable: true });
          });
        } else if (typeof Audio !== "undefined") {
          stopAudio();
          activeAudioUrl = URL.createObjectURL(new Blob([message.data], { type: "audio/mpeg" }));
          activeAudio = new Audio(activeAudioUrl);
          void activeAudio.play().catch(() => {
            listener({ type: "error", code: "provider", recoverable: true });
          });
        }
        return;
      }
      if (typeof message.data !== "string") return;
      const event = parseGatewayEvent(message.data);
      if (!event) return;
      if (event.type === "speaking.started") {
        if (!requestedSpeechMessageIds.has(event.messageId)) return;
        activeSpeechMessageId = event.messageId;
      } else if (event.type === "speaking.stopped") {
        const stoppedMessageId = event.messageId ?? activeSpeechMessageId;
        if (!stoppedMessageId || stoppedMessageId !== activeSpeechMessageId) return;
        requestedSpeechMessageIds.delete(stoppedMessageId);
        activeSpeechMessageId = null;
        stopAudio();
      }
      // A terminal gateway message revokes recorder/microphone/playback/socket
      // ownership before the host hook can clear its session handle or render a
      // terminal state. cleanup is idempotent when socket.close re-enters.
      if (event.type === "closed" || (event.type === "error" && !event.recoverable)) {
        cleanup();
        listener(event);
        return;
      }
      listener(event);
    };
    activeSocket.onerror = () => {
      if (!closed) listener({ type: "error", code: "network", recoverable: true });
    };
    activeSocket.onclose = () => {
      const notify = !closed;
      cleanup();
      if (notify) {
        listener({ type: "error", code: "network", recoverable: true });
        listener({ type: "closed", reason: "error" });
      }
    };

    recorder = createRecorder(stream);
    recorder.ondataavailable = (event) => {
      const currentSocket = socket;
      if (!closed && event.data.size > 0 && currentSocket?.readyState === 1) {
        currentSocket.send(event.data);
      }
    };
    recorder.start(Math.max(40, options.chunkMilliseconds ?? 80));
    listener({ type: "connected" });
    listener({ type: "listening" });
  } catch (error) {
    cleanup();
    throw error;
  }

  const abort = () => cleanup();
  signal.addEventListener("abort", abort, { once: true });

  return {
    interrupt: async () => {
      stopAudio();
      if (activeSpeechMessageId) requestedSpeechMessageIds.delete(activeSpeechMessageId);
      activeSpeechMessageId = null;
      const currentSocket = socket;
      if (currentSocket?.readyState === 1) {
        currentSocket.send(JSON.stringify({ type: "playback.interrupt" }));
      }
    },
    speak: async ({ messageId, text }) => {
      const currentSocket = socket;
      if (closed || currentSocket?.readyState !== 1) return;
      requestedSpeechMessageIds.add(messageId);
      currentSocket.send(JSON.stringify({ type: "assistant.output", messageId, text }));
    },
    close: async () => {
      signal.removeEventListener("abort", abort);
      const currentSocket = socket;
      if (currentSocket?.readyState === 1) {
        currentSocket.send(JSON.stringify({ type: "session.close" }));
      }
      cleanup();
    },
  };
}

function waitForSocketOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const settle = (callback: () => void) => {
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
      callback();
    };
    const opened = () => settle(resolve);
    const failed = () =>
      settle(() => reject(new Error("Realtime voice gateway connection failed")));
    const aborted = () => settle(() => reject(signal.reason));
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", failed, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function parseGatewayEvent(raw: string): RealtimeVoiceAdapterEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case "connected":
    case "listening":
      return { type: event.type };
    case "transcript.partial":
      return typeof event.text === "string" ? { type: event.type, text: event.text } : null;
    case "transcript.final":
      return typeof event.text === "string" &&
        typeof event.providerAcceptanceId === "string" &&
        event.providerAcceptanceId.length > 0 &&
        event.providerAcceptanceId.length <= 128
        ? {
            type: event.type,
            text: event.text,
            providerAcceptanceId: event.providerAcceptanceId,
          }
        : null;
    case "speaking.started":
      return typeof event.messageId === "string"
        ? { type: event.type, messageId: event.messageId }
        : null;
    case "speaking.stopped":
      return event.messageId === null || typeof event.messageId === "string"
        ? { type: event.type, messageId: event.messageId }
        : null;
    case "reconnecting":
      return typeof event.attempt === "number"
        ? { type: event.type, attempt: event.attempt }
        : null;
    case "error":
      return ["permission_denied", "not_supported", "network", "provider", "unknown"].includes(
        String(event.code),
      ) && typeof event.recoverable === "boolean"
        ? {
            type: event.type,
            code: event.code as
              | "permission_denied"
              | "not_supported"
              | "network"
              | "provider"
              | "unknown",
            recoverable: event.recoverable,
          }
        : null;
    case "closed":
      return ["completed", "cancelled", "error", "expired"].includes(String(event.reason))
        ? {
            type: event.type,
            reason: event.reason as "completed" | "cancelled" | "error" | "expired",
          }
        : null;
    default:
      return null;
  }
}
