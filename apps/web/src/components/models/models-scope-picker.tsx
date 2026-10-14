import { LayersIcon, LockIcon } from "lucide-react";
import { useId } from "react";

import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { cn } from "@/lib/utils";
import type { ModelsWorkspace } from "./organization-models-list";

/* ----------------------------------------------------------------------------
   "Models for: [Defaults ▾]": which settings the Models page shows.

   Defaults are what every workspace uses unless it changes a setting for
   itself (owners and admins edit them). Picking a workspace shows that
   workspace's settings on a tinted header that says changes apply only
   there. People who can't edit the defaults start on their Overview: the
   model providers their workspaces use, and the workspaces they can open.
   Decided 13 Oct 2026 (DESIGN.md §7).
   -------------------------------------------------------------------------- */

export const DEFAULTS_SCOPE = "defaults";

export function ModelsScopePicker({
  workspaces,
  workspace,
  administrator,
  onSelect,
}: {
  /** The workspaces this person can open here, shared ones first. */
  workspaces: readonly ModelsWorkspace[];
  /** The workspace shown, or undefined for the Defaults (or Overview). */
  workspace: { id: string; name: string; personal: boolean } | undefined;
  /** Owners and admins: the top choice is the Defaults they edit. A workspace nobody here manages is listed, disabled. */
  administrator: boolean;
  /** Undefined opens the Defaults (or Overview). */
  onSelect: (workspaceId: string | undefined) => void;
}) {
  const labelId = useId();
  const workspaceId = workspace?.id;
  const current = workspace ?? null;
  const top = administrator ? "Defaults" : "Overview";
  const options: SelectOption[] = [
    {
      value: DEFAULTS_SCOPE,
      label: top,
      description: administrator
        ? "What every workspace starts from"
        : "Model providers your workspaces use",
      leading: <LayersIcon aria-hidden="true" className="size-4 text-fg-muted" />,
    },
    ...[
      ...workspaces,
      // A workspace that isn't listed (a direct link) still names itself in the picker.
      ...(current && !workspaces.some((each) => each.id === current.id) ? [current] : []),
    ].map((each) => ({
      value: each.id,
      label: each.personal ? "Your Personal workspace" : each.name,
      group: "Workspaces",
      ...("canManage" in each && !each.canManage && each.id !== current?.id
        ? { disabled: true, disabledReason: "Only its workspace admins can change its models." }
        : {}),
      leading: each.personal ? (
        <LogoTile size="sm" icon={<LockIcon />} />
      ) : (
        <LogoTile size="sm" name={each.name} />
      ),
    })),
  ];
  const name = current ? (current.personal ? "your Personal workspace" : current.name) : null;
  const scoped = workspaceId !== undefined;
  const hint = !scoped
    ? administrator
      ? "Every workspace uses these unless it changes a setting for itself. New workspaces start with them."
      : "The model providers your workspaces use. Pick a workspace to see or change its models."
    : current?.personal
      ? "Only you use your Personal workspace. Anything not changed here comes from the defaults."
      : `Changes here apply only to ${name ?? "this workspace"}. Anything not changed comes from the defaults.`;

  return (
    <div
      data-scope={scoped ? "workspace" : "defaults"}
      className={cn(
        "mb-8 grid gap-2",
        scoped && "-mx-3 rounded-lg border border-brand/25 bg-brand-strong/5 px-3 py-3",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span id={labelId} className="text-sm font-medium text-fg-muted">
          Models for
        </span>
        <SelectMenu
          aria-labelledby={labelId}
          size="sm"
          className="w-64 max-w-full"
          showMetaInTrigger={false}
          options={options}
          value={workspaceId ?? DEFAULTS_SCOPE}
          onValueChange={(value) => onSelect(value === DEFAULTS_SCOPE ? undefined : value)}
        />
        {scoped && current && !current.personal ? (
          <MetaChip variant="soft">Workspace</MetaChip>
        ) : null}
      </div>
      <p className="m-0 text-sm leading-5 text-fg-muted">{hint}</p>
    </div>
  );
}
