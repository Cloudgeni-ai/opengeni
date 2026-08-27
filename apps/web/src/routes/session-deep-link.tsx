import { useEffect, useMemo, useState } from "react";

import { LoadingPanel, ProblemPanel } from "@/components/common";
import { useAppContext } from "@/context";
import {
  useOptionalBrowserAccountBridge,
  type BrowserAccountSafeSlot,
} from "@/lib/browser-account-bridge";
import {
  authorizedSessionReadWorkspaceIds,
  canonicalSessionDeepLinkTarget,
  resolveAuthorizedSessionWorkspace,
  shouldRedirectSessionDeepLink,
} from "@/lib/session-deep-link";

export function SessionDeepLinkRoute({ sessionId }: { sessionId: string }) {
  const context = useAppContext();
  const browserAccounts = useOptionalBrowserAccountBridge();
  const resolveCrossSlot = browserAccounts?.resolveDeepLink;
  const selectCrossSlot = browserAccounts?.selectSlot;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "not-found" }
    | { kind: "error" }
    | { kind: "switch"; slot: BrowserAccountSafeSlot }
  >({ kind: "loading" });
  const authorizedWorkspaceIds = useMemo(
    () => authorizedSessionReadWorkspaceIds(context.accessContext, context.workspaces),
    [context.accessContext, context.workspaces],
  );

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });

    void resolveAuthorizedSessionWorkspace(
      context.client,
      context.accessContext.workspaceGrants,
      sessionId,
      { authorizedWorkspaceIds },
    ).then(async (resolution) => {
      if (cancelled) {
        return;
      }
      if (resolution.status === "resolved") {
        const targetPath = canonicalSessionDeepLinkTarget(
          resolution.workspaceId,
          sessionId,
          window.location,
        );
        const targetPathname = targetPath.split(/[?#]/, 1)[0] ?? targetPath;
        if (shouldRedirectSessionDeepLink(window.location.pathname, targetPathname)) {
          // A full-document replace keeps the compatibility URL out of the
          // back stack and preserves the original query/hash for the canonical
          // session view. The canonical route never renders this component,
          // so a successful redirect cannot loop.
          window.location.replace(targetPath);
          return;
        }
      }
      if (resolution.status === "not-found" && resolveCrossSlot) {
        try {
          const crossSlot = await resolveCrossSlot(window.location.pathname);
          if (cancelled) return;
          if (crossSlot.kind === "switch_required") {
            setState({ kind: "switch", slot: crossSlot.slot });
            return;
          }
        } catch {
          if (cancelled) return;
          setState({ kind: "error" });
          return;
        }
      }
      setState({ kind: resolution.status === "error" ? "error" : "not-found" });
    });

    return () => {
      cancelled = true;
    };
  }, [
    attempt,
    context.accessContext.workspaceGrants,
    context.client,
    authorizedWorkspaceIds,
    resolveCrossSlot,
    sessionId,
  ]);

  if (state.kind === "loading") {
    return <LoadingPanel label="Opening session" />;
  }
  if (state.kind === "error") {
    return (
      <ProblemPanel
        title="Session unavailable"
        description="We couldn't verify this session right now. Try again in a moment."
        action={
          <button
            type="button"
            className="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm font-medium hover:bg-surface-3"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        }
      />
    );
  }
  if (state.kind === "switch") {
    return (
      <ProblemPanel
        title="Open with another account"
        description={`This session is available to ${state.slot.displayName} (${state.slot.verifiedClaim.value}). No workspace details are shown until you switch.`}
        action={
          <button
            type="button"
            className="min-h-11 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm font-medium hover:bg-surface-3 forced-colors:border-[CanvasText]"
            onClick={() => {
              setState({ kind: "loading" });
              const slot = state.slot;
              void selectCrossSlot?.(slot.id)
                .then((settled) => {
                  if (!settled) setState({ kind: "switch", slot });
                })
                .catch(() => setState({ kind: "error" }));
            }}
          >
            Open as {state.slot.displayName}
          </button>
        }
      />
    );
  }
  return (
    <ProblemPanel
      title="Session not found"
      description="This session doesn't exist or you don't have access to it."
    />
  );
}
