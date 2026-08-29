import { PublishedHtmlArtifactFrame } from "@opengeni/react/artifacts";
import {
  SITE_RUNTIME_PROTOCOL_VERSION,
  injectSiteRuntimeBootstrap,
  isSiteRuntimeRequest,
  type SiteRuntimeRequest,
  type SiteRuntimeResponse,
} from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useRef } from "react";

export function SiteRuntimeFrame(props: {
  html: string;
  title: string;
  className?: string;
  onRequest: (
    request: SiteRuntimeRequest,
    emit: (value: SiteRuntimeResponse) => void,
  ) => Promise<unknown>;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const channelRef = useRef<MessageChannel | null>(null);
  const onRequestRef = useRef(props.onRequest);
  onRequestRef.current = props.onRequest;
  const runtimeHtml = useMemo(() => injectSiteRuntimeBootstrap(props.html), [props.html]);

  const disconnect = useCallback(() => {
    channelRef.current?.port1.close();
    channelRef.current?.port2.close();
    channelRef.current = null;
  }, []);

  useEffect(() => disconnect, [disconnect]);

  const connect = useCallback(() => {
    disconnect();
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    const channel = new MessageChannel();
    channelRef.current = channel;
    const emit = (value: SiteRuntimeResponse) => {
      if (channelRef.current === channel) channel.port1.postMessage(value);
    };
    channel.port1.onmessage = (event: MessageEvent<SiteRuntimeRequest>) => {
      const request = event.data;
      if (!isSiteRuntimeRequest(request)) return;
      void onRequestRef
        .current(request, emit)
        .then((result) => emit({ id: request.id, ok: true, result }))
        .catch((error: unknown) =>
          emit({
            id: request.id,
            ok: false,
            error: {
              code: "site_runtime_request_failed",
              message: error instanceof Error ? error.message : "Site runtime request failed",
            },
          }),
        );
    };
    channel.port1.start();
    target.postMessage(
      { type: "opengeni.site.connect", version: SITE_RUNTIME_PROTOCOL_VERSION },
      "*",
      [channel.port2],
    );
  }, [disconnect]);

  return (
    <PublishedHtmlArtifactFrame
      iframeRef={iframeRef}
      onLoad={connect}
      title={props.title}
      html={runtimeHtml}
      className={props.className}
      sandbox="allow-scripts"
    />
  );
}
