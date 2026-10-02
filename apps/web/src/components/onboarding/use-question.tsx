import { Blocks, Loader2Icon, SparklesIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { Field, TextInput } from "@/components/ui/field";
import { analyticsAction } from "@/lib/analytics-actions";
import type { FirstAgentUse } from "@/lib/first-agent";

export const USE_CHOICES: ReadonlyArray<{
  use: FirstAgentUse;
  title: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    use: "product",
    title: "Add AI agents to my product",
    description:
      "Put an agent in your website or app. Tell us about it and an agent starts building.",
    icon: <Blocks />,
  },
  {
    use: "work",
    title: "Use agents for my own work",
    description: "Agents research, write code and run recurring tasks for you in the cloud.",
    icon: <SparklesIcon />,
  },
];

/**
 * "What do you want to use Opengeni for?" The first real question of first
 * run. Before the organization exists it also carries the organization's
 * name, suggested and quiet ("We'll set up Ada's organization. Rename"), so
 * naming it is never a step of its own. Skip is always there.
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
  const [missing, setMissing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const nameHintId = useId();
  const naming = organizationName !== undefined;
  const nameMissing = naming && !organizationName.trim();
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        if (!use) {
          setMissing(true);
          return;
        }
        if (nameMissing) {
          setRenaming(true);
          return;
        }
        onChoose(use, { submit: true });
      }}
    >
      <ChoiceCards
        aria-label="What do you want to use Opengeni for?"
        value={use ?? ""}
        onValueChange={(value) => {
          const next = value as FirstAgentUse;
          setMissing(false);
          setUse(next);
          onChoose(next, { submit: false });
        }}
        error={missing ? "Choose one to continue, or skip." : (error ?? undefined)}
        disabled={busy}
      >
        {USE_CHOICES.map((choice) => (
          <ChoiceCard
            key={choice.use}
            value={choice.use}
            title={choice.title}
            description={choice.description}
            icon={choice.icon}
          />
        ))}
      </ChoiceCards>
      {naming ? (
        renaming || nameMissing ? (
          <Field
            className="mt-5"
            label="Organization name"
            hint="The company or team you work with. You can change it later."
            error={nameMissing ? "Enter a name for your organization." : undefined}
            id="organization-onboarding-name"
          >
            <TextInput
              value={organizationName}
              autoComplete="organization"
              autoFocus
              // The suggestion is a starting point: typing replaces it.
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => onOrganizationNameChange?.(event.target.value)}
            />
          </Field>
        ) : (
          <p id={nameHintId} className="mt-4 text-xs leading-4.5 text-fg-muted">
            We'll set up <span className="font-medium text-fg">{organizationName}</span> for you.{" "}
            <button
              type="button"
              className="font-medium text-fg underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 pointer-coarse:py-2"
              onClick={() => setRenaming(true)}
            >
              Rename
            </button>
          </p>
        )
      ) : null}
      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          className="text-fg-muted pointer-coarse:h-11"
          disabled={busy || nameMissing}
          onClick={onSkip}
          {...analyticsAction("skip_first_agent")}
        >
          Skip
        </Button>
        <Button type="submit" disabled={busy} {...analyticsAction("choose_intent")}>
          {busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
          {busy ? "Setting things up…" : "Continue"}
        </Button>
      </div>
    </form>
  );
}
