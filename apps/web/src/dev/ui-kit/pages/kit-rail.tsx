import type { MouseEvent } from "react";
import { SendIcon, SlidersHorizontalIcon, SquarePenIcon } from "lucide-react";

import { WorkspaceConfigGlyph } from "@/components/rail/workspace-config-link";
import { PRIMARY_WORKSPACE_ITEMS } from "@/components/rail/workspace-nav-data";
import { NavItem, type NavItemSize } from "@/components/ui/settings-nav";

/* ----------------------------------------------------------------------------
   The main rail's destinations, as the product ships them (components/rail/
   primary-nav.tsx and workspace-nav.tsx): New session, For you, Capabilities,
   Knowledge, Schedules, Artifacts, then Settings. Labels, order and
   icons come from the real catalog. Settings opens in the content area.
   -------------------------------------------------------------------------- */

const DESTINATION_IDS = {
  "/workspaces/$workspaceId/plugins": "capabilities",
  "/workspaces/$workspaceId/state": "knowledge",
  "/workspaces/$workspaceId/schedules": "schedules",
  "/workspaces/$workspaceId/artifacts": "artifacts",
} as const;

type RailDestinationId = (typeof DESTINATION_IDS)[keyof typeof DESTINATION_IDS];

export type KitRailId = "new-session" | "for-you" | RailDestinationId | "settings";

const DESTINATIONS = PRIMARY_WORKSPACE_ITEMS.flatMap((item) => {
  const id = DESTINATION_IDS[item.to as keyof typeof DESTINATION_IDS];
  return id ? [{ ...item, id }] : [];
});

/** The label a rail id shows, for toasts and page titles. */
export function kitRailLabel(id: KitRailId): string {
  if (id === "new-session") return "New session";
  if (id === "for-you") return "For you";
  if (id === "settings") return "Settings";
  return DESTINATIONS.find((item) => item.id === id)?.label ?? id;
}

export interface KitRailItemsProps {
  active?: KitRailId | null;
  collapsed?: boolean;
  /** Pending reviews: a dot on Knowledge. */
  knowledgeAttention?: number;
  /** For you's "needs you" count. */
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
  const go = (id: KitRailId) => (event: MouseEvent) => {
    event.preventDefault();
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
      <NavItem
        href="#for-you"
        onClick={go("for-you")}
        icon={<SendIcon />}
        label="For you"
        badge={forYouCount > 0 ? String(forYouCount) : undefined}
        active={active === "for-you"}
        collapsed={collapsed}
        size={size}
      />
      {DESTINATIONS.map((item) => (
        <NavItem
          key={item.id}
          href={`#${item.id}`}
          onClick={go(item.id)}
          icon={<WorkspaceConfigGlyph icon={item.icon} />}
          label={item.label}
          attention={item.id === "knowledge" && knowledgeAttention > 0}
          attentionLabel={`${knowledgeAttention} waiting for review`}
          active={active === item.id}
          collapsed={collapsed}
          size={size}
        />
      ))}
      <NavItem
        href="#settings"
        onClick={go("settings")}
        icon={<SlidersHorizontalIcon />}
        label="Settings"
        active={active === "settings"}
        collapsed={collapsed}
        size={size}
      />
    </>
  );
}
