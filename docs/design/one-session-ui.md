# One session UI

Status: built, October 21, 2026, as one PR: the move (part 1) and the embeds
(part 2). The session-proxy embed was decided on October 22, 2026: option 1,
the proxy's opt-in `sessionApp` mode (see "Session proxy").

## Problem

Opengeni has two session UIs.

- The web app builds its own: `packages/react/src/app/routes/session.tsx` (3,900 lines),
  `routes/sessions-index.tsx` (2,600), `components/rail/*` (session list alone
  5,000), `components/session/*` (45 files), its own composer chrome and pickers.
  About 28,000 lines. It uses some package pieces (`MessageTimeline`,
  `HumanInputSurface`, `ApprovalSurface`, `SessionChrome`) but assembles them itself.
- `@opengeni/react` ships `SessionConversation`, `NewConversation`, `SessionList`
  and `OpenGeniChat`, a separate and thinner assembly of the same pieces. Nothing
  first-party depends on it, so it falls behind. `docs/embedding.md` says so:
  "The Opengeni web app does not mount these surfaces and keeps its own behavior."

Every embed (the Excel add-in, customer products, the playground) therefore gets
the weaker UI, and every improvement to the web app is made once, in the app.

## Goal

The web app renders its session surfaces from `@opengeni/react`. Every other
surface renders the same components with a deliberate subset of features. No
second implementation exists.

## Inventory of the web app's session surfaces

Grouped by area. "Default off" columns are proposals for the presets below.

| Area | Web app today | Package today |
| --- | --- | --- |
| Chat list | Rail `session-list.tsx`: search, filters and browse order, projects (channels) with create/move, pinning, archive and restore, delete with refusal reasons, unread/mute, subagent tree rows with lazy loading, Site session groups, hover details, creator monogram, delivery and scheduled-task attention, pagination, context menu and row quick actions, skeletons | `SessionList`: flat list, rename, archive, paging |
| Session header | `session-header.tsx`: title editor, ancestry breadcrumb, status badge, workstream control, pin, mute, admin access indicator and grant dialog, model and Codex/subscription account indicators, private indicator, panel toggle, Site origin link | none (title only inside `SessionChrome`) |
| Conversation | `SessionChatPane`: `MessageTimeline` with message actions (fork, copy), find in conversation, search results, inline artifacts and interactive blocks, user message bodies with resource attachments, subagent tree, wait status, failed-session banner with retry, admission, usage-limit, machine-access, unavailable-model and model-recovery notices, read-only and terminal-session notices, skill reviews, learning-refusal actions, knowledge activity, file drop target | `SessionConversation`: timeline, approvals, human input, composer, goal chrome, voice, attachments |
| Composer | `ConsoleComposer` around `ChatComposer`: model picker with payment source, effort, capabilities chip and menu, follow-up repository picker, runs-on machine picker, secrets menu, usage limit, tool selection, agents pill, mobile "+" panel with drill-ins, focus intents, Stop and queue | `ChatComposer` with optional model picker |
| Session dock and panels | Files, terminal, desktop, browser and computer viewers, editable artifacts workspace, inspector, model-context inspector, agent configuration panel, session commands | `SandboxWorkspace` and viewers exist; the app adapts them |
| New chat | `sessions-index.tsx`: starters, model control, folder (project) picker, repository and resource access, compute target, visibility, usage limit, secrets, private-workspace note, recent sessions, credit prompts, draft sync, realtime start | `NewConversation`: input and create |
| App only (stays in the app) | Primary navigation, inbox, workspace switcher and admin, settings pages, billing pages, onboarding, desktop app-shots | |

## Design

1. **Components move, the app becomes a host.** Each area above becomes a
   package component built from the web app's version (the better one), not
   from today's package version. Today's thinner package versions are deleted
   once the moved ones replace them.
2. **One feature switchboard.** A typed `SessionUiFeatures` object (for example
   `modelPicker`, `effort`, `projects`, `pinning`, `subagents`, `runsOn`,
   `repositories`, `secrets`, `inspector`, `findInChat`, `dock`, `voice`,
   `adminAccess`) with named presets. A feature shows only when the preset (or
   the host) turns it on and the server reports it can serve it (the existing
   client-config capabilities). Hosts override single keys.
3. **A host adapter instead of app imports.** Links to app-only places (model
   settings, billing, a full session in the web app), routing, and app-specific
   prompts (credits) come through a small `host` prop. Absent entries hide the
   link or open the web app.
4. **Shared primitives.** The web app's UI primitives that these components need
   (button, menus, dialogs, tooltips, hover cards, fields) move to
   `@opengeni/react` so both render identically. Styling stays on the existing
   `--og-*` tokens.
5. **Opt-in weight stays opt-in.** Heavy pieces keep lazy subpath entries, as
   today (terminal, editor, desktop, machines), so a customer embed does not
   download the inspector or the dock.
