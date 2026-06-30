# Sandbox "Workspace" Panel — UI Design Direction + Build Spec

Status: spec for the Build phase. Backend is VERIFIED working on the live preview.
Scope: the right-hand **Workspace** dock in the OpenGeni web app (`apps/web`) and the
underlying `@opengeni/react` surface components/hooks it composes.

Locked product decisions (do not relitigate in v1):

1. **Git = review-first.** A Pierre-style file tree with changed files badged vs `HEAD`;
   click a changed file → Pierre-style diff (staged/unstaged). Branch + dirty-status header.
   The **agent commits**; the human **observes**. Power-git lives in the terminal.
   **No commit/stage/push UI in v1.**
2. **Desktop = watch + take-over.** Default you **watch** the agent drive its own desktop
   (noVNC). A **"Take control"** toggle hands your mouse/keyboard to the box.
3. **Terminal = interactive xterm** attached to the box PTY.

---

## 0. The current UI, honestly

The surfaces exist and are wired to real, working hooks — but the shell around them is broken
and three of the four surfaces can't even load. Concrete defects, each traced to a line:

- **The dock is a fixed, non-resizable strip.** `apps/web/src/routes/session.tsx:148` mounts the
  whole inspector inside `grid-cols-[minmax(0,1fr)_minmax(0,390px)]`. The sandbox is a *tab inside*
  that 390 px column (`session.tsx:180`). There is no resize handle, no collapse-to-edge that
  preserves the chat, and no maximize. **A 1024×768 desktop inside ~388 px renders as a useless
  sliver** — this is the headline visual failure.
- **noVNC fails to load.** `use-desktop-stream.ts:35` does
  `const specifier = "@novnc/novnc"; await import(/* @vite-ignore */ specifier)`. The string-indirection
  defeats Vite's dependency pre-bundling, so the browser gets a bare specifier and throws
  *"Failed to resolve module specifier '@novnc/novnc'."* The desktop never connects even when the
  capability advertises a transport.
- **Terminal / Files / Diff silently no-op.** `@xterm/xterm`, `@xterm/addon-fit`, and the Pierre
  libraries are declared as **optional peer deps** (`packages/react/package.json`) and are **not
  installed in `apps/web`**. `sandbox-terminal.tsx:68` lazy-imports `@xterm/xterm` → rejects → the
  terminal sits on its "Loading terminal…" placeholder forever. Files/Diff fall back to the
  hand-rolled built-ins, which work but are not the Pierre UX the product wants.
- **Tabs are wrong for the product.** `sandbox-workspace.tsx` exposes four peer tabs
  *Terminal | Files | Diff | Desktop*. The locked model is **three** tabs with **Git folded into
  Files as review-first** (Diff is a *consequence of selecting a changed file*, not a sibling tab).
- **Desktop is watch-only.** `DesktopViewer` hard-forces `viewOnly` (`use-desktop-stream.ts:113`):
  `rfb.viewOnly = mode === "read-only" || !interactive`, and the app never passes `interactive`.
  There is **no take-control affordance**. The RFB interface already supports it
  (`packages/sdk/src/desktop.ts:55` `viewOnly: boolean`), so this is a UI gap, not a backend one.

**What is good and must be kept:** the hooks are correct and capability-gated. `useSandboxFiles`
(lazy tree + git-status overlay + `fs.changed`/`git.changed` auto-refresh), `useSandboxGit`
(structured `GitFileDiff[]` + branch + ahead/behind), `useSandboxTerminal` (Channel-A projection
with an interactive `write` when the PTY supports stdin), `useDesktopStream` (correct RFB lifecycle,
consent gate, URL-rotation reconnect), and `useSessionCapabilities` (the single UI source of truth).
**The Build phase rebuilds the shell and the four surface components; it does not touch the hooks'
data contracts.**

---

## 1. Library decisions (FINAL — for the Build phase)

All verified installable via `npm view` on 2026-06-22.

### File tree + diff — **use Pierre. It is public.**

`@pierre/trees` and `@pierre/diffs` are both published and installable. We get the genuine Pierre
look/UX, not an approximation. Crucially, **`@pierre/diffs` ships its own React `FileTree` too** —
`@pierre/diffs/react` exports `FileTree`, `useFileTree`, `useFileTreeSelection`,
`useFileTreeSearch`, **and** `FileDiff` / `MultiFileDiff`. So one dependency covers both the
review-first tree and the diff, with a shared visual language.

