# Production new-session route browser QA

This harness imports the real `SessionsIndexRoute`, `ConsoleComposer`, shared
`ChatComposer`, pickers, RecentSessions, starter component, styles, and local logos.
Only `@/context` and its client service boundary are replaced. There is no copied
preview UI, resolver, real authentication, provider connection, or live Send.
The real draft hook persists in fixture memory; `startSession` records submitted
text and returns null, deliberately stopping before navigation/agent execution.

From `apps/web`, run in separate terminals:

```sh
bun run vite --config test/new-session-starters-qa.vite.config.ts --host 127.0.0.1 --port 4317 --strictPort
bun test/new-session-starters-browser-check.ts
```

Prerequisites: installed workspace dependencies, Chromium at
`/usr/local/bin/chromium`, approved source at `/workspace/approved-starters-source.json`.
Overrides: `CHROMIUM_PATH`, `STARTERS_APPROVED_SOURCE`, `STARTERS_QA_URL`.
The installed Vite dependency `oxc-parser` parses only approved starter data;
the approved preview code and resolver are never executed.

Output: `new-session-starters-evidence/results.json` plus top/bottom screenshots
for 1280×720, 390×720 and 320×720, each light and dark. Each run overwrites these
bounded evidence outputs. Keep the browser runner separate from `bun test` unit
discovery; invoke it with `bun` as shown above.

Checks include six equally sized unclipped cards below six real recent-session
rows, exact approved title/description/prompt, loaded local vendor logos at 32px,
utility icons at 20px, two-line minimum and natural grow/shrink, unchanged visible
composer control identities, production scroll-owner wheel/keyboard/touch input,
click-only draft/focus with `preventScroll`, no pre-Send session or setup dialog,
edited-text submission through Enter and the Send button, no horizontal overflow,
no page errors, and zero attempted external HTTP requests.

Scope limits: Chromium fixture QA, not live stack/auth/backend/provider QA. No
surrounding application rail is mounted. Attachment upload is disabled, voice is
truthfully unavailable, model/permissions/resource catalogs are controlled, and
connected-machine, rig, and variable-set variants are not exercised. Control
identity checks apply to this selected fixture state, not every permission state.
Natural textarea growth can adjust route scrollTop through browser anchoring;
re-selecting an unchanged draft must retain exactly the same scroll position.