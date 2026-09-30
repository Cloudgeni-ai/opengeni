/**
 * The one capability picker for forms with a Save button: workspace defaults,
 * a running session's Agent panel and the schedule form. A starting point
 * (choice cards, each with its consequence) and then every capability as a
 * checkbox row in three groups; Skills is the one three-way setting. A
 * capability this server doesn't offer stays visible, disabled, with the
 * reason. Tool ids never appear here.
 */
import { LockIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { Checkbox } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  AGENT_CAPABILITY_GROUPS,
  AGENT_STARTING_POINTS,
  SKILLS_OPTIONS,
  UNAVAILABLE_CAPABILITY_REASON,
  capabilityDescription,
  capabilityLabel,
  capabilityStateLabel,
  skillsFromOption,
  skillsOptionValue,
  withCapability,
  withStartingPoint,
  type AgentCapabilityDraft,
  type AgentCapabilityId,
  type CapabilityAvailability,
  type ResolvedAgentCapabilities,
} from "@/lib/agent-capabilities";
import { cn } from "@/lib/utils";

export function AgentCapabilityPicker({
  draft,
  onChange,
  availability,
  disabled = false,
  disabledReason,
  startingPointLabel = "Starting point",
  startingPointDescription,
  rowAside,
}: {
  draft: AgentCapabilityDraft;
  onChange: (draft: AgentCapabilityDraft) => void;
  availability: CapabilityAvailability;
  /** Read-only: shows the values, changes nothing. */
  disabled?: boolean;
  /** Who can change it, shown once on the starting point. */
  disabledReason?: ReactNode;
  startingPointLabel?: ReactNode;
  startingPointDescription?: ReactNode;
  /** Quiet extra line under one capability (for example, which apps it covers). */
  rowAside?: (id: AgentCapabilityId) => ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-6" data-slot="agent-capability-picker">
      <ChoiceCards
        label={startingPointLabel}
        description={startingPointDescription}
        value={draft.from}
        onValueChange={(value) => onChange(withStartingPoint(draft, value as "all" | "none"))}
        layout="grid"
        disabled={disabled}
      >
        {AGENT_STARTING_POINTS.map((option) => (
          <ChoiceCard
            key={option.value}
            value={option.value}
            title={option.title}
            description={option.description}
            disabled={disabled}
            disabledReason={disabled ? disabledReason : undefined}
          />
        ))}
      </ChoiceCards>
      {AGENT_CAPABILITY_GROUPS.map((group) => (
        <CapabilityGroup key={group.id} label={group.label}>
          {group.capabilities.map((id) => (
            <CapabilityRow
              key={id}
              id={id}
              values={draft.values}
              availability={availability}
              disabled={disabled}
              aside={rowAside?.(id)}
              onChange={(value) => onChange(withCapability(draft, id, value))}
            />
          ))}
        </CapabilityGroup>
      ))}
    </div>
  );
}

export function CapabilityGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h3 id={id} className="pb-1 text-xs leading-4.5 font-medium text-fg-subtle">
        {label}
      </h3>
      <ul className="m-0 flex min-w-0 list-none flex-col divide-y divide-border p-0">{children}</ul>
    </section>
  );
}

function CapabilityRow({
  id,
  values,
  availability,
  disabled,
  aside,
  onChange,
}: {
  id: AgentCapabilityId;
  values: ResolvedAgentCapabilities;
  availability: CapabilityAvailability;
  disabled: boolean;
  aside?: ReactNode;
  onChange: (value: boolean | ResolvedAgentCapabilities["skills"]) => void;
}) {
  const labelId = useId();
  const descriptionId = useId();
  const available = availability.isAvailable(id);
  const locked = disabled || !available;
  const text = (
    <span className="min-w-0 flex-1">
      <span id={labelId} className="block text-sm font-medium text-fg">
        {capabilityLabel(id)}
      </span>
      <span
        id={descriptionId}
        className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-fg-muted"
      >
        {available ? (
          capabilityDescription(id)
        ) : (
          <>
            <LockIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
            <span className="min-w-0">{UNAVAILABLE_CAPABILITY_REASON}</span>
          </>
        )}
      </span>
      {aside && available ? (
        <span className="mt-0.5 block text-xs leading-4.5 text-fg-subtle">{aside}</span>
      ) : null}
    </span>
  );
  if (id === "skills") {
    return (
      <li
        className="flex min-h-14 min-w-0 flex-wrap items-center gap-x-6 gap-y-2 py-2.5"
        data-capability={id}
      >
        {text}
        <SegmentedControl
          size="sm"
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          value={available ? skillsOptionValue(values.skills) : "off"}
          onValueChange={(value) => onChange(skillsFromOption(value))}
          disabled={locked}
          options={SKILLS_OPTIONS}
          className="shrink-0 max-sm:w-full"
          fullWidth={false}
        />
      </li>
    );
  }
  const checked = available && values[id] === true;
  return (
    <li className="min-w-0" data-capability={id}>
      <label
        className={cn(
          "-mx-3 flex min-h-14 min-w-0 items-center gap-6 rounded-[10px] px-3 py-2.5",
          locked
            ? "cursor-default"
            : "cursor-pointer transition-colors duration-[120ms] hover:bg-surface-2",
        )}
      >
        {text}
        <Checkbox
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          checked={checked}
          disabled={locked}
          onCheckedChange={(next) => onChange(next)}
        />
      </label>
    </li>
  );
}

/** Read-only list: each capability with its state in words. */
export function AgentCapabilityList({
  values,
  availability,
  onlyOn = false,
}: {
  values: ResolvedAgentCapabilities;
  availability: CapabilityAvailability;
  /** Show only what is on (compact views). */
  onlyOn?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {AGENT_CAPABILITY_GROUPS.map((group) => {
        const ids = group.capabilities.filter(
          (id) =>
            !onlyOn ||
            (availability.isAvailable(id) &&
              (id === "skills" ? values.skills !== false : values[id])),
        );
        if (ids.length === 0) return null;
        return (
          <CapabilityGroup key={group.id} label={group.label}>
            {ids.map((id) => {
              const state = capabilityStateLabel(values, id, availability);
              const on = state !== "Off" && availability.isAvailable(id);
              return (
                <li
                  key={id}
                  data-capability={id}
                  className="flex min-h-11 min-w-0 items-center justify-between gap-4 py-2"
                >
                  <span className="min-w-0">
                    <span className="block text-sm text-fg">{capabilityLabel(id)}</span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-right text-xs leading-4.5",
                      on ? "text-fg" : "text-fg-subtle",
                    )}
                  >
                    {state}
                  </span>
                </li>
              );
            })}
          </CapabilityGroup>
        );
      })}
    </div>
  );
}