- **Files tree:** `FileTree` + `useFileTree` from `@pierre/diffs/react`. Model-driven
  (a `FileTree` model class), supports `renderContextMenu`, selection hooks, and search
  (`useFileTreeSearch`) — exactly the Pierre tree. We badge changed files by feeding git status
  into the model and tinting rows.
- **Diff:** `FileDiff` (single file) / `MultiFileDiff` (old vs new) from `@pierre/diffs/react`.
  Shiki-highlighted, virtualized (`Virtualizer`), unified + split, line annotations, custom
  header render props. This is best-in-class and beats `react-diff-view`/`@git-diff-view/react`
  on highlighting + virtualization.
- **Trade-off, accepted:** `@pierre/diffs` pulls `shiki` (+ `@shikijs/transformers`) and a worker
  pool, and `@pierre/trees` pulls `preact` as an internal render target. This is heavier than a
  hand-rolled tree, but the product explicitly wants the Pierre UX and we are paying for quality,
  not reuse. Mitigations: load `@pierre/diffs/react` **lazily** (only when the Files tab first
  opens), and pass `disableWorkerPool` only if the worker bundling fights Vite (default: keep the
  pool for big-diff performance). Pin exact versions; `@pierre/trees` is a **beta** (`1.0.0-beta.4`).

> **Fallback already in place (keep as the escape hatch):** `FileBrowser` and `DiffView` keep their
> `renderNode` / `fallback` swap seams and their hand-rolled renderers. If a Pierre upgrade breaks
> or the beta tree regresses, the built-ins still deliver a working (if plainer) tree+diff. The
> *hook* is the reusable contract; the chrome is swappable. Build wires Pierre **behind** these
> seams so we can fall back without touching `apps/web`.

### Terminal — **@xterm v6 family**

- `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`, `@xterm/addon-web-links@0.12.0`.
- **Bump the peer ranges** in `packages/react/package.json` from `^5.5.0`/`^0.10.0` to the v6 line
  (`^6.0.0` / `^0.11.0`) and **add** `@xterm/addon-web-links@^0.12.0` (clickable URLs in agent
  output — a real quality win). Install all three as **real devDependencies in `apps/web`** so the
  app bundles them (today they are absent → the lazy import rejects).

### Desktop — **@novnc/novnc**

- `@novnc/novnc@1.7.0` (bump peer from `^1.5.0`; the package name in code is correct, plain `novnc`
  is an unrelated stale fork — do not use it). Install as a real dep in `apps/web`.
- **Fix the import** in `use-desktop-stream.ts`: replace the string-indirection
  (`const specifier = "@novnc/novnc"; import(specifier)`) with a **static specifier dynamic import**
  `import("@novnc/novnc")` so Vite pre-bundles it. Keep it inside the connect `useEffect` for
  SSR-safety. The `@vite-ignore` comment is the cause of the bare-specifier failure — remove it.

### Dock layout — **react-resizable-panels**

- `react-resizable-panels@4.11.2`. Gives us `Panel` / `PanelGroup` / `PanelResizeHandle` with a
  draggable handle, min/max sizes, collapse, and `autoSaveId` persistence. This replaces the fixed
  390 px grid column. Maximize is our own state on top of it (see §2).

### Summary table

| Concern        | Package                  | Version       | Where installed            |
| -------------- | ------------------------ | ------------- | -------------------------- |
| File tree      | `@pierre/diffs`          | `1.2.11`      | `@opengeni/react` (peer+demo), `apps/web` |
| Diff           | `@pierre/diffs`          | `1.2.11`      | (same — one package)       |
| (Pierre tree alt / SSR) | `@pierre/trees` | `1.0.0-beta.4` | only if `useFileTreeSearch` SSR needed; otherwise skip |
| Terminal       | `@xterm/xterm`           | `6.0.0`       | react peer, apps/web dep    |
| Terminal fit   | `@xterm/addon-fit`       | `0.11.0`      | react peer, apps/web dep    |
| Terminal links | `@xterm/addon-web-links` | `0.12.0`      | react peer, apps/web dep    |
| Desktop (VNC)  | `@novnc/novnc`           | `1.7.0`       | react peer, apps/web dep    |
| Dock           | `react-resizable-panels` | `4.11.2`      | `@opengeni/react` dep, apps/web |

**Net new packages to install:** `@pierre/diffs`, `@xterm/addon-web-links`, `react-resizable-panels`
(version-bump the existing xterm/novnc peers). `@pierre/trees` is **optional** — only pull it if we
want its standalone SSR tree; `@pierre/diffs/react`'s `FileTree` is sufficient for v1.

