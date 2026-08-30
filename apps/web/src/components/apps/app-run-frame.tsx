import {
  createOgAppHostBridge,
  isOgJsonValue,
  OG_APP_BRIDGE_PROTOCOL,
  type OgAppHostBridge,
} from "@opengeni/app-sdk";
import type {
  AppRuntimeCatalogResponse,
  CreateAppLaunchResponse,
  OpenGeniAppsClient,
  WorkspaceApp,
} from "@opengeni/sdk/apps";
import { RefreshCwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { MetaChip } from "@/components/ui/meta-chip";

export const APP_RUN_BROKER_IFRAME_SANDBOX = "allow-scripts allow-same-origin";
export const APP_RUN_INNER_IFRAME_SANDBOX = "allow-scripts allow-same-origin";
export const APP_RUN_IFRAME_ALLOW =
  "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'";

function htmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function scriptJson(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function appRunBrokerDocument(
  launchUrl: string,
  appOrigin: string,
  productOrigin: string,
  appTitle: string,
): string | null {
  const safeUrl = safeAppLaunchUrl(launchUrl, appOrigin, productOrigin);
  if (!safeUrl) return null;
  const declaredAppOrigin = new URL(appOrigin).origin;
  const declaredProductOrigin = new URL(productOrigin).origin;
  const html = `<!doctype html>
<meta charset="utf-8">
<title>${htmlAttribute(appTitle)}</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${htmlAttribute(declaredAppOrigin)}; base-uri 'none'; form-action 'none'">
<style>html,body,iframe{border:0;height:100%;margin:0;padding:0;width:100%}</style>
<iframe id="app" title="${htmlAttribute(appTitle)} content" src="${htmlAttribute(safeUrl)}" sandbox="${APP_RUN_INNER_IFRAME_SANDBOX}" allow="${htmlAttribute(APP_RUN_IFRAME_ALLOW)}" referrerpolicy="no-referrer" credentialless></iframe>
<script>
const protocol=${scriptJson(OG_APP_BRIDGE_PROTOCOL)};
const expectedParentOrigin=${scriptJson(declaredProductOrigin)};
const expectedAppOrigin=${scriptJson(declaredAppOrigin)};
const frame=document.getElementById("app");
let connected=false;
let loaded=false;
let appReady=false;
let pending=null;
function deliver(){
  if(!loaded||!appReady||!pending||!frame.contentWindow)return;
  const next=pending;
  pending=null;
  frame.contentWindow.postMessage(next.message,expectedAppOrigin,[next.port]);
}
frame.addEventListener("load",()=>{loaded=true;deliver()},{once:true});
window.addEventListener("message",event=>{
  const message=event.data;
  if(event.source===frame.contentWindow&&event.origin===expectedAppOrigin&&message&&message.protocol===protocol&&message.kind==="app_ready"){
    appReady=true;
    deliver();
    return;
  }
  if(connected||event.source!==parent||event.origin!==expectedParentOrigin||!message||message.protocol!==protocol||message.kind!=="connect"||event.ports.length!==1)return;
  connected=true;
  pending={message,port:event.ports[0]};
  deliver();
});
</script>`;
  return html;
}

export function safeAppLaunchUrl(
  launchUrl: string,
  appOrigin: string,
  productOrigin: string,
): string | null {
  try {
    const url = new URL(launchUrl);
    const declaredOrigin = new URL(appOrigin).origin;
    const currentOrigin = new URL(productOrigin).origin;
    if (url.username || url.password || url.origin !== declaredOrigin) return null;
    if (url.origin === currentOrigin) return null;
    if (url.protocol === "https:") return url.href;
    if (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
      ["localhost", "127.0.0.1"].includes(new URL(productOrigin).hostname)
    ) {
      return url.href;
    }
    return null;
  } catch {
    return null;
  }
}

export function AppRunFrame({
  workspaceId,
  app,
  catalog,
  launch,
  client,
  productOrigin,
  onStop,
}: {
  workspaceId: string;
  app: WorkspaceApp;
  catalog: AppRuntimeCatalogResponse;
  launch: CreateAppLaunchResponse;
  client: Pick<OpenGeniAppsClient, "callRuntimeTool">;
  productOrigin: string;
  onStop: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<OgAppHostBridge | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [bridgeState, setBridgeState] = useState<"connecting" | "ready" | "error">("connecting");
  const safeUrl = useMemo(
    () => safeAppLaunchUrl(launch.launchUrl, launch.appOrigin, productOrigin),
    [launch.appOrigin, launch.launchUrl, productOrigin],
  );
  const brokerDocument = useMemo(
    () => appRunBrokerDocument(launch.launchUrl, launch.appOrigin, productOrigin, app.title),
    [app.title, launch.appOrigin, launch.launchUrl, productOrigin],
  );
  const toolByCapability = useMemo(
    () => new Map(catalog.tools.map((tool) => [tool.programmaticPath.join("."), tool] as const)),
    [catalog.tools],
  );
  const allowedCapabilities = useMemo(() => [...toolByCapability.keys()], [toolByCapability]);
  const runtimeIdentityMatches =
    app.id === catalog.appId &&
    app.id === launch.appId &&
    catalog.releaseId === launch.releaseId &&
    toolByCapability.size === catalog.tools.length;

  const connect = useCallback(() => {
    bridgeRef.current?.close();
    bridgeRef.current = null;
    const targetWindow = iframeRef.current?.contentWindow;
    if (!targetWindow || !brokerDocument || !runtimeIdentityMatches) return;
    setBridgeState("connecting");
    try {
      const bridge = createOgAppHostBridge({
        targetWindow,
        token: launch.nonce,
        delivery: { kind: "exact_origin", origin: new URL(productOrigin).origin },
        context: {
          workspaceId,
          appId: app.id,
          launchId: launch.launchId,
          releaseId: launch.releaseId,
          catalogDigest: catalog.catalogDigest,
          authorityGeneration: launch.authorityGeneration,
          appVersion: String(app.version),
          grantedCapabilities: allowedCapabilities,
        },
        grantedCapabilities: allowedCapabilities,
        invoke: async (invocation) => {
          if (invocation.operation !== "call") {
            throw new Error("Unsupported Apps bridge operation.");
          }
          const tool = toolByCapability.get(invocation.capability);
          if (!tool) throw new Error("Unknown Apps capability.");
          const input = invocation.input ?? {};
          if (
            typeof input !== "object" ||
            input === null ||
            Array.isArray(input) ||
            !isOgJsonValue(input)
          ) {
            throw new Error("App tool input must be a JSON object.");
          }
          const response = await client.callRuntimeTool(
            workspaceId,
            app.id,
            launch.releaseId,
            launch.launchId,
            launch.authorityGeneration,
            launch.nonce,
            {
              operationId: invocation.operationId ?? crypto.randomUUID(),
              identity: tool.identity,
              input,
              catalogDigest: catalog.catalogDigest,
            },
          );
          if (response.status !== "succeeded" || response.error) {
            throw new Error("The app tool call failed.");
          }
          if (!isOgJsonValue(response.output)) {
            throw new Error("The app tool returned a non-JSON result.");
          }
          return response.output;
        },
      });
      bridgeRef.current = bridge;
      void bridge.ready.then(
        () => setBridgeState("ready"),
        () => setBridgeState("error"),
      );
    } catch {
      setBridgeState("error");
    }
  }, [
    allowedCapabilities,
    app.id,
    app.version,
    catalog.catalogDigest,
    client,
    launch,
    runtimeIdentityMatches,
    brokerDocument,
    productOrigin,
    toolByCapability,
    workspaceId,
  ]);

  useEffect(
    () => () => {
      bridgeRef.current?.close();
    },
    [],
  );

  if (!runtimeIdentityMatches) {
    return (
      <div role="alert" className="rounded-lg border border-status-failed/40 p-4 text-sm text-fg">
        OpenGeni refused the app launch because its identity or capability projection did not match
        the confirmed runtime catalog.
      </div>
    );
  }

  if (!safeUrl || !brokerDocument) {
    return (
      <div role="alert" className="rounded-lg border border-status-failed/40 p-4 text-sm text-fg">
        OpenGeni refused the app launch URL because it was not HTTPS, same-origin HTTP, or did not
        match the declared app origin.
      </div>
    );
  }

  return (
    <section
      aria-label={`${app.title} app run`}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface"
    >
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{app.title}</div>
        <span aria-live="polite" className="shrink-0">
          {bridgeState === "error" ? (
            <MetaChip dot="failed">Bridge unavailable</MetaChip>
          ) : (
            <span className="text-2xs text-fg-subtle">
              {bridgeState === "ready" ? "Connected" : "Connecting…"}
            </span>
          )}
        </span>
        <Button
          type="button"
          size={bridgeState === "error" ? "sm" : "icon-sm"}
          variant="ghost"
          aria-label={bridgeState === "error" ? "Reconnect app" : "Reload app"}
          onClick={() => {
            bridgeRef.current?.close();
            setReloadKey((value) => value + 1);
          }}
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
        >
          <RefreshCwIcon aria-hidden="true" className="size-4" />
          {bridgeState === "error" ? "Reconnect" : null}
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Close app"
          onClick={onStop}
          className="pointer-coarse:size-11"
        >
          <XIcon aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <iframe
        key={reloadKey}
        ref={iframeRef}
        srcDoc={brokerDocument}
        title={`${app.title} application`}
        sandbox={APP_RUN_BROKER_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        className="min-h-0 flex-1 border-0 bg-white"
        onLoad={() => {
          connect();
        }}
      />
    </section>
  );
}
