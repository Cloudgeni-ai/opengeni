import { defineSchema } from "./define-schema";
import { z } from "zod";
import { SessionAvatar } from "./bots";

/**
 * The customizable sidebar (docs/sidebar-layout.md): a workspace default that
 * admins set, plus each person's own changes on top (hide, add, reorder,
 * reset). Items are groups, links to an app (optionally one of its pages),
 * links to an agent's page, https links, and live lists such as pinned or
 * recent apps.
 *
 * Mixed versions: readers ignore item types they don't know, and writers
 * keep stored items they don't know untouched, so web, desktop and phone
 * clients (and API replicas during a rolling deploy) of different versions
 * never break each other's layouts.
 */

export const SIDEBAR_LAYOUT_VERSION = 1;
/** Top-level items in one layout (workspace default or a person's additions). */
export const SIDEBAR_LAYOUT_MAX_ITEMS = 50;
/** Items inside one group. */
export const SIDEBAR_GROUP_MAX_ITEMS = 50;
/** Changes in one update request. */
export const SIDEBAR_LAYOUT_MAX_CHANGES = 50;
export const SIDEBAR_LABEL_MAX_CHARS = 80;
export const SIDEBAR_URL_MAX_CHARS = 2048;
/** Apps a live list shows by default, and at most. */
export const SIDEBAR_LIVE_LIST_DEFAULT_LIMIT = 5;
export const SIDEBAR_LIVE_LIST_MAX_LIMIT = 20;
/** Phones show at most this many apps per live list. */
export const SIDEBAR_LIVE_LIST_MOBILE_LIMIT = 3;

export const SidebarLiveListKind = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    /** Apps pinned in the workspace's Artifacts library (shared pins). */
    "pinned_apps",
    /** Apps this person opened most recently. */
    "recent_apps",
  ]),
);
export type SidebarLiveListKind = z.infer<typeof SidebarLiveListKind>;

/** A live list's label when it has none of its own. */
export const SIDEBAR_LIVE_LIST_LABELS: Record<SidebarLiveListKind, string> = {
  pinned_apps: "Pinned apps",
  recent_apps: "Recent apps",
};

/**
 * The icons a sidebar item may carry: lucide icon names (lucide.dev), drawn
 * the same on web and phone. An item without one keeps its usual mark (an
 * outside link shows its site's icon).
 */
export const SIDEBAR_ITEM_ICONS = [
  "app-window",
  "layout-dashboard",
  "layout-grid",
  "file-text",
  "book-open",
  "notebook-pen",
  "chart-line",
  "chart-column",
  "table-2",
  "list-checks",
  "calendar",
  "clock",
  "folder",
  "inbox",
  "mail",
  "message-square",
  "users",
  "bot",
  "globe",
  "link",
  "house",
  "store",
  "briefcase",
  "receipt",
  "rocket",
  "star",
  "heart",
  "flag",
  "bookmark",
  "target",
  "zap",
  "sparkles",
  "lightbulb",
  "megaphone",
  "shield-check",
  "code",
  "terminal",
  "database",
  "server",
  "git-pull-request",
  "bug",
  "wrench",
  "flask-conical",
  "pen-tool",
  "image",
  "graduation-cap",
  "map",
  "package",
] as const;

export const SidebarItemIcon = /* @__PURE__ */ defineSchema(() => z.enum(SIDEBAR_ITEM_ICONS));
export type SidebarItemIcon = (typeof SIDEBAR_ITEM_ICONS)[number];

/** Whether `value` is an icon this version draws. */
export function isSidebarItemIcon(value: unknown): value is SidebarItemIcon {
  return typeof value === "string" && (SIDEBAR_ITEM_ICONS as readonly string[]).includes(value);
}

/** The primary rail's built-in entries, which a person (or the default) can hide. */
export const SIDEBAR_NAV_ENTRIES = [
  "inbox",
  "capabilities",
  "knowledge",
  "automations",
  "agents",
  "meetings",
  "artifacts",
  "apps",
  "get_started",
] as const;
export const SidebarNavEntry = /* @__PURE__ */ defineSchema(() => z.enum(SIDEBAR_NAV_ENTRIES));
export type SidebarNavEntry = (typeof SIDEBAR_NAV_ENTRIES)[number];

/** Settings pages a person moves under More in the settings rail, at most. */
export const SIDEBAR_SETTINGS_MORE_MAX = 100;

/** A settings rail entry's id, such as `workspace:general` or `organization:members`. */
const SettingsEntryId = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9:/$_-]+$/, "Use a settings entry id such as workspace:general"),
);

/**
 * How the rest of the navigation looks, beside the items: each is unset by
 * default, which keeps today's behaviour, and a person's own choice wins
 * over the workspace default's.
 */
export const SidebarLayoutOptions = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** Apps show as rows of their own in the Sessions list, their chats under them (default true). */
      sessionsShowApps: z.boolean().optional(),
      /** Built-in rail entries left out (default none). */
      hiddenNavEntries: z.array(SidebarNavEntry).max(SIDEBAR_NAV_ENTRIES.length).optional(),
      /** Settings entries moved under More in the settings rail; the rest stay at the top (default none). */
      settingsMore: z.array(SettingsEntryId).max(SIDEBAR_SETTINGS_MORE_MAX).optional(),
    })
    .strict(),
);
export type SidebarLayoutOptions = z.infer<typeof SidebarLayoutOptions>;

/** The options in effect for a person, after their own choices and the default's. */
export const ResolvedSidebarLayoutOptions = /* @__PURE__ */ defineSchema(() =>
  z.object({
    sessionsShowApps: z.boolean(),
    hiddenNavEntries: z.array(z.string()),
    /** Null: no settings entry is under More. */
    settingsMore: z.array(z.string()).nullable(),
  }),
);
export type ResolvedSidebarLayoutOptions = z.infer<typeof ResolvedSidebarLayoutOptions>;

export const DEFAULT_SIDEBAR_LAYOUT_OPTIONS: ResolvedSidebarLayoutOptions = {
  sessionsShowApps: true,
  hiddenNavEntries: [],
  settingsMore: null,
};

/** The option keys this version knows, from its schema. */
function sidebarOptionKeys(): readonly string[] {
  return Object.keys(SidebarLayoutOptions.shape);
}

/**
 * Stored options, read leniently. Values this version reads are tidied
 * (duplicates and malformed entries drop); everything else stays as it is,
 * options a newer version added and values a newer version widened alike, so
 * this version's writes keep them. Read them with knownSidebarOptions.
 */
export function readStoredSidebarOptions(value: unknown): SidebarLayoutOptions {
  if (!isRecord(value)) return {};
  const strings = (list: unknown, max: number) =>
    Array.isArray(list)
      ? [
          ...new Set(
            list.filter(
              (entry): entry is string =>
                typeof entry === "string" && SettingsEntryId.safeParse(entry).success,
            ),
          ),
        ].slice(0, max)
      : undefined;
  const hidden = strings(value.hiddenNavEntries, 32);
  const more = strings(value.settingsMore, SIDEBAR_SETTINGS_MORE_MAX);
  return {
    ...value,
    ...(hidden ? { hiddenNavEntries: hidden as SidebarNavEntry[] } : {}),
    ...(more ? { settingsMore: more } : {}),
  } as SidebarLayoutOptions;
}