---

## 2. Layout — the resizable Workspace dock

The dock is a **right-anchored, resizable, collapsible, maximizable** surface that lives **beside**
the chat, not inside a fixed strip. It replaces the `grid-cols-[…390px]` aside in `session.tsx`.

### Structure (react-resizable-panels)

```
<PanelGroup direction="horizontal" autoSaveId="og.session.dock">
  <Panel id="chat"  order={1} minSize={30}>            … SessionChatPane …          </Panel>
  <PanelResizeHandle />   ← 6px hit area, 1px visual rule, brand on hover/drag
  <Panel id="dock"  order={2} minSize={22} maxSize={70}
         collapsible collapsedSize={0} defaultSize={32}> … Workspace dock …         </Panel>
</PanelGroup>
```

- **Drag handle** sets the dock width (percent of the session area). `minSize` ~22 % keeps the tree
  legible; `maxSize` ~70 % lets the desktop/terminal dominate without hiding chat entirely.
- **Collapse** to `collapsedSize={0}` hides the dock and gives chat the full width; a thin **rail
  tab** on the right edge re-opens it, and the existing header toggle drives the same collapsed
  state. Width persists via `autoSaveId`.
- **Maximize-to-full-workspace** is a *mode above the PanelGroup*, not a panel size. A maximize
  button in the dock header flips a `maximized` boolean; when true the dock renders as an
  **`fixed inset-0 z-40`** overlay covering the whole session area (chat hidden behind it), with a
  restore button. This is how you actually *use* the desktop and the terminal full-bleed. `Esc`
  restores. (Rationale: pushing a Panel to ~100 % still leaves the resize handle + a chat sliver and
  fights min sizes; an overlay is cleaner and matches Cursor/VS Code "maximize panel".)
- **Responsive:** below `lg`, the PanelGroup collapses to a single column and the dock becomes a
  **bottom sheet** (`direction="vertical"`) or a full-screen route — desktop/terminal are unusable
  in a narrow side column. v1: stack vertically with the dock as a bottom panel, maximize still
  available.

### Tabs inside the dock

Exactly **three** tabs, Git folded into Files:

```
┌────────────────────────────────────────────┐
│  Files   Terminal   Desktop      ⤢  ⟶  ✕   │  ← tabs left; maximize / collapse / close right
├────────────────────────────────────────────┤
│                                            │
│             active surface                 │
│                                            │
└────────────────────────────────────────────┘
```

- Tab order: **Files | Terminal | Desktop**. Default = first capability-available tab (Files when a
  FileSystem is advertised, else Terminal, else Desktop). Today's `defaultTab` logic in
  `sandbox-workspace.tsx` is kept but reordered (Files-first; "Diff" tab removed).
- Each tab is still **capability-gated** off `useSessionCapabilities` — a tab only renders when its
  surface is advertised; an advertised-but-degraded surface shows the existing reason-aware notice.
- The **Desktop tab carries a live "Take control" / "Watching" pill** in the tab strip when active.
- The **Files tab carries a dirty-count badge** (e.g. `Files ·3`) when the repo has changes, so you
  see review work pending without opening it.

---

## 3. Visual design tokens

Match the existing app theme — **do not invent colors.** The package ships an OKLCH token system in
`packages/react/styles/tokens.css`, bridged to Tailwind v4 utilities in `styles/index.css`
(`bg-og-surface-1`, `text-og-fg-muted`, `border-og-border`, `rounded-og-md`, `shadow-og-glow`,
`font-og-mono`, …). Dark is the first-class default; light is `[data-og-theme="light"]`.

Use these, never literals:

| Role                         | Token                                  |
| ---------------------------- | -------------------------------------- |
| Dock background              | `--og-color-bg`                        |
| Surface chrome (header/tabs) | `--og-color-surface-1` / `surface-2`   |
| Borders / rules / handle     | `--og-color-border` (`border-strong` on hover) |
| Primary text                 | `--og-color-fg`                        |
| Muted / subtle text          | `--og-color-fg-muted` / `fg-subtle`    |
| Accent (active tab, focus, take-control on) | `--og-color-accent` (+ `accent-soft` fill) |
| Running / live indicator     | `--og-color-status-running`            |
| Danger (take-control warning, disconnect) | `--og-color-danger`       |
| Mono (terminal, paths, diff) | `--og-font-mono`                       |
| Radii                        | `--og-radius-sm` (controls) / `md` (cards) |
| Resize-handle hover glow     | `--og-shadow-glow` (subtle)            |

