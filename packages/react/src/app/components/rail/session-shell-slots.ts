// The surface-owned slots of the session shell, in a module of their own so
// the rail's parts (the sessions list among them) can read them without
// importing the shell.
import { createContext, type ReactNode } from "react";
import type { WindowBarCrumb } from "../../../ui/window-bar-title";

/**
 * The surface-owned sections of the session shell. Every slot is optional: a
 * surface without a workspace switcher, workspace navigation or footer simply
 * leaves them out and the shell keeps its layout.
 */
export type SessionShellSlots = Readonly<{
  /** The workspace switcher under the brand row (or under the window controls). */
  switcher?: ReactNode;
  /** Primary navigation after "New session" (inbox, workspace shortcuts). */
  primaryNav?: ReactNode;
  /**
   * The primary navigation renders "New session" itself (RailNewSessionLink),
   * among its entries, so the person can order it; the rail leaves out its own.
   */
  primaryNavPlacesNewSession?: boolean;
  /**
   * The workspace's customizable links and groups (docs/sidebar-layout.md),
   * under the primary navigation and above the sessions.
   */
  layout?: ReactNode;
  /**
   * The phone drawer's "Workspace" tab. Without it, phones show the sessions
   * list alone, with no tabs.
   */
  mobileWorkspacePanel?: ReactNode;
  /** Pinned under the rail's scroll viewport: account menu, offers. */
  railFooter?: ReactNode;
  /** Notices across the top of the canvas, under the top strip. */
  canvasBanners?: ReactNode;
  /**
   * The rail section a page is in ("Agents"), first in the macOS window bar's
   * trail. Null where the page is the section itself or in none.
   */
  windowBarSection?: ((pathname: string) => WindowBarCrumb | null) | undefined;
  /**
   * Whether apps show as rows of their own in the Sessions list, their chats
   * under them (docs/sidebar-layout.md, `sessionsShowApps`). False lists an
   * app's chats as ordinary chats. Null: not known yet, so the list waits
   * (showing its loading state) rather than drawing app rows and then
   * redrawing. Default true.
   */
  sessionsShowApps?: boolean | null | undefined;
  /**
   * Where apps show (docs/sidebar-layout.md, `appsPlacement`): rows in the
   * Sessions list, an Apps section of their own below Sessions, or hidden (as
   * `sessionsShowApps: false`). Null: not known yet, so the list waits.
   * Unset: `sessionsShowApps` decides.
   */
  appsPlacement?: "sessions" | "section" | "hidden" | null | undefined;
  /** Changes the person's apps placement; the list's view menu offers it only with this. */
  onAppsPlacementChange?: ((placement: "sessions" | "section" | "hidden") => void) | undefined;
  /**
   * "Add to sidebar" in an app row's menu: `has` says whether the app is
   * already in the person's sidebar (the item is left out then).
   */
  sidebarApps?: { has: (appId: string) => boolean; add: (appId: string) => void } | undefined;
}>;

export const SessionShellSlotsContext = createContext<SessionShellSlots>({});