/** The options in effect: a person's own choice, else the default's, else today's behaviour. */
export function mergeSidebarOptions(
  workspace: SidebarLayoutOptions | undefined,
  personal: SidebarLayoutOptions | undefined,
): ResolvedSidebarLayoutOptions {
  const own = knownSidebarOptions(personal);
  const shared = knownSidebarOptions(workspace);
  return {
    sessionsShowApps:
      own?.sessionsShowApps ??
      shared?.sessionsShowApps ??
      DEFAULT_SIDEBAR_LAYOUT_OPTIONS.sessionsShowApps,
    hiddenNavEntries: [...(own?.hiddenNavEntries ?? shared?.hiddenNavEntries ?? [])],
    settingsMore: own?.settingsMore ?? shared?.settingsMore ?? null,
  };
}

/** Read a layout answer's options leniently: a server from before them shows today's behaviour. */
export function readResolvedSidebarOptions(value: unknown): ResolvedSidebarLayoutOptions {
  return mergeSidebarOptions(readStoredSidebarOptions(value), undefined);
}

/**
 * Stored options as this version reads them, for answers: options a newer
 * version added, values it widened and rail entries it added are left out
 * (storage keeps them).
 */
export function knownSidebarOptions(
  options: SidebarLayoutOptions | undefined,
): SidebarLayoutOptions | undefined {
  if (!options) return undefined;
  const known: SidebarLayoutOptions = {};
  const { sessionsShowApps, hiddenNavEntries, settingsMore } = options as Record<string, unknown>;
  if (typeof sessionsShowApps === "boolean") known.sessionsShowApps = sessionsShowApps;
  if (Array.isArray(hiddenNavEntries))
    known.hiddenNavEntries = hiddenNavEntries.filter((entry): entry is SidebarNavEntry =>
      (SIDEBAR_NAV_ENTRIES as readonly unknown[]).includes(entry),
    );
  if (Array.isArray(settingsMore))
    known.settingsMore = settingsMore.filter((entry): entry is string => typeof entry === "string");
  // Every option the schema has is read above.
  return known;
}

export const SidebarItemId = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, "Use 1-64 letters, digits, - or _")
    .refine((value) => value !== SIDEBAR_ROOT_KEY, "This id is reserved"),
);

/** The key of the top level in `SidebarPersonalChanges.order`. */
export const SIDEBAR_ROOT_KEY = "root";

const Label = /* @__PURE__ */ defineSchema(() =>
  z.string().trim().min(1).max(SIDEBAR_LABEL_MAX_CHARS),
);

/** Whether `value` is a page path inside an app: `/releases`, `/admin?tab=2#top`. */
export function isSidebarAppPath(value: string): boolean {
  return (
    value.length <= SIDEBAR_URL_MAX_CHARS &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    // No control characters or whitespace; encode them in the path.
    !/[\u0000-\u0020\u007f]/u.test(value)
  );
}

/** Whether `value` is an outside link the sidebar may show: https only, no credentials. */
export function isSidebarExternalUrl(value: string): boolean {
  if (value.length > SIDEBAR_URL_MAX_CHARS || /[\u0000-\u0020\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.hostname !== "";
  } catch {
    return false;
  }
}

export const SidebarAppPath = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .trim()
    .refine(isSidebarAppPath, "An app page path starts with / (for example /releases)"),
);

export const SidebarExternalUrl = /* @__PURE__ */ defineSchema(() =>
  z.string().trim().refine(isSidebarExternalUrl, "Outside links must be https:// addresses"),
);

/** A link to an app, optionally one of its pages ("Releases" opens `/releases`). */
export const SidebarAppLinkItem = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: SidebarItemId,
      type: z.literal("app"),
      appId: z.string().uuid(),
      /** A page inside the app; its home page when omitted. */
      path: SidebarAppPath.optional(),
      /** Shown instead of the app's own title. */
      label: Label.optional(),
      /** Shown instead of the app mark. */
      icon: SidebarItemIcon.optional(),
    })
    .strict(),
);
export type SidebarAppLinkItem = z.infer<typeof SidebarAppLinkItem>;

/** An outside https link; it opens in a new tab and is marked external. */
export const SidebarExternalLinkItem = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: SidebarItemId,
      type: z.literal("link"),
      url: SidebarExternalUrl,
      label: Label,
      /** Shown instead of the site's own icon. */
      icon: SidebarItemIcon.optional(),
    })
    .strict(),
);
export type SidebarExternalLinkItem = z.infer<typeof SidebarExternalLinkItem>;

/** A link to an agent's page; it shows the agent's name and avatar. */
export const SidebarAgentLinkItem = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: SidebarItemId,
      type: z.literal("agent"),
      agentId: z.string().uuid(),
      /** Shown instead of the agent's own name. */
      label: Label.optional(),
    })
    .strict(),
);
export type SidebarAgentLinkItem = z.infer<typeof SidebarAgentLinkItem>;

/** A list the sidebar fills in itself, such as pinned or recent apps. */
export const SidebarLiveListItem = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: SidebarItemId,
      type: z.literal("live_list"),
      list: SidebarLiveListKind,
      label: Label.optional(),
      limit: z.number().int().min(1).max(SIDEBAR_LIVE_LIST_MAX_LIMIT).optional(),
    })
    .strict(),
);
export type SidebarLiveListItem = z.infer<typeof SidebarLiveListItem>;

export const SidebarChildItem = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("type", [
    SidebarAppLinkItem,
    SidebarExternalLinkItem,
    SidebarLiveListItem,
    SidebarAgentLinkItem,
  ]),
);
export type SidebarChildItem = z.infer<typeof SidebarChildItem>;

/** A named, collapsible group of links and lists (groups don't nest). */
export const SidebarGroupItem = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: SidebarItemId,
      type: z.literal("group"),
      label: Label,
      /** Starts collapsed; each person's open/closed choice is kept on their device. */
      collapsed: z.boolean().optional(),
      /** Shown beside its name. */
      icon: SidebarItemIcon.optional(),
      items: z.array(SidebarChildItem).max(SIDEBAR_GROUP_MAX_ITEMS),
    })
    .strict(),
);
export type SidebarGroupItem = z.infer<typeof SidebarGroupItem>;

export const SidebarItem = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("type", [
    SidebarGroupItem,
    SidebarAppLinkItem,
    SidebarExternalLinkItem,
    SidebarLiveListItem,
    SidebarAgentLinkItem,
  ]),
);
export type SidebarItem = z.infer<typeof SidebarItem>;
export type SidebarItemType = SidebarItem["type"];

/** Built-in item types; anything else is an item from a newer version. */
export const SIDEBAR_ITEM_TYPES: readonly SidebarItemType[] = [
  "group",
  "app",
  "link",
  "live_list",
  "agent",
];

/**
 * Stored items as JSON. Known types are validated on write; unknown ones
 * (written by a newer version) are kept as they are.
 */
export type StoredSidebarItem = { id: string; type: string; [key: string]: unknown };

/**
 * The workspace default, as stored. Fields a newer version added (here and
 * in `options`) are kept as they are when this version writes, so API
 * replicas of different versions never drop each other's settings during a
 * rolling deploy.
 */
export type StoredSidebarLayout = {
  version: number;
  items: StoredSidebarItem[];
  /** Navigation options for everyone; unset keeps today's behaviour. */
  options?: SidebarLayoutOptions;
  [field: string]: unknown;
};

