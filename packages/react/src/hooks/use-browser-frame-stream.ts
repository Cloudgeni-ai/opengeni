import {
  browserFrameSocketUrl,
  decodeBrowserFrameMessage,
  type BrowserFrame,
  type BrowserFrameStreamOptions,
  type BrowserSessionAttachment,
} from "@opengeni/sdk/interaction";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type EmbeddedBrowserInteractionClientOverride,
  useEmbeddedBrowserInteraction,
} from "../session-context";
import {
  decodeStreamFrame,
  decodeStreamOpenAck,
  encodeStreamClose,
  encodeStreamOpen,
  STREAM_CLOSE_REASON_NORMAL,
  STREAM_KIND_BROWSER,
  STREAM_ROLE_CLIENT,
} from "../lib/relay-wire";

export type BrowserFrameConnectionState =
  | "idle"
  | "attaching"
  | "connecting"
  | "live"
  | "reconnecting"
  | "error";

export type BrowserFrameWebSocket = Pick<
  WebSocket,
  "binaryType" | "readyState" | "close" | "addEventListener" | "removeEventListener"
> & { send(data: ArrayBuffer): void };

export type BrowserFrameWebSocketFactory = (
  url: string,
  protocols: string[],
) => BrowserFrameWebSocket;

const RELAY_TAG_OPEN = 1;
const RELAY_TAG_OPEN_ACK = 2;
const RELAY_TAG_FRAME = 3;
const RELAY_TAG_CLOSE = 4;
const MAX_AUTOMATIC_RECONNECTS_WITHOUT_A_FRAME = 2;

export type UseBrowserFrameStreamOptions = EmbeddedBrowserInteractionClientOverride & {
  browserSessionId: string | null;
  targetId: string | null;
  enabled?: boolean | undefined;
  stream?: BrowserFrameStreamOptions | undefined;
  webSocketFactory?: BrowserFrameWebSocketFactory | undefined;
};

export type UseBrowserFrameStreamResult = {
  state: BrowserFrameConnectionState;
  frame: BrowserFrame | null;
  attachment: Pick<
    BrowserSessionAttachment,
    "browserSessionId" | "controllerGeneration" | "targetId" | "expiresAt"
  > | null;
  error: Error | null;
  reconnect: () => void;
};

/**
 * Reconnecting, latest-only BrowserSession media attachment. Direct placement
 * grants travel as a WebSocket subprotocol; connected-machine grants stay in the
 * relay's first authenticated binary message. Neither transport puts a grant in
 * a URL, event, log, or separately exposed React state.
 */
