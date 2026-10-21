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

| Action | Mac | Windows and Linux | Notes |
| --- | --- | --- | --- |
| Command menu | ⌘K | Ctrl+K | Chats and actions in one list |
| New chat | ⌘⇧O, and ⌘N on desktop | Ctrl+Shift+O, Ctrl+N on desktop | Browsers reserve ⌘N |
| Copy chat link | ⌘⇧, | Ctrl+Shift+, | Linear's key for copying an issue URL |
| Pin or unpin chat | ⌘⌥P | Ctrl+Alt+P | Clear of the common browser shortcuts |
| Inbox | ⌘⇧I | Ctrl+Shift+I on desktop only | Browsers on Windows and Linux use Ctrl+Shift+I for developer tools |
| Previous or next chat | ⌥↑ / ⌥↓ | Alt+↑ / Alt+↓ | Sidebar order, like Slack |
| Pinned chat 1 to 9 | ⌘1 to ⌘9 on desktop | Ctrl+1 to 9 on desktop | Browsers use these for tabs |
| Find in chat | ⌘F | Ctrl+F | Exists today |
| Toggle sidebar | ⌃⌘S | Ctrl+Shift+S | Exists on desktop, added on web |
| Shortcut cheat sheet | ⌘/ | Ctrl+/ | Slack's key |

Desktop keeps ⌘⌥1 to 9 for switching accounts and ⌘[ / ⌘] for back and forward.

**Control+Tab** is open. Browsers keep Control+Tab for switching tabs, so on the
web it can never reach the page. On desktop the recommendation is a recent-chats
switcher: hold Control, press Tab to step back through the chats you viewed
most recently, and let go to open the highlighted one, like the macOS app
switcher and VS Code. The alternative is to make it a second key for next chat.

## The ⌘K menu

Opening it is instant: no request is made before it appears.

- **Empty query:** recent chats you opened (most recent first), then pinned
  chats, then a short list of common actions (new chat, inbox, copy link, pin)
  with their keys.
- **Typing:** results update on every keystroke from chats already loaded in
  the sidebar and recent list, ranked by how well the title matches. The server
  title search runs alongside and merges in chats the sidebar has not loaded.
  Actions that match appear in their own group with their keys.
- **Ranking:** whole-title prefix, then a word in the title starting with the
  query, then substring, then all query words found in any order, then letters
  in order (so "kbsh" finds "Keyboard shortcuts"). Ties go to the chat updated
  most recently. Archived chats are included last and marked.
- **Message text:** the last row is always "Search messages for “…”", which
  opens the existing full-history search with the query filled in. Full-history
  message search stays where it is; it is no longer on the path for finding a
  chat by name.
- **Keys inside the menu:** ↑ ↓ move, Enter opens, ⌘Enter opens the chat in a
  new tab on web or window on desktop, Tab on a chat shows its actions (pin,
  copy link, rename, archive), Esc closes.

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
