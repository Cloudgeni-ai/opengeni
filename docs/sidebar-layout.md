# Sidebar layout

The sidebar's links and groups, above the chat list. A workspace has one
**default** that workspace admins set; each person can change their own
sidebar on top of it (add, hide, reorder) and reset it back to the default.
Agents change it with the same model through tools.

It sits beside, and does not replace, the existing ways to organize things:
projects still group chats in the chat list, and shared pins still pin Apps
in Artifacts. The sidebar shows those pins through a **Pinned apps** list.

## Items

| Type        | What it shows                                                          |
| ----------- | ---------------------------------------------------------------------- |
| `group`     | A named, collapsible group of the items below. Groups don't nest.      |
| `app`       | An App, optionally one of its pages (`path: "/releases"`). Its own title unless `label` is set. |
| `agent`     | An agent's page (`agentId`), with the agent's avatar. Its name unless `label` is set. Opens in place. |
| `link`      | An `https://` link with a `label`. An outside link opens in a new tab and is marked external; a link to a page of this Opengeni opens in place. |
| `live_list` | A list the sidebar fills in: `pinned_apps` (the workspace's shared pins) or `recent_apps` (apps this person opened or edited last), `limit` 1 to 20 (default 5). |

App links, outside links and groups take an optional `icon`: a lucide icon name from
`SIDEBAR_ITEM_ICONS` in `@opengeni/contracts/sidebar-layout` (for example
`rocket`, `book-open`, `chart-line`). Without one, an app shows the app icon,
a group its chevron, and an outside link the site's own icon (see API). An
icon a reader doesn't know is ignored and the item still shows. Apps have no
icon of their own; the icon belongs to the sidebar item.

An Apps section is an ordinary item: a group holding a `recent_apps` or
`pinned_apps` list, which can be moved, renamed, given a `limit` or removed
like any other.

## Options

Beside its items, a layout holds `options` for the rest of the navigation.
Each is unset by default, which keeps today's behaviour; the workspace
default sets them for everyone and a person's own value wins:

| Option             | Effect                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `sessionsShowApps` | `false`: project apps don't show as rows of their own in the Sessions list; their chats show as ordinary chats. Default `true`. |
| `hiddenNavEntries` | Built-in rail entries left out: any of `inbox`, `capabilities`, `knowledge`, `automations`, `agents`, `meetings`, `artifacts`. An entry still shows while it is the current page or has something waiting (a Knowledge review, an Inbox item, a recording). Default none. |
| `settingsMore`     | Settings rail entry ids (`workspace:general`, `organization:members`, ...) moved under one collapsed **More**, which opens while it holds the current page; every other entry, including new ones, stays at the top. Settings search still finds everything. Default unset: every entry at the top. |

Item ids are 1 to 64 letters, digits, `-` or `_`; the server makes one when a
new item has none. A person's own items always get ids starting with `my-`: a
given id without it is prefixed (`docs` is stored as `my-docs`), so use the id
in the answer for later changes. Default items can't use that prefix, so an
item an admin adds later never takes the id of someone's own item. A layout
holds at most 50
top-level items and 50 per group, a person's own items in a group included.

What a person sees is filtered for them: apps they can't open (Only me apps of
someone else, archived or deleted apps, or anything when they lack
`artifacts:read`) and agents they can't see (someone else's Only me agent, a
deleted one, or any agent when they lack `sessions:read`, as on the Agents
page) are left out, and a group left with nothing they can open is left out
too (admins still see it, to fill it). An agent link shows the agent's
current name and avatar (its initials when it has none), so renaming the
agent renames the link unless the link has its own `label`. On the next change to the
layout that holds them, links are also dropped from storage, so they don't
count toward the limits, when:

- the app no longer exists in the workspace (in the default or a person's own
  items; apps are removed only with their workspace, so this is mostly links
  written by hand or by an integration to an id that isn't an app here);
- the app became someone else's Only me (a person's own items; in the
  default it stays, for the people who can open it).

Agent links follow the same rule: on the next change to the layout that holds
them, links to a deleted agent are dropped, and a person's own link to an
agent that became someone else's Only me. A new agent link must name an agent
the caller can see (422 otherwise; 403 without `sessions:read`).

