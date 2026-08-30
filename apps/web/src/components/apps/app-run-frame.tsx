import { createOgAppHostBridge, isOgJsonValue, type OgAppHostBridge } from "@opengeni/app-sdk";
import type {
  AppRuntimeCatalogResponse,
  CreateAppLaunchResponse,
  OpenGeniAppsClient,
  WorkspaceApp,
} from "@opengeni/sdk/apps";
import { RefreshCwIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

export const APP_RUN_IFRAME_SANDBOX = "allow-scripts";
export const APP_RUN_IFRAME_ALLOW =
  "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'";

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
    if (!targetWindow || !safeUrl || !runtimeIdentityMatches) return;
    setBridgeState("connecting");
    try {
      const bridge = createOgAppHostBridge({
        targetWindow,
        token: launch.nonce,
        delivery: { kind: "opaque_sandbox" },
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
    safeUrl,
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

  if (!safeUrl) {
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
      className="flex min-h-[32rem] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface"
    >
      <div className="flex min-h-11 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{app.title}</div>
        <span aria-live="polite" className="text-2xs text-fg-subtle">
          {bridgeState === "ready"
            ? "Connected"
            : bridgeState === "error"
              ? "Bridge unavailable"
              : "Connecting…"}
        </span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Reload app"
          onClick={() => {
            bridgeRef.current?.close();
            setReloadKey((value) => value + 1);
          }}
        >
          <RefreshCwIcon className="size-4" />
        </Button>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Stop app" onClick={onStop}>
          <SquareIcon className="size-3.5" />
        </Button>
      </div>
      <iframe
        key={reloadKey}
        ref={iframeRef}
        src={safeUrl}
        title={`${app.title} application`}
        sandbox={APP_RUN_IFRAME_SANDBOX}
        allow={APP_RUN_IFRAME_ALLOW}
        referrerPolicy="no-referrer"
        className="min-h-0 flex-1 border-0 bg-white"
        onLoad={() => {
          connect();
          iframeRef.current?.focus();
        }}
      />
    </section>
  );
}
