import { useState, type MouseEvent } from "react";
import { MoreHorizontalIcon, SendIcon, SlidersHorizontalIcon, SquarePenIcon } from "lucide-react";

import { WorkspaceConfigGlyph } from "@/components/rail/workspace-config-link";
import { PRIMARY_WORKSPACE_ITEMS } from "@/components/rail/workspace-nav-data";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CheckboxField } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { NavItem, type NavItemSize } from "@/components/ui/settings-nav";
import {
  DEFAULT_RAIL_DESTINATIONS,
  normalizeRailDestinations,
  type RailDestinationId,
} from "@/lib/rail-destinations";

/* ----------------------------------------------------------------------------
   The main rail's destinations, as the product ships them (components/rail/
   primary-nav.tsx): New session, the chosen destinations (default Schedules,
   Artifacts, Knowledge, Capabilities), More, then Settings. More holds the
   rest plus "Customize rail". Labels, order and icons come from the real
   catalog; the choice is kept per pane, not saved.
   -------------------------------------------------------------------------- */

export type KitRailId = "new-session" | RailDestinationId | "settings";

const FOR_YOU_LABEL = "For you";

function labelFor(id: RailDestinationId): string {
  if (id === "for-you") return FOR_YOU_LABEL;
  return PRIMARY_WORKSPACE_ITEMS.find((item) => item.id === id)?.label ?? id;
}

/** The label a rail id shows, for toasts and page titles. */
export function kitRailLabel(id: KitRailId): string {
  if (id === "new-session") return "New session";
  if (id === "settings") return "Settings";
  return labelFor(id);
}

function prevent(event: MouseEvent) {
  event.preventDefault();
}

export interface KitRailItemsProps {
  active?: KitRailId | null;
  collapsed?: boolean;
  /** Pending reviews: a dot on Knowledge (or on More while Knowledge is under it). */
  knowledgeAttention?: number;
  /** For you's "needs you" count, shown on More while For you is under it. */
  forYouCount?: number;
  onNavigate?: (id: KitRailId) => void;
  size?: NavItemSize;
}

