import { LockIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type SessionTenancyCreateCapabilitiesView = {
  activated: boolean;
  canCreatePrivate: boolean;
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

  // When Workspace is the only valid value there is no decision to make.
  // Personal work belongs in the member's owner-only Personal workspace;
  // activated organizations get the real Workspace / Only me choice below.
  if (props.capabilities?.canCreatePrivate !== true) {
    return null;
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
          disabled={props.disabled}
          icon={<LockIcon className="size-4" aria-hidden="true" />}
          title="Only me"
          description="Only you can open this session."
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
