import { useId } from "react";
import { cn } from "@/lib/utils";
import type { ConnectionOwnership } from "@/types";
import { Dialog, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CapabilityDialogContent } from "./detail-dialog";

export function OwnershipSelector({
  value,
  onChange,
  compact = false,
  credentialBased = false,
}: {
  value: ConnectionOwnership;
  onChange: (value: ConnectionOwnership) => void;
  compact?: boolean;
  credentialBased?: boolean;
}) {
  const groupName = useId();
  const workspaceDescription = credentialBased
    ? "Workspace agents and automations can act through the account these credentials authorize."
    : "Workspace agents and automations can act through your account.";
  const personalDescription = credentialBased
    ? "Only your authorized work can use these credentials."
    : "Only your authorized work can use your account.";
  if (compact) {
    const descriptionId = `${groupName}-description`;
    return (
      <fieldset className="space-y-2" aria-describedby={descriptionId}>
        <legend className="session-capability-card__fine font-medium text-fg">Connect for</legend>
        <div className="session-capability-card__choice">
          {(["workspace", "personal"] as const).map((ownership) => (
            <label key={ownership} className="relative cursor-pointer">
              <input
                className="peer sr-only"
                type="radio"
                name={groupName}
                value={ownership}
                checked={value === ownership}
                onChange={() => onChange(ownership)}
              />
              <span className="session-capability-card__choice-label border border-border text-fg-muted peer-checked:bg-surface-2 peer-checked:text-fg peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                {ownership === "workspace" ? "This workspace" : "Only me"}
              </span>
            </label>
          ))}
        </div>
        <p id={descriptionId} className="session-capability-card__fine text-fg-subtle">
          {value === "workspace" ? workspaceDescription : personalDescription}
        </p>
      </fieldset>
    );
  }
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-fg-muted">Who can use this connection?</legend>
      <OwnershipOption
        groupName={groupName}
        checked={value === "workspace"}
        value="workspace"
        title="This workspace"
        description={workspaceDescription}
        onChange={() => onChange("workspace")}
      />
      <OwnershipOption
        groupName={groupName}
        checked={value === "personal"}
        value="personal"
        title="Only me"
        description={personalDescription}
        onChange={() => onChange("personal")}
      />
    </fieldset>
  );
}

function OwnershipOption({
  groupName,
  checked,
  value,
  title,
  description,
  onChange,
}: {
  groupName: string;
  checked: boolean;
  value: ConnectionOwnership;
  title: string;
  description: string;
  onChange: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
        checked ? "border-brand bg-brand/5" : "border-border bg-bg hover:bg-surface",
      )}
    >
      <input
        type="radio"
        name={groupName}
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 size-4 accent-current"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{title}</span>
        <span className="mt-0.5 block text-xs leading-5 text-fg-subtle">{description}</span>
      </span>
    </label>
  );
}

export function ConnectionOwnershipDialog({
  name,
  value,
  onChange,
  onContinue,
  onClose,
}: {
  name: string;
  value: ConnectionOwnership;
  onChange(value: ConnectionOwnership): void;
  onContinue(): void;
  onClose(): void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <CapabilityDialogContent className="gap-5 p-6 pb-6 sm:max-w-lg sm:p-6 sm:pb-6">
        <DialogHeader>
          <DialogTitle>Connect {name}</DialogTitle>
          <DialogDescription>Choose who can use this account.</DialogDescription>
        </DialogHeader>
        <OwnershipSelector value={value} onChange={onChange} />
        <Button onClick={onContinue}>Continue</Button>
      </CapabilityDialogContent>
    </Dialog>
  );
}