/** A person's own changes on top of the workspace default, as stored; newer fields are kept too. */
export type StoredSidebarPersonalChanges = {
  version: number;
  /** Workspace items this person hid. */
  hidden: string[];
  /** This person's own items; `parentId` is a group's id, or null for the top level. */
  added: { parentId: string | null; item: StoredSidebarItem }[];
  /** This person's order per level: `root` or a group's id → item ids. */
  order: Record<string, string[]>;
  /** This person's own navigation options, over the default's. */
  options?: SidebarLayoutOptions;
  [field: string]: unknown;
};

export const EMPTY_SIDEBAR_LAYOUT: StoredSidebarLayout = {
  version: SIDEBAR_LAYOUT_VERSION,
  items: [],
};

/** The id of the built-in default's Pinned apps list. */
export const SIDEBAR_BUILT_IN_PINNED_APPS_ID = "pinned-apps";

/**
 * The default of a workspace whose admins never changed it: the workspace's
 * pinned apps. Clients leave out a live list with no apps, so a workspace
 * without pins sees nothing. The first change to the default starts from
 * this, so admins can remove it or build around it.
 */
export const BUILT_IN_SIDEBAR_LAYOUT: StoredSidebarLayout = {
  version: SIDEBAR_LAYOUT_VERSION,
  items: [{ id: SIDEBAR_BUILT_IN_PINNED_APPS_ID, type: "live_list", list: "pinned_apps" }],
};

/**
 * The workspace default from its stored row: the built-in default when no
 * admin ever saved one, else the saved layout as it is (an empty saved
 * layout stays empty).
 */
export function readWorkspaceSidebarLayout(
  row: { layout: unknown } | null | undefined,
): StoredSidebarLayout {
  return row ? readStoredSidebarLayout(row.layout) : structuredClone(BUILT_IN_SIDEBAR_LAYOUT);
}

export const EMPTY_SIDEBAR_PERSONAL_CHANGES: StoredSidebarPersonalChanges = {
  version: SIDEBAR_LAYOUT_VERSION,
  hidden: [],
  added: [],
  order: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SIDEBAR_LAYOUT_KEYS: ReadonlySet<string> = new Set(["version", "items", "options"]);
const SIDEBAR_PERSONAL_KEYS: ReadonlySet<string> = new Set([
  "version",
  "hidden",
  "added",
  "order",
  "options",
]);

/** The fields of `value` this version doesn't know (a newer version wrote them), as they are. */
function fieldsBeyond(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
}

/**
 * The stored version: a newer version's number stays, so its own fields stay
 * meaningful. So a version bump must keep layouts readable and writable by
 * older versions (new fields and values only, never a changed meaning).
 */
function storedVersion(value: unknown): number {
  return typeof value === "number" && value > SIDEBAR_LAYOUT_VERSION
    ? value
    : SIDEBAR_LAYOUT_VERSION;
}

function storedItem(value: unknown): StoredSidebarItem | null {
  if (!isRecord(value)) return null;
  const { id, type } = value;
  if (typeof id !== "string" || !SidebarItemId.safeParse(id).success) return null;
  if (typeof type !== "string" || type.length < 1 || type.length > 64) return null;
  if (type === "group") {
    const items = Array.isArray(value.items) ? value.items : [];
    return {
      ...value,
      id,
      type,
      items: items.map(storedItem).filter((item): item is StoredSidebarItem => item !== null),
    };
  }
  return { ...value, id, type };
}

/** Read a stored workspace layout leniently: malformed entries drop, unknown types and fields stay. */
export function readStoredSidebarLayout(value: unknown): StoredSidebarLayout {
  if (!isRecord(value) || !Array.isArray(value.items)) return EMPTY_SIDEBAR_LAYOUT;
  const options = readStoredSidebarOptions(value.options);
  return {
    ...fieldsBeyond(value, SIDEBAR_LAYOUT_KEYS),
    version: storedVersion(value.version),
    items: value.items.map(storedItem).filter((item): item is StoredSidebarItem => item !== null),
    ...(Object.keys(options).length ? { options } : {}),
  };
}

/** Read stored personal changes leniently; fields a newer version added stay. */
export function readStoredSidebarPersonalChanges(value: unknown): StoredSidebarPersonalChanges {
  if (!isRecord(value)) return EMPTY_SIDEBAR_PERSONAL_CHANGES;
  const ids = (list: unknown) =>
    Array.isArray(list)
      ? [...new Set(list.filter((id): id is string => typeof id === "string"))]
      : [];
  const added = Array.isArray(value.added)
    ? value.added.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const item = storedItem(entry.item);
        if (!item) return [];
        const parentId = typeof entry.parentId === "string" ? entry.parentId : null;
        // Fields a newer version added to the entry stay.
        return [{ ...entry, parentId, item }];
      })
    : [];
  const order: Record<string, string[]> = {};
  if (isRecord(value.order))
    for (const [key, list] of Object.entries(value.order)) order[key] = ids(list);
  const options = readStoredSidebarOptions(value.options);
  return {
    ...fieldsBeyond(value, SIDEBAR_PERSONAL_KEYS),
    version: storedVersion(value.version),
    hidden: ids(value.hidden),
    added,
    order,
    ...(Object.keys(options).length ? { options } : {}),
  };
}

function knownFields(item: StoredSidebarItem): StoredSidebarItem {
  const shape =
    item.type === "app"
      ? SidebarAppLinkItem.shape
      : item.type === "link"
        ? SidebarExternalLinkItem.shape
        : item.type === "live_list"
          ? SidebarLiveListItem.shape
          : item.type === "agent"
            ? SidebarAgentLinkItem.shape
            : item.type === "group"
              ? SidebarGroupItem.shape
              : null;
  if (!shape) return item;
  // An icon a newer version added is left out here, so the item still shows.
  return Object.fromEntries(
    Object.entries(item).filter(
      ([key, value]) => Object.hasOwn(shape, key) && (key !== "icon" || isSidebarItemIcon(value)),
    ),
  ) as StoredSidebarItem;
}

/**
 * A stored item as a built-in type, or null when it's malformed or from a
 * newer version. Fields a newer version added are ignored here (and kept in
 * storage), so an older reader still shows the item.
 */
export function knownSidebarItem(item: StoredSidebarItem): SidebarItem | null {
  if (item.type === "group") {
    // A group from this version may hold children from a newer one: keep the group.
    const children = Array.isArray(item.items) ? (item.items as StoredSidebarItem[]) : [];
    const parsed = SidebarGroupItem.safeParse({
      ...knownFields(item),
      items: children.flatMap((child) => {
        const known = knownSidebarItem(child);
        return known && known.type !== "group" ? [known] : [];
      }),
    });
    return parsed.success ? parsed.data : null;
  }
  const parsed = SidebarItem.safeParse(knownFields(item));
  return parsed.success ? parsed.data : null;
}

export type SidebarItemOrigin = "workspace" | "personal";

/** One level of the layout a person sees, before app titles and permissions are applied. */
export type MergedSidebarChild = SidebarChildItem & { origin: SidebarItemOrigin };
export type MergedSidebarGroup = Omit<SidebarGroupItem, "items"> & {
  origin: SidebarItemOrigin;
  items: MergedSidebarChild[];
};
export type MergedSidebarItem = MergedSidebarChild | MergedSidebarGroup;

export type MergedSidebarLayout = {
  items: MergedSidebarItem[];
  /** Workspace items this person hid, with the group they're in (null: top level). */
  hidden: { parentId: string | null; item: MergedSidebarItem }[];
};

