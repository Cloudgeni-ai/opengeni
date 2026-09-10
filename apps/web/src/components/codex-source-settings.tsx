import type { CodexAccountsResponse, WorkspaceCodexSubscriptionMode } from "@opengeni/sdk";
import { useId, useState } from "react";

import { FormDisclosure } from "@/components/ui/form-disclosure";
import { Select } from "@/components/ui/select";

type Source = NonNullable<CodexAccountsResponse["source"]>;

export function codexSourceSummary(source: Source): string {
  if (source.effectiveSource === "disabled") return "Codex is turned off";
  if (source.effectiveSource === "organization") {
    return source.organizationAvailable
      ? "Using organization subscriptions"
      : "No organization subscription connected";
  }
  return source.workspaceAvailable
    ? "Using workspace subscriptions"
    : "No workspace subscription connected";
}

export function CodexSourceSettings({
  source,
  busy,
  onChange,
}: {
  source: Source;
  busy: boolean;
  onChange: (mode: WorkspaceCodexSubscriptionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const helpId = useId();
  return (
    <FormDisclosure
      title="Subscription source"
      summary={codexSourceSummary(source)}
      open={open}
      onOpenChange={setOpen}
    >
      <label className="grid gap-2 text-xs font-medium">
        Use subscriptions from
        <Select
          value={source.mode}
          disabled={busy}
          aria-describedby={helpId}
          onChange={(event) => onChange(event.target.value as WorkspaceCodexSubscriptionMode)}
        >
          <option value="automatic">Automatic (default)</option>
          <option value="organization">Organization only</option>
          <option value="workspace">This workspace only</option>
          <option value="disabled">Turn off Codex</option>
        </Select>
      </label>
      <p id={helpId} className="text-xs leading-5 text-fg-subtle">
        {source.mode === "automatic"
          ? "Uses subscriptions connected to this workspace. When none are connected, uses the organization's subscriptions."
          : source.mode === "organization"
            ? "Uses only the organization's subscriptions. Manage them in organization model settings."
            : source.mode === "workspace"
              ? "Uses only subscriptions connected here, even when the organization has a subscription."
              : "Codex models are unavailable in this workspace."}
      </p>
    </FormDisclosure>
  );
}