export function useBrowserFrameStream(
  options: UseBrowserFrameStreamOptions,
): UseBrowserFrameStreamResult {
  const { client, workspaceId } = useEmbeddedBrowserInteraction(options);
  const enabled = options.enabled ?? true;
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<Omit<UseBrowserFrameStreamResult, "reconnect">>({
    state: "idle",
    frame: null,
    attachment: null,
    error: null,
  });
  const latestRef = useRef<{ key: string; sequence: number }>({
    key: "",
    sequence: -1,
  });
  const factoryRef = useRef(options.webSocketFactory);
  const streamRef = useRef(options.stream);
  factoryRef.current = options.webSocketFactory;
  streamRef.current = options.stream;

  const reconnect = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const browserSessionId = options.browserSessionId;
    const targetId = options.targetId;
    if (!enabled || !browserSessionId || !targetId || typeof window === "undefined") {
      setResult({ state: "idle", frame: null, attachment: null, error: null });
      return;
    }

    // Never render or target input against a frame from the previously selected
    // resource while its replacement attachment is negotiating.
    latestRef.current = { key: "", sequence: -1 };
    setResult({
      state: "attaching",
      frame: null,
      attachment: null,
      error: null,
    });

    let disposed = false;
    let socket: BrowserFrameWebSocket | null = null;
    let socketHandlers: {
      open: () => void;
      message: (event: MessageEvent) => void;
      error: () => void;
      close: () => void;
    } | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let controllerGeneration: string | null = null;
    let activeAttachment: BrowserSessionAttachment | null = null;
    let activeStream: BrowserSessionAttachment["stream"] | null = null;
    let attachmentExpiresAt = 0;
    let lastRelaySequence: string | null = null;
    let relayAccepted = false;
    let pendingFrame: { bytes: Uint8Array; source: BrowserFrameWebSocket } | null = null;
    let decodingFrame = false;
    const attachmentAbort = new AbortController();

    const clearSocket = (terminateProducer = false) => {
      if (!socket) return;
      const current = socket;
      const handlers = socketHandlers;
      if (terminateProducer && activeStream?.kind === "relay" && socket.readyState === 1) {
        try {
          socket.send(
            relayDatagram(
              RELAY_TAG_CLOSE,
              encodeStreamClose({
                channelId: activeStream.channel.channelId,
                reason: STREAM_CLOSE_REASON_NORMAL,
                message: "viewer detached",
              }),
            ),
          );
        } catch {
          // OPEN can race a transport close. Local teardown must still finish.
        }
      }
      if (handlers) {
        current.removeEventListener("open", handlers.open);
        current.removeEventListener("message", handlers.message);
        current.removeEventListener("error", handlers.error);
        current.removeEventListener("close", handlers.close);
      }
      if (current.readyState === 0 || current.readyState === 1) {
        current.close(1000, "viewer detached");
      }
      socket = null;
      socketHandlers = null;
      pendingFrame = null;
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      if (failures >= MAX_AUTOMATIC_RECONNECTS_WITHOUT_A_FRAME) return;
      const delay = Math.min(5_000, 250 * 2 ** Math.min(failures, 5));
      failures += 1;
      setResult((current) => ({ ...current, state: "reconnecting" }));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectSocket();
      }, delay);
    };

    const fail = (cause: unknown, reconnectAutomatically = true) => {
      if (disposed) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setResult((current) => ({ ...current, state: "error", error }));
      clearSocket();
      if (reconnectAutomatically) scheduleReconnect();
    };

    const onOpen = (source: BrowserFrameWebSocket) => {
      if (disposed || source !== socket) return;
      if (activeStream?.kind === "relay") {
        const body = encodeStreamOpen({
          channel: {
            ...activeStream.channel,
            kind: STREAM_KIND_BROWSER,
          },
          token: activeStream.token,
          role: STREAM_ROLE_CLIENT,
          resumeFromSeq:
            lastRelaySequence === null ? "0" : (BigInt(lastRelaySequence) + 1n).toString(),
        });
        try {
          source.send(relayDatagram(RELAY_TAG_OPEN, body));
        } catch (error) {
          fail(error);
        }
        return;
      }
      setResult((current) => ({ ...current, state: "live", error: null }));
    };

    const drainLatestFrame = async () => {
      if (decodingFrame) return;
      decodingFrame = true;
      try {
        while (pendingFrame) {
          if (disposed) break;
          const pending = pendingFrame;
          pendingFrame = null;
          const { bytes, source } = pending;
          const frame = decodeBrowserFrameMessage(bytes);
          if (disposed || source !== socket) continue;
          if (frame.browserSessionId !== browserSessionId || frame.targetId !== targetId) {
            throw new Error("browser frame belongs to another resource");
          }
          if (!controllerGeneration || frame.controllerGeneration !== controllerGeneration) {
            throw new Error("browser frame belongs to a stale controller");
          }
          const key = `${browserSessionId}:${targetId}:${frame.controllerGeneration}:${frame.targetGeneration}:${frame.documentGeneration}`;
          if (latestRef.current.key === key && frame.sequence <= latestRef.current.sequence)
            continue;
          latestRef.current = { key, sequence: frame.sequence };
          failures = 0;
          setResult((current) => ({
            ...current,
            state: "live",
            frame,
            error: null,
          }));
        }
      } catch (cause) {
        fail(cause);
      } finally {
        decodingFrame = false;
        if (!disposed && pendingFrame) void drainLatestFrame();
      }
    };

    const onMessage = (source: BrowserFrameWebSocket, event: MessageEvent) => {
      void (async () => {
        try {
          const bytes = await messageBytes(event.data);
          if (disposed || source !== socket) return;
          let frameBytes = bytes;
          if (activeStream?.kind === "relay") {
            if (bytes.length < 1) throw new Error("browser relay returned an empty message");
            const tag = bytes[0];
            const body = bytes.subarray(1);
            if (tag === RELAY_TAG_OPEN_ACK) {
              const ack = decodeStreamOpenAck(body);
              if (!ack.accepted) {
                activeAttachment = null;
                activeStream = null;
                attachmentExpiresAt = 0;
                throw new Error(ack.error?.message ?? "browser stream was rejected by the relay");
              }
              relayAccepted = true;
              return;
            }
            if (tag === RELAY_TAG_CLOSE) {
              activeAttachment = null;
              activeStream = null;
              attachmentExpiresAt = 0;
              lastRelaySequence = null;
              relayAccepted = false;
              fail(new Error("Browser frame source ended."), false);
              return;
            }
            if (tag !== RELAY_TAG_FRAME || !relayAccepted) return;
            const relayFrame = decodeStreamFrame(body);
            lastRelaySequence = relayFrame.seq;
            frameBytes = relayFrame.data;
          }
          pendingFrame = { bytes: frameBytes, source };
          void drainLatestFrame();
        } catch (cause) {
          fail(cause);
        }
      })();
    };

    const onError = (source: BrowserFrameWebSocket) => {
      if (source !== socket) return;
      fail(new Error("Browser view lost connection."));
    };

    const onClose = (source: BrowserFrameWebSocket) => {
      if (disposed || source !== socket) return;
      clearSocket();
      scheduleReconnect();
    };

    const connectSocket = () => {
      if (disposed) return;
      clearSocket();
      if (!activeAttachment || !activeStream || attachmentExpiresAt <= Date.now() + 1_000) {
        void attach();
        return;
      }
      relayAccepted = false;
      setResult((current) => ({
        ...current,
        state: "connecting",
        error: null,
      }));
      const createSocket =
        factoryRef.current ?? ((url: string, protocols: string[]) => new WebSocket(url, protocols));
      const openedSocket = createSocket(
        activeStream.kind === "relay"
          ? activeStream.url
          : browserFrameSocketUrl(activeAttachment, streamRef.current),
        activeStream.kind === "direct_websocket" ? [...activeStream.protocols] : [],
      );
      socket = openedSocket;
      socketHandlers = {
        open: () => onOpen(openedSocket),
        message: (event) => onMessage(openedSocket, event),
        error: () => onError(openedSocket),
        close: () => onClose(openedSocket),
      };
      openedSocket.binaryType = "arraybuffer";
      openedSocket.addEventListener("open", socketHandlers.open);
      openedSocket.addEventListener("message", socketHandlers.message);
      openedSocket.addEventListener("error", socketHandlers.error);
      openedSocket.addEventListener("close", socketHandlers.close);
    };

    const attach = async () => {
      if (disposed) return;
      clearSocket();
      if (expiryTimer) clearTimeout(expiryTimer);
      setResult((current) => ({
        ...current,
        state: current.attachment ? "reconnecting" : "attaching",
        error: null,
      }));
      try {
        const attachment = await client.attachBrowserSession(
          workspaceId,
          browserSessionId,
          {
            targetId,
            expiresInSeconds: 120,
            ...(streamRef.current ? { stream: streamRef.current } : {}),
          },
          { signal: attachmentAbort.signal },
        );
        if (disposed) return;
        if (attachment.browserSessionId !== browserSessionId || attachment.targetId !== targetId) {
          throw new Error("browser attachment does not match the requested resource");
        }
        controllerGeneration = attachment.controllerGeneration;
        activeAttachment = attachment;
        activeStream = attachment.stream;
        attachmentExpiresAt = Date.parse(attachment.expiresAt);
        lastRelaySequence = null;
        relayAccepted = false;
        setResult((current) => ({
          ...current,
          state: "connecting",
          attachment: {
            browserSessionId: attachment.browserSessionId,
            controllerGeneration: attachment.controllerGeneration,
            targetId: attachment.targetId,
            expiresAt: attachment.expiresAt,
          },
          error: null,
        }));
        const refreshIn = Number.isFinite(attachmentExpiresAt)
          ? Math.max(1_000, attachmentExpiresAt - Date.now() - 5_000)
          : 60_000;
        expiryTimer = setTimeout(() => {
          if (disposed) return;
          clearSocket(true);
          activeAttachment = null;
          activeStream = null;
          attachmentExpiresAt = 0;
          void attach();
        }, refreshIn);
        connectSocket();
      } catch (cause) {
        if (attachmentAbort.signal.aborted || disposed) return;
        fail(cause, !isPlacementGenerationLossError(cause));
      }
    };

    void attach();
    return () => {
      disposed = true;
      attachmentAbort.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (expiryTimer) clearTimeout(expiryTimer);
      clearSocket(true);
    };
  }, [client, enabled, nonce, options.browserSessionId, options.targetId, workspaceId]);

  return { ...result, reconnect };
}

function relayDatagram(tag: number, body: Uint8Array): ArrayBuffer {
  const message = new Uint8Array(body.length + 1);
  message[0] = tag;
  message.set(body, 1);
  return message.buffer as ArrayBuffer;
}

async function messageBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new Error("browser frame stream returned a non-binary message");
}

function isPlacementGenerationLossError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /placement instance changed|controller authority changed/i.test(message);
}