function orderLevel<T extends { id: string }>(items: T[], order: string[] | undefined): T[] {
  if (!order?.length) return items;
  const rank = new Map(order.map((id, index) => [id, index]));
  // Ordered items first, by this person's order; the rest (added since) keep theirs.
  return [
    ...items.filter((item) => rank.has(item.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!),
    ...items.filter((item) => !rank.has(item.id)),
  ];
}

/**
 * The layout a person sees: the workspace default with their own changes on
 * top. Unknown and malformed items are left out. Doesn't check access; the
 * API drops what the person can't open.
 */
export function mergeSidebarLayout(
  workspace: StoredSidebarLayout,
  personal: StoredSidebarPersonalChanges,
): MergedSidebarLayout {
  const hiddenIds = new Set(personal.hidden);
  const hidden: MergedSidebarLayout["hidden"] = [];
  const root: MergedSidebarItem[] = [];
  const groups = new Map<string, MergedSidebarChild[]>();
  const seen = new Set<string>();
  const placeChild = (
    item: StoredSidebarItem,
    origin: SidebarItemOrigin,
    parentId: string | null,
    level: MergedSidebarItem[],
  ) => {
    const known = knownSidebarItem(item);
    if (!known || known.type === "group" || seen.has(known.id)) return;
    seen.add(known.id);
    const merged: MergedSidebarChild = { ...known, origin };
    if (origin === "workspace" && hiddenIds.has(known.id)) {
      hidden.push({ parentId, item: merged });
      return;
    }
    level.push(merged);
  };
  const place = (item: StoredSidebarItem, origin: SidebarItemOrigin) => {
    const known = knownSidebarItem(item);
    if (!known || seen.has(known.id)) return;
    if (known.type !== "group") return placeChild(item, origin, null, root);
    seen.add(known.id);
    const children: MergedSidebarChild[] = [];
    const { items: _items, ...rest } = known;
    const merged: MergedSidebarGroup = { ...rest, origin, items: children };
    for (const child of (item.items as StoredSidebarItem[] | undefined) ?? [])
      placeChild(child, origin, known.id, children as MergedSidebarItem[]);
    if (origin === "workspace" && hiddenIds.has(known.id)) {
      hidden.push({ parentId: null, item: merged });
      return;
    }
    groups.set(known.id, children);
    root.push(merged);
  };
  for (const item of workspace.items) place(item, "workspace");
  // Top-level additions first, so a person's own group exists for their items in it.
  const additions = [
    ...personal.added.filter((entry) => entry.parentId === null || entry.item.type === "group"),
    ...personal.added.filter((entry) => entry.parentId !== null && entry.item.type !== "group"),
  ];
  for (const { parentId, item } of additions) {
    const group = parentId !== null && item.type !== "group" ? groups.get(parentId) : undefined;
    // An item whose group is gone (or hidden) stays visible at the top level.
    if (group) placeChild(item, "personal", parentId, group as MergedSidebarItem[]);
    else place(item, "personal");
  }
  const sortGroup = (item: MergedSidebarItem): MergedSidebarItem =>
    item.type === "group"
      ? { ...item, items: orderLevel(item.items, personal.order[item.id]) }
      : item;
  return {
    items: orderLevel(root, personal.order[SIDEBAR_ROOT_KEY]).map(sortGroup),
    hidden,
  };
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/**
 * A new item's id; the server makes one when it's omitted. A person's own
 * items always get ids starting with `my-` (`SIDEBAR_PERSONAL_ID_PREFIX`): a
 * given id without it is prefixed (`docs` becomes `my-docs`), so read the id
 * back from the answer. Workspace ids can't start with `my-`.
 */
const NewItemId = /* @__PURE__ */ defineSchema(() => SidebarItemId.optional());

/** A new item; the server picks an id when it's omitted. */
export const NewSidebarItem = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        id: NewItemId,
        type: z.literal("group"),
        label: Label,
        collapsed: z.boolean().optional(),
        icon: SidebarItemIcon.optional(),
        items: z
          .array(
            z.discriminatedUnion("type", [
              SidebarAppLinkItem.extend({ id: NewItemId }),
              SidebarExternalLinkItem.extend({ id: NewItemId }),
              SidebarLiveListItem.extend({ id: NewItemId }),
              SidebarAgentLinkItem.extend({ id: NewItemId }),
            ]),
          )
          .max(SIDEBAR_GROUP_MAX_ITEMS)
          .optional(),
      })
      .strict(),
    SidebarAppLinkItem.extend({ id: NewItemId }),
    SidebarExternalLinkItem.extend({ id: NewItemId }),
    SidebarLiveListItem.extend({ id: NewItemId }),
    SidebarAgentLinkItem.extend({ id: NewItemId }),
  ]),
);
export type NewSidebarItem = z.infer<typeof NewSidebarItem>;

/**
 * One change. Where `add` and `move` put an item (docs/sidebar-layout.md,
 * "Placement"): `beforeId` if given, else `afterId`, else `index`, else the
 * end of the level; give only one. A neighbour must be in the target level
 * (the group named by `groupId`, else the top level for `add` and the item's
 * current level for `move`). `index` counts the level including items the
 * caller can't see (for a person's changes, the default's items they haven't
 * hidden plus their own), and is clamped to its length. In a person's own
 * changes a default item stays in the group the admin put it in; only their
 * own items change groups.
 */
export const SidebarLayoutChange = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("op", [
    z
      .object({
        op: z.literal("add"),
        item: NewSidebarItem,
        /** Put it in this group (not for groups); the top level when omitted. */
        groupId: SidebarItemId.optional(),
        /** Position in its level; the end when omitted. */
        index: z.number().int().min(0).optional(),
        /** Put it just before this item of its level (instead of `index`). */
        beforeId: SidebarItemId.optional(),
        /** Put it just after this item of its level (instead of `index`). */
        afterId: SidebarItemId.optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal("update"),
        itemId: SidebarItemId,
        label: Label.nullable().optional(),
        /** App links: the page inside the app; null is its home page. */
        path: SidebarAppPath.nullable().optional(),
        url: SidebarExternalUrl.optional(),
        collapsed: z.boolean().optional(),
        limit: z.number().int().min(1).max(SIDEBAR_LIVE_LIST_MAX_LIMIT).nullable().optional(),
        /** App links, outside links and groups: an icon from SIDEBAR_ITEM_ICONS; null removes it. */
        icon: SidebarItemIcon.nullable().optional(),
      })
      .strict(),
    z
      .object({
        op: z.literal("remove"),
        itemId: SidebarItemId,
      })
      .strict(),
    z
      .object({
        op: z.literal("show"),
        itemId: SidebarItemId,
      })
      .strict(),
    z
      .object({
        op: z.literal("move"),
        itemId: SidebarItemId,
        /** Into this group, or null for the top level; its current level when omitted. */
        groupId: SidebarItemId.nullable().optional(),
        /**
         * Position among the level's items. Prefer `beforeId` or `afterId`: the
         * stored level can hold items a reader doesn't see, so a neighbour is
         * exact where an index may not be. The end when none is given.
         */
        index: z.number().int().min(0).optional(),
        /** Put it just before this item of the target level. */
        beforeId: SidebarItemId.optional(),
        /** Put it just after this item of the target level. */
        afterId: SidebarItemId.optional(),
      })
      .strict(),
    z.object({ op: z.literal("reset") }).strict(),
    z
      .object({
        /**
         * Navigation options (see SidebarLayoutOptions). Each one given is
         * set; null clears it, back to the default's (personal) or today's
         * behaviour (workspace).
         */
        op: z.literal("options"),
        sessionsShowApps: z.boolean().nullable().optional(),
        hiddenNavEntries: z
          .array(SidebarNavEntry)
          .max(SIDEBAR_NAV_ENTRIES.length)
          .nullable()
          .optional(),
        settingsMore: z.array(SettingsEntryId).max(SIDEBAR_SETTINGS_MORE_MAX).nullable().optional(),
      })
      .strict(),
  ]),
);
export type SidebarLayoutChange = z.infer<typeof SidebarLayoutChange>;

