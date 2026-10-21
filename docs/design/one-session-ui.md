# One session UI

Status: proposal, October 21, 2026.

## Problem

Opengeni has two session UIs.

- The web app builds its own: `apps/web/src/routes/session.tsx` (3,900 lines),
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
   Office theme, a customer page's background (current `theme="auto"`).

### Presets

| Feature | `app` (web, desktop) | `companion` (Excel and other first-party side panes) | `embed` (customer product) | `visitor` (anonymous) |
| --- | --- | --- | --- | --- |
| Chat list | full rail list | list as a drawer, search, pin, archive | simple list | off |
| Projects, subagent tree rows | on | read only | off | off |
| Model picker, effort | on | on | off (host opt-in) | off |
| Runs on, repositories, secrets, usage limit | on | on | off | off |
| Approvals, questions, goal, Stop, queue | on | on | on | on |
| Attachments, voice input | on | on | on | uploads off |
| Live voice | on | on | off | off |
| Find in chat, message actions | on | on | copy only | copy only |
| Header indicators (model account, admin, private) | on | model account only | off | off |
| Dock, inspector, agent configuration | on | "open in Opengeni" link | off | off |
| Loading copy | console | console | neutral | neutral |

## Plan

Each step is its own UI-only PR and leaves the web app unchanged to the eye.

0. **Baseline.** Screenshot suite of the web app's session surfaces on a seeded
   local stack (list, header menus, timeline variants, notices, composer menus,
   new chat, mobile) to compare every later step against.
1. Shared primitives into the package.
2. Composer and its pickers.
3. Conversation pane and its notices, find, message actions, subagents.
4. Session header.
5. Chat list.
6. New chat page.
7. `OpenGeniChat` and `SessionConversation` become preset compositions of the
   moved components; delete the old thin versions; the Excel pane uses
   `companion` with Office theme; update `docs/embedding.md` and the public
   conversation UI guide.

Estimate: about 15 hours of agent work in total, with the chat list and the
conversation pane the largest steps.

## Risks

- Regressions in the most-used surface. Mitigated by the screenshot baseline,
  existing web tests moving with their components, and step-by-step merges.
- Bundle size for embeds. Mitigated by keeping heavy features on lazy subpaths
  and checking embed bundle size per step.
- Public API churn for existing embedders. `OpenGeniChat`, `SessionConversation`
  and `NewConversation` keep their names and props; defaults stay as documented.
