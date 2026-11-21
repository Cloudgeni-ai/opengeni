/**
 * The customizable sidebar (docs/sidebar-layout.md): the workspace default
 * that admins set, plus each person's own changes on top. Clients ignore item
 * types they don't know, so a newer server never breaks an older client.
 */

import type { SessionAvatar } from "@opengeni/contracts";

/** Where an item comes from: the workspace default, or this person's own. */
export type SidebarItemOrigin = "workspace" | "personal";

export type SidebarLiveListKind = "pinned_apps" | "recent_apps";

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
};

/** An outside https link; open it in a new tab and mark it external. */
export type ResolvedSidebarExternalLink = {
  id: string;
  origin: SidebarItemOrigin;
  type: "link";
  url: string;
  label: string;
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
  };
  workspace: {
    revision: number;
    /** Whether this caller may change the workspace default (workspace admins). */
    canEdit: boolean;
    /** The default before anyone's own changes; for admins only. */
    items?: ResolvedSidebarItem[];
  };
};

type NewSidebarChild =
  | { id?: string; type: "app"; appId: string; path?: string; label?: string }
  | { id?: string; type: "link"; url: string; label: string }
  | { id?: string; type: "live_list"; list: SidebarLiveListKind; label?: string; limit?: number }
  | { id?: string; type: "agent"; agentId: string; label?: string };

/** A new item; the server picks an id when it's omitted. */
export type NewSidebarItem =
  | NewSidebarChild
  | { id?: string; type: "group"; label: string; collapsed?: boolean; items?: NewSidebarChild[] };

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
  | { op: "reset" };

export type UpdateSidebarLayoutRequest = {
  /** `personal`: your own sidebar. `workspace`: everyone's default (workspace admins). */
  scope: "personal" | "workspace";
  changes: SidebarLayoutChange[];
  /** The scope's revision you read; a newer one is refused (409) instead of changed on top. */
  expectedRevision?: number;
};
