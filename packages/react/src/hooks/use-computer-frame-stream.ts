import {
  computerFrameSocketUrl,
  decodeComputerFrameMessage,
  type ComputerFrame,
  type ComputerFrameStreamOptions,
  type ComputerSessionAttachment,
} from "@opengeni/sdk/interaction";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeStreamFrame,
  decodeStreamOpenAck,
  encodeStreamClose,
  encodeStreamOpen,
  STREAM_CLOSE_REASON_NORMAL,
  STREAM_KIND_COMPUTER,
  STREAM_ROLE_CLIENT,
} from "../lib/relay-wire";
import {
  type EmbeddedComputerInteractionClientOverride,
  useEmbeddedComputerInteraction,
} from "../session-context";

export type ComputerFrameConnectionState =
  | "idle"
  | "attaching"
  | "connecting"
  | "live"
  | "reconnecting"
  | "error";

export type ComputerFrameWebSocket = Pick<
  WebSocket,
  "binaryType" | "readyState" | "close" | "addEventListener" | "removeEventListener"
> & { send(data: ArrayBuffer): void };

export type ComputerFrameWebSocketFactory = (
  url: string,
  protocols: string[],
) => ComputerFrameWebSocket;

const RELAY_TAG_OPEN = 1;
const RELAY_TAG_OPEN_ACK = 2;
const RELAY_TAG_FRAME = 3;
const RELAY_TAG_CLOSE = 4;

export type UseComputerFrameStreamOptions = EmbeddedComputerInteractionClientOverride & {
  computerSessionId: string | null;
  targetId: string | null;
  enabled?: boolean | undefined;
  stream?: ComputerFrameStreamOptions | undefined;
  webSocketFactory?: ComputerFrameWebSocketFactory | undefined;
};

export type UseComputerFrameStreamResult = {
  state: ComputerFrameConnectionState;
  frame: ComputerFrame | null;
  attachment: Pick<
    ComputerSessionAttachment,
    "computerSessionId" | "controllerGeneration" | "targetId" | "stream" | "expiresAt"
  > | null;
  error: Error | null;
  reconnect: () => void;
};

/** Reconnecting, latest-only ComputerSession media attachment. Grants remain in
 * WebSocket subprotocols or the relay's authenticated first binary message. */
