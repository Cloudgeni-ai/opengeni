# OpenGeni web UI spec

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
    depends on it. When something can't be deleted, say what blocks it before the click.
    Reversible actions (remove access, archive, restore from history) use an Undo toast instead
    of a dialog.

## 2. Tokens

Use the Tailwind semantic names only. No raw hex, no `var(--og-x, #fallback)`, no shadcn aliases
(`bg-background`, `text-muted-foreground`, `bg-accent`), no `dark:` overrides inside
`components/ui`, no `text-[10px]` / `text-[11px]` literals.

| Token | Use |
| --- | --- |
| `bg` | Page canvas, rail |
| `surface` | Inputs, dialogs, menus |
| `surface-2` | Row hover, active nav, chips, segmented track, the detail page aside card |
| `surface-3` | Pressed, open |
| `border` | Every hairline |
| `border-strong` | Outline hover, switch off-track |
| `fg` | Titles, labels |
| `fg-muted` | Descriptions, meta lines |
| `fg-subtle` | Quiet meta, placeholders, separators |
| `brand` | Icon, link, focus, active tab bar, selected ring |
| `primary` | The filled primary button only |
| `status-idle` | Green: Connected, Active, Succeeded, Installed |
| `status-waiting` | Purple: Needs you, Needs reconnect, Pending review |
| `status-running` | Amber: Running, Syncing |
| `danger` | Red: Failed, Expired, destructive actions |

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
| Row title, tab, nav, button, label | 14 / 20 | 500 | |
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
- Header rhythm: title top 24, subtitle +4, hairline 16 below; tabs 44px tall; first section 44
  below the tab rule.
- Sections: heading to description 4, to content 12. Between sections one hairline with 24 above
  and below. No boxes around sections.
- Rows: catalog 76px (40px tile, 2-column grid at 720px+, for discovery); resource 56-64px (32px
  tile, one column, hairline dividers, for things you own). A short list of accounts on a settings
  page may use the 40px tile. Inside an open section a resource list is `flush`: tiles and titles
  line up with the section title, the hover bleeds 12px out with a 10px radius, and the hairlines
  stay inside the content edge.
- One control height: every control at the right end of a row (button, select or picker trigger,
  segmented control) is 32px tall (44px on coarse pointers). Buttons and triggers share the
  secondary button's 10px radius and border; a model picker in settings uses the "field" trigger
  (model name, then the payer in muted text, never the reasoning effort, never a pill). Switches
  keep their own 20px size.
- Elevation: pages and rows are flat, hover is a `surface-2` fill. Dialogs: 1px border +
  `shadow-lg`. Menus: `shadow-md`.
- Focus: 2px ring in brand at 55%, 2px offset. Motion: 120ms, color and opacity only.
- Rail: 240px in every mode. Nav item 32px, radius 10, 16px icon, 14/500 muted; active =
  `surface-2` + `fg` + a 2x16px brand bar.
- Every page works at 390px wide with no horizontal scroll and 44px touch targets on coarse
  pointers.

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
  the reference goes in Technical details.
- One name per object across rail, title, back link, buttons and toasts. One noun per concept
  (schedule, not "scheduled task").
- Descriptions say what the setting does, and what Off keeps if that matters: "Summarizes long
  chats in a form another provider's model can continue. Off keeps new chats on Codex, with better
  memory of long conversations." Never spell out both states as "On: ... Off: ...". Details only
  some people need go in a tooltip.
- **No description that restates the label.** A page subtitle, section description or row
  description earns its place by adding something the label and value don't say. "General" does
  not need "The organization's name and ID"; a "Name" row shows the name, not "The name people
  see". Drop it rather than paraphrase. The same goes for a section header that only repeats the
  page title: Settings > General starts with its rows (Name, ID) and no "Organization" or
  "Workspace" header.
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
- **Nothing to pick, nothing shown.** Hide a chip, filter or picker that has only one possible
  value or none.
- **One row per provider.** A provider with several connection modes is one row; its page lists
  the modes as outcomes ("Pay with your ChatGPT plan", "Pay per use with an API key").
- **Toolbar pieces stay in the toolbar.** `ToolbarSearch` always sits inside a `Toolbar`. A `Select`
  in a narrow `SettingRow` gets a fixed width so the column doesn't jump between values.

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
area (rail and settings sub-nav stay), and a back link returns to the list with its scroll and
filters intact.

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

**Settings pages render in `SettingsFrame`.** The frame draws the sub-nav and the section's page
header; a sub-page (an account, a key, a person, a form) hides that header and declares its own
back link and title. Every sub-page has its own URL param (`?account=`, `?key=`, `?view=`), so
reload and browser Back work, and its back link returns to the tab or list it was opened from.
Inside the settings column pages are flush: `FLUSH_DETAIL_PAGE_CLASS` for `DetailPage`,
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
| Page header | Icon on main-rail pages only; settings sub-pages drop the icon because the sub-nav gives context. |
| Navigation | The rail never swaps. Settings opens a sub-nav column inside the content. |
| Section | Open section: 16px title (one step above the 14px row titles), 12px description, rows below, one hairline between sections, no box. |
| Tabs and toolbar | Underline tabs; search, filter and the primary action in a toolbar that keeps its shape. Status filters are not a second tab row. |
| List row | Divided resource row (56-64px, 32px tile, one meta line) for things you own; the catalog row (76px, 40px tile, 2 columns) for discovery. Same tile, type and hover. |
| Detail | **Detail page** (section 8). No side sheets. Expand in place only for one level of secondary options. |
| Empty state | Centered: 40px icon tile, title, one sentence, one action; the header action hides while empty. Add 2-3 template cards where starting is hard (Schedules). |
| Setting row | Label and description left, the one control in a fixed right column. A setting with its own page is a `SettingNavRow`; a destructive group action is a `SettingDangerRow` at the end. |
| Switch | Brand track when on, a visible track when off in both themes. |
| Segmented control | Filled track with the active option raised on the surface. |
| Choice cards | Brand ring: brand border, faint brand fill, a check in the corner. The same highlight for every selected state. |
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
  `--og-*` variables for light and dark (`--og-color-bg`, `--og-color-surface-1`,
  `--og-color-accent`, `--og-color-status-*`, `--og-font-sans`, ...). Change a color or font there
  and every surface follows, in both themes.
- `apps/web/src/styles.css` maps those onto Tailwind names in `@theme` (`--color-bg`,
  `--color-brand`, `--font-sans`, `--radius-md` 10px, `--radius-lg` 14px, `--text-2xs`). Rename or
  retune the scale there.

Components use only the semantic utilities (`bg-surface`, `text-fg-muted`, `border-border`,
`text-brand`, `rounded-md`), so they pick up the change without edits. Some primitives still
write the 10px and 14px radii as literals (`rounded-[10px]`, `rounded-[14px]`); a radius restyle
means moving those to `rounded-md` / `rounded-lg` first. Check the result in `/dev/ui-kit` with
the Side by side theme before shipping.
