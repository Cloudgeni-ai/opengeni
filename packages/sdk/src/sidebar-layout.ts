/**
 * The customizable sidebar (docs/sidebar-layout.md): the workspace default
 * that admins set, plus each person's own changes on top. Clients ignore item
 * types they don't know, so a newer server never breaks an older client.
 */

import type { SessionAvatar } from "@opengeni/contracts";

/** Where an item comes from: the workspace default, or this person's own. */
export type SidebarItemOrigin = "workspace" | "personal";

export type SidebarLiveListKind = "pinned_apps" | "recent_apps";

/**
 * An item's icon: a lucide icon name from `SIDEBAR_ITEM_ICONS` in
 * `@opengeni/contracts/sidebar-layout` (such as `rocket` or `chart-line`).
 * Newer servers may add names; draw the usual mark for one you don't know.
 */
export type SidebarItemIcon = string;

/**
 * Where apps show: as rows in the Sessions list (`sessions`), in an Apps
 * section of their own below Sessions (`section`), or not as rows, their chats
 * listed as ordinary chats (`hidden`).
 */
export type SidebarAppsPlacement = "sessions" | "section" | "hidden";

/** The primary rail's built-in entries a person (or the default) can hide. */
export type SidebarNavEntry =
  | "inbox"
  | "capabilities"
  | "knowledge"
  | "automations"
  | "agents"
  | "meetings"
  | "artifacts"
  | "apps"
  | "get_started";

/** Navigation options as set; unset ones keep today's behaviour (or follow the default). */
export type SidebarLayoutOptions = {
  /** Apps show as rows of their own in the Sessions list (default true); false is the same as appsPlacement `hidden`. */
  sessionsShowApps?: boolean;
  /** Where apps show (default `sessions`). */
  appsPlacement?: SidebarAppsPlacement;
  /** Built-in rail entries left out (default none). */
  hiddenNavEntries?: SidebarNavEntry[];
  /** Settings rail entry ids moved under More; the rest stay at the top (default none). */
  settingsMore?: string[];
  /** Built-in rail entries in order at the top (`new_session`, `inbox`, ..., `setup` for the folded group). */
  navOrder?: string[];
  /** Built-in rail entries inside the folded group, in order. */
  navSetup?: string[];
};

/** The navigation options in effect for this person. */
export type ResolvedSidebarLayoutOptions = {
  /** False only when apps are hidden. */
  sessionsShowApps: boolean;
  /** Absent from servers from before it: read sessionsShowApps then. */
  appsPlacement?: SidebarAppsPlacement;
  hiddenNavEntries: string[];
  /** Null: no settings entry is under More. */
  settingsMore: string[] | null;
  /** Null: the rail's own order. Absent from servers from before it. */
  navOrder?: string[] | null;
  navSetup?: string[] | null;
};

/** A link to an app, optionally one of its pages. */
export type ResolvedSidebarAppLink = {
  id: string;
  origin: SidebarItemOrigin;
  type: "app";
  appId: string;
  /** A page inside the app (`/releases`); null is its home page. */
  path: string | null;
  /** Its own label, else the app's title. */
  label: string;
  icon?: SidebarItemIcon;
};

/** An outside https link; open it in a new tab and mark it external. */
export type ResolvedSidebarExternalLink = {
  id: string;
  origin: SidebarItemOrigin;
  type: "link";
  url: string;
  label: string;
  /** Without one, show the site's icon (`client.getSidebarLinkIcon`). */
  icon?: SidebarItemIcon;
};

/** A list the sidebar fills in itself; `apps` holds only apps this person can open. */
export type ResolvedSidebarLiveList = {
  id: string;
  origin: SidebarItemOrigin;
  type: "live_list";
  /** A `SidebarLiveListKind`; newer servers may add kinds. */
  list: string;
  label: string;
  limit: number;
  apps: { appId: string; title: string }[];
};

export type ResolvedSidebarChild =
  | ResolvedSidebarAppLink
  | ResolvedSidebarExternalLink
  | ResolvedSidebarLiveList
  | ResolvedSidebarAgentLink;

/** A link to an agent's page; only agents this person can see are listed. */
export type ResolvedSidebarAgentLink = {
  id: string;
  origin: SidebarItemOrigin;
  type: "agent";
  agentId: string;
  /** Its own label, else the agent's name. */
  label: string;
  /** The agent's avatar, or its initials when it has none. */
  avatar: SessionAvatar;
};

