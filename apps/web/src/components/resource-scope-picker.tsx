import { Building2Icon, UserRoundIcon, UsersRoundIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type ResourceScope = "organization" | "workspace" | "user";

const choices = [
  {
    value: "organization",
    label: "Organization",
    description: "Available in every workspace in this organization.",
    icon: Building2Icon,
  },
  {
    value: "workspace",
    label: "Workspace",
    description: "Available only in this workspace.",
    icon: UsersRoundIcon,
  },
  {
    value: "user",
    label: "Only me",
    description: "Private to you across workspaces you can access.",
    icon: UserRoundIcon,
  },
] as const;

export function ResourceScopePicker(props: {
  id: string;
  value: ResourceScope;
  onChange: (scope: ResourceScope) => void;
  organizationEnabled: boolean;
  personalEnabled: boolean;
  disabled?: boolean;
}) {
  return (
    <fieldset className="grid gap-2" disabled={props.disabled}>
      <legend className="text-sm font-medium text-fg">Who is this for?</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {choices.map((choice) => {
          const unavailable =
            (choice.value === "organization" && !props.organizationEnabled) ||
            (choice.value === "user" && !props.personalEnabled);
          const selected = props.value === choice.value;
          const Icon = choice.icon;
          return (
            <label
              key={choice.value}
              className={cn(
                "relative grid min-h-24 cursor-pointer content-start gap-1 rounded-lg border p-3 text-left transition-colors",
                selected
                  ? "border-brand bg-brand/8 ring-1 ring-brand/30"
                  : "border-border bg-surface/45 hover:border-border-strong hover:bg-surface",
                unavailable && "cursor-not-allowed opacity-55",
              )}
            >
              <input
                className="sr-only"
                type="radio"
                name={`${props.id}-scope`}
                value={choice.value}
                checked={selected}
                disabled={unavailable}
                onChange={() => props.onChange(choice.value)}
              />
              <span className="flex items-center gap-2 text-sm font-medium text-fg">
                <Icon className="size-4 text-fg-muted" aria-hidden="true" />
                {choice.label}
              </span>
              <span className="text-xs leading-5 text-fg-muted">
                {unavailable && choice.value === "organization"
                  ? "Organization owners can create organization resources."
                  : unavailable && choice.value === "user"
                    ? "Sign in with your managed account to create personal resources."
                    : choice.description}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function resourceScopeLabel(scope: ResourceScope): string {
  return scope === "user" ? "Only me" : scope === "organization" ? "Organization" : "Workspace";
}
