import { Blocks, Loader2Icon, SparklesIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { Field, TextInput } from "@/components/ui/field";
import { analyticsAction } from "@/lib/analytics-actions";
import type { FirstAgentUse } from "@/lib/first-agent";

export const USE_CHOICES: ReadonlyArray<{
  use: FirstAgentUse;
  title: string;
  icon: ReactNode;
}> = [
  { use: "product", title: "Add AI agents to my product", icon: <Blocks /> },
  { use: "work", title: "Use agents for my own work", icon: <SparklesIcon /> },
];

/**
 * "What do you want to use Opengeni for?" The first real question of first
 * run. Before the organization exists it also carries the organization's
 * name, prefilled and editable in place, so naming it is never a step of its
 * own. Nothing is required: Continue without an answer is Skip.
 */
export function UseQuestion({
  initialUse,
  organizationName,
  onOrganizationNameChange,
  busy = false,
  error,
  onChoose,
  onSkip,
}: {
  initialUse: FirstAgentUse | null;
  /** The organization to create; omitted once it exists. */
  organizationName?: string;
  onOrganizationNameChange?: (name: string) => void;
  busy?: boolean;
  error?: string | null;
  /** Saves the answer as soon as it changes, before Continue. */
  onChoose: (use: FirstAgentUse, options: { submit: boolean }) => void;
  onSkip: () => void;
}) {
  const [use, setUse] = useState<FirstAgentUse | null>(initialUse);
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        if (use) onChoose(use, { submit: true });
        else onSkip();
      }}
    >
      <ChoiceCards
        aria-label="What do you want to use Opengeni for?"
        value={use ?? ""}
        onValueChange={(value) => {
          const next = value as FirstAgentUse;
          setUse(next);
          onChoose(next, { submit: false });
        }}
        error={error ?? undefined}
        disabled={busy}
      >
        {USE_CHOICES.map((choice) => (
          <ChoiceCard key={choice.use} value={choice.use} title={choice.title} icon={choice.icon} />
        ))}
      </ChoiceCards>
      {organizationName !== undefined ? (
        <Field className="mt-5" label="Organization" id="organization-onboarding-name">
          <TextInput
            value={organizationName}
            autoComplete="organization"
            onChange={(event) => onOrganizationNameChange?.(event.target.value)}
          />
        </Field>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          className="text-fg-muted pointer-coarse:h-11"
          disabled={busy}
          onClick={onSkip}
          {...analyticsAction("skip_first_agent")}
        >
          Skip
        </Button>
        <Button type="submit" disabled={busy} {...analyticsAction("choose_intent")}>
          {busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
          Continue
        </Button>
      </div>
    </form>
  );
}
