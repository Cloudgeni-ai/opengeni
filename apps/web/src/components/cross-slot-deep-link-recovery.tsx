import { useOptionalBrowserAccounts } from "@opengeni/react/accounts";
import type { ManagedAuthSessionSetProjection } from "@opengeni/sdk/accounts";
import { useEffect, useState, type ReactNode } from "react";

import { LoadingPanel, ProblemPanel } from "@/components/common";
import { Button } from "@/components/ui/button";

type Slot = ManagedAuthSessionSetProjection["slots"][number];

export function CrossSlotDeepLinkRecovery(props: { path: string; fallback: ReactNode }) {
  const accounts = useOptionalBrowserAccounts();
  const resolveDeepLink = accounts?.resolveDeepLink;
  const selectSlot = accounts?.selectSlot;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "fallback" } | { kind: "error" } | { kind: "switch"; slot: Slot }
  >(() => (resolveDeepLink ? { kind: "loading" } : { kind: "fallback" }));

  useEffect(() => {
    if (!resolveDeepLink) {
      setState({ kind: "fallback" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    void resolveDeepLink(props.path)
      .then((resolution) => {
        if (cancelled) return;
        setState(
          resolution.kind === "switch_required"
            ? { kind: "switch", slot: resolution.slot }
            : { kind: "fallback" },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, props.path, resolveDeepLink]);

  if (state.kind === "loading") return <LoadingPanel label="Checking browser accounts" />;
  if (state.kind === "fallback") return props.fallback;
  if (state.kind === "error") {
    return (
      <ProblemPanel
        title="Destination unavailable"
        description="OpenGeni couldn't safely verify this link across your browser accounts. No workspace details were disclosed."
        action={
          <Button
            type="button"
            variant="secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <ProblemPanel
      title="Open with another account"
      description={`This destination is available to ${state.slot.displayName} (${state.slot.verifiedClaim.value}). No organization or workspace details are shown before you switch.`}
      action={
        <Button
          type="button"
          className="min-h-11"
          onClick={() => {
            const slot = state.slot;
            setState({ kind: "loading" });
            void selectSlot?.(slot.id)
              .then((settled) => {
                if (!settled) setState({ kind: "switch", slot });
              })
              .catch(() => setState({ kind: "error" }));
          }}
        >
          Open as {state.slot.displayName}
        </Button>
      }
    />
  );
}
