# Actual composer review fixture

This fixture imports `ConsoleComposer`, `ChatComposer`, `MessageTimeline`, the model
and tools pickers, repository pickers, mobile overflow, and the session Variable Set
picker from production source. It imports the ordinary app stylesheet, including
the shared composer CSS, fonts, tokens, and container-query breakpoints.

The build imports the current checkout's production authorization status surface.
Healthy attached resources produce no extra composer controls or status text.
There is no fixture-only authorization design or historical baseline component.

Only the application data context is substituted, through a build-only alias.
This allows the unchanged production components to render without live credentials.
Resource writes and uploads fail explicitly. Sending changes only local fixture
state and the real timeline renderer. The example model/resource/tool data is not a
live account projection; voice is unavailable. Navigation shell, SessionChrome
signals, and backend authorization/workflow execution are not mounted or verified.

From the repository root:

```sh
bun install --frozen-lockfile
bun apps/web/test/real-personal-access/build.ts
bun apps/web/node_modules/typescript/bin/tsc --noEmit -p apps/web/test/real-personal-access/tsconfig.json
PREVIEW_CHROMIUM_PATH=/usr/local/bin/chromium bun apps/web/test/real-personal-access/check.ts
```

The build defaults to `dist` beside this file, or accepts an output directory as
its first argument. It emits a single self-contained HTML runtime and a retained
source JSON bundle. No runtime workspace tools are requested by the Site.
The browser check uses Playwright's installed browser by default; set
`PREVIEW_CHROMIUM_PATH` only when using an existing system Chromium executable.

For visual review, serve the generated HTML. Exercise the real model/tools menus,
Send, the unavailable-resource probe and Retry, the empty-draft guard, narrow widths,
and light/dark themes. This component
review is not proof of the appearance or behavior of an authenticated deployed
session with a different model/resource/voice configuration.