export const SidebarLayoutScope = /* @__PURE__ */ defineSchema(() =>
  z.enum(["personal", "workspace"]),
);
export type SidebarLayoutScope = z.infer<typeof SidebarLayoutScope>;

export const UpdateSidebarLayoutRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** `personal`: your own sidebar. `workspace`: everyone's default (admins). */
      scope: SidebarLayoutScope,
      changes: z.array(SidebarLayoutChange).min(1).max(SIDEBAR_LAYOUT_MAX_CHANGES),
      /** The scope's revision you read; a newer one is refused instead of overwritten. */
      expectedRevision: z.number().int().min(0).optional(),
    })
    .strict(),
);
export type UpdateSidebarLayoutRequest = z.infer<typeof UpdateSidebarLayoutRequest>;

/** A change that can't apply to the layout as it is now (unknown item, full group). */
export class SidebarLayoutChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidebarLayoutChangeError";
  }
}

/** A change that would go over a limit (items in the sidebar or a group). */
export class SidebarLayoutLimitError extends SidebarLayoutChangeError {
  constructor(message: string) {
    super(message);
    this.name = "SidebarLayoutLimitError";
  }
}

/**
 * Ids of a person's own items start with this, and workspace items' never do,
 * so an item an admin adds later can't take the id of someone's own item.
 */
export const SIDEBAR_PERSONAL_ID_PREFIX = "my-";

function newItemId(
  item: { type: string },
  taken: Set<string>,
  randomId: () => string,
  prefix: string,
): string {
  for (;;) {
    const id = `${prefix}${item.type === "live_list" ? "list" : item.type}-${randomId()}`;
    if (!taken.has(id)) return id;
  }
}

function assignIds(
  item: NewSidebarItem,
  taken: Set<string>,
  randomId: () => string,
  scope: "workspace" | "personal",
): StoredSidebarItem {
  const prefix = scope === "personal" ? SIDEBAR_PERSONAL_ID_PREFIX : "";
  const take = (candidate: { id?: string | undefined; type: string }) => {
    let id = candidate.id;
    if (id !== undefined && scope === "workspace" && id.startsWith(SIDEBAR_PERSONAL_ID_PREFIX))
      throw new SidebarLayoutChangeError(
        `Ids starting with "${SIDEBAR_PERSONAL_ID_PREFIX}" are for people's own items`,
      );
    if (id !== undefined && !id.startsWith(prefix)) id = `${prefix}${id}`.slice(0, 64);
    if (id !== undefined && taken.has(id))
      throw new SidebarLayoutChangeError(`An item with id "${id}" already exists`);
    id ??= newItemId(candidate, taken, randomId, prefix);
    taken.add(id);
    return id;
  };
  if (item.type === "group") {
    const id = take(item);
    const children = (item.items ?? []).map((child) => ({ ...child, id: take(child) }));
    return {
      id,
      type: "group",
      label: item.label,
      ...(item.icon ? { icon: item.icon } : {}),
      ...(item.collapsed !== undefined ? { collapsed: item.collapsed } : {}),
      items: children,
    };
  }
  return { ...item, id: take(item) } as StoredSidebarItem;
}

function collectIds(items: StoredSidebarItem[], into = new Set<string>()): Set<string> {
  for (const item of items) {
    into.add(item.id);
    if (item.type === "group" && Array.isArray(item.items))
      collectIds(item.items as StoredSidebarItem[], into);
  }
  return into;
}

type Located = { level: StoredSidebarItem[]; index: number; parent: StoredSidebarItem | null };

function locate(items: StoredSidebarItem[], id: string): Located | null {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.id === id) return { level: items, index, parent: null };
    if (item.type === "group" && Array.isArray(item.items)) {
      const children = item.items as StoredSidebarItem[];
      const childIndex = children.findIndex((child) => child.id === id);
      if (childIndex >= 0) return { level: children, index: childIndex, parent: item };
    }
  }
  return null;
}

function levelIds(level: readonly StoredSidebarItem[]): string[] {
  return level.map((item) => item.id);
}

function cloneItems(items: StoredSidebarItem[]): StoredSidebarItem[] {
  return structuredClone(items);
}

function updateItem(
  item: StoredSidebarItem,
  change: Extract<SidebarLayoutChange, { op: "update" }>,
): StoredSidebarItem {
  if (!SIDEBAR_ITEM_TYPES.includes(item.type as SidebarItemType))
    throw new SidebarLayoutChangeError(
      "This item comes from a newer version and can't be edited here",
    );
  const next: StoredSidebarItem = { ...item };
  const set = (key: string, value: unknown) => {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  };
  if (change.label !== undefined) {
    if (change.label === null && (item.type === "group" || item.type === "link"))
      throw new SidebarLayoutChangeError("Groups and links need a label");
    set("label", change.label);
  }
  if (change.path !== undefined) {
    if (item.type !== "app") throw new SidebarLayoutChangeError("Only app links have a page path");
    set("path", change.path);
  }
  if (change.url !== undefined) {
    if (item.type !== "link") throw new SidebarLayoutChangeError("Only outside links have a url");
    set("url", change.url);
  }
  if (change.collapsed !== undefined) {
    if (item.type !== "group") throw new SidebarLayoutChangeError("Only groups collapse");
    set("collapsed", change.collapsed);
  }
  if (change.limit !== undefined) {
    if (item.type !== "live_list")
      throw new SidebarLayoutChangeError("Only live lists have a limit");
    set("limit", change.limit);
  }
  if (change.icon !== undefined) {
    if (item.type !== "app" && item.type !== "link" && item.type !== "group")
      throw new SidebarLayoutChangeError("Only app links, outside links and groups have an icon");
    set("icon", change.icon);
  }
  if (!knownSidebarItem(next))
    throw new SidebarLayoutChangeError("That change makes the item invalid");
  return next;
}

type Position = {
  index?: number | undefined;
  beforeId?: string | undefined;
  afterId?: string | undefined;
};

/** Where `position` falls among `ids` (the level without the item being placed). */
function positionIndex(ids: readonly string[], position: Position): number | undefined {
  const neighbour = position.beforeId ?? position.afterId;
  if (neighbour === undefined) return position.index;
  const at = ids.indexOf(neighbour);
  if (at < 0) throw new SidebarLayoutChangeError(`No item "${neighbour}" next to it`);
  return position.beforeId !== undefined ? at : at + 1;
}

function insertAt<T>(level: T[], item: T, index: number | undefined) {
  const at = index === undefined ? level.length : Math.min(Math.max(index, 0), level.length);
  level.splice(at, 0, item);
}

function checkLimits(items: StoredSidebarItem[]) {
  if (items.length > SIDEBAR_LAYOUT_MAX_ITEMS)
    throw new SidebarLayoutLimitError(`A sidebar holds at most ${SIDEBAR_LAYOUT_MAX_ITEMS} items`);
  for (const item of items)
    if (
      item.type === "group" &&
      Array.isArray(item.items) &&
      item.items.length > SIDEBAR_GROUP_MAX_ITEMS
    )
      throw new SidebarLayoutLimitError(`A group holds at most ${SIDEBAR_GROUP_MAX_ITEMS} items`);
}

