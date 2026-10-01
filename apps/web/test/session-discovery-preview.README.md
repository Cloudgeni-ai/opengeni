# Session discovery browser preview

This harness imports the production `SessionsIndexRoute`, `SessionSearchDialog`,
Recent list, segmented control, select, message preview, and styles. Only the
context and client service boundary use sample responses. There is no live
authentication, database, agent execution, or submission.

From `apps/web`, run in separate terminals:

```sh
bun run vite --config test/session-discovery-preview.vite.config.ts
bun test/session-discovery-preview.browser.ts
```

The browser runner uses Chromium at `/usr/local/bin/chromium` (override with
`CHROMIUM_PATH`) and saves screenshots under `/workspace/previews`. It checks
light and dark themes at 1280px, 390px and 320px:

- The Recent request uses `parentSessionId: null` and renders six parents.
- Parent sessions is the default search scope for both title and message reads.
- All sessions includes the sample sub-sessions; switching back removes them.
- Keyboard navigation changes the scope and keeps one choice selected.
- Mobile results open in the real context preview and return to results.
- The dialog and page do not overflow horizontally, and no page errors occur.

The service fixture honors parent scope to exercise production request wiring;
database filtering and authorization are verified separately by backend tests.