/** The rail items only; render inside the frame's `NavGroup`. */
export function KitRailItems({
  active = null,
  collapsed = false,
  knowledgeAttention = 0,
  forYouCount = 2,
  onNavigate,
  size,
}: KitRailItemsProps) {
  const [chosen, setChosen] = useState<RailDestinationId[]>([...DEFAULT_RAIL_DESTINATIONS]);
  const [customizing, setCustomizing] = useState(false);
  const shows = (id: RailDestinationId) => chosen.includes(id);
  const destinations = PRIMARY_WORKSPACE_ITEMS.filter(
    (item): item is typeof item & { id: RailDestinationId } => item.id !== "settings",
  );
  const settings = PRIMARY_WORKSPACE_ITEMS.find((item) => item.id === "settings");
  const hidden = destinations.filter((item) => !shows(item.id));
  const forYouHidden = !shows("for-you");
  const knowledgeWaiting = knowledgeAttention > 0;
  const moreActive =
    active !== null &&
    active !== "new-session" &&
    active !== "settings" &&
    !shows(active as RailDestinationId);
  const moreCount = forYouHidden ? forYouCount : 0;
  const moreDot = knowledgeWaiting && !shows("knowledge");

  const go = (id: KitRailId) => (event: MouseEvent) => {
    prevent(event);
    onNavigate?.(id);
  };

  return (
    <>
      <NavItem
        href="#new-session"
        onClick={go("new-session")}
        icon={<SquarePenIcon />}
        label="New session"
        active={active === "new-session"}
        collapsed={collapsed}
        size={size}
      />
      {shows("for-you") ? (
        <NavItem
          href="#for-you"
          onClick={go("for-you")}
          icon={<SendIcon />}
          label={FOR_YOU_LABEL}
          badge={forYouCount > 0 ? String(forYouCount) : undefined}
          active={active === "for-you"}
          collapsed={collapsed}
          size={size}
        />
      ) : null}
      {destinations
        .filter((item) => shows(item.id))
        .map((item) => (
          <NavItem
            key={item.id}
            href={`#${item.id}`}
            onClick={go(item.id)}
            icon={<WorkspaceConfigGlyph icon={item.icon} />}
            label={item.label}
            attention={item.id === "knowledge" && knowledgeWaiting}
            attentionLabel={`${knowledgeAttention} waiting for review`}
            active={active === item.id}
            collapsed={collapsed}
            size={size}
          />
        ))}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <NavItem
            asChild
            icon={<MoreHorizontalIcon />}
            label="More"
            active={moreActive}
            badge={moreCount > 0 ? String(moreCount) : undefined}
            attention={moreDot}
            attentionLabel="Knowledge needs review"
            collapsed={collapsed}
            size={size}
          >
            <button type="button" />
          </NavItem>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side={collapsed ? "right" : "bottom"}
          className="w-[min(15rem,calc(100vw-1rem))]"
        >
          {forYouHidden ? (
            <DropdownMenuItem
              className="min-h-8 pointer-coarse:min-h-11"
              onSelect={() => onNavigate?.("for-you")}
            >
              <SendIcon className="size-4" />
              <span className="min-w-0 flex-1 truncate">{FOR_YOU_LABEL}</span>
              {forYouCount > 0 ? (
                <span className="font-mono text-2xs text-fg-subtle tabular-nums">
                  {forYouCount}
                </span>
              ) : null}
            </DropdownMenuItem>
          ) : null}
          {hidden.map((item) => {
            const review = item.id === "knowledge" && knowledgeWaiting;
            return (
              <DropdownMenuItem
                key={item.id}
                className="min-h-8 pointer-coarse:min-h-11"
                onSelect={() => onNavigate?.(item.id)}
              >
                <WorkspaceConfigGlyph icon={item.icon} className="size-4" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {review ? (
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full bg-status-waiting"
                  />
                ) : null}
              </DropdownMenuItem>
            );
          })}
          {forYouHidden || hidden.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem
            className="min-h-8 pointer-coarse:min-h-11"
            onSelect={() => setCustomizing(true)}
          >
            <SlidersHorizontalIcon className="size-4" />
            Customize rail
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {settings ? (
        <NavItem
          href="#settings"
          onClick={go("settings")}
          icon={<WorkspaceConfigGlyph icon={settings.icon} />}
          label={settings.label}
          active={active === "settings"}
          collapsed={collapsed}
          size={size}
        />
      ) : null}
      <CustomizeRailDialog
        open={customizing}
        onOpenChange={setCustomizing}
        chosen={chosen}
        options={["for-you", ...destinations.map((item) => item.id)]}
        onSave={(next) => setChosen(normalizeRailDestinations(next))}
      />
    </>
  );
}

function CustomizeRailDialog({
  open,
  onOpenChange,
  chosen,
  options,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chosen: RailDestinationId[];
  options: RailDestinationId[];
  onSave: (next: RailDestinationId[]) => void;
}) {
  const [draft, setDraft] = useState<RailDestinationId[]>(chosen);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(chosen);
  }
  const isDefault =
    draft.length === DEFAULT_RAIL_DESTINATIONS.length &&
    DEFAULT_RAIL_DESTINATIONS.every((id) => draft.includes(id));
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Customize rail"
      description="Pick what shows in the rail. Everything else stays under More."
      submitLabel="Save"
      onSubmit={() => onSave(draft)}
      footerStart={
        isDefault ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2.5 text-fg-muted"
            onClick={() => setDraft([...DEFAULT_RAIL_DESTINATIONS])}
          >
            Reset
          </Button>
        )
      }
    >
      <div role="group" aria-label="Destinations" className="grid gap-3">
        {options.map((id) => (
          <CheckboxField
            key={id}
            name={`rail-${id}`}
            label={labelFor(id)}
            checked={draft.includes(id)}
            onCheckedChange={(checked) =>
              setDraft((current) =>
                checked ? [...current, id] : current.filter((each) => each !== id),
              )
            }
          />
        ))}
      </div>
    </FormDialog>
  );
}
