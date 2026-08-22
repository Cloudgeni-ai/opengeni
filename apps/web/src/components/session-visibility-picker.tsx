import { LockIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type SessionTenancyCreateCapabilitiesView = {
  activated: boolean;
  canCreatePrivate: boolean;
  personalWorkspace: boolean;
  reason: "available" | "not_activated" | "managed_session_required" | "unavailable";
};

export function SessionVisibilityPicker(props: {
  id: string;
  personalWorkspace: boolean;
  value: "private" | "workspace";
  capabilities: SessionTenancyCreateCapabilitiesView | null;
  disabled: boolean;
  onChange: (visibility: "private" | "workspace") => void;
}) {
  const privateEnabled = props.personalWorkspace || props.capabilities?.canCreatePrivate === true;
  const privateReason =
    props.capabilities === null
      ? "Checking availability…"
      : props.capabilities.reason === "managed_session_required"
        ? "Sign in with your managed account to create an Only-me session."
        : props.capabilities.reason === "not_activated"
          ? "Private sessions are not enabled for this organization yet."
          : props.capabilities.reason === "unavailable"
            ? "Private-session availability could not be checked. Try again shortly."
            : "Only you can open this session.";

  if (props.personalWorkspace) {
    return (
      <section className="mt-5 rounded-lg border border-border bg-surface/60 p-3">
        <div className="flex items-center gap-2">
          <LockIcon className="size-4 text-brand" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium">Only me</p>
            <p className="text-xs text-fg-muted">
              This is your Personal workspace, so the session is already private.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <fieldset className="mt-5 grid gap-2">
      <legend className="px-0.5 text-2xs font-medium uppercase tracking-[0.08em] text-fg-subtle">
        Who can see this session?
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <VisibilityOption
          value="workspace"
          name={`${props.id}-visibility`}
          selected={props.value === "workspace"}
          disabled={props.disabled}
          icon={<UsersIcon className="size-4" aria-hidden="true" />}
          title="Workspace"
          description="People with access to this workspace can open it."
          onSelect={props.onChange}
        />
        <VisibilityOption
          value="private"
          name={`${props.id}-visibility`}
          selected={props.value === "private"}
          disabled={props.disabled || !privateEnabled}
          icon={<LockIcon className="size-4" aria-hidden="true" />}
          title="Only me"
          description={privateReason}
          onSelect={props.onChange}
        />
      </div>
    </fieldset>
  );
}

function VisibilityOption(props: {
  name: string;
  value: "private" | "workspace";
  selected: boolean;
  disabled: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  onSelect: (visibility: "private" | "workspace") => void;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 transition-colors",
        props.selected ? "border-brand bg-brand/8" : "border-border bg-surface/50",
        props.disabled
          ? "cursor-not-allowed opacity-55"
          : "cursor-pointer hover:border-border-strong",
      )}
    >
      <input
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.selected}
        disabled={props.disabled}
        onChange={() => props.onSelect(props.value)}
        className="mt-0.5 size-4 accent-brand"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {props.icon}
          {props.title}
        </span>
        <span className="mt-0.5 block text-xs leading-4 text-fg-muted">{props.description}</span>
      </span>
    </label>
  );
}
