import { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { OpenGeniProvider } from "../provider";

export type SessionProxyBaseUrl = {
  /**
   * Mount path of your `createSessionProxyHandler` (for example
   * `"/api/opengeni"`). The component then needs no `OpenGeniProvider`,
   * client, or workspace id: it creates the browser client for that path and
   * uses the workspace the proxy resolved for the signed-in user. An explicit
   * `workspaceId` skips that lookup.
   */
  baseUrl?: string | undefined;
};

type ScopeState =
  | { status: "loading" }
  | { status: "ready"; workspaceId: string }
  | { status: "error"; message: string };

/**
 * `OpenGeniProvider` for a same-origin session proxy, from its base URL alone.
 * The proxy's client config names the resolved workspace, so the browser
 * never handles an Opengeni id. Provider-based usage is unchanged.
 */
export function SessionProxyScope({
  baseUrl,
  workspaceId,
  children,
}: {
  baseUrl: string;
  workspaceId?: string | undefined;
  children: ReactNode;
}) {
  // Version skew between this bundle and the server SDK is tolerated, as for
  // any embedded host: the proxy reports its own contract revision.
  const client = useMemo(
    () => new OpenGeniBrowserClient({ baseUrl, apiContract: "compatible" }),
    [baseUrl],
  );
  const [state, setState] = useState<ScopeState>(
    workspaceId ? { status: "ready", workspaceId } : { status: "loading" },
  );
  useEffect(() => {
    if (workspaceId) {
      setState({ status: "ready", workspaceId });
      return;
    }
    let active = true;
    setState({ status: "loading" });
    client.getClientConfig().then(
      (config) => {
        if (!active) return;
        setState(
          config.workspaceId
            ? { status: "ready", workspaceId: config.workspaceId }
            : {
                status: "error",
                message:
                  "This server does not report its workspace. Update @opengeni/sdk on the server, or pass workspaceId.",
              },
        );
      },
      (error: unknown) => {
        if (!active) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Could not load the conversation.",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [client, workspaceId]);

  if (state.status === "error") {
    return (
      <div role="alert" className="og-root p-3 text-og-sm text-og-danger" data-og-proxy-error="">
        {state.message}
      </div>
    );
  }
  if (state.status === "loading") {
    return <div className="og-root" aria-busy="true" data-og-proxy-loading="" />;
  }
  return (
    <OpenGeniProvider client={client} workspaceId={state.workspaceId}>
      {children}
    </OpenGeniProvider>
  );
}