/** App ids linked anywhere in `items` (lowercase). */
export function sidebarLinkedAppIds(items: readonly StoredSidebarItem[]): string[] {
  return linkedIds(items, "app", "appId");
}

/** Agent ids linked anywhere in `items` (lowercase). */
export function sidebarLinkedAgentIds(items: readonly StoredSidebarItem[]): string[] {
  return linkedIds(items, "agent", "agentId");
}

function linkedIds(items: readonly StoredSidebarItem[], type: string, field: string): string[] {
  const ids = new Set<string>();
  const visit = (item: StoredSidebarItem) => {
    const id = item[field];
    if (item.type === type && typeof id === "string") ids.add(id.toLowerCase());
    if (item.type === "group" && Array.isArray(item.items))
      for (const child of item.items as StoredSidebarItem[]) visit(child);
  };
  for (const item of items) visit(item);
  return [...ids];
}

/** `items` without links to apps that are gone (`live` holds the lowercase ids still there). */
export function withoutGoneSidebarApps(
  items: readonly StoredSidebarItem[],
  live: ReadonlySet<string>,
): StoredSidebarItem[] {
  return withoutGone(items, "app", "appId", live);
}

/** `items` without links to agents that are gone (`live` holds the lowercase ids still there). */
export function withoutGoneSidebarAgents(
  items: readonly StoredSidebarItem[],
  live: ReadonlySet<string>,
): StoredSidebarItem[] {
  return withoutGone(items, "agent", "agentId", live);
}

function withoutGone(
  items: readonly StoredSidebarItem[],
  type: string,
  field: string,
  live: ReadonlySet<string>,
): StoredSidebarItem[] {
  const keep = (item: StoredSidebarItem) => {
    const id = item[field];
    return item.type !== type || typeof id !== "string" || live.has(id.toLowerCase());
  };
  return items
    .filter(keep)
    .map((item) =>
      item.type === "group" && Array.isArray(item.items)
        ? { ...item, items: (item.items as StoredSidebarItem[]).filter(keep) }
        : item,
    );
}

function applyOptions(
  options: SidebarLayoutOptions | undefined,
  change: Extract<SidebarLayoutChange, { op: "options" }>,
): SidebarLayoutOptions | undefined {
  const next: Record<string, unknown> = { ...options };
  for (const key of sidebarOptionKeys()) {
    const value = (change as Record<string, unknown>)[key];
    if (value === null) delete next[key];
    else if (value !== undefined)
      next[key] = Array.isArray(value)
        ? [...new Set([...value, ...unknownEntries(key, next[key])])]
        : value;
  }
  return Object.keys(next).length ? (next as SidebarLayoutOptions) : undefined;
}

/**
 * Hidden rail entries a newer version added: answers leave them out, so a
 * client's list never names them; keep them when it replaces the list.
 */
function unknownEntries(key: string, stored: unknown): unknown[] {
  if (key !== "hiddenNavEntries" || !Array.isArray(stored)) return [];
  return stored.filter((entry) => !(SIDEBAR_NAV_ENTRIES as readonly unknown[]).includes(entry));
}

function withOptions<T extends { options?: SidebarLayoutOptions }>(
  value: Omit<T, "options">,
  options: SidebarLayoutOptions | undefined,
): T {
  return (options ? { ...value, options } : value) as T;
}

/** Apply changes to the workspace default. Throws SidebarLayoutChangeError. */
export function applyWorkspaceSidebarChanges(
  layout: StoredSidebarLayout,
  changes: readonly SidebarLayoutChange[],
  randomId: () => string,
): StoredSidebarLayout {
  let items = cloneItems(layout.items);
  let options = layout.options ? structuredClone(layout.options) : undefined;
  // Fields a newer version added stay unless the default is reset.
  let beyond = structuredClone(fieldsBeyond(layout, SIDEBAR_LAYOUT_KEYS));
  let version = storedVersion(layout.version);
  for (const change of changes) {
    switch (change.op) {
      case "reset":
        items = [];
        options = undefined;
        beyond = {};
        version = SIDEBAR_LAYOUT_VERSION;
        break;
      case "options":
        options = applyOptions(options, change);
        break;
      case "add": {
        const item = assignIds(change.item, collectIds(items), randomId, "workspace");
        if (change.groupId === undefined)
          insertAt(items, item, positionIndex(levelIds(items), change));
        else {
          if (item.type === "group") throw new SidebarLayoutChangeError("Groups don't nest");
          const group = items.find(
            (entry) => entry.id === change.groupId && entry.type === "group",
          );
          if (!group) throw new SidebarLayoutChangeError(`No group "${change.groupId}"`);
          const children = Array.isArray(group.items) ? (group.items as StoredSidebarItem[]) : [];
          insertAt(children, item, positionIndex(levelIds(children), change));
          group.items = children;
        }
        break;
      }
      case "update": {
        const found = locate(items, change.itemId);
        if (!found) throw new SidebarLayoutChangeError(`No item "${change.itemId}"`);
        found.level[found.index] = updateItem(found.level[found.index]!, change);
        break;
      }
      case "remove": {
        const found = locate(items, change.itemId);
        if (!found) throw new SidebarLayoutChangeError(`No item "${change.itemId}"`);
        found.level.splice(found.index, 1);
        break;
      }
      case "show":
        throw new SidebarLayoutChangeError("Show applies to your own sidebar (scope personal)");
      case "move": {
        const found = locate(items, change.itemId);
        if (!found) throw new SidebarLayoutChangeError(`No item "${change.itemId}"`);
        const [item] = found.level.splice(found.index, 1);
        const targetGroupId =
          change.groupId === undefined ? (found.parent?.id ?? null) : change.groupId;
        if (targetGroupId === null) insertAt(items, item!, positionIndex(levelIds(items), change));
        else {
          if (item!.type === "group") throw new SidebarLayoutChangeError("Groups don't nest");
          const group = items.find((entry) => entry.id === targetGroupId && entry.type === "group");
          if (!group) throw new SidebarLayoutChangeError(`No group "${targetGroupId}"`);
          const children = Array.isArray(group.items) ? (group.items as StoredSidebarItem[]) : [];
          insertAt(children, item!, positionIndex(levelIds(children), change));
          group.items = children;
        }
        break;
      }
    }
  }
  checkLimits(items);
  return withOptions<StoredSidebarLayout>({ ...beyond, version, items }, options);
}

/**
 * Apply changes to one person's sidebar on top of `workspace`. Removing a
 * workspace item hides it for them; removing their own item deletes it.
 * Moving reorders their view. Throws SidebarLayoutChangeError.
 */
