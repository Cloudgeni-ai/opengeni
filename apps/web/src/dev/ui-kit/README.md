# OpenGeni UI kit (DEV only)

The component studio at `/dev/ui-kit` (`http://homeserver:3140/dev/ui-kit`). Every fork is
decided (27 Sep 2026): the registry's `recommended` version is the decision and carries the
"Decided" tag, and the other versions stay visible as history. The binding spec is
`apps/web/DESIGN.md`; the design brief is `.ui-audit/design-brief.md`.

No side sheets: detail views are pages (`components/ui/detail-page.tsx`) and create/edit flows are
`FormPage`s, both rendered in place inside the page previews with a back link. Centered modals
only for destructive confirms and one-field prompts. A section with a `decision` in the registry
ignores older stored picks of a retired version.

The route is registered in `src/App.tsx` only when `import.meta.env.DEV`, and the kit is lazy
loaded, so none of this reaches a production build.

## Rules for builders

- Every component you show is the **real primitive** from `src/components/ui/`. Alternatives are
  real variants of it (a `variant` prop or equivalent), never kit-only lookalikes. Page
  compositions in the Pages group may be kit-only files, built from those primitives.
- Tokens only (`bg-bg`, `bg-surface`, `text-fg-muted`, `border-border`, `brand`, `status-*`,
  `danger`...). No hex, no `dark:` overrides, no shadcn aliases, no `text-[10px]`/`text-[11px]`.
- Content comes from `fixtures.ts`. Never lorem ipsum. Sentence case, plain dashes.
- **Content renders twice in Side by side** (a light pane and a dark pane). Never hardcode DOM
  ids; use `useId()`. Component state is per pane.
- Only edit your own section file. If the page shows "This section is being built" for someone
  else's section, leave it; the rest of the kit keeps working.

## Files

| File | What it is |
| --- | --- |
| `index.tsx` | The studio shell (`UiKitRoute`): nav, theme and width toggles, Copy my picks. |
| `kit.tsx` | Helpers for section files: `KitSection`, `Fork`, `Alternative`, `StatesGrid`, `StateCell`, `UsageNotes`, `KitBlock`, `KitCanvas`, `KitNote`, `PagePreview`, `KitErrorBoundary`, `useKitPane`. |
| `picks.ts` | Picks and notes store: `usePick`, `setPick`, `useExplicitPick`, `useNote`, `setNote`. |
| `fixtures.ts` | All fixtures from brief section 8, typed. |
| `theme.tsx` | Theme forcing (`ThemeScope`) used by Side by side. You don't need it in sections. |
| `view.ts` | URL state (`?section`, `?theme`, `?width`, `?chrome`). |
| `sections/registry.ts` | Every section: group, title, purpose, used on, alternatives, recommended default. |
| `sections/<key>.tsx` | One file per section, `export default function ...Section()`. |

## A section file

Replace the placeholder in `sections/<key>.tsx` (the Switch props below are illustrative). The
shell already shows the title, purpose and
"Used on" from the registry, so a section only renders blocks:

```tsx
import { Switch } from "@/components/ui/switch";
import { Alternative, Fork, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";
import { codexWorkspaceAccounts } from "../fixtures";

export default function SwitchSection() {
  const account = codexWorkspaceAccounts[0]!;
  return (
    <KitSection sectionKey="switch">
      <Fork>
        <Alternative id="a" align="center">
          <Switch variant="brand" defaultChecked aria-label="Use for new work" />
        </Alternative>
        <Alternative id="b" align="center">
          <Switch variant="neutral" defaultChecked aria-label="Use for new work" />
        </Alternative>
        <Alternative id="c" align="center">
          <Switch variant="brand" showStateText defaultChecked aria-label="Use for new work" />
        </Alternative>
      </Fork>
      <StatesGrid>
        <StateCell label="Off"><Switch aria-label="Voice input" /></StateCell>
        <StateCell label="On"><Switch defaultChecked aria-label="Voice input" /></StateCell>
        <StateCell label="Disabled" note="Only workspace admins can change this.">
          <Switch disabled aria-label="Voice input" />
        </StateCell>
        <StateCell label="In a row" span="full" align="stretch">
          {/* a SettingRow with account.name ... */}
        </StateCell>
      </StatesGrid>
      <UsageNotes
        use={["One on/off setting that saves immediately"]}
        avoid={["Inside a form with a Save button"]}
      />
    </KitSection>
  );
}
```

Only show a `Fork` where the registry lists alternatives. Foundations, Feedback and Pages have no
fork; render `KitBlock`s, `StatesGrid`s and `KitCanvas`es instead (the shell adds a notes field).

## API

### `KitSection`

`{ sectionKey: SectionKey; children: ReactNode }`. Wraps a section. Children are blocks, spaced
32px apart with a hairline between. Renders the section header itself only in contexts where the
shell doesn't (never in the normal kit).

### `Fork` and `Alternative`

`Fork` props:

- `pickKey?: SectionKey` - defaults to the enclosing `KitSection`.
- `title?: string` - default "Pick a version".
- `description?: ReactNode` - default "We recommend B: <why>" from the registry.
- `layout?: "columns" | "stack"` - `columns` (default) puts versions side by side when the
  section is at least 896px wide (3 versions) or 672px (2); use `stack` for wide previews such as
  page headers, lists and tables.
- `showNote?: boolean` - the notes field under the versions (default true).

`Alternative` props:

- `id: "a" | "b" | "c"` - required. The letter badge, name, rationale and "Recommended" tag come
  from the registry.
