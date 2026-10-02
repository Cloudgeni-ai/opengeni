import type { AllowanceExhaustedRefusal } from "@opengeni/sdk";
import { GaugeIcon } from "lucide-react";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { cn } from "../lib/cn";
import {
  allowanceLabels,
  allowanceResetSentence,
  formatAllowanceInstant,
  type AllowanceLabels,
} from "../usage/allowance-copy";
import { useEntranceAnimation } from "./entrance";

/**
 * Replace the built-in "usage limit reached" row. Return `undefined` to keep
 * the default for this refusal (for example, only customize member limits).
 */
export type RenderAllowanceExhausted = (
  refusal: AllowanceExhaustedRefusal,
  context: { labels: AllowanceLabels; defaultRow: ReactNode },
) => ReactNode | undefined;

type AllowancePresentation = {
  render: RenderAllowanceExhausted | undefined;
  labels: AllowanceLabels;
};

const AllowancePresentationContext = createContext<AllowancePresentation>({
  render: undefined,
  labels: allowanceLabels(),
});

export function AllowancePresentationProvider({
  render,
  labels,
  children,
}: {
  render: RenderAllowanceExhausted | undefined;
  labels: Partial<AllowanceLabels> | undefined;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ render, labels: allowanceLabels(labels) }), [render, labels]);
  return (
    <AllowancePresentationContext.Provider value={value}>
      {children}
    </AllowancePresentationContext.Provider>
  );
}

/**
 * A usage ceiling stopped further work. Calm by design: nothing failed, the
 * conversation is kept, and the row says who can raise the limit and when it
 * resets. Never the server's prose or a member identifier.
 */
export function AllowanceExhaustedRow({ refusal }: { refusal: AllowanceExhaustedRefusal }) {
  const { render, labels } = useContext(AllowancePresentationContext);
  const enter = useEntranceAnimation();
  const workspace = refusal.scope === "workspace";
  const defaultRow = (
    <div
      className={cn(
        enter && "animate-og-enter",
        "flex items-start gap-2.5 rounded-og-md border border-og-status-waiting/35 bg-og-status-waiting/8 px-3.5 py-2.5 text-og-menu text-og-fg",
      )}
      role="status"
      data-og-allowance-exhausted={refusal.scope}
    >
      <GaugeIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-og-status-waiting" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {workspace ? labels.workspaceLimitReachedTitle : labels.memberLimitReachedTitle}
        </p>
        <p className="mt-0.5 text-og-fg-muted">
          {workspace ? labels.workspaceRemedy : labels.memberRemedy}{" "}
          <span
            title={refusal.resetsAt ? formatAllowanceInstant(refusal.resetsAt) : undefined}
            className="whitespace-nowrap"
          >
            {allowanceResetSentence(labels, refusal.resetsAt)}
          </span>
        </p>
      </div>
    </div>
  );
  return <>{render?.(refusal, { labels, defaultRow }) ?? defaultRow}</>;
}
