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

import {
  ACCESS_OPTIONS,
  disableWrites,
  enableWrites,
  knowledgeAccess,
  skillsAccess,
  type AccessLevel,
  type CapabilityLearning,
} from "@/components/agent/capability-learning";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { Checkbox } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import {
  AGENT_CAPABILITY_GROUPS,
  AGENT_STARTING_POINTS,
  SKILLS_OPTIONS,
  UNAVAILABLE_CAPABILITY_REASON,
  capabilityDescription,
  capabilityLabel,
  skillsFromOption,
  skillsOptionValue,
  withCapability,
  withStartingPoint,
  type AgentCapabilityDraft,
  type AgentCapabilityId,
  type CapabilityAvailability,
  type ResolvedAgentCapabilities,
} from "@/lib/agent-capabilities";
import { LEARNING_MODE_LABEL } from "@/lib/agent-learning-vocabulary";
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
  learning,
}: {
  draft: AgentCapabilityDraft;
  onChange: (draft: AgentCapabilityDraft) => void;
  /**
   * Agent learning for the same scope. With it, Skills and Knowledge are each
   * one Off / Read / Read and write choice, and Read and write shows whether
   * the agent's saves apply right away or wait for review.
   */
  learning?: CapabilityLearning | undefined;
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
              learning={learning}
              onChange={(value) => onChange(withCapability(draft, id, value))}
              onAccessChange={(level) => {
                if (!learning) return;
                if (id === "skills") {
                  onChange(
                    withCapability(
                      draft,
                      id,
                      level === "off" ? false : level === "read" ? "read" : "manage",
                    ),
                  );
                  if (level === "write")
                    learning.onChange(enableWrites(learning.modes, ["skills"]));
                } else {
                  onChange(withCapability(draft, id, level !== "off"));
                  if (level === "write") {
                    learning.onChange(enableWrites(learning.modes, ["knowledge", "instructions"]));
                  } else if (level === "read") {
                    learning.onChange(disableWrites(learning.modes, ["knowledge", "instructions"]));
                  }
                }
              }}
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
  learning,
  onChange,
  onAccessChange,
}: {
  id: AgentCapabilityId;
  values: ResolvedAgentCapabilities;
  availability: CapabilityAvailability;
  disabled: boolean;
  aside?: ReactNode;
  learning?: CapabilityLearning | undefined;
  onChange: (value: boolean | ResolvedAgentCapabilities["skills"]) => void;
  onAccessChange: (level: AccessLevel) => void;
}) {
  const labelId = useId();
  const descriptionId = useId();
  const available = availability.isAvailable(id);
  const locked = disabled || !available;
  const text = (
    <span className="min-w-0 flex-1">
      <span
        id={labelId}
        className={cn("block text-sm font-medium", available ? "text-fg" : "text-fg-muted")}
      >
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
  if (learning && (id === "skills" || id === "knowledge")) {
    const level = !available
      ? "off"
      : id === "skills"
        ? skillsAccess(values.skills, learning.modes)
        : knowledgeAccess(values.knowledge === true, learning.modes);
    return (
      <li className="flex min-h-14 min-w-0 flex-col gap-2 py-2.5" data-capability={id}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
          {text}
          <SegmentedControl
            size="sm"
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            value={level}
            onValueChange={(value) => onAccessChange(value as AccessLevel)}
            disabled={locked}
            options={ACCESS_OPTIONS}
            className="shrink-0 max-sm:w-full"
            fullWidth={false}
          />
        </div>
        {level === "write" ? (
          <div className="flex min-w-0 flex-col gap-1.5 rounded-[10px] bg-surface-2 px-3 py-2">
            {(id === "skills"
              ? ([["skills", "New and changed skills"]] as const)
              : ([
                  ["knowledge", "Saved knowledge"],
                  ["instructions", "Edits to instructions"],
                ] as const)
            ).map(([category, label]) => (
              <LearningModeRow
                key={category}
                label={label}
                value={learning.modes[category]}
                allowOff={id === "knowledge"}
                disabled={locked}
                onChange={(mode) => learning.onChange({ ...learning.modes, [category]: mode })}
              />
            ))}
            <span className="text-xs leading-4.5 text-fg-subtle">
              Automatic applies right away. Review first waits for your OK in Knowledge › Review.
            </span>
          </div>
        ) : null}
      </li>
    );
  }
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

function accessLevelOf(
  id: AgentCapabilityId,
  values: ResolvedAgentCapabilities,
  modes: CapabilityLearning["modes"] | null | undefined,
): AccessLevel | null {
  if (id === "skills") {
    return modes
      ? skillsAccess(values.skills, modes)
      : values.skills === "manage"
        ? "write"
        : values.skills
          ? "read"
          : "off";
  }
  if (id === "knowledge" && modes) return knowledgeAccess(values.knowledge === true, modes);
  return null;
}

function accessLabel(
  id: AgentCapabilityId,
  values: ResolvedAgentCapabilities,
  modes: CapabilityLearning["modes"] | null | undefined,
): string {
  const level = accessLevelOf(id, values, modes);
  if (level !== "write") return "Read only";
  if (!modes) return "Read and write";
  const mode =
    id === "skills"
      ? modes.skills
      : modes.knowledge !== "off"
        ? modes.knowledge
        : modes.instructions;
  return `Read and write · ${LEARNING_MODE_LABEL[mode]}`;
}

function accessDescription(
  id: AgentCapabilityId,
  values: ResolvedAgentCapabilities,
  modes: CapabilityLearning["modes"] | null | undefined,
): string {
  const level = accessLevelOf(id, values, modes);
  if (id === "skills") {
    return level === "write"
      ? "Uses installed Skills and can save, install, and publish them."
      : "Uses installed Skills.";
  }
  if (id === "knowledge" && level) {
    return level === "write"
      ? "Searches the Library and instructions, and can save to them."
      : "Searches the Library and instructions. Saves nothing.";
  }
  return capabilityDescription(id);
}

function LearningModeRow({
  label,
  value,
  allowOff,
  disabled,
  onChange,
}: {
  label: string;
  value: CapabilityLearning["modes"]["skills"];
  allowOff: boolean;
  disabled: boolean;
  onChange: (mode: CapabilityLearning["modes"]["skills"]) => void;
}) {
  const id = useId();
  const modes = allowOff
    ? (["automatic", "review_first", "off"] as const)
    : (["automatic", "review_first"] as const);
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <label htmlFor={id} className="text-xs font-medium text-fg-label">
        {label}
      </label>
      <Select
        id={id}
        value={value}
        disabled={disabled}
        className="w-[150px]"
        onChange={(event) => onChange(event.target.value as typeof value)}
      >
        {modes.map((mode) => (
          <option key={mode} value={mode}>
            {LEARNING_MODE_LABEL[mode]}
          </option>
        ))}
      </Select>
    </div>
  );
}

/**
 * Read-only summary for narrow views (the session dock): what is on, grouped,
 * with its one-line description; then one line each for what is off and what
 * this server doesn't offer.
 */
export function AgentCapabilitySummary({
  values,
  availability,
  rowAside,
  learningModes,
}: {
  values: ResolvedAgentCapabilities;
  availability: CapabilityAvailability;
  /** Agent learning for the same scope: Skills and Knowledge then say Read or Read and write. */
  learningModes?: CapabilityLearning["modes"] | null | undefined;
  /** Quiet extra line under one capability that is on (for example, a related setting). */
  rowAside?: (id: AgentCapabilityId) => ReactNode;
}) {
  const on = (id: AgentCapabilityId) =>
    availability.isAvailable(id) &&
    (id === "skills" ? values.skills !== false : values[id] === true);
  const off = AGENT_CAPABILITY_GROUPS.flatMap((group) => group.capabilities).filter(
    (id) => availability.isAvailable(id) && !on(id),
  );
  const unavailable = AGENT_CAPABILITY_GROUPS.flatMap((group) => group.capabilities).filter(
    (id) => !availability.isAvailable(id),
  );
  return (
    <div className="flex min-w-0 flex-col gap-4" data-slot="agent-capability-summary">
      {AGENT_CAPABILITY_GROUPS.map((group) => {
        const ids = group.capabilities.filter(on);
        if (ids.length === 0) return null;
        return (
          <CapabilityGroup key={group.id} label={group.label}>
            {ids.map((id) => (
              <li key={id} data-capability={id} className="min-w-0 py-2">
                <span className="flex min-w-0 items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-fg">{capabilityLabel(id)}</span>
                  {id === "skills" || (id === "knowledge" && learningModes) ? (
                    <span className="shrink-0 text-xs text-fg-muted">
                      {accessLabel(id, values, learningModes)}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs leading-4.5 text-fg-muted">
                  {accessDescription(id, values, learningModes)}
                </span>
                {rowAside?.(id) ? (
                  <span className="mt-0.5 block text-xs leading-4.5 text-fg-subtle">
                    {rowAside(id)}
                  </span>
                ) : null}
              </li>
            ))}
          </CapabilityGroup>
        );
      })}
      {off.length > 0 ? (
        <p className="text-xs leading-4.5 text-fg-muted">
          <span className="font-medium text-fg">Off: </span>
          {off.map(capabilityLabel).join(", ")}.
        </p>
      ) : null}
      {unavailable.length > 0 ? (
        <p className="flex min-w-0 items-start gap-1.5 text-xs leading-4.5 text-fg-muted">
          <LockIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
          <span className="min-w-0">
            {UNAVAILABLE_CAPABILITY_REASON}: {unavailable.map(capabilityLabel).join(", ")}.
          </span>
        </p>
      ) : null}
    </div>
  );
}