- `name?: string`, `rationale?: ReactNode` - override the registry text only if you must.
- `canvas?: "bg" | "surface"` - `bg` (default) is the page canvas; `surface` is the inside of a
  dialog or sheet.
- `padding?: boolean` - default true (20px). Set false for edge-to-edge lists or page frames.
- `align?: "stretch" | "center"` - `stretch` (default) fills the width, top-aligned; `center`
  centres small controls.
- `className?: string`, `children` - the real primitive.

Each version has its own error boundary, so one broken version doesn't hide the others.

### `StatesGrid` and `StateCell`

`StatesGrid`: `{ title?: string = "States"; description?: ReactNode; columns?: 1 | 2 | 3 | 4 = 3;
children }`. Columns collapse on narrow widths (container queries, so panes and frames adapt).

`StateCell`:

- `label: string` - the state name ("Disabled", "Loading", "Long text").
- `note?: ReactNode` - one line under the canvas, for example the disabled reason.
- `span?: 2 | "full"` - take two columns or the whole row.
- `canvas?: "bg" | "surface"`, `padding?: boolean`.
- `align?: "center" | "stretch"` - `center` (default) for small controls, `stretch` for rows.
- `width?: "auto" | "mobile"` - `mobile` caps the content at 390px. Viewport breakpoints don't
  change; the Mobile 390 toggle renders the section in a real 390px frame.

Show every state the brief lists for the recommended version: loading, disabled with reason,
error, long text, and so on.

### `UsageNotes`

`{ title?: string = "When to use"; use: ReactNode[]; avoid?: ReactNode[]; children?: ReactNode }`.
Take the lines from the brief's "Which control when" table.

### Other helpers

- `KitBlock` - `{ title: string; description?: ReactNode; aside?: ReactNode; className?; children }`.
  A titled block for anything else ("Anatomy", "In a sheet").
- `KitCanvas` - `{ canvas?: "bg" | "surface"; padding?: boolean; className?; children }`. A
  bordered preview canvas.
- `KitNote` - `{ sectionKey?: SectionKey; label?: string }`. The notes field; `Fork` already
  includes it.
- `PagePreview` - `{ label?: string; height?: number; className?; children }`. A 16px-radius frame
  on the page canvas for the Pages group; give it a `height` to scroll inside.
- `KitErrorBoundary` - `{ title?; compact?; resetKey?; onReset?; children }`.
- `RecommendedTag` - the "Recommended" chip.
- `ComingUp` - the placeholder body. Delete it when you build the section.
- `useKitPane()` - `{ theme: "light" | "dark"; index; count; mobileFrame; headerInShell;
  notesInPane }` for the pane being rendered.
- `useKitSectionKey()` - the enclosing section's key.

## Picks

```ts
import { usePick, useExplicitPick, setPick, useNote, setNote } from "../picks";

const header = usePick("page-header"); // Bendik's pick, or the recommended default ("b")
const picked = useExplicitPick("page-header"); // "a" | "b" | "c" | null
```

Pages previews must use `usePick` for every component they include, so they follow the picks. The
store is `localStorage["opengeni-ui-kit-picks-v1"]` and syncs across panes, tabs and the 390px
frames. "Copy my picks" exports every pick and note as readable text.

## Fixtures

`import { variableSets, schedules, people, ... } from "../fixtures";`

Everything from brief section 8: `organization`, `workspaces`, `currentWorkspace` (Design preview),
`people` and `personById`, `workspaceRoles`, `organizationRoles`, `platformEngineeringAccess`,
`designPreviewAccess`, `designPreviewAccessRequests`, `agentActivity`, `sessionDefaults`,
`variableSets` and `variableSetById`, `blockedDeleteVariableSet`, `emptyVariableSet`,
`envPastePreview`, `variableNameRules`, `sandboxEnvironments`, `repositories`, `modelCatalog`,
`defaultModel`, `codexProvider`, `codexWorkspaceAccounts`, `codexOrganizationAccounts`,
`exhaustedUsageWindow`, `gatewayProviders`, `allowedModelsSummary`, `schedules` and
`scheduleById`, `scheduleTemplates`, `cadenceExamples`, `timeZones`, `apiKeyPresets`,
`apiKeyExpiryOptions`, `apiKeys`, `newApiKeySecret`, `knowledgeEntries`, `reviewItems`,
`workspaceInstructions`, `organizationIdentity`, `learningModes`, `learningSettings`,
`connectedCapabilities`, `popularCapabilities`, `skillCapabilities`, `chats`.

Every item carries display-ready labels ("3 days ago", "Mon 28 Sep, 08:00") and ISO timestamps.
All times are relative to `KIT_NOW` (Sat 26 Sep 2026, 13:48 Oslo); pass it as "now" to anything
that computes relative time. Weekday names follow the 2026 calendar, so the brief's "Mon 29 Sep" is
"Mon 28 Sep" here.

## Viewing and screenshots

| Query | Effect |
| --- | --- |
| `?section=<key>` | One section. Omit for the overview. |
| `?theme=light` / `dark` / `split` | Theme. `split` renders the section twice, light and dark. |
| `?width=mobile` | The section in 390px frames (real viewport, so breakpoints apply). |
| `?chrome=0` | No nav or top bar, for clean screenshots. |

Example: `http://127.0.0.1:3140/dev/ui-kit?section=switch&theme=split&chrome=0`.

Side by side keeps the document light and forces dark on the second pane, for both Tailwind
utilities and `--og-*` tokens. Menus, tooltips and dialogs opened from a pane take that pane's
theme.
