# Opengeni web UI spec

The binding UI spec for `apps/web`. Every new or rebuilt screen follows it. Where it and older
code disagree, this file wins; bring the code in line when you touch it.

- Live reference: the DEV-only component studio at `/dev/ui-kit` (`bun run dev:web`, then
  `http://homeserver:3140/dev/ui-kit` or your dev URL). Every primitive below is shown there with
  its states, and the Pages group shows whole pages built from these decisions.
- Primitives live in `src/components/ui/`. Reuse them. If a pattern will appear on a second route,
  extract it into `components/ui` before shipping the second copy.
- Decided 27 Sep 2026 by Bendik. The kit keeps the retired alternatives visible for the history,
  marked with the "Decided" tag on the chosen one.

## 1. Principles

1. **Flat lists, one detail page.** A resource is a row. Clicking the row opens its own page where
   everything about it lives. At most one level of disclosure, never a card inside a card.
2. **Pages, not panels.** Nothing slides in from the side. Opening, creating and editing all happen
   on full pages in the content area with a "← Back to list" link, like Claude's and Codex's
   settings. Small centered modals are only for short confirmations and one-field prompts
   (section 8).
3. **One row anatomy everywhere.** Leading tile, title (with an optional small chip), one line of
   quiet meta ("by Maja Berg · Read-only IAM credentials…", truncated), a right-aligned date and a
   ⋯ menu or chevron.
4. **One primary action per region.** The loudest thing on a page is the thing most people come to
   do. Secondary actions go in the ⋯ menu.
5. **The control follows the meaning.** See section 5.
6. **Product words, not system words.** Name the product and the outcome ("Connect Gmail",
   "Replace value"). Scopes, IDs, enums, endpoints and registry names go behind one collapsed
   "Technical details" or disappear.
7. **Show the truth, or nothing.** Hide what the deployment can't do. When something is
   unavailable, say why and who can fix it. Never show a count, status or label the data can't back.
8. **One status language.** Dot plus label, sentence case, one tone table. Plans, scopes and types
   are metadata chips, not statuses.
9. **One frame.** One page header, two content widths, a small type scale, radii 10 / 14 / 16, a
   4px grid. Every destination appears once, with one name and one icon.
10. **Destructive means explicit.** Confirm with the real name, the real consequences and what
    depends on it. When something can't be deleted, say what blocks it before the click, in
    place of the action: no ghosted Delete button next to the reason.
    Reversible actions (remove access, archive, restore from history) use an Undo toast instead
    of a dialog.

## 2. Tokens

Use the Tailwind semantic names only. No raw hex, no `var(--og-x, #fallback)`, no shadcn aliases
(`bg-background`, `text-muted-foreground`, `bg-accent`), no `dark:` overrides inside
`components/ui`, no `text-[10px]` / `text-[11px]` literals.

| Token | Use |
| --- | --- |
| `bg` | Rail and page chrome (behind the rail glow). Inside the content pane `bg` resolves to `canvas` |
| `canvas` | The main content pane beside the rail or settings rail (`data-canvas`) |
| `surface` | Inputs, dialogs, menus, outline buttons |
| `surface-2` | Chips, segmented track, the detail page aside card |
| `surface-3` | Pressed, open |
| `hover` | The one hover: rail and settings-rail items, session and folder rows, list rows, suggestion cards, menu rows (highlight and keyboard focus), ghost buttons. A translucent `fg` wash, never a solid grey |
| `selection` | Selected and active: the open session row, the active nav item, a selected list row; also the secondary button fill. Always a clear step stronger than `hover` |
| `border` | Every hairline |
| `border-strong` | Outline hover |
| `fg` | Titles, labels, the active nav item |
| `fg-label` | Things you act on in navigation and lists: rail and settings-rail items, session titles, their icons. A hair under `fg`, never muted |
| `fg-muted` | Descriptions, meta lines, secondary button text, section labels in a rail |
| `fg-subtle` | Quiet meta, placeholders, separators |
| `brand` | Neutral grey: icon, link, focus, active tab bar, selected ring. Never blue |
| `primary` | The filled primary button only ("teal wash": `primary` fill, `primary-foreground` ink, `primary-border` edge, `primary-hover`) |
| `switch-track` / `switch-thumb` | A switch that is off |
| `status-idle` | Green: Connected, Active, Succeeded, Installed |
| `status-waiting` | Peach: Needs you, Needs reconnect, Pending review |
| `status-running` | Amber: Running, Syncing |
| `danger` | Red: Failed, Expired, destructive actions |

**Titles are never grey.** Every title, heading, row title, notice title, empty-state title,
card title, form label and legend is `fg`. `fg-muted` and `fg-subtle` are only for descriptions,
meta, placeholders and counts.

The palette is neutral grey everywhere (no blue or slate tint). Color appears only in the
primary button's teal wash, the soft teal/peach glow and the status hues.

