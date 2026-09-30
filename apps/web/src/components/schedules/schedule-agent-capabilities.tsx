/**
 * Schedule form > "What the agent can do": the same capability picker as
 * workspace settings and the composer. "Workspace defaults" saves nothing, so
 * runs follow the workspace's agent defaults at run time; "Choose for this
 * schedule" freezes the choice into the schedule.
 */
import { resolveWorkspaceAgentDefaults, type AgentCapabilities } from "@opengeni/contracts";
import { useMemo } from "react";

import { AgentCapabilityPicker } from "@/components/agent/agent-capability-picker";
import { Disclosure } from "@/components/ui/disclosure";
import { Field } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAppContext } from "@/context";
import {
  capabilityAvailability,
  capabilitySummary,
  draftFromRequest,
  requestFromDraft,
  workspaceAgentDefaultsDraft,
} from "@/lib/agent-capabilities";

export function ScheduleAgentCapabilities({
  workspaceId,
  value,
  onChange,
  disabled = false,
}: {
  workspaceId: string;
  value: AgentCapabilities | undefined;
  onChange: (value: AgentCapabilities | undefined) => void;
  disabled?: boolean;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const availability = useMemo(
    () => capabilityAvailability(context.clientConfig.agentConfig),
    [context.clientConfig.agentConfig],
  );
  const workspaceDraft = useMemo(
    () =>
      workspaceAgentDefaultsDraft({
        capabilities: resolveWorkspaceAgentDefaults(workspace?.settings)?.capabilities,
        legacyHumanInputOff: workspace?.settings.agentHumanInputEnabled === false,
      }),
    [workspace?.settings],
  );
  const custom = value !== undefined;
  const draft = custom ? draftFromRequest(value) : workspaceDraft;
  const summary = capabilitySummary(draft.values, availability);
  return (
    <Disclosure
      variant="row"
      title="What the agent can do"
      summary={custom ? `Chosen for this schedule · ${summary}` : `Workspace defaults · ${summary}`}
    >
      <div className="flex min-w-0 flex-col gap-6">
        <Field
          label="Capabilities"
          group
          hint={
            custom
              ? "Saved with the schedule. Later changes to the workspace's defaults don't change it."
              : "Each run uses the workspace's agent defaults at the time it runs."
          }
        >
          <SegmentedControl
            size="sm"
            value={custom ? "custom" : "default"}
            disabled={disabled}
            onValueChange={(next) =>
              onChange(
                next === "custom" ? requestFromDraft(workspaceDraft, availability) : undefined,
              )
            }
            options={[
              { value: "default", label: "Workspace defaults" },
              { value: "custom", label: "Choose for this schedule" },
            ]}
          />
        </Field>
        {custom ? (
          <AgentCapabilityPicker
            draft={draft}
            availability={availability}
            disabled={disabled}
            onChange={(next) => onChange(requestFromDraft(next, availability))}
          />
        ) : null}
      </div>
    </Disclosure>
  );
}
