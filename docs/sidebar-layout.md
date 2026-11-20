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
| `link`      | An outside `https://` link with a `label`. It opens in a new tab and is marked external. |
| `live_list` | A list the sidebar fills in: `pinned_apps` (the workspace's shared pins) or `recent_apps` (Apps this person opened last), `limit` 1 to 20 (default 5). |

Item ids are 1 to 64 letters, digits, `-` or `_`; the server makes one when a
new item has none. A layout holds at most 50 top-level items and 50 per group.

What a person sees is filtered for them: Apps they can't open (Only me Apps of
someone else, archived or deleted Apps, or anything when they lack
`artifacts:read`) are left out, and a group left with nothing they can open
is left out too (admins still see it, to fill it).

The built-in default is empty, so nothing changes for a workspace until
someone adds items.

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
  optional `groupId` and `index`), `update` (`label`, `path`, `url`,
  `collapsed`, `limit`), `remove`, `show`, `move` (`index`, optional
  `groupId`, `null` for the top level) and `reset`.
- With `expectedRevision`, a newer revision is refused with 409 instead of
  changed on top of. Without it, the change applies to the latest revision.
- A new App link must name an App the caller can open (422 otherwise);
  an invalid change is a 422 with the reason.

The SDK has `client.getSidebarLayout(workspaceId)` and
`client.updateSidebarLayout(workspaceId, request)`. Both routes are app
actions, so agents with app actions can call them as the person.

An App package installer (or any integration) adds an App to the default with
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
  chats. Each row has a menu (Move up, Move down, Hide or Remove, Customize
  sidebar). Customize sidebar is also in the account menu and opens the
  Sidebar page (`/workspaces/<id>/sidebar`): Yours, and Workspace default for
  admins. Groups remember open or closed per browser. The icon-only rail
  leaves the section out.
- **Phone browsers**: groups are flattened into one list and live lists show
  at most 3 Apps.
- **The Opengeni phone app** doesn't show the layout yet.

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
  longest ago closes. Switching workspaces closes them.
- Coming back to an App seen earlier in the tab draws its last copy at once
  (and refreshes it behind), and a first open is a blank canvas in the
  App's theme, not a loading card.

The Site view (`/workspaces/<id>/sites/<id>`), with its chat and publishing,
is unchanged.

## Mixed versions

Readers ignore item types and fields they don't know, and writers keep stored
items they don't know, so web, desktop and phone clients (and API replicas
during a rolling deploy) of different versions never break each other's
layouts. An older client simply doesn't show newer item types.

## Storage

One table, `sidebar_layouts` (migration `1515_sidebar_layouts.sql`): one row
for the default (`subject_id` null) and one per person who changed anything,
each with its JSON layout (at most 256 KB) and a revision for
compare-and-set. Row-level security keeps it to its workspace.

## Self-hosting

Everything here works self-hosted with no settings. Opengeni's look for Apps
is served by the Sites gateway on published Sites; without Sites publishing
(`OPENGENI_SITES_DOMAIN` unset) Apps still get it inside Opengeni, where it is
inlined.