6. **Theme.** Every surface follows its host: the web app's setting, Excel's
   Office theme, or the light or dark theme a customer page passes.

### Presets

Embeds show nearly everything the web app shows by default. A feature is left
off by default only when it needs something the embedding page may not want
(a side panel next to the chat, workspace-admin rights, a global shortcut,
Opengeni's own brand);
each such feature is one key to turn on. Everything else (model and effort,
capabilities, repositories, runs on, secrets, usage limit, approvals and
questions, goals, attachments, voice, find in chat, message actions, header
indicators) is always on and follows the server's client configuration and the
person's permissions, exactly as in the web app. A switch only hides.

| Feature (`SessionUiFeatures`) | `app` (web, desktop) | `companion` (Excel and other first-party side panes) | `embed` (customer page) |
| --- | --- | --- | --- |
| `chatList` (search, filters, projects, pins, archive, subagent rows) | on | on (a drawer when narrow) | on |
| `dock` (files, terminal, desktop, browser, artifacts, inspector; lazy) | on | on | off |
| `adminAccess` (workspace-admin access indicator and grant) | on | off | off |
| `keyboardShortcuts` (⌘K menu, shortcut keys, ⌘/ sheet; `newChatShortcut` is a deprecated alias) | on | off | off |
| `brand` (the Opengeni row at the top of the chat list) | on | on | off |

`SessionApp` defaults to `embed`; first-party hosts pass `companion` or `app`.
With the dock off, entries that only open a dock panel (the header's usage
limit, the composer's chat settings) hide with it.

Links into app-only pages (settings, billing, schedules) navigate in the web
app and open the web app (`consoleUrl`, through the host's `openUrl`) from an
embed.

## As built

- **One app state.** `useAppState` (`app/app-state.tsx`) is the single
  implementation of `AppContextValue`. The web app's `context.tsx` calls it with
  its sign-in host; `SessionApp` calls it with `authority: "host"` (the embedding
  page authenticated the client). `AppContextValue` is not split into smaller
  contexts: the 55 consumers read overlapping slices, and one value keeps the
  two hosts identical.
- **One host seam.** Navigation, API calls, optional surfaces, per-message
  context and the `embedded` flag come from one `AppHost` value
  (`app/lib/app-host.tsx`). `SessionApp` provides its own through
  `AppHostProvider`, so two embeds on one page never share one; the web app
  sets a page-wide default with `configurePageAppHost` (navigation in
  `navigation-host.tsx`, API and surfaces in `app-host.ts`).
- **Nothing page-global in an embed.** Menus, dialogs, sheets, tooltips and
  hover cards portal into the embed's own root (`PortalContainerProvider`), so
  they keep its scoped styles and theme. Toasts render in an embed toaster,
  apart from the host page's (two embeds share one stack). The app's internal events (find in chat, focus the composer, open
  the usage-limit editor, session search) go through a per-instance event
  target, ⌘/Ctrl+F is caught only inside the embed, and the embed never
  rewrites the page title or navigates the page away.
- **Workbench peers.** `enableWorkbench()` (`@opengeni/react/workbench`) turns
  on highlighted diffs, the terminal, the desktop viewer and the code editor in
  one call; the web app's session route and the Excel pane both use it.
- **One shell.** `SessionShell` (`app/components/rail/session-shell.tsx`) is
  the rail (resizable column on desktop, sheet on phones), the canvas top strip
  with the session header, and the canvas. Surface-owned sections arrive as
  slots: `switcher`, `primaryNav`, `mobileWorkspacePanel`, `railFooter`,
  `canvasBanners`. The web app's `RailShell` is only its slot composition.
- **`SessionApp`** (`@opengeni/react/session-app`): `apiBaseUrl`, `headers`,
  `consoleUrl`, `workspaceId`, `sessionId` and `onSessionChange`,
  `onSessionState` (the open chat's status and held events, from the session
  route's own stream, through `AppHost.onSessionState`), `preset`,
  `features`, `slots`, `surfaces` (PDF preview, editable artifacts), `theme`,
  `messageContext`, `openUrl`, `onUnauthorized`, `resolveLink` and
  `renderLink` (the host's handling of links in agent messages, asked before
  the app's own: the dock, else the web app page through `openUrl`). It renders its own `og-root`
  with `data-og-theme`, never touching the host page's `<html>`. A 401 from
  either the SDK client or a raw app request calls `onUnauthorized`.
- **Styles.** The web app's design system (token bridge, base rules, motion)
  lives in `@opengeni/react/app.css`. The web app imports it through its own
  stylesheet; the published `compiled.css` includes it and the `src/app`
  utilities, every rule scoped to `.og-root` (a test fails on any rule that
  is not), and the Excel pane uses `compiled.css` exactly as a customer would.
  Page-level rules (document sizing, desktop window chrome) stay in the web app.
- **Excel.** The add-in pane is `SessionApp` with the `companion` preset,
  `compiled.css`, `enableWorkbench()`, the PDF preview surface, the Office theme
  (its sign-in and error screens included), the workbook status as a canvas banner, the workspace and
  sign-out under the chat list, and the workbook's model context on every
  message.

### Session proxy

`OpenGeniChat`, `SessionConversation` and `NewConversation` back customer
pages that must not hold a credential: the browser talks to
`createSessionProxyHandler`, which runs each request as the resolved user. The
session app uses about 126 client methods (workspaces, access context,
capabilities, connections, repositories, machines, projects, pins and more).
Two end states were considered:

1. The proxy forwards the session app's workspace-scoped routes as the
   resolved user (the API still enforces their permissions), after which
   `OpenGeniChat` renders `SessionApp` with the `embed` preset.
2. A per-user browser credential minted by the customer's backend, after which
   customer pages use `SessionApp` directly and the proxy stays for chat-only
   embeds.

Decision (October 22, 2026): option 1, first as an opt-in `sessionApp` mode
with its own list of permitted writes. Revised (October 23, 2026): the proxy
is a relay for every route in the resolved workspace, with Opengeni's
permissions as the only authority and no mode or per-feature flags; products
narrow it with the key's and members' permissions and a `refuse` hook, and
choose what users see with UI props and presets. See
[Product relay](product-relay.md). Option 2 was rejected because a browser
credential bypasses the host's `createSession` and message hooks.

## Plan

The work lands as one large UI-only PR, reviewed in several rounds,
because most mistakes here are aggregate ones (a lost feature, a host seam that
leaks app state) that small PRs hide.

Step 0 found the real size: the web app's session surfaces import about 110,000
lines, 55 files read the app-wide `useAppContext()` state (about 100 fields:
model, effort, repositories, GitHub, tools, capability catalog, startSession and
more) and 29 files use the router. Moving surfaces one at a time would make each
step re-solve the same coupling, so the coupling is solved first, once:

- **App contract in the package.** `@opengeni/react/app/app-context` owns the
  `AppContextValue` type, the types it needs, the React context and
  `useAppContext()`. The web app's `context.tsx` keeps its provider logic and
  provides that context. Embeds provide it from a package implementation.
- **Navigation host.** `@opengeni/react/app/lib/navigation` gives moved code
  `navigate`, `Link`, location and search. The web app backs it with its router;
  embeds back it with their own routing or in-memory state.
- **Analytics host.** Product analytics labels stay; the sender is registered by
  the host (no-op by default).
- **API host.** `@opengeni/react/app/lib/app-api` is the typed set of server
  calls the moved code makes. The web app registers its `api.ts`; embeds
  register an implementation on the SDK client.
- **Surface host.** `@opengeni/react/app/lib/app-surfaces` lets the host supply
  pieces that must not ship in the published package (for example Codex
  subscription redemption, which stays in the web app) or the web app's heavy
  editors (PDF preview, the editable-artifact workspace). Absent surfaces render
  nothing. The desktop bridge is not a surface: moved code reads the desktop
  app's global bridge directly, as before.
- **Bulk move.** The session closure moves to `packages/react/src/app/`, keeping
  relative paths, imported as `@opengeni/react/app/<path>`. App shell files
  (router setup, sign-in, settings, billing pages) stay in `apps/web`. The
  `app/*` and `ui/*` subpaths are first-party building blocks, not a public,
  versioned API; customers use `OpenGeniChat` and the other documented exports.

**Part 1 (first PR): the move.** Baseline screenshots and accessibility trees of
every session surface (list, menus, timeline variants, composer menus, new
chat, mobile) on a seeded local stack; the app contract, navigation, API,
analytics and surface hosts; the bulk move of shared primitives, composer,
conversation pane, header, chat list and new-chat page; the web app becomes a
host. Verified by identical screenshots and accessibility trees against `main`,
the full test suite, and the web bundle budget.

**Part 2: the embeds.** Presets and the feature switchboard; `SessionApp`
backed by the same app state with in-memory navigation; the published
`compiled.css` grows to cover the moved components; the Excel pane uses
`companion` with the Office theme; `docs/embedding.md` is updated. The
session-proxy components wait on the decision above.

### Bundle

Part 1 keeps the web app's code splitting. Measured with
`scripts/check-web-bundle-budget.ts` against `main` on the same machine: the
initial graph grows by about 7 KB gzip (1.6%, the host seams and two small
leaf chunks); the direct session-route graph is unchanged.

## Risks

- Regressions in the most-used surface. Mitigated by the screenshot baseline,
  existing web tests moving with their components, and step-by-step merges.
- Bundle size for embeds. Mitigated by keeping heavy features on lazy subpaths
  and checking embed bundle size per step.
- Public API churn for existing embedders. `OpenGeniChat`, `SessionConversation`
  and `NewConversation` keep their names and props; defaults stay as documented.
