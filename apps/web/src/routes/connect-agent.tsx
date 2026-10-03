import type { McpConnectionRequest } from "@opengeni/sdk";
import { BotIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { apiBaseUrl } from "@/api";
import { ConsentFrame, McpConsentPage } from "@/components/organization-access/mcp-consent-page";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import { userErrorText } from "@/lib/api-error";

/* ----------------------------------------------------------------------------
   /connect-agent: where an agent's sign-in to the organization MCP server
   lands. `authorize` continues an authorization the person started before
   signing in; `request` is the pending sign-in to answer.
   -------------------------------------------------------------------------- */

function apiOrigin(): string {
  return new URL(apiBaseUrl || window.location.origin, window.location.href).origin;
}

export function ConnectAgentRoute({
  request: requestToken,
  authorize,
}: {
  request?: string | undefined;
  authorize?: string | undefined;
}) {
  const { client } = useAppContext();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; request: McpConnectionRequest }
    | { kind: "leaving" }
    | { kind: "error"; title: string; description: string }
  >({ kind: "loading" });

  useEffect(() => {
    // Signed in now: continue the agent's authorization on the server. Only
    // this exact endpoint is followed, never an arbitrary address.
    if (authorize) {
      if (authorize.startsWith("/oauth/authorize?")) {
        window.location.replace(new URL(authorize, apiOrigin()).toString());
        setState({ kind: "leaving" });
      } else {
        setState({ kind: "error", ...UNKNOWN });
      }
      return;
    }
    if (!requestToken) {
      setState({ kind: "error", ...UNKNOWN });
      return;
    }
    let live = true;
    client
      .getMcpConnectionRequest(requestToken)
      .then((request) => {
        if (live) setState({ kind: "ready", request });
      })
      .catch((caught: unknown) => {
        if (!live) return;
        const status = (caught as { status?: number }).status;
        setState({
          kind: "error",
          ...(status === 410 || status === 403
            ? EXPIRED
            : {
                title: "Couldn't load this sign-in",
                description: userErrorText(caught, "Start it again from your agent."),
              }),
        });
      });
    return () => {
      live = false;
    };
  }, [authorize, client, requestToken]);

  if (state.kind === "ready") {
    return (
      <McpConsentPage
        request={state.request}
        onAnswer={async (decision) => {
          const { redirectTo } = await client.answerMcpConnectionRequest(requestToken!, decision);
          setState({ kind: "leaving" });
          window.location.assign(redirectTo);
        }}
      />
    );
  }
  if (state.kind === "error") {
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={<BotIcon />}
          title={state.title}
          description={state.description}
        />
      </ConsentFrame>
    );
  }
  return (
    <ConsentFrame>
      <div className="flex min-w-0 flex-col gap-4" aria-busy="true">
        <Skeleton className="h-7 w-72 rounded-md" />
        <Skeleton className="h-5 w-96 max-w-full rounded-md" />
        <Skeleton className="h-40 w-full rounded-[14px]" />
      </div>
    </ConsentFrame>
  );
}

const EXPIRED = {
  title: "This sign-in expired",
  description: "Sign-ins last 10 minutes and can be answered once. Start it again from your agent.",
};

const UNKNOWN = {
  title: "Nothing to connect here",
  description: "Open this page from your agent's sign-in, for example /mcp in Claude Code.",
};