Links to an archived app are kept, hidden while it's archived, so restoring
the app brings them back. They still count toward the limits, except that
when a change would go over a limit, every archived link in the layout being
changed (the default, or the person's own items) is dropped to make room, and
those links don't come back on restore. A person's change doesn't drop the
default's archived links, so a default group that is full stays full for them.

The built-in default is one **Pinned apps** live list (`pinned_apps`, id
`pinned-apps`). A live list with no apps is left out of the sidebar, as is a
group left with only such lists (the Sidebar page still lists them), so a
workspace without pinned apps sees no change. It's an ordinary default
item: admins can remove it or change the
default, and people can hide it. The built-in default applies only while a
workspace has never saved its default; a saved default is used as it is,
even an empty one, and a workspace `reset` empties the default rather than
bringing the built-in one back.

## Personal changes

A person's sidebar is the default with their changes on top:

- **Add**: their own items, at the top level or in any group (theirs or the
  default's).
- **Hide**: removing a default item hides it for them only. It's listed under
  Hidden on the Sidebar page, where Show brings it back.
- **Reorder**: within a level. Default items stay in the group the admin put
  them in; a person's own items can move between groups.
- **Reset**: drops all their changes.

When the default changes later, people keep their changes: new default items
appear (after the ones they ordered), and items an admin removed disappear.
Their own items in a group the admin removed move to the top level.

API keys and service callers have no sidebar of their own
(`personal.available` is false); they can still read and, with
`workspace:admin`, change the default.

## API

`GET /v1/workspaces/:workspaceId/sidebar-layout` (`workspace:read`) returns
what the caller sees (`items`), the default items they hid (`hidden`), and for
each scope its `revision`. Admins also get the default as everyone sees it
before their own changes (`workspace.items`) and `workspace.canEdit: true`.

`PATCH /v1/workspaces/:workspaceId/sidebar-layout` takes
`{ scope, changes, expectedRevision? }`:

- `scope: "personal"` changes the caller's own sidebar (`workspace:read`).
- `scope: "workspace"` changes the default (`workspace:admin`, else 403).
- `changes` (1 to 50, applied in order, all or nothing): `add` (`item`,
  optional `groupId` and a position), `update` (`label`, `path`, `url`,
  `collapsed`, `limit`, `icon` (`null` removes it); renaming a group is an
  `update` of its `label`), `remove`, `show`, `move` (optional `groupId`,
  `null` for the top level, and a position), `options` (any of the options
  above; `null` unsets one) and `reset` (which also unsets the scope's
  options).
- The answer's `options` are the ones in effect for the caller;
  `personal.options` and, for admins, `workspace.options` are each scope's
  own.
- A position is `beforeId` or `afterId` (an item of the target level) or an
  `index`; see Placement below.
- With `expectedRevision`, a newer revision is refused with 409 instead of
  changed on top of. Without it, the change applies to the latest revision.
- A new App link must name an App the caller can open (422 otherwise);
  an invalid change is a 422 with the reason.

### Placement

Where `add` and `move` put an item:

1. `beforeId` if given, else `afterId`, else `index`, else the end of the
   level. Give only one; the others are ignored.
2. The level is the group named by `groupId` (`null` is the top level). Without
   `groupId`, `add` uses the top level and `move` the item's current level.
3. A neighbour must be in that level, or the change is refused (422).
4. `index` counts the level including items the caller can't see (apps they
   can't open or that are archived): for the default, its stored level; for a
   person's own changes, the default's items they haven't hidden plus their
   own. Past the end means the end. Prefer a neighbour, which is exact.
5. In a person's own changes, a default item stays in the group the admin
   put it in (moving it elsewhere is refused); their own items can move
   between groups and the top level.

Clients keep the newest answer: each scope's `revision` only grows, so when
two reads or updates overlap and finish out of order, an answer with a lower
`personal` or `workspace` revision than the one shown is ignored
(`sidebarLayoutIsOlder` in `@opengeni/contracts/sidebar-layout`). In the rare
case where each answer is newer in a different scope, the one shown stays
until the next read.

The SDK has `client.getSidebarLayout(workspaceId)` and
`client.updateSidebarLayout(workspaceId, request)`. Both routes are app
actions, so agents with app actions can call them as the person.

`GET /v1/workspaces/:workspaceId/sidebar-layout/link-icon?url=<https url>`
(`workspace:read`, `client.getSidebarLinkIcon`) returns the icon of a site
linked in the caller's sidebar: its `/favicon.ico`, fetched by the server
under the outbound network policy (https only, at most 2 redirects and
100 KB, raster images only, kept a day). A site that isn't in the caller's
sidebar, or has no such icon, is a 404.

An app package installer (or any integration) adds an app to the default with
one call:

```json
{
  "scope": "workspace",
  "changes": [{ "op": "add", "item": { "type": "app", "appId": "<app id>" } }]
}
```

## Agent tools

- `sidebar_layout_get`: the sidebar as the person sees it, with ids.
- `sidebar_layout_update`: the PATCH body above. Personal changes work for
  any chat a person started; the workspace default needs a chat holding
  `workspace:admin`. Without it, the agent runs the same request as the person
  through `admin_action_call` (`PATCH /v1/workspaces/:workspaceId/sidebar-layout`),
  which asks first.

Both are in the workspace-admin tool family and need `workspace:read`.

## Clients

- **Web and the desktop app**: under the primary navigation, above the
  chats. The sidebar is edited in place: drag a row to reorder it (an app
  row from the Sessions list can be dropped in too), a group's **+** adds an
  app to it, and each row's menu has Rename, Icon, Show (how many apps a
  list shows), Hide or Remove, and Customize sidebar. A project app's menu in
  the Sessions list has **Add to sidebar**. A quiet Customize row under the
  section shows while the pointer is over it (always on touch screens). Both, the account menu's
  Customize sidebar and settings search ("sidebar") open the Sidebar page
  (`/workspaces/<id>/sidebar`): Yours, and Workspace default for admins. Its
  **Add** menu adds an **App**, an **Agent** (picked from the agents you can
  see), a **Link**, a **Group** or a **List**; a group's menu has Rename (inline: Enter or
  leaving the field saves, Escape cancels) for your own groups, and for the
  default's groups under Workspace default; rows also have Icon and, for
  lists, Show. The page's More (next to Add) switches the options above
  (Group chats under their app, and Menu entries for each rail entry) and
  holds Reset to workspace default; for you and, for admins, as the default.
  A settings entry's button says what it does, **Move to More** or **Show
  at top**, while the pointer is over the entry (a small arrow, always shown,
  on touch screens). The rail draws the options as this browser last saw
  them while the layout loads, so the Sessions list, hidden entries and
  More don't redraw after it arrives; with none seen yet the Sessions list
  waits for them (up to two seconds) before drawing. Groups
  remember open or closed per browser. The icon-only rail
  leaves the section out. Changes made elsewhere (an agent's tool call,
  another tab or device) show when the window regains focus, on return to
  the tab, or within two minutes.