export function applyPersonalSidebarChanges(
  workspace: StoredSidebarLayout,
  personal: StoredSidebarPersonalChanges,
  changes: readonly SidebarLayoutChange[],
  randomId: () => string,
): StoredSidebarPersonalChanges {
  let next: StoredSidebarPersonalChanges = structuredClone(personal);
  const workspaceIds = collectIds(workspace.items);
  const ownIndex = (id: string) => next.added.findIndex((entry) => entry.item.id === id);
  const ownChild = (id: string) => {
    for (const entry of next.added)
      if (entry.item.type === "group" && Array.isArray(entry.item.items)) {
        const children = entry.item.items as StoredSidebarItem[];
        const index = children.findIndex((child) => child.id === id);
        if (index >= 0) return { group: entry.item, children, index };
      }
    return null;
  };
  const groupExists = (id: string) => {
    const merged = mergeSidebarLayout(workspace, next).items;
    return merged.some((item) => item.id === id && item.type === "group");
  };
  const levelKeyOf = (id: string): string | null => {
    const merged = mergeSidebarLayout(workspace, next);
    for (const item of merged.items) {
      if (item.id === id) return SIDEBAR_ROOT_KEY;
      if (item.type === "group" && item.items.some((child) => child.id === id)) return item.id;
    }
    return null;
  };
  const mergedLevelIds = (key: string): string[] => {
    const merged = mergeSidebarLayout(workspace, next).items;
    if (key === SIDEBAR_ROOT_KEY) return merged.map((item) => item.id);
    const group = merged.find((item) => item.id === key);
    return group?.type === "group" ? group.items.map((child) => child.id) : [];
  };
  const place = (levelKey: string, id: string, position: Position) => {
    const ids = mergedLevelIds(levelKey).filter((entry) => entry !== id);
    insertAt(ids, id, positionIndex(ids, position));
    next.order[levelKey] = ids;
  };
  for (const change of changes) {
    switch (change.op) {
      case "reset":
        next = structuredClone(EMPTY_SIDEBAR_PERSONAL_CHANGES);
        break;
      case "options": {
        const { options: _options, ...rest } = next;
        next = withOptions<StoredSidebarPersonalChanges>(rest, applyOptions(next.options, change));
        break;
      }
      case "add": {
        const taken = collectIds(workspace.items);
        for (const entry of next.added) collectIds([entry.item], taken);
        const item = assignIds(change.item, taken, randomId, "personal");
        const groupId = change.groupId ?? null;
        if (groupId !== null) {
          if (item.type === "group") throw new SidebarLayoutChangeError("Groups don't nest");
          if (!groupExists(groupId)) throw new SidebarLayoutChangeError(`No group "${groupId}"`);
          if (mergedLevelIds(groupId).length >= SIDEBAR_GROUP_MAX_ITEMS)
            throw new SidebarLayoutLimitError(
              `A group holds at most ${SIDEBAR_GROUP_MAX_ITEMS} items`,
            );
          const own = next.added.find(
            (entry) => entry.item.id === groupId && entry.item.type === "group",
          );
          if (own) {
            const children = Array.isArray(own.item.items)
              ? (own.item.items as StoredSidebarItem[])
              : [];
            children.push(item);
            own.item.items = children;
          } else next.added.push({ parentId: groupId, item });
        } else next.added.push({ parentId: null, item });
        if (
          change.index !== undefined ||
          change.beforeId !== undefined ||
          change.afterId !== undefined
        )
          place(groupId ?? SIDEBAR_ROOT_KEY, item.id, change);
        break;
      }
      case "update": {
        const index = ownIndex(change.itemId);
        if (index >= 0) next.added[index]!.item = updateItem(next.added[index]!.item, change);
        else {
          const child = ownChild(change.itemId);
          if (child) child.children[child.index] = updateItem(child.children[child.index]!, change);
          else if (workspaceIds.has(change.itemId))
            throw new SidebarLayoutChangeError(
              "Workspace items are edited in the workspace default; hide it and add your own instead",
            );
          else throw new SidebarLayoutChangeError(`No item "${change.itemId}"`);
        }
        break;
      }
      case "remove": {
        const index = ownIndex(change.itemId);
        const child = index < 0 ? ownChild(change.itemId) : null;
        if (index >= 0) {
          const [removed] = next.added.splice(index, 1);
          // Your group goes with its items, also ones stored beside it by an older version.
          if (removed?.item.type === "group")
            next.added = next.added.filter((entry) => entry.parentId !== removed.item.id);
        } else if (child) child.children.splice(child.index, 1);
        else if (workspaceIds.has(change.itemId)) {
          if (!next.hidden.includes(change.itemId)) next.hidden.push(change.itemId);
        } else throw new SidebarLayoutChangeError(`No item "${change.itemId}"`);
        break;
      }
      case "show":
        if (!workspaceIds.has(change.itemId))
          throw new SidebarLayoutChangeError(`No workspace item "${change.itemId}"`);
        next.hidden = next.hidden.filter((id) => id !== change.itemId);
        break;
      case "move": {
        const current = levelKeyOf(change.itemId);
        if (current === null) throw new SidebarLayoutChangeError(`No item "${change.itemId}"`);
        const target =
          change.groupId === undefined ? current : (change.groupId ?? SIDEBAR_ROOT_KEY);
        if (target !== current) {
          // Only your own items change group; workspace items keep the admin's grouping.
          const index = ownIndex(change.itemId);
          const child = index < 0 ? ownChild(change.itemId) : null;
          if (index < 0 && !child)
            throw new SidebarLayoutChangeError(
              "Workspace items stay in their group; move it within its level instead",
            );
          if (target !== SIDEBAR_ROOT_KEY) {
            const moving = index >= 0 ? next.added[index]!.item : child!.children[child!.index]!;
            if (moving.type === "group") throw new SidebarLayoutChangeError("Groups don't nest");
            if (!groupExists(target)) throw new SidebarLayoutChangeError(`No group "${target}"`);
            if (mergedLevelIds(target).length >= SIDEBAR_GROUP_MAX_ITEMS)
              throw new SidebarLayoutLimitError(
                `A group holds at most ${SIDEBAR_GROUP_MAX_ITEMS} items`,
              );
          }
          let item: StoredSidebarItem | undefined;
          if (index >= 0) item = next.added.splice(index, 1)[0]?.item;
          else item = child!.children.splice(child!.index, 1)[0];
          // Into your own group it goes inside it, as Add puts it, so it moves and goes with the group.
          const own = next.added.find(
            (entry) => entry.item.id === target && entry.item.type === "group",
          );
          if (own) {
            const children = Array.isArray(own.item.items)
              ? (own.item.items as StoredSidebarItem[])
              : [];
            children.push(item!);
            own.item.items = children;
          } else
            next.added.push({ parentId: target === SIDEBAR_ROOT_KEY ? null : target, item: item! });
        }
        place(target, change.itemId, change);
        break;
      }
    }
  }
  if (next.added.length > SIDEBAR_LAYOUT_MAX_ITEMS)
    throw new SidebarLayoutLimitError(`You can add at most ${SIDEBAR_LAYOUT_MAX_ITEMS} items`);
  checkLimits(next.added.map((entry) => entry.item));
  // Keep only order entries for levels and items that still exist.
  const merged = mergeSidebarLayout(workspace, next);
  const known = new Map<string, Set<string>>([
    [SIDEBAR_ROOT_KEY, new Set(merged.items.map((item) => item.id))],
  ]);
  for (const item of merged.items)
    if (item.type === "group") known.set(item.id, new Set(item.items?.map((child) => child.id)));
  const order: Record<string, string[]> = {};
  for (const [key, ids] of Object.entries(next.order)) {
    const level = known.get(key);
    const kept = level ? ids.filter((id) => level.has(id)) : [];
    if (kept.length) order[key] = kept;
  }
  // `next` keeps fields a newer version added (a reset clears them).
  return { ...next, version: storedVersion(next.version), order };
}

// ---------------------------------------------------------------------------
// What the API answers
// ---------------------------------------------------------------------------

export const SidebarLayoutApp = /* @__PURE__ */ defineSchema(() =>
  z.object({ appId: z.string().uuid(), title: z.string() }).strict(),
);
export type SidebarLayoutApp = z.infer<typeof SidebarLayoutApp>;

