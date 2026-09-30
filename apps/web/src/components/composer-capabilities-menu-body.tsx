/**
 * Composer "+" > Capabilities: what the agent can do in this chat. Off
 * ("Customize for this chat" switch) the list shows the workspace's defaults
 * read-only and the chat sends nothing; on, every row is a toggle and the chat
 * sends its own `agent.capabilities`. Workspace connectors opens the
 * connectors list nested under it. Product words only; no tool ids.
 */
import { CheckIcon, ChevronRightIcon, LockIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ConnectorAction } from "@/components/session-connectors-menu-body";
import {
  ComposerMenuHeader,
  ComposerMenuSwitch,
  ComposerMenuSwitchIndicator,
} from "@/components/ui/composer-menu";
import {
  AGENT_CAPABILITY_GROUPS,
  UNAVAILABLE_CAPABILITY_REASON,
  capabilityDescription,
  capabilityLabel,
  capabilitySummary,
  effectiveCapabilityOn,
  withCapability,
  type AgentCapabilityDraft,
  type AgentCapabilityId,
  type CapabilityAvailability,
} from "@/lib/agent-capabilities";
import { cn } from "@/lib/utils";

export type ComposerAgentCapabilities = {
  /** "Customize for this chat" is on: the chat sends its own capabilities. */
  customized: boolean;
  /** What the chat gets: its own values when customized, else the workspace's. */
  draft: AgentCapabilityDraft;
  availability: CapabilityAvailability;
  onCustomizedChange: (customized: boolean) => void;
  onChange: (draft: AgentCapabilityDraft) => void;
  disabled?: boolean;
};

export function ComposerCapabilitiesMenuBody(props: {
  capabilities: ComposerAgentCapabilities;
  presentation?: "menu" | "dialog";
  leading?: ReactNode;
  /** Number of connected apps on for this chat, shown under Workspace connectors. */
  connectorsSelected: number;
  connectorsTotal: number;
  onOpenConnectors: () => void;
}) {
  const { capabilities } = props;
  const { customized, draft, availability } = capabilities;
  const set = (id: AgentCapabilityId, value: boolean | "read" | "manage" | false) =>
    capabilities.onChange(withCapability(draft, id, value));
  return (
    <>
      <ComposerMenuHeader title="Capabilities" leading={props.leading} />
      <div className="min-h-0 shrink overflow-y-auto overscroll-contain p-2">
        <div className="flex min-h-14 items-center gap-3 rounded-md px-2 py-2">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium" id="composer-capabilities-customize">
              Customize for this chat
            </span>
            <span className="mt-0.5 block text-xs leading-4.5 text-fg-muted">
              {customized
                ? "This chat uses the choices below."
                : `Off uses the workspace's defaults: ${capabilitySummary(draft.values, availability).toLowerCase()}.`}
            </span>
          </span>
          <ComposerMenuSwitch
            label="Customize for this chat"
            checked={customized}
            disabled={capabilities.disabled}
            onCheckedChange={(next) => capabilities.onCustomizedChange(next)}
          />
        </div>
        {AGENT_CAPABILITY_GROUPS.map((group) => (
          <section key={group.id} aria-label={group.label} className="mt-2">
            <h3 className="px-2 pt-1 pb-1 text-xs leading-4.5 font-medium text-fg-subtle">
              {group.label}
            </h3>
            {group.capabilities.map((id) => {
              const available = availability.isAvailable(id);
              const on = effectiveCapabilityOn(draft.values, id, availability);
              const editable = customized && available && !capabilities.disabled;
              const description = available ? capabilityDescription(id) : null;
              const text = (
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-fg">{capabilityLabel(id)}</span>
                  {available ? (
                    <span className="mt-0.5 block text-xs leading-4.5 font-normal text-fg-muted">
                      {id === "workspaceConnectors" && on
                        ? props.connectorsTotal === 0
                          ? "No apps connected yet."
                          : `${props.connectorsSelected} of ${props.connectorsTotal} connected apps on.`
                        : description}
                    </span>
                  ) : (
                    <span className="mt-0.5 flex items-start gap-1.5 text-xs leading-4.5 font-normal text-fg-muted">
                      <LockIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
                      {UNAVAILABLE_CAPABILITY_REASON}
                    </span>
                  )}
                </span>
              );
              const row = (
                <div key={id} className="flex min-w-0 items-center gap-1" data-capability={id}>
                  {editable ? (
                    <ConnectorAction
                      presentation={props.presentation}
                      keepOpen
                      checked={on}
                      label={capabilityLabel(id)}
                      className="flex min-h-14 flex-1 items-center gap-3 rounded-md px-2 py-2"
                      onAction={() => set(id, id === "skills" ? (on ? false : "read") : !on)}
                    >
                      {text}
                      <ComposerMenuSwitchIndicator checked={on} />
                    </ConnectorAction>
                  ) : (
                    <div
                      className={cn(
                        "flex min-h-14 flex-1 items-center gap-3 px-2 py-2",
                        !available && "opacity-70",
                      )}
                      aria-label={`${capabilityLabel(id)}, ${
                        !available ? UNAVAILABLE_CAPABILITY_REASON : on ? "on" : "off"
                      }`}
                    >
                      {text}
                      <span className="flex size-7 shrink-0 items-center justify-center">
                        {on ? <CheckIcon aria-hidden className="size-4 text-fg-muted" /> : null}
                      </span>
                    </div>
                  )}
                  {id === "workspaceConnectors" && on ? (
                    <ConnectorAction
                      presentation={props.presentation}
                      keepOpen
                      label="Choose connected apps"
                      className="flex size-11 shrink-0 items-center justify-center rounded-md"
                      onAction={props.onOpenConnectors}
                    >
                      <ChevronRightIcon aria-hidden className="size-4 text-fg-subtle" />
                    </ConnectorAction>
                  ) : null}
                </div>
              );
              if (id !== "skills" || !on) return row;
              // Skills on: one indented choice to also let the agent change them.
              const manage = draft.values.skills === "manage";
              return (
                <div key={id}>
                  {row}
                  {editable ? (
                    <ConnectorAction
                      presentation={props.presentation}
                      keepOpen
                      checked={manage}
                      label="Also save and install Skills"
                      className="flex min-h-11 items-center gap-3 rounded-md py-2 pr-2 pl-6"
                      onAction={() => set("skills", manage ? "read" : "manage")}
                    >
                      <span className="min-w-0 flex-1 text-sm text-fg">
                        Also save and install Skills
                      </span>
                      <ComposerMenuSwitchIndicator checked={manage} />
                    </ConnectorAction>
                  ) : (
                    <p className="py-1 pr-2 pl-6 text-xs leading-4.5 text-fg-muted">
                      {manage ? "Can also save and install Skills." : "Can read Skills only."}
                    </p>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </>
  );
}