| | Light | Dark ("graphite") |
| --- | --- | --- |
| `bg` (rail, chrome) | `#f6f6f6` | `#303030` |
| `canvas` (content pane) | `#ffffff` | `#202020` (darker than the rail) |
| `surface` / `surface-2` / `surface-3` | `#ffffff` / `#eeeeee` / `#e5e5e5` | `#333333` / `#383838` / `#404040` |
| `hover` | `fg` at 6% (`rgb(36 36 36 / 0.06)`) | `fg` at 8% (`rgb(230 230 230 / 0.08)`) |
| `selection` | `#e2e2e2` | `#484848` |
| `border` / `border-strong` | `#dedede` / `#bdbdbd` | `#454545` / `#555555` |
| `fg` / `fg-label` / `fg-muted` / `fg-subtle` | `#242424` / `#3a3a3a` / `#5f5f5f` / `#696969` | `#e6e6e6` / `#d4d4d4` / `#b8b8b8` / `#a3a3a3` |
| `brand` (accent) / accent-deep / accent-fg | `#545454` / `#383838` / `#ffffff` | `#c4c4c4` / `#d5d5d5` / `#242424` |
| `primary` fill / ink / edge | `#ebf2f0` / `#292929` / `#c4d5d0` | `#2b3432` / `#eeeeee` / `#4e5e59` |
| `status-waiting` / `running` / `idle` | `#8c5524` / `#716122` / `#237058` | `#e9ab77` / `#d5bd72` / `#83cbb0` |
| Glow teal / peach | `#9fe3d359` / `#ffb78752` | `#79d9c125` / `#ffb78724` |

Light `fg-muted`, `fg-subtle` and the light status hues are a step darker than the studio values
(`#686868`, `#767676`, `#a3652f`, `#8b782c`, `#287d64`), and dark `fg-muted` and `fg-subtle` a step
lighter than `#b0b0b0` and `#949494`, so every text token keeps 4.5:1 as 11-12px text on the rail,
`surface-2` and the hover wash, and `fg`, `fg-label`, `fg-muted` and the status hues keep it on the
selected row too (`fg-subtle` there is for icons only).

**Hover and selected.** There is one hover, the `hover` token: `fg` mixed into transparent (6% in
light, 8% in dark). Because it is translucent it darkens (light) or lightens (dark) whatever sits
under it by the same step - the rail glow, the canvas, a card, a menu panel - so it never blends
into the glow the way a solid grey does. Use `hover:bg-hover` on transparent rows and items; on
something with its own fill (a suggestion card) keep the fill and add the wash as a layer with
`hover:hover-layer`. Selected and active is a separate, stronger, opaque state: `selection` fill,
`fg` text, plus the brand bar (nav) or the `brand/20` edge (session row). A selected item keeps its
fill on hover. A roving keyboard tab stop shows the hover wash only while it holds focus.

**Buttons.** Primary: the teal wash, no shadow, hover mixes 15% ink into the fill. Secondary:
`selection` fill, `fg-muted` text. Outline: `surface` fill, `border`, `fg` text. Disabled: 50%
opacity for every variant, and only with a visible reason nearby (section 6).

**One primary per region.** The single most important action in a region is the teal-wash
primary; everything else there is the white outline, and tertiary actions are ghost or links. A
region is a page header, a section, an empty state, a dialog footer, a banner or notice, a form
page footer, or a menu.

- Primary: the page header's create or connect action ("New schedule", "Create API key", "Invite
  people"); a section's add action when the header has none for it ("Connect account" on
  Settings > Models); the action in an empty state ("Connect account", "Create schedule", "Start
  your first session"); the confirm of a non-destructive dialog or form page ("Create schedule",
  "Save"); the unblocking action in a notice, banner or menu ("Connect a model", "Open Models",
  "Reconnect", "Reload now").
- Outline: row actions (Rename, Resume on a row, Make primary, Replace value), a second action
  next to a primary, Cancel and Back. Destructive confirms use the destructive variant; a delete
  entry point is outline with danger text.
- Never two teal buttons in one region, and never an inverted (`fg`-filled) or near-black button.
  Selected chips and filters use `selection` with `fg` text, not an inverted fill.

**Rail glow.** The main rail and the settings rail use `.og-rail-glow`: a teal wash from the
top-left and a peach wash from the bottom-right over `bg`. The signed-out pages use
`.og-page-glow`, the same two washes down the left edge of the canvas.

Grey (`fg-subtle`) is Paused, Not connected, Revoked, Off. Always a dot plus a sentence-case
label; never color alone.

**Only states that need attention are shown.** A healthy object carries no status: no green
"Connected" or "Active" badge on a row or a page header. Show Needs reconnect, Paused, Out of
usage, Failed and the like; when nothing is wrong, the badge is simply absent. Green stays for
results the person just caused or is waiting on (Succeeded, Installed).

## 3. Type scale

Inter Variable with `cv11 ss01 ss03`; JetBrains Mono for IDs, code and key prefixes only.

