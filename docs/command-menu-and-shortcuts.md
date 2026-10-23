# Command menu and keyboard shortcuts

Opengeni has one place that knows what a person can do in the app: the
**action registry**. The ⌘K command menu, the chat row's right-click and ⋯
menus, the chat header menu, the desktop menu bar, tooltips and the shortcut
cheat sheet all read from it. A shortcut, label or availability rule is written
once, so web and desktop cannot drift apart.

## Goals

- Every frequent action is one chord away, and every chord can be discovered
  without reading documentation: it is shown next to the action in ⌘K, in menus
  and in tooltips, and the cheat sheet (⌘/) lists them all.
- Finding a chat by title is instant and forgiving.
- A small set of keys. A chord exists only for something people do many times a
  day. Everything else is reachable through ⌘K.
- Web and the desktop app behave the same, except where the browser reserves a
  key.

Not in scope: single-letter or sequence shortcuts (G then I), user-customisable
keys, a global quick-ask hotkey, and mobile.

## The action registry

An action is plain data plus two functions:

```ts
type AppAction = {
  id: string; // "chat.copyLink"
  title: string; // "Copy link"
  group: "navigate" | "chat" | "create" | "view" | "help";
  keywords?: string[]; // extra words ⌘K matches, e.g. ["share", "url"]
  icon?: LucideIcon;
  chord?: Chord | { web?: Chord; desktop?: Chord }; // per-surface when the browser reserves a key
  /** Hidden from ⌘K and menus when this returns false. */
  available(context: ActionContext): boolean;
  run(context: ActionContext): void | Promise<void>;
};
```

`ActionContext` carries the workspace, the chat the action targets (the open
chat for global use, the row's chat for row menus), navigation, the SDK client
and the surface (`web` or `desktop`). Chat actions such as pin, copy link,
rename, mark unread and archive are the same objects whether they run from ⌘K,
a chord, the row menu or the chat header, so a fix in one place fixes all of
them.

One key listener on the window dispatches chords. It ignores repeats and IME
composition, never fires while a modal other than ⌘K owns focus, and lets
text-editing keys through when focus is in the composer or another text field
unless the chord has ⌘ or Ctrl in it. Chords are matched on `KeyboardEvent.code`
so they work on every keyboard layout.

On desktop the menu bar owns the chords it shows. The page sends the registry's
menu-visible actions (id, title, accelerator, menu) to the shell over the
existing `commands` bridge; the shell builds the menu from them and sends the
action id back when an item or its key is used. The page's own listener skips
chords the shell already owns, so nothing runs twice. Older desktop builds keep
their static menu.

## The key set

Mac keys are written in Apple's order (⌃⌥⇧⌘). Punctuation keys also match the
character typed, so ⌘/ works on layouts where "/" needs Shift.

| Action | Mac | Windows and Linux | Notes |
| --- | --- | --- | --- |
| Command menu | ⌘K | Ctrl+K | Chats, Sites and actions in one list |
| New chat | ⌘N on desktop, ⇧⌘O everywhere | Ctrl+N on desktop, Ctrl+Shift+O everywhere | Browsers reserve ⌘N |
| Copy chat link | ⇧⌘, | Ctrl+Shift+, | Linear's key for copying an issue URL |
| Pin or unpin chat | ⌥⌘P | Ctrl+Alt+P | Clear of the common browser shortcuts |
| Archive or restore chat | ⌃⌘A | Ctrl+Alt+A | Apple Mail's Archive key; browsers on Windows and Linux use Ctrl+Shift+A for tab search |
| Inbox | ⇧⌘I | Ctrl+Shift+I on desktop only | Browsers on Windows and Linux use Ctrl+Shift+I for developer tools |
| Previous or next chat | ⌥↑ / ⌥↓ | Alt+↑ / Alt+↓ | Sidebar order, like Slack |
| Previous or next workspace | ⌥⌘↑ / ⌥⌘↓ | Ctrl+Alt+↑ / Ctrl+Alt+↓, and Ctrl+Shift+PgUp / PgDn on desktop | The workspace picker's order, wrapping around. Arrows sit in the same place on every layout (⌘⇧[ and ⌘⇧] need ⌥ on Nordic keyboards and are taken by browsers); some Linux desktops keep Ctrl+Alt+arrows, hence the second key |
| Pinned chat 1 to 9 | ⌘1 to ⌘9 on desktop | Ctrl+1 to 9 on desktop | Browsers use these for tabs |
| Recent chat switcher | ⌃Tab on desktop | Ctrl+Tab on desktop | Browsers use these for tabs; see below |
| Find in chat | ⌘F | Ctrl+F | Exists today |
| Toggle sidebar | ⌘B (⌃⌘S also works) | Ctrl+B (Ctrl+Shift+S also works) | The common editor and chat-app key. Rich-text editors keep ⌘B for bold, so the desktop menu bar shows the platform's standard key |
| Toggle workspace panel | ⌥⌘B | Ctrl+Alt+B | The right-hand panel; VS Code's key for its second sidebar |
| Shortcut cheat sheet | ⌘/ | Ctrl+/ | Slack's key |

Desktop keeps ⌥⌘1 to 9 for switching accounts and ⌘[ / ⌘] for back and forward.

**Control+Tab** switches between recently viewed chats in the desktop app.
Browsers keep Control+Tab for switching tabs, so on the web it never reaches
the page. A quick press opens the chat you viewed before this one, and pressing
it again comes back, so two chats can be flipped between. Holding Control shows
the recent chats (at most ten, most recently viewed first) in the middle of the
window; each Tab moves down the list, Shift+Tab moves up, and letting go of
Control opens the highlighted chat. Esc, a click outside the list or leaving
the window cancels. The list only appears after a short delay, so a quick
press never flashes it. Archived and subagent chats are left out. On Windows
and Linux, Ctrl+Tab does the same.

The recent chats span all of the person's workspaces, so Control+Tab also
jumps back to a chat in another workspace; such chats carry a small tag with
their workspace's name, and opening one switches to that workspace. Chats in a
workspace no longer open to the person are left out. The list is kept per
person in local storage (`opengeni.recentChats.<subject>`); older per-workspace
lists merge into it on first read.

## Workspaces

The workspace picker at the top of the sidebar lists every workspace open to
the person, grouped by organization: the default organization first, then by
name, and each organization's workspaces by name. ⌥⌘↑ and ⌥⌘↓ walk that same
list, wrapping around, and the picker shows the keys at its foot. ⌘K finds
workspaces by name too, and "Switch workspace…" (also in the desktop Go menu)
turns ⌘K into a workspace list: type to filter, Enter switches, Esc goes back.
The sidebar, its pins and its order stay per workspace.

## The ⌘K menu

Opening it is instant: no request is made before it appears.

- **Empty query:** recent chats you opened (most recent first, topped up from
  the top of the sidebar), then actions for the chat you are in (copy link,
  pin, rename, fork, mark unread, archive) with their keys, then general
  actions (new chat, find, inbox, search messages, switch workspace, sidebar,
  shortcuts). Recent chats include other workspaces, tagged with their
  workspace. Between recent chats and the chat's actions, "Recent Sites"
  lists at most three of this workspace's Sites, most recent activity first
  (conversations, a new version, or the person opening it), from the Site
  rows the sidebar has loaded; the Site on screen is left out.
- **Typing:** results update on every keystroke from chats already loaded in
  the sidebar and recent list, ranked by how well the title matches. The server
  title search runs alongside and merges in chats the sidebar has not loaded,
  in this workspace and in up to nine of the person's other workspaces (the
  ones used most recently first), each joining as it answers. Chats from other
  workspaces rank just below equal matches here and are tagged with their
  workspace; opening one switches workspace. Actions that match appear in
  their own group with their keys, and workspaces whose name matches in theirs.