**Per-surface theming of third-party libs:**

- **xterm:** build an `ITheme` from the tokens at mount — read the computed CSS vars
  (`getComputedStyle(root).getPropertyValue('--og-color-bg')`, `--og-color-fg`, `--og-color-accent`
  for cursor/selection). `SandboxTerminal` already accepts an `XtermTheme` prop and a `fontFamily`;
  pass `var(--og-font-mono)` and the token-derived theme. Re-derive on `data-og-theme` change.
- **Pierre diff/tree:** Pierre ships `@pierre/theme` / `@pierre/theming` and Shiki themes. Pick a
  dark Shiki theme close to our slate palette (e.g. a github-dark / vitesse-dark base) and a light
  one; wrap Pierre in a container that sets its CSS custom props from our tokens so gutters,
  line-number, and add/del backgrounds read as `--og-color-diff-add/del` (the built-in `DiffView`
  already defines these — reuse the same variable names so dark/light flips for free).
- **noVNC:** the canvas is provider pixels — no theming. Chrome around it (consent gate, warming
  notice, take-control bar) uses tokens; the existing `DesktopViewer` notices already do.

**Information density:** match the app — small type (`11–13px`), tight rows, density from typography
and spacing, not color. One accent, used sparingly (active tab, focus ring, take-control-on).

---

## 4. Per-surface UX

### 4.1 Files (review-first, Git folded in)

The default and most-used surface. **Tree on top/left, diff below/right** within the tab — a
two-pane review layout, not two tabs.

- **Header (sticky):** branch name + dirty status. From `useSandboxGit`: `branch`, `ahead`/`behind`
  (`↑2 ↓1`), and a dirty/clean dot. Example: `feat/sandbox-dock · ●  ↑2`. Read-only — no
  branch-switch UI (power-git → terminal).