const ResolvedBase = {
  id: z.string(),
  origin: z.enum(["workspace", "personal"]),
};

export const ResolvedSidebarAppLink = /* @__PURE__ */ defineSchema(() =>
  z.object({
    ...ResolvedBase,
    type: z.literal("app"),
    appId: z.string().uuid(),
    path: z.string().nullable(),
    /** Its own label, else the app's title. */
    label: z.string(),
    /** Its icon (a SIDEBAR_ITEM_ICONS name; a client draws its usual mark for one it doesn't know). */
    icon: z.string().optional(),
  }),
);
export const ResolvedSidebarExternalLink = /* @__PURE__ */ defineSchema(() =>
  z.object({
    ...ResolvedBase,
    type: z.literal("link"),
    url: z.string(),
    label: z.string(),
    /** Its icon; without one, clients show the site's own icon. */
    icon: z.string().optional(),
  }),
);
export const ResolvedSidebarLiveList = /* @__PURE__ */ defineSchema(() =>
  z.object({
    ...ResolvedBase,
    type: z.literal("live_list"),
    list: z.string(),
    label: z.string(),
    limit: z.number().int(),
    /** The apps in it now, already limited to ones this person can open. */
    apps: z.array(SidebarLayoutApp),
  }),
);
/** A link to an agent's page, for people who can see the agent. */
export const ResolvedSidebarAgentLink = /* @__PURE__ */ defineSchema(() =>
  z.object({
    ...ResolvedBase,
    type: z.literal("agent"),
    agentId: z.string().uuid(),
    /** Its own label, else the agent's name. */
    label: z.string(),
    /** The agent's avatar, or its initials when it has none. */
    avatar: SessionAvatar,
  }),
);
export const ResolvedSidebarChild = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("type", [
    ResolvedSidebarAppLink,
    ResolvedSidebarExternalLink,
    ResolvedSidebarLiveList,
    ResolvedSidebarAgentLink,
  ]),
);
export type ResolvedSidebarChild = z.infer<typeof ResolvedSidebarChild>;
export const ResolvedSidebarGroup = /* @__PURE__ */ defineSchema(() =>
  z.object({
    ...ResolvedBase,
    type: z.literal("group"),
    label: z.string(),
    collapsed: z.boolean(),
    icon: z.string().optional(),
    items: z.array(ResolvedSidebarChild),
  }),
);
export const ResolvedSidebarItem = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("type", [
    ResolvedSidebarGroup,
    ResolvedSidebarAppLink,
    ResolvedSidebarExternalLink,
    ResolvedSidebarLiveList,
    ResolvedSidebarAgentLink,
  ]),
);
export type ResolvedSidebarItem = z.infer<typeof ResolvedSidebarItem>;

/**
 * Read resolved items leniently, as a client of any version must: items of
 * a type this client doesn't know (from a newer server) are left out.
 */
export function readResolvedSidebarItems(value: unknown): ResolvedSidebarItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ResolvedSidebarItem[] => {
    if (isRecord(entry) && entry.type === "group") {
      const group = ResolvedSidebarGroup.safeParse({ ...entry, items: [] });
      if (!group.success) return [];
      const children = Array.isArray(entry.items) ? entry.items : [];
      const items = children.flatMap((child) => {
        const parsed = ResolvedSidebarChild.safeParse(child);
        return parsed.success ? [parsed.data] : [];
      });
      return [{ ...group.data, items }];
    }
    const parsed = ResolvedSidebarChild.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** `GET /v1/workspaces/:workspaceId/sidebar-layout` and the update's answer. */
export const SidebarLayoutResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** What this person sees, in order: hidden items and items they can't open are left out. */
    items: z.array(ResolvedSidebarItem),
    /** Workspace items this person hid, to show again. */
    hidden: z.array(z.object({ parentId: z.string().nullable(), item: ResolvedSidebarItem })),
    personal: z.object({
      /** Whether this caller has a sidebar of their own (people do; keys and services don't). */
      available: z.boolean(),
      revision: z.number().int(),
      /** Whether they changed anything, so Reset applies. */
      customized: z.boolean(),
      /** Their own options, as set (unset ones follow the default). */
      options: SidebarLayoutOptions.optional(),
    }),
    workspace: z.object({
      revision: z.number().int(),
      /** Whether this caller may change the workspace default (workspace admins). */
      canEdit: z.boolean(),
      /** The default as everyone sees it before their own changes; for admins only. */
      items: z.array(ResolvedSidebarItem).optional(),
      /** The default's own options, as set (unset ones are left out); for admins only. */
      options: SidebarLayoutOptions.optional(),
    }),
    /**
     * The navigation options in effect for this person. Absent from servers
     * from before them: read it with readResolvedSidebarOptions.
     */
    options: ResolvedSidebarLayoutOptions.optional(),
  }),
);
export type SidebarLayoutResponse = z.infer<typeof SidebarLayoutResponse>;

/** Whether a person's changes differ from the workspace default. */
export function sidebarPersonalChangesCustomized(personal: StoredSidebarPersonalChanges): boolean {
  return (
    personal.hidden.length > 0 ||
    personal.added.length > 0 ||
    Object.keys(personal.options ?? {}).length > 0 ||
    Object.values(personal.order).some((ids) => ids.length > 0)
  );
}

/** A phone's sidebar: groups flatten into one list, live lists capped. */
export function flattenSidebarItemsForMobile(
  items: readonly ResolvedSidebarItem[],
): ResolvedSidebarChild[] {
  return items
    .flatMap((item) => (item.type === "group" ? item.items : [item]))
    .map((item) =>
      item.type === "live_list"
        ? {
            ...item,
            apps: item.apps.slice(0, Math.min(item.limit, SIDEBAR_LIVE_LIST_MOBILE_LIMIT)),
          }
        : item,
    );
}

/**
 * What the sidebar itself shows: a live list with no apps is left out until
 * it fills, so the built-in Pinned apps list shows only in a workspace with
 * pins. A group left with only such lists goes too. The Sidebar page lists
 * every item.
 */
export function sidebarItemsShown(items: readonly ResolvedSidebarItem[]): ResolvedSidebarItem[] {
  const shown = (item: ResolvedSidebarChild) => item.type !== "live_list" || item.apps.length > 0;
  return items.flatMap((item): ResolvedSidebarItem[] => {
    if (item.type !== "group") return shown(item) ? [item] : [];
    const children = item.items.filter(shown);
    // A group left with nothing to show goes too; one that was empty stays (to fill).
    return children.length > 0 || item.items.length === 0 ? [{ ...item, items: children }] : [];
  });
}

type SidebarLayoutRevisions = {
  personal?: { revision?: number } | null | undefined;
  workspace?: { revision?: number } | null | undefined;
};

/**
 * Whether `next` is older than `shown` in either scope, so a client keeps
 * what it shows: answers to overlapping reads and updates can arrive out of
 * order, and each scope's revision only grows. Two answers each newer in a
 * different scope (rare) keep the one shown until the next read.
 */
export function sidebarLayoutIsOlder(
  next: SidebarLayoutRevisions,
  shown: SidebarLayoutRevisions | null | undefined,
): boolean {
  if (!shown) return false;
  const revision = (scope: { revision?: number } | null | undefined) =>
    typeof scope?.revision === "number" ? scope.revision : 0;
  return (
    revision(next.personal) < revision(shown.personal) ||
    revision(next.workspace) < revision(shown.workspace)
  );
}