- **Phone browsers**: groups are flattened into one list and live lists show
  at most 3 apps.
- **The Opengeni phone app**: in the side menu, under Automations and above
  the pinned chats. Groups show as a heading over their items, like the
  menu's projects (they don't collapse), a live list as a heading over at
  most 3 apps, and top-level links without one. An agent shows its avatar and
  opens its page on the web, where agents are managed. An app opens in the app's
  viewer at its page (`/native-view/workspaces/<id>/sites/<appId>?page=<path>`;
  a server without `?page=` opens its home page), and an outside link opens
  in the browser. It's read only: changes are made on the web or by an agent.
  Item icons show there too, and an outside link without one shows its
  site's icon (the arrow while it loads or when there is none). Hidden
  built-in entries are left out as on the web: Automations in the side menu,
  and Artifacts, Meetings or Inbox in the tab bar (Chats always stays, and an
  entry stays while it's open, recording or has something waiting). The
  phone has no Capabilities, Knowledge or Agents entries.
  It refreshes each time the menu opens and on pull to refresh, and shows the
  last layout at once.

## Apps as pages

An App opened from the sidebar is a page of Opengeni's own, not an
Artifacts view:

- It fills the main area, with no toolbar, and its own address is the page
  URL: `/workspaces/<id>/apps/<appId>/<path>` (its query and fragment, if any,
  in `?at=`). Back, Forward, reload and copied links keep the App where it was.
- It follows Opengeni's light or dark theme, and can use Opengeni's look (see
  [Site runtime API](site-runtime-api.md#opengeni-look-for-apps)).
- The last 3 Apps you left stay open while you go elsewhere, so coming back
  doesn't reload them or lose their state. More than that, the one shown
  longest ago closes. Switching workspaces closes them. Each return to an
  app counts as opening it, for Recent apps; saving a new version of an app
  counts too.
- Coming back to an App seen earlier in the tab draws its last copy at once
  (and refreshes it behind), and a first open is a blank canvas in the
  App's theme, not a loading card. If the refresh finds the App gone or no
  longer open to you, the copy is dropped and the error shown.

The Site view (`/workspaces/<id>/sites/<id>`), with its chat and publishing,
is unchanged.

## Mixed versions

Readers ignore item types and fields they don't know, and writers keep stored
items they don't know, so web, desktop and phone clients (and API replicas
during a rolling deploy) of different versions never break each other's
layouts. An older client simply doesn't show newer item types: agent links
are left out of web and phone clients from before they existed, and an older
API replica keeps them in storage without showing them.

Icons and options follow the same rule: older clients ignore them. Writers
keep what they don't know: item fields (icons), options, option values a
newer version widened (`sessionsShowApps: "auto"`), layout fields, fields on
a person's added entries and a newer layout `version` stay in storage
through an older replica's write, and answers carry only what the replica
reads. Reset is the one change that clears them. So a newer version adds
fields and values; it never changes what an existing one means. API
replicas from before this rule drop what they don't know when they write:
from before options existed, the layout's `options`; from #8030's release,
options and fields added since. Set them again if a change made during such
a rollout is lost.

## Storage

One table, `sidebar_layouts` (migration `1518_sidebar_layouts.sql`): one row
for the default (`subject_id` null) and one per person who changed anything,
each with its JSON layout (at most 256 KB) and a revision for
compare-and-set. Row-level security keeps it to its workspace.

## Self-hosting

Everything here works self-hosted with no settings. Opengeni's look for Apps
is served by the Sites gateway on published Sites; without Sites publishing
(`OPENGENI_SITES_DOMAIN` unset) Apps still get it inside Opengeni, where it is
inlined.