- **Tree (`@pierre/diffs/react` `FileTree`):** fed by `useSandboxFiles` (lazy expand, `fs.changed`
  auto-refresh). **Changed files badged vs HEAD** using the git-status overlay the hook already
  computes (`added`/`modified`/`deleted`/`renamed`/`untracked`), tinted with the existing
  `STATUS_TINT` token mapping (success/warning/danger/info/subtle). A **"Changes" section at the top**
  lists just the changed files (Pierre `useFileTreeSearch`/selection), so review is one glance; the
  full tree is below for context. Lazy children load on dir-expand (keep the hook's `expand`).
- **Click a changed file → diff** in the lower pane (`FileDiff`). Unchanged file → read-only file
  view (Pierre `File`) or a quiet "no changes" state. **Staged vs unstaged toggle** in the diff
  pane header (the hook already takes `staged` — surface it as a segmented control
  `Working tree | Staged`). Unified/split toggle too (`layout` already supported).
- **Empty/degraded:** "No repository mounted" vs "No changes" (the hook distinguishes `isRepo`).
  FileSystem-unavailable → reason notice.
- **No commit/stage/push controls.** The agent commits; the human reviews. This is the whole point
  of review-first. The diff is **observation**, styled like a PR review (Pierre's home turf).
- **Beat:** Cursor's file list is flat; Pierre's grouped "Changes + tree + inline diff" is the
  target, and we get it natively.

### 4.2 Terminal (interactive)

- **xterm.js** fed by `useSandboxTerminal` (Channel-A projection: agent command firehose +
  interactive PTY output). `SandboxTerminal` already writes chunks incrementally by id and wires
  `onData → write` when `result.write` is non-null. **Make it interactive by default** (drop the
  app's hard `readOnly` on `sandbox-workspace.tsx:96`): keystrokes pipe to the box PTY when the
  backend advertises stdin; it gracefully stays read-only (the agent firehose) when it doesn't.
- **Add `@xterm/addon-fit`** (already used) + **`@xterm/addon-web-links`** (new — clickable URLs in
  output). FitAddon on mount + `ResizeObserver` on the dock panel (resize handle drag must refit —
  today only `window.resize` refits, so dragging the dock leaves the terminal mis-sized; add a
  `ResizeObserver` on the container).
- **Header:** a small status line — `pty: <shell>` + a running/idle dot from `result.running`, and a
  "read-only" pill when `write === null`. A **clear** (local scrollback) button.
- **Theme:** token-derived `ITheme` + `var(--og-font-mono)` at 13px.
- **Beat:** e2b/Replit ship a real PTY; we match it and add link-detection + token theming.

### 4.3 Desktop (watch + take-over)

- **Watch by default:** noVNC `viewOnly`, scaled to fit (`scaleViewport`). The viewer attaches only
  after the un-redacted consent gate (already implemented) — keep it. The box warms lazily; the
  warming/unavailable/viewer-cap notices already exist.
- **Take control toggle** (the new bit): a header segmented control **`Watching ⇄ Take control`**.
  - "Watching" → `viewOnly = true` (you see the agent's pixels, no input).
  - "Take control" → pass `interactive` so `use-desktop-stream.ts:113` resolves
    `rfb.viewOnly = false`; your mouse + keyboard now drive the box. This requires
    `capability.mode !== "read-only"` (server gate) — when the server forces read-only, the toggle is
    **disabled with a tooltip** ("This deployment streams the desktop read-only").
  - **The toggle is `interactive` state lifted into `DesktopViewer`** (today `interactive` is a prop
    that's never set). On flip, the RFB's `viewOnly` updates — the effect already re-runs on
    `interactive` change, so a flip reconnects/re-attaches input cleanly.
  - **Visual:** when in control, a thin **accent border + "You're in control" pill** frames the
    canvas (so you never lose track of who's driving), plus a **"Return control"** action. Pointer
    capture lives in the canvas; clicking outside / `Esc` / blur returns control to watch to avoid
    trapping the cursor.
  - **Shared-box caution:** when `capability.shared`, the take-control affordance shows the existing
    shared-session warning copy (you'd be driving a box other sessions watch).
- **Maximize is essential here** — a desktop is unusable at dock width; the §2 maximize overlay is
  the primary way to actually take control.
- **Beat:** most agent UIs only *watch*. Watch-with-takeover (read-only-by-default, server-gated,
  visibly framed) is the differentiator and matches the product's "dual-use desktop" vision.

---

## 5. References — match or beat

| Product            | What to take                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| **Pierre** review UI | The whole Files surface: Changes group + tree + inline syntax-diff. We use Pierre directly. |
| **Cursor** agent sidebar | Resizable/collapsible dock beside chat; per-file review; restraint. We beat its flat file list with Pierre grouping. |
| **VS Code**        | Panel maximize/restore, resize-handle ergonomics, `Esc`-to-restore, persisted layout. |
| **StackBlitz / e2b / Replit** | Real interactive PTY + live preview; fit-on-resize. We match the PTY and add link detection. |
| **noVNC demos**    | Scale-to-fit, view-only vs full-control, security-failure reconnect (the hook already mirrors this). |

---

## 6. Build checklist (hand-off to Build phase)

1. **Deps:** add `@pierre/diffs@1.2.11`, `@xterm/addon-web-links@0.12.0`,
   `react-resizable-panels@4.11.2`; bump `@xterm/*` peers to v6 and `@novnc/novnc` to `^1.7.0`;
   install xterm(×3) + novnc as **real deps in `apps/web`**. Add the new libs to the
   `packages/react/demo` so every surface renders in the headless harness against `mock.ts`.
2. **Fix noVNC import:** static `import("@novnc/novnc")`, drop `@vite-ignore` + string indirection
   (`use-desktop-stream.ts`).
3. **Dock shell:** new `WorkspaceDock` (PanelGroup + resize handle + collapse + maximize overlay,
   `autoSaveId`), replacing the fixed aside in `session.tsx`. Three tabs Files | Terminal | Desktop.
4. **Files surface:** wire `@pierre/diffs/react` `FileTree` behind `FileBrowser`'s `renderNode`/
   `fallback` seam; two-pane tree+diff with Changes group, branch/dirty header, staged/unstaged +
   unified/split toggles. Wire `FileDiff` behind `DiffView`'s `fallback`. Keep built-ins as fallback.
5. **Terminal:** interactive by default; add web-links addon + `ResizeObserver` refit; token theme;
   header status.
6. **Desktop:** lift `interactive` into a "Take control" toggle in `DesktopViewer`, server-gated on
   `capability.mode`, framed when in control, shared-box warning, `Esc`/blur returns control.
7. **Theming:** derive xterm `ITheme` + Pierre/Shiki theme from tokens; verify dark↔light flip.
8. **Verify headless:** render each surface in `packages/react/demo` (Vite + `mock.ts`) — extend the
   mock to advertise a desktop transport + a dirty git status + a PTY so all three tabs light up —
   and screenshot via Playwright using nix-built Chromium (`nix build nixpkgs#chromium` →
   `./result/bin/chromium` as `executablePath`; JS `spawnSync` for the nix eval, not a bash loop).
