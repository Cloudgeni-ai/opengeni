import type { LearningRefusal } from "@opengeni/sdk/learning-refusal";
import { BrainCircuitIcon } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { useOpenGeniText } from "../messages/runtime";
import { useEntranceAnimation } from "./entrance";
import {
  learningRefusalBody,
  learningRefusalPlace,
  learningRefusalPlaceLabel,
  learningRefusalTitle,
  type LearningRefusalPlace,
} from "./learning-refusal-copy";

export type LearningRefusalActions = {
  /** Opens the place where the person can make the change themselves. */
  onOpen?: ((place: LearningRefusalPlace) => void) | undefined;
};

const LearningRefusalActionsContext = createContext<LearningRefusalActions>({});

export function LearningRefusalActionsProvider({
  children,
  ...actions
}: LearningRefusalActions & { children: ReactNode }) {
  return (
    <LearningRefusalActionsContext.Provider value={actions}>
      {children}
    </LearningRefusalActionsContext.Provider>
  );
}

/**
 * A change the agent tried to save to Skills, workspace instructions, or
 * Knowledge was refused. It stays outside the folded work row so the person
 * learns their request was not kept, says why in plain words, and links to
 * where they can still make it. Calm by design: nothing broke.
 */
export function LearningRefusalRow({ refusal }: { refusal: LearningRefusal }) {
  const t = useOpenGeniText();
  const enter = useEntranceAnimation();
  const { onOpen } = useContext(LearningRefusalActionsContext);
  const place = learningRefusalPlace(refusal);
  return (
    <div
      className={cn(
        enter && "animate-og-enter",
        "flex items-start gap-2.5 rounded-og-md border border-og-status-waiting/35 bg-og-status-waiting/8 px-3.5 py-2.5 text-og-menu text-og-fg",
      )}
      role="status"
      data-og-learning-refusal={refusal.reason}
    >
      <BrainCircuitIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-og-status-waiting" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{learningRefusalTitle(t, refusal)}</p>
        <p className="mt-0.5 text-og-fg-muted">{learningRefusalBody(t, refusal)}</p>
        {place && onOpen ? (
          <button
            type="button"
            className="mt-1.5 -ml-1 rounded-og-sm px-1 py-0.5 font-medium text-og-fg underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-og-accent"
            onClick={() => onOpen(place)}
          >
            {learningRefusalPlaceLabel(t, place)}
          </button>
        ) : null}
      </div>
    </div>
  );
}