| Role | Size / line | Weight | Notes |
| --- | --- | --- | --- |
| Page title, detail page title | 20 / 28 | 600 | -0.5px tracking |
| Dialog title | 18 / 26 | 600 | -0.25px |
| Section heading | 16 / 24 | 600 | -0.2px; one step above row titles so a section never reads as a setting |
| Row title, tab, button, label | 14 / 20 | 500 | `fg` |
| Rail and settings-rail items, session titles | 14 / 20 | 400 | `fg-label`; the active item is marked by its fill and bar, not by weight |
| Body, page subtitle, meta line under a detail title | 14 / 20 | 400 | `fg-muted` |
| Description, help | 12 / 18 | 400 | `fg-muted`, 2-line clamp in rows |
| Meta, chip, count | 11 / 16 | 500 | `fg-subtle` or a tone |
| Mono | 12 / 18 | 400 | IDs, code, key prefixes only |

Retired: 13 and 10px text, 16px anywhere but section headings, uppercase tracked group labels,
opacity-muted text.

## 4. Spacing, radius, elevation, frame

- Spacing: 4px base, steps 4, 8, 12, 16, 24, 32, 44.
- Radius: 10px controls (buttons, inputs, nav items, logo tiles, segmented track); 14px rows,
  search field, cards, the detail aside card; 16px dialogs and popovers; full for chips and pills.
- Two widths: **standard** 960px (settings, detail pages, resource lists) and **wide** 1136px
  (catalogs, dashboards). Form pages use one 640px column, left-aligned in the 960px frame so the
  back link and title sit where the detail page puts them.
- Header rhythm: title top 24, subtitle +4, then 16px of space and no hairline under the header
  (the title and the first section breathe instead; `divider` draws one only where a page needs
  it). On settings pages the first section heading sits 32px below that. Tabs are 44px tall
  with their own rule; first section 44 below the tab rule.
- Sections: heading to description 4, to content 12. **In settings (workspace and
  organization), every section is a grouped card**: the heading and description sit outside,
  above; the rows sit in one card (1px `border`, radius 14, `surface`, 20px side gutter, 4px top
  and bottom) split by inset hairlines, and sections are 32px apart with no rule between them. A
  resource list (people, API keys) that is a page's content is itself the card. A Notice among
  the rows loses its own box (never a card in a card); a section whose rows render nothing shows
  no empty card. The settings shell sets this (`SectionVariantProvider variant="group"`); pages
  don't choose it. Outside settings, sections stay open: one hairline with 24 above and below,
  no boxes.
- **Dependent settings are a sub-selection under their parent.** A setting that only applies
  while another is on (Voice input > Transcription provider, Try another provider) appears only
  while the parent is on, indented 20px under it (48px under a control-left row, in line with its
  label), with no hairline between the parent and its children or between the children, and no
  guide line; the hairline comes after the whole group. Children keep the ordinary row type
  (title, description, control on the right) with tighter spacing (44px rows, 8px padding). A
  large group of dependent rows becomes its own card with its own heading instead.
  `SettingRow` children render this way.
- A block that is not a SettingRow list (e.g. "Linked product access") takes the same heading
  plus card treatment; its empty or loading line is a row inside the card.