- **Sites:** this workspace's Sites whose title matches appear in a "Sites"
  group (at most five), ranked like chat titles, right after the chats (chats
  always come first; with no matching chats, Sites take their place). The Site
  rows the sidebar has loaded answer instantly; the artifact catalog's Site
  title search
  (`GET /v1/workspaces/:workspaceId/artifact-catalog?kind=site&q=…`, active
  Sites only) merges the rest as it answers, with the catalog's access checks,
  so another person's Only me Site never shows. Hostnames are not matched:
  reading a Site's publication needs Site manager access. A failed Site search
  leaves the rest of the menu as it is; a workspace that refuses access is not
  asked again until the menu opens next. Enter opens the Site in the app's Site
  view, as its sidebar row does (the desktop app too); ⌘Enter on the web opens
  it in a new tab.
- **Fork chat:** forks the chat on screen from its latest message, the same as
  the fork button under a message, and opens the same confirmation.
- **Ranking:** whole-title prefix, then a word in the title starting with the
  query, then substring, then all query words found in any order, then letters
  in order, read as an abbreviation that starts words (so "kbsh" finds
  "Keyboard shortcuts"). Those letter guesses only show when nothing matches
  properly, so "pin" lists the pin action and not every title with p, i and n
  in it. Ties go to the chat updated most recently. Archived chats are
  included last and marked.
- **Message text:** the last row is always "Search messages for “…”", which
  opens the existing full-history search with the query filled in. Full-history
  message search stays where it is; it is no longer on the path for finding a
  chat by name.
- **Keys inside the menu:** ↑ ↓ move, Enter opens, ⌘Enter opens the chat in a
  new tab on web or window on desktop, Tab on a chat shows its actions (pin,
  copy link, rename, archive; for a chat in another workspace, open and copy
  link), Esc closes.

The server title search changes from one literal substring to matching each
word: a chat matches when every word in the query appears in its title or first
message. This keeps today's behaviour for single words and fixes multi-word
queries in a different order.

## Discoverability

- Every menu item and button tooltip for a registry action shows its key, read
  from the registry.
- ⌘/ opens the cheat sheet: the registry's actions with chords, grouped, in the
  person's platform notation. ⌘K shows "Keyboard shortcuts ⌘/" as an action.
- Copy link and pin are added to the chat header's menu as well as the row
  menus, from the same actions.

## Where the code lives

- `packages/react/src/app/lib/actions/`: the registry, chords, matching, the
  window listener and ranking.
- `packages/react/src/app/components/command-menu/`: the ⌘K menu and the cheat
  sheet.
- `packages/desktop/src/main/menu.ts`: builds the menu bar from the actions the
  page reports, with the current static items as the fallback.
- `packages/db`: the word-based title search.