export function useComputerFrameStream(
  options: UseComputerFrameStreamOptions,
): UseComputerFrameStreamResult {
  const { client, workspaceId } = useEmbeddedComputerInteraction(options);
  const enabled = options.enabled ?? true;
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<Omit<UseComputerFrameStreamResult, "reconnect">>({
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
    const computerSessionId = options.computerSessionId;
    const targetId = options.targetId;
    if (!enabled || !computerSessionId || !targetId || typeof window === "undefined") {
      setResult({ state: "idle", frame: null, attachment: null, error: null });
      return;
    }

    latestRef.current = { key: "", sequence: -1 };
    setResult({
      state: "attaching",
      frame: null,
      attachment: null,
      error: null,
    });

    let disposed = false;
    let socket: ComputerFrameWebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    let controllerGeneration: string | null = null;
    let activeAttachment: ComputerSessionAttachment | null = null;
    let activeStream: ComputerSessionAttachment["stream"] | null = null;
    let attachmentExpiresAt = 0;
    let lastRelaySequence: string | null = null;
    let relayAccepted = false;
    const attachmentAbort = new AbortController();

    const clearSocket = (terminateProducer = false) => {
      if (!socket) return;
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
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      if (socket.readyState === 0 || socket.readyState === 1) {
        socket.close(1000, "viewer detached");
      }
      socket = null;
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      const delay = Math.min(5_000, 250 * 2 ** Math.min(failures, 5));
      failures += 1;
      setResult((current) => ({ ...current, state: "reconnecting" }));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectSocket();
      }, delay);
    };

    const fail = (cause: unknown) => {
      if (disposed) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      setResult((current) => ({ ...current, state: "error", error }));
      clearSocket();
      scheduleReconnect();
    };

    const onOpen = () => {
      if (disposed) return;
      failures = 0;
      if (activeStream?.kind === "relay") {
        const body = encodeStreamOpen({
          channel: { ...activeStream.channel, kind: STREAM_KIND_COMPUTER },
          token: activeStream.token,
          role: STREAM_ROLE_CLIENT,
          resumeFromSeq:
            lastRelaySequence === null ? "0" : (BigInt(lastRelaySequence) + 1n).toString(),
        });
        try {
          socket?.send(relayDatagram(RELAY_TAG_OPEN, body));
        } catch (error) {
          fail(error);
        }
        return;
      }
      setResult((current) => ({ ...current, state: "live", error: null }));
    };

    const onMessage = (event: MessageEvent) => {
      void (async () => {
        try {
          const bytes = await messageBytes(event.data);
          if (disposed) return;
          let frameBytes = bytes;
          if (activeStream?.kind === "relay") {
            if (bytes.length < 1) throw new Error("computer relay returned an empty message");
            const tag = bytes[0];
            const body = bytes.subarray(1);
            if (tag === RELAY_TAG_OPEN_ACK) {
              const ack = decodeStreamOpenAck(body);
              if (!ack.accepted) {
                activeAttachment = null;
                activeStream = null;
                attachmentExpiresAt = 0;
                throw new Error(ack.error?.message ?? "computer stream was rejected by the relay");
              }
              relayAccepted = true;
              return;
            }
            if (tag === RELAY_TAG_CLOSE) {
              // A relay close is terminal for this producer/channel. Reusing
              // the same attachment only reconnects to a dead channel forever;
              // invalidate it so the retry mints a fresh producer.
              activeAttachment = null;
              activeStream = null;
              attachmentExpiresAt = 0;
              lastRelaySequence = null;
              relayAccepted = false;
              throw new Error("Computer frame source ended.");
            }
            if (tag !== RELAY_TAG_FRAME || !relayAccepted) return;
            const relayFrame = decodeStreamFrame(body);
            lastRelaySequence = relayFrame.seq;
            frameBytes = relayFrame.data;
          }
          const frame = await decodeComputerFrameMessage(frameBytes);
          if (disposed) return;
          if (frame.computerSessionId !== computerSessionId || frame.targetId !== targetId) {
            throw new Error("computer frame belongs to another resource");
          }
          if (!controllerGeneration || frame.controllerGeneration !== controllerGeneration) {
            throw new Error("computer frame belongs to a stale controller");
          }
          const key = `${computerSessionId}:${targetId}:${frame.controllerGeneration}:${frame.targetGeneration}`;
          if (latestRef.current.key === key && frame.sequence <= latestRef.current.sequence) return;
          latestRef.current = { key, sequence: frame.sequence };
          setResult((current) => ({
            ...current,
            state: "live",
            frame,
            error: null,
          }));
        } catch (cause) {
          fail(cause);
        }
      })();
    };

    const onError = () => fail(new Error("Computer view lost connection."));

    const onClose = () => {
      if (disposed) return;
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
      if (activeStream.kind === "direct_rfb") {
        setResult((current) => ({ ...current, state: "live", error: null }));
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
      socket = createSocket(
        activeStream.kind === "relay"
          ? activeStream.url
          : computerFrameSocketUrl(activeAttachment, streamRef.current),
        activeStream.kind === "direct_websocket" ? [...activeStream.protocols] : [],
      );
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
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
        const attachment = await client.attachComputerSession(
          workspaceId,
          computerSessionId,
          {
            targetId,
            expiresInSeconds: 120,
            ...(streamRef.current ? { stream: streamRef.current } : {}),
          },
          { signal: attachmentAbort.signal },
        );
        if (disposed) return;
        if (
          attachment.computerSessionId !== computerSessionId ||
          attachment.targetId !== targetId
        ) {
          throw new Error("computer attachment does not match the requested resource");
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
            computerSessionId: attachment.computerSessionId,
            controllerGeneration: attachment.controllerGeneration,
            targetId: attachment.targetId,
            stream: attachment.stream,
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
        fail(cause);
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
  }, [client, enabled, nonce, options.computerSessionId, options.targetId, workspaceId]);

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
  throw new Error("computer frame stream returned a non-binary message");
}