- **Never a card inside a card.** Nothing inside a settings card draws its own box: a list is
  rows split by the card's hairlines, a Notice, an inline form, a one-time secret or Technical
  details is a row with no border of its own, and choice cards become flat
  radio rows (radio, title, consequence line) on the card's text column; the filled radio marks
  the choice, with no fill or inset of its own.
  `ChoiceCards` and `ListRow` do this themselves when they sit in a card. A section whose content
  is a single boxed control (a large textarea, a code editor) stays open (`variant="open"`): the
  control is the card. A form dialog or sheet opened from a card starts fresh (`FormDialog` and
  `Sheet` wrap their content in `SectionFrameReset`; a plain `Dialog` that shows lists or choices
  does the same itself, so the startup bundle doesn't carry the section context).
- Rows: catalog 76px (40px tile, 2-column grid at 720px+, for discovery); resource 64px (32px
  tile, one column, hairline dividers, for things you own). **Every row in a list has the same
  height.** A resource row is its title plus ONE secondary line: the description and the meta
  facts share it and truncate; a row without them centers its title in the same 64px. A status
  ("Suspended", "Invited · expires in 14 days", "Revoked") goes in `ListRow`'s `status` slot, at
  the right of the name area on wide lists and on the secondary line on narrow ones, never on an
  extra line. On a phone-width list the line keeps the description and one folded fact, or
  the status instead of the facts; a chip on the line never makes the row taller. Only a
  disabled reason may wrap. A short list of accounts on a settings
  page may use the 40px tile. Inside an open section a resource list is `flush`: tiles and titles
  line up with the section title, the hover bleeds 12px out with a 10px radius, and the hairlines
  stay inside the content edge.
- One control height: every control at the right end of a row (button, select or picker trigger,
  segmented control) is 32px tall (44px on coarse pointers). Buttons and triggers share the
  secondary button's 10px radius and border; a model picker in settings uses the "field" trigger
  (model name, then the payer in muted text, never the reasoning effort, never a pill). Switches
  keep their own 20px size.
- Elevation: pages and rows are flat, hover is the `hover` wash. Dialogs: 1px border +
  `shadow-lg`. Menus: `shadow-md` (see "Menus and popovers" below).
- Focus: 2px ring in brand (neutral grey) at 55%, 2px offset. Motion: 120ms, color and opacity
  only.
- Rail: 240px in every mode, on the rail glow. Nav item 32px, radius 10, 16px icon, 14/400
  `fg-label` (icon and text alike); hover = the `hover` wash; active = `selection` + `fg` + a 2x16px
  brand bar. Session
  titles and the "Sessions" heading are `fg-label` too; only true meta (timestamps, counts, "Show
  2 more", the empty note) is `fg-muted` or `fg-subtle`. The open session row is a selected row:
  `selection` fill, `fg` text and a 1px `brand/20` edge, radius 10; row hover is the `hover` wash. The
  settings rail follows the same rule, with its group labels in `fg-muted`.
- Every page works at 390px wide with no horizontal scroll and 44px touch targets on coarse
  pointers.

### Menus and popovers

One surface and one row for every menu, in both themes: the workspace picker, the project folder
picker, the composer "+" menu and its drill-ins, the model and voice pickers, row and header ⋯
menus, right-click menus, selects, comboboxes and hover cards. The classes live in
`components/ui/menu-styles.ts` (the SDK mirrors them in `packages/react/src/lib/menu-styles.ts`);
the Radix primitives (`dropdown-menu.tsx`, `context-menu.tsx`, `select-menu.tsx`) already apply
them, so a call site sets a width and nothing else.

- **Panel:** `surface` fill (`--color-popover` is `surface`, never `surface-3`), 1px `border`,
  16px radius, `shadow-og-md`, 6px inset. No second border, tint or shadow on a call site.
- **Row:** 32px (44px on coarse pointers), 10px side padding, radius 10. A 16px icon in
  `fg-muted`, 10px gap, then the label in 14/400 `fg`. Hover and keyboard focus are the same
  `hover` wash (the app-wide hover token); menu items draw no focus ring (triggers and plain buttons keep theirs).
  Disabled is 50% opacity; destructive is `danger` text and icon.
- **Right side**, in this order: meta (a count or the current value, 12px `fg-muted`), then a
  16px chevron in `fg-muted` for a row that opens a submenu, or the check. **The chosen option
  gets a 16px `fg` check on the right**, never a tint, bold label or left-hand dot; every option
  of a choice list reserves the check's slot so meta lines up.
- **Group heading:** 12/500 `fg-muted`, sentence case (never uppercase). **Separator:** one
  `border` hairline inside the 6px inset, 6px above and below.
- **Create action** ("New project", "New workspace in Acme", "Add repository URL"): an ordinary
  row with a plus icon and `fg` label, last in the list it adds to, with no separator before it.
- **Drill-in (submenu inside the same panel):** a header with a 32px back button (chevron-left)
  and the title in 14/500 `fg`, over a hairline. Radix side submenus use the same panel.
- **Empty, unavailable:** one plain sentence (or a 14px line plus one 12px reason) in
  the panel, never a card, dashed box or icon tile. Say it once, and hide an action that can't
  work (no disabled "Refresh list" when GitHub is unavailable).
- **Loading never shows inside an action menu.** A menu opens at its final size: its data and
  code are fetched before it opens (the composer warms every "+" drill-in when "+" is hovered,
  focused or idle, via `lazyComposerPanel`) and kept, so a reopen shows the last rows and a
  refresh updates them in place. Only a true first load shows skeleton rows at the final row
  height (`ComposerMenuRowsSkeleton`), never a "Loading…" sentence, and nothing behind the menu
  on the page says it is loading.
- **Per-chat settings live under "+".** The composer bar holds only "+", voice, the model and
  Send. Where the chat runs (managed sandbox and its Sandbox Environment, or a connected machine
  and its folder), who can see it, variable sets, repositories and chat settings are "+" rows
  with the current value as right-side meta, each opening a drill-in. The project chip above the
  message stays: it says where the new chat is filed, not how it runs. A running chat's header
  names its compute only when it runs on someone's own machine. Workspace defaults for these
  are on workspace General > New session defaults.
- Tiles and logos in rows (workspace initials, organization, apps) fit the 16px icon slot so
  labels align; richer rows (connectors with a logo, name and account) keep the same padding,
  radius and hover and have no dividers between them.

## 5. Which control when

| Control | Use when | Never |
| --- | --- | --- |
| Switch | One on/off setting that saves immediately. One exception: the single "all or pick" switch at the top of a form page that reveals the list below it ("Allow every model"); the page's Save commits it | Inside a form with a Save button otherwise |
| Segmented control | 2-4 mutually exclusive short options, always visible | More than 4 options, or long labels |
| Choice cards | 2-3 options where each needs a consequence sentence | Simple filters |
| Select (menu style) | 5+ options or a dynamic list; model and role pickers with descriptions and payment source | Actions |
| Combobox | Long or remote lists that need search (people, repositories, time zones) | Fewer than about 8 options |
| Checkbox | Picking several from a set, inside a form with Save | Immediate on/off |
| Dropdown menu | Actions on one object (row ⋯: Replace value, Delete) | Choosing a value |
| Disclosure | Secondary options of the same object, one level ("Advanced", "Technical details") | Nested, or hiding the primary action. A right chevron means "opens", never "expands" |
| Navigational row | A setting that lives on its own page (Allowed models, Models it can serve): the whole row opens it, the current value sits muted by a chevron (`SettingNavRow`) | An Edit, Change or View button whose only job is to open a page |
| Detail page | Anything you open: see section 8 | A side sheet |
| Form page | Every create and edit flow | A side sheet, or an inline form that pushes the list down |
| Centered dialog | A short confirmation, a one-field prompt, or a short choice right before one action ("Pause agent work": a few options, Cancel and the action) | Anything with two or more fields, a long list, or tabs |

**No menu buttons for a choice before an action.** A button with a chevron that opens options
("Pause" > 30 min, 1 hour, Custom) hides the choice and mixes a menu with an action. Use a plain
button that opens a small centered dialog: a short choice list, one sentence on what happens, then
Cancel and the action as the primary.

## 6. Copy rules

- Name the product and the outcome: "Search, read, draft, and send email from your Gmail."
- CTA = verb + object: "Connect Gmail", "Replace value", "Add people", "Create schedule".
- No scopes, IDs, UUIDs, enums, tags, endpoints or registry names outside "Technical details" or a
  CopyField.
- Unavailable: say why and who can fix it, and disable or hide the action.
- Errors: what happened + what to do. Never a raw `OpenGeni API 404 ... Reference: <uuid>` string;
  the reference goes in Technical details. Use `lib/api-error.ts`: `userErrorText` for toasts and
  form errors, `ErrorMessage {...apiErrorDetails(error)}` for a failed section (what happened, the
  advice, Try again, the reference behind Technical details).
- Permission refusals are not errors. A 403 or a missing permission replaces the rows with one
  calm muted line naming who can grant it ("Only workspace admins can manage webhooks. Ask a
  workspace admin for access."), with no red and no Retry (`isPermissionDenied` picks it). In a
  Personal workspace, where nobody administers the workspace, say where it can be done instead.
- One name per object across rail, title, back link, buttons and toasts. One noun per concept
  (schedule, not "scheduled task").
- Descriptions say what the setting does, and what Off keeps if that matters: "Summarizes long
  chats in a form another provider's model can continue. Off keeps new chats on Codex, with better
  memory of long conversations." Never spell out both states as "On: ... Off: ...". Details only
  some people need go in a tooltip.
- **No description that restates the label.** A page subtitle, section description or row
  description earns its place by adding something the label and value don't say. "General" does
  not need "The organization's name and ID"; a "Name" row shows the name, not "The name people
  see". Drop it rather than paraphrase.
- **Every settings card has a short heading, and it never repeats the page title.** Settings >
  General opens with a "Details" card (Name, Type, ID), not a headless card and not a
  "General", "Workspace" or "Organization" heading.
- The product is "Opengeni" (lowercase g) in every user-visible string: titles, labels, toasts,
  meta. Code identifiers, package names (`@opengeni/...`), env vars and URLs keep their own
  spelling.
- Sentence case everywhere. Plain dashes (-), never em-dashes. Dates as "Mon 28 Sep, 08:00" or
  "3 days ago" with the exact time on hover; never seconds, never ISO.
- No ellipsis in button labels: "Delete", "Pause", "Rename", not "Delete...". A button that opens
  a dialog is still named for what it does. Progress labels ("Saving…") and loading text keep it.
- Back links name the list they return to: "Variable sets", "Models", "Your skills". The arrow is
  the icon, not a character in the label.

## 7. Lists and settings on one page

Learned on Settings > Models, 27 Sep 2026.

- **One flat list per kind of thing.** Connected accounts of every provider are one divided list.
  No group headers inside a list, no pool-wide controls between rows, no ⋯ menu floating above
  them.
- **Settings of a group get their own section, as setting rows.** "Sharing work between
  accounts", "Keep Codex chats portable": each row has exactly one control. A destructive action
  for the group ("Turn off Codex") is the last row, as quiet danger text (`SettingDangerRow`) that
  confirms in a dialog. Show them directly; don't fold two or three rows under an "Advanced".
- **No control for what the system decides.** When the product picks something automatically
  (which Codex accounts new work uses), say the outcome in one line above the list ("New work uses
  this workspace's Codex accounts. The organization's account is set aside while these are
  connected.") and mute what is set aside ("Not in use") instead of offering a switch people read
  as a filter. A saved explicit choice shows truthfully in that line with one quiet way back
  ("Use automatically").
- **Unconnected options are not rows.** A provider you haven't connected is a choice on the
  Connect (or New) page, never a list row with its own Connect button. With nothing connected, the
  list becomes the empty state with the one Connect action.
- **The create/connect page is a list of rows** (logo, name, one line on how it works or who
  pays), each opening its own step. Not choice cards with a Continue button.
- **Navigate with the row, not with a button.** A setting that opens a page is a navigational row
  (section 5). Buttons on rows do something (Rename, Make primary, Turn on).
- **Edit pages for existing settings** show Cancel and Save only once something changed; until
  then the back link is the way out.
- **Empty lists carry their own action.** While a list is empty, its toolbar and the header's
  create action hide; the empty state holds the one action.
- **Tiles for kinds of object, words for types.** Every row has a leading tile, and the tile marks
  the kind of object (a collection, a file, an entry; a site, an image, a document). Types of the
  same object (Decision, Fact, Incident) share that object's tile and are a quiet word first in
  the meta line ("Decision · Staging runs on walrus-2…"), never an icon each.
- **Nothing to pick, nothing shown.** Hide a chip, filter or picker that has only one possible
  value or none.
- **One row per provider.** A provider with several connection modes is one row; its page lists
  the modes as outcomes ("Pay with your ChatGPT plan", "Pay per use with an API key").
- **Toolbar pieces stay in the toolbar.** `ToolbarSearch` always sits inside a `Toolbar`. A `Select`
  in a narrow `SettingRow` gets a fixed width so the column doesn't jump between values.

### Resource pages

Learned on Knowledge, Schedules, Artifacts and Capabilities, 29 Sep 2026. The four read as one
system; a new main-rail page of things follows them.

- **One frame.** `PageHeader` with the rail icon, the title and a subtitle that adds something;
  on the right the page's one primary create action ("Add knowledge", "New schedule", "New
  artifact", "Add connection") and, when there is more, a ⋯ with the rest (Upload files, New
  collection, Learning). Never a second button with a chevron. Places on the page are underline
  tabs in the header; search, filters and the view toggle are a `Toolbar` 24px under them.
  Resource lists use the standard width, catalogs the wide one.
- **One row.** Tile, title (a scope chip only when it isn't the default), one quiet line (type
  word first, then where it came from or the text, truncating from the end), a status only when
  it needs attention (`status` slot), then the date as a right-aligned column and the ⋯ or
  chevron. Lists under a page header are `flush`, so tiles line up with the title and the
  search. What you have is resource rows; what you can add (Capabilities' Popular, Browse) is
  the catalog.
- **A healthy object carries no badge**, on its row or its page ("Active" is never shown).
- **Review is a list and a page per change.** Each waiting change is a row (what it is, where it
  came from, when); the row opens the change's own page (`?view=review&proposal=`), where the
  proposal reads as it will be kept: new text plainly, a change as prose with added text marked
  and removed text struck through. The page header holds the one action row: Reject and Edit as
  outline, Approve (or "Approve and next") as the primary, and a ⋯ for Open entry and Approve all
  from the same chat. A decision moves straight to the next change, and the last one returns to
  the list. Edit replaces the text with the form on the same page. The learning mode is not a
  line over the list: it lives in the page's ⋯ ("Learning · Automatic"), and an empty Review
  says in one sentence why nothing waits, with Learning settings as its action.

### State and truth on a page

- **Workspace-wide state is a banner with its action.** A paused workspace shows one banner at the
  top of the affected pages with Resume in it, not a disabled control on every row.
- **On a paused object's page the primary action is Resume.** Everything else moves to the ⋯
  menu until it runs again.
- **Unrelated gaps never block editing.** A missing capability disables only the control that needs
  it, with the reason; the rest of the form stays editable.
- **Never claim a count you don't have.** Detail meta and "Used by" say "Checking use..." while
  unknown and fail closed (no count, no "Not used") when the check fails.
- **Say each fact once.** A detail page's aside must not repeat what the header already says
  (plan, owner, "Belongs to"). If the aside would only repeat the header, drop it. The header meta
  is one line ("ChatGPT Pro · Shared by Acme" or "ChatGPT Pro · This workspace"); an object you
  can't change says who can in one muted sentence ("Managed by your organization.") or, for those
  who can, one button to the place that manages it.
- **Name the organization or say "your organization".** Use its real name; never put a short id
  ("Org f011ba91") into a sentence.
- **Available, not hidden, when a server turns something off.** A provider this deployment has
  turned off stays on the Connect page, disabled, with "Not enabled on this server".

## 8. Pages, not sheets

This is the one rule people most often get wrong, so it has its own section.

**Anything you open is its own page.** A variable set, a Codex or model account, a person, an API
key, a schedule, a knowledge entry, a workspace, an environment. The list row navigates to a
URL (`/variable-sets/aws-production`, `/models/accounts/ops`), the page renders inside the content
area (the rail, or the settings rail, stays), and a back link returns to the list with its scroll
and filters intact.

The detail page anatomy (`components/ui/detail-page.tsx`, following Claude's skill page):

```
← Variable sets                                     DetailPage back
[tile] AWS production  [Organization]      [+ Add variable] [⋯]
       4 variables · Used by 1 schedule · updated 3 days ago
Variables 4 | Used by 1                              underline tabs
─────────────────────────────────────────────────
Main column: DetailSection ...        | Quiet aside card:
                                      |   Available to / Last change / ID
```

- `DetailPage` - the 960px column and the back link.
- `DetailPageHeader` - 40px `LogoTile` or avatar, 20/600 title, `chips` (StatusBadge, MetaChip),
  a `meta` line (pass an array; parts join with " · "), `actions` (at most one primary, then a ⋯
  menu that holds Rename, Delete, Disconnect), and optional `tabs` (`LineTabsNav` underline, with
  counts). Header actions are 32px with the 10px radius (`size="sm"` buttons, `RowButton`, and
  `MoreMenu` for the ⋯); the default 36px button is for a list page's `PageHeader` primary only.
- `DetailPageBody` - the main column of `DetailSection`s split by hairlines, and an optional
  `aside` (`DetailAside` + `DetailAsideItem`: "Created by", "Available to", IDs). The aside
  drops under the main column below 620px of content width. **It must not repeat header facts**;
  when it would, there is no aside.
- A single technical fact (one ID) is not worth a "Technical details" disclosure: put it in the ⋯
  menu ("Copy account ID") or on one quiet row. A disclosure holds two or more things.
- **Back returns where you came from.** A link into another scope (a workspace's settings ->
  organization settings, or back) passes its origin (`from` + `fromLabel`, `lib/return-to.ts`),
  and the destination's back link says and returns there ("← Design preview · Models"). Without
  it, Back goes to the page's own parent.
- Focus moves to the page title when the page opens in place; the title is focusable from script
  (`useFocusOnNavigation`). Back on the list, focus returns to the row that was opened.

**Settings is a mode of the rail.** Entering settings (the rail footer's Settings, any workspace,
organization or personal settings URL, and the Agents, Insights and runtime pages listed in the
settings rail) swaps the main rail for the settings rail, drawn by `SettingsShell`
(`components/settings/settings-sidebar.tsx`, sections from `settings-rail.tsx`): a back link that
leaves settings ("Back to sessions"), then the one workspace picker (the same component and menu as
the main rail's: workspace name, organization under it), then every settings page the person can
use in one rail, in three sections: **Workspace** (its settings and dashboards, then its runtime
pages), **Organization** (only the organization pages this person can use) and **Your
account**. Each section starts with a plain text header in 14/500 naming only the scope
("Workspace", "Organization", "Your account"): the picker already names the workspace and
organization, so headers don't repeat them (only where there is no picker, as for a workspace an
admin manages without access, does the header add the name as quiet 12px meta). These are the only
headings. Inside a section, pages fall into at most two groups set apart by space, never by a
second level of labels: Workspace = its settings and dashboards, then its runtime (Variable sets,
Sandbox environments, Machines); Organization = the organization and its people (General, People,
Workspaces, Organization identity), then what it provides, pays for and protects (Models,
Integrations, Billing & usage, Developer, Security & data). Sections are split by one hairline.
There are no per-section switchers. Workspace, organization and personal settings all draw this
same rail, so the scope of every page is visible and nothing jumps to a second rail. Switching
workspace or organization in the picker keeps the same kind of page;
switching organization returns to the workspace last used there. Leaving
restores the main rail. Below 1024px the settings rail folds into a header with the back link, the current page and
its scope ("Organization · Acme Robotics", since the picker is out of sight until the drawer
opens), and a Menu button that opens it in a drawer. Settings pages render full width beside
the rail in the standard 960px column, with the section's page header; a sub-page (an account, a
key, a person, a form) hides that header and declares its own back link and title. Pages that own
their layout (Agents, Insights, Variable sets) render their own `ContentPage`. Every sub-page has its own URL param (`?account=`, `?key=`, `?view=`), so
reload and browser Back work, and its back link returns to the tab or list it was opened from.
Inside settings, pages are flush: `FLUSH_DETAIL_PAGE_CLASS` for `DetailPage`,
`FlushFormPage` (or `FLUSH_FORM_PAGE_CLASS`) for `FormPage`, and the flush `AccessList`, so the
back link, title and rows start where the section header does. Page actions use `RowButton` and
`MoreMenu` from `components/ui/page-actions.tsx`.

**Creating and editing is a page too.** New schedule (`/schedules/new`), Edit schedule, New
variable set, Add variables, Create API key, Invite people, Connect account, New workspace, New
knowledge entry. Use `FormPage` from `components/ui/form-dialog.tsx`: a back link, a 20/600
title, one 640px column of fields, server errors inside the form, and a sticky footer with Cancel
(ghost) and one primary. A second step after submit (an API key shown once) happens on the same
page. After a create, go to the new object's page.

**A small centered modal is still right** for:

- Destructive confirmations with consequences: Delete, Revoke, Disconnect, Remove
  (`DestructiveConfirm`, including type-to-confirm and the blocked variant).
- One-field prompts where a page would be absurd: Rename, Replace value (`FormDialog`, size `sm`).
- A short OAuth or device-code step (show a code, wait for the provider), opened only from a
  page's primary button.

Never: a right-side sheet or panel for anything, a sheet opened from a sheet, an inline create form
that pushes the list down, or a dialog with tabs or a list in it. `DetailSheet` and `FormSheet`
remain in `components/ui` only for existing call sites that have not moved yet; do not add new
uses.

## 9. Decided component picks

All picks are the kit's decided versions. Build these; the alternatives in the kit are history.

| Component | Decision |
| --- | --- |
| Page header | Icon on main-rail pages only; settings pages drop the icon because the settings rail gives context. |
| Navigation | Settings swaps the rail for the settings rail (240px, grouped, icons) with a back link that restores the main rail. No settings sub-nav inside the content. |
| Workspace picker | The trigger names the workspace and, under it, its organization; a Personal workspace shows a lock tile and "Private · <organization>" instead of a chip, so names keep the width (menu rows use the same lock tile, no chip). Privacy is said once per place and only where it is true: the new-chat page of a Personal workspace has one quiet line ("Private: only you can see chats here."), and its session header a read-only lock + "Private" whose tooltip says admins can't open it and billing shows only usage amounts. Shared workspaces show no privacy marks except an actual Only me chat, whose access control already reads "Private". The same picker heads the settings rail. The menu shows the current organization as a header with its workspaces and "New workspace in <organization>" (disabled with the reason when the person can't create there; never created in another organization), then Organization settings, then the other organizations under "Switch organization" and New organization. Switching organization returns to the workspace last used there (else its first shared workspace, else the Personal one). New workspace is one flow: the organization's New workspace page (Organization settings > Workspaces), opened with a back link to where you were; created from the picker, you land in the new workspace. |
| Section | 16px title (one step above the 14px row titles), 12px description. In settings the rows below sit in one grouped card; elsewhere they sit open with one hairline between sections. |
| Tabs and toolbar | Underline tabs; search, filter and the primary action in a toolbar that keeps its shape. Status filters are not a second tab row. |
| List row | Divided resource row (56-64px, 32px tile, one meta line) for things you own; the catalog row (76px, 40px tile, 2 columns) for discovery. Same tile, type and hover. |
| Detail | **Detail page** (section 8). No side sheets. Expand in place only for one level of secondary options. |
| Empty state | Centered: 40px icon tile, title, one sentence, one action; the header action hides while empty. Add 2-3 template cards where starting is hard (Schedules). |
| Setting row | Label and description left, the one control in a fixed right column. A setting with its own page is a `SettingNavRow`; a destructive group action is a `SettingDangerRow` at the end. |
| Switch | The primary fill and edge when on, with a primary-ink thumb; the `switch-track` with a `switch-thumb` when off, visible in both themes. |
| Segmented control | Filled track with the active option raised on the surface. |
| Choice cards | Brand ring: brand border, faint brand fill, a check in the corner. The same highlight for every selected state. Inside a settings card they become flat radio rows split by the card's hairlines. |
| Select | Menu select like the composer: title, description, payment source, a check on the selected option. The settings trigger is the 32px "field" style, as wide as its content (at least 180px). |
| Disclosure | Advanced row: full-width row, rotating chevron, title and a summary of current values. |
| Status badge | Plain dot + label in rows; the bordered 22px pill with a 6px dot in page headers. |
| Usage meter | A 4px bar with "22% left" and the reset time on the account page. In an account row, `UsageReadout`: "78% left this week" and a 64px bar, right-aligned against the chevron (words only where the row folds on a phone). |
| Form | **Form page** (section 8) for every create and edit flow; a centered dialog only for one-field prompts. |
| Destructive confirm | Consequence list by default; type-to-confirm for permanent, wide-impact actions; Undo toast instead of a dialog when reversible; a blocked variant with no destructive button. |
| Secret values | Write-only: values are never shown after saving; Replace value only. |
| Cadence picker | Sentence builder: [Every weekday] at [08:00] [Oslo time], with a live next-run line. |
| Access list | Inline role select that saves immediately and a ⋯ menu with Remove, the same rows in every place access is edited. |
| Foundations | One `LogoTile` (40/32/24px): brand logos on a light tile in both themes, fallback icons on `surface-2`. `RelativeTime` ("3 days ago", exact time on hover), `CopyField` for IDs, `DiffView` with revision history. |

## 10. How to restyle

Colors, fonts and most sizes are tokens, so a restyle happens in two files, not in components:

- `packages/react/styles/tokens.css` (`@opengeni/react` tokens) defines the palette and fonts as
  `--og-*` variables for light and dark (`--og-color-bg`, `--og-color-canvas`,
  `--og-color-surface-1`, `--og-color-selection`, `--og-color-hover`, `--og-color-accent`,
  `--og-color-primary*`, `--og-glow-*`, `--og-color-status-*`, `--og-font-sans`, ...). Change a
  color or font there and every surface follows, in both themes. Run `bun run build:css` in `packages/react` after
  editing it; `compiled.css` is checked in.
- `apps/web/src/styles.css` maps those onto Tailwind names in `@theme` (`--color-bg`,
  `--color-canvas`, `--color-brand`, `--color-primary`, `--font-sans`, `--radius-md` 10px,
  `--radius-lg` 14px, `--text-2xs`), rebinds `bg` to `canvas` inside `[data-canvas]`, and holds
  the glow classes. Rename or retune the scale there.

Components use only the semantic utilities (`bg-surface`, `text-fg-muted`, `border-border`,
`text-brand`, `rounded-md`), so they pick up the change without edits. Some primitives still
write the 10px and 14px radii as literals (`rounded-[10px]`, `rounded-[14px]`); a radius restyle
means moving those to `rounded-md` / `rounded-lg` first. Check the result in `/dev/ui-kit` with
the Side by side theme before shipping.