/** A named, collapsible group of links and lists. */
export type ResolvedSidebarGroup = {
  id: string;
  origin: SidebarItemOrigin;
  type: "group";
  label: string;
  /** Whether it starts collapsed. */
  collapsed: boolean;
  icon?: SidebarItemIcon;
  items: ResolvedSidebarChild[];
};

export type ResolvedSidebarItem = ResolvedSidebarGroup | ResolvedSidebarChild;

export type SidebarLayoutResponse = {
  /** What this person sees, in order; hidden items and apps they can't open are left out. */
  items: ResolvedSidebarItem[];
  /** Workspace items this person hid, to show again. */
  hidden: { parentId: string | null; item: ResolvedSidebarItem }[];
  personal: {
    /** Whether this caller has a sidebar of their own (people do; keys and services don't). */
    available: boolean;
    revision: number;
    /** Whether they changed anything, so Reset applies. */
    customized: boolean;
    /** Their own options, as set. */
    options?: SidebarLayoutOptions;
  };
  workspace: {
    revision: number;
    /** Whether this caller may change the workspace default (workspace admins). */
    canEdit: boolean;
    /** The default before anyone's own changes; for admins only. */
    items?: ResolvedSidebarItem[];
    /** The default's own options, as set; for admins only. */
    options?: SidebarLayoutOptions;
  };
  /** The navigation options in effect; absent from servers from before them (today's behaviour). */
  options?: ResolvedSidebarLayoutOptions;
};

type NewSidebarChild =
  | { id?: string; type: "app"; appId: string; path?: string; label?: string; icon?: string }
  | { id?: string; type: "link"; url: string; label: string; icon?: string }
  | { id?: string; type: "live_list"; list: SidebarLiveListKind; label?: string; limit?: number }
  | { id?: string; type: "agent"; agentId: string; label?: string };

/** A new item; the server picks an id when it's omitted. */
export type NewSidebarItem =
  | NewSidebarChild
  | {
      id?: string;
      type: "group";
      label: string;
      collapsed?: boolean;
      icon?: string;
      items?: NewSidebarChild[];
    };

export type SidebarLayoutChange =
  | {
      op: "add";
      item: NewSidebarItem;
      /** Put it in this group; the top level when omitted. */
      groupId?: string;
      /** Position in its level; the end when omitted. */
      index?: number;
      /** Put it just before this item of its level (instead of `index`). */
      beforeId?: string;
      /** Put it just after this item of its level (instead of `index`). */
      afterId?: string;
    }
  | {
      op: "update";
      itemId: string;
      label?: string | null;
      path?: string | null;
      url?: string;
      collapsed?: boolean;
      limit?: number | null;
      /** App links, outside links and groups; null removes it. */
      icon?: string | null;
    }
  /** Personal: hides a workspace item or deletes your own. Workspace: deletes it. */
  | { op: "remove"; itemId: string }
  /** Personal: shows a workspace item you hid. */
  | { op: "show"; itemId: string }
  /**
   * Reorder, or (your own items) move to another group. Prefer `beforeId` or
   * `afterId`: the stored level can hold items you don't see, so an `index`
   * counts those too. The end of the level when none is given.
   */
  | {
      op: "move";
      itemId: string;
      groupId?: string | null;
      index?: number;
      beforeId?: string;
      afterId?: string;
    }
  /** Personal: back to the workspace default. Workspace: empties the default. */
  | { op: "reset" }
  /** Navigation options for the scope; null clears one (personal: back to the default's). */
  | {
      op: "options";
      /** Also sets appsPlacement: false is `hidden`, true is `sessions`. */
      sessionsShowApps?: boolean | null;
      /** Also sets sessionsShowApps; wins over it in the same change. */
      appsPlacement?: SidebarAppsPlacement | null;
      hiddenNavEntries?: SidebarNavEntry[] | null;
      settingsMore?: string[] | null;
      navOrder?: string[] | null;
      navSetup?: string[] | null;
    };

export type UpdateSidebarLayoutRequest = {
  /** `personal`: your own sidebar. `workspace`: everyone's default (workspace admins). */
  scope: "personal" | "workspace";
  changes: SidebarLayoutChange[];
  /** The scope's revision you read; a newer one is refused (409) instead of changed on top. */
  expectedRevision?: number;
};
