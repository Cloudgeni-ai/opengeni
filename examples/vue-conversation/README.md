# Vue conversation: Harbor guest desk

A genuinely non-React host: Vue 3 single-file components and a Composition API
composable, Vite, and the existing Bun Fetch adapter for
`createSessionProxyHandler`. It talks to a standalone service through the
**published** `@opengeni/sdk@7.5.0`; no repository SDK aliases, React packages,
runtime embedding, new backend framework, or public deployment are needed.
The UI is Harbor's, not OpenGeni's.

## Install and run

Requirements: Node 22.12+ (Vite), npm, Bun 1.3.10+, and an existing managed
OpenGeni deployment with a server-held full-access organization API key.
The deployment needs agent configuration admission and human input enabled,
session tenancy/private chats activated, and an available model/credits for the
acting user. Single-user `local` access mode does not admit external actors.

```sh
cd examples/vue-conversation/app
npm ci --workspaces=false
cp .env.example .env.local
```

Fill the **server-only** `OPENGENI_API_BASE_URL`, `OPENGENI_API_KEY`, and
`OPENGENI_ORGANIZATION_ID` in `.env.local`. Choose stable host tenant/user/source
IDs. Generate an onboarding operation UUID with
`bun -e 'console.log(crypto.randomUUID())'`, save it as
`OPENGENI_MEMBER_OPERATION_ID` **before** the next command, and reuse it on
retries. Do not put credentials in a `VITE_` variable or browser config.

```sh
npm run onboard
```

This explicit onboarding step ensures the tenant's organization workspace and
grants only `workspace:read`, `sessions:create`, `sessions:read`, and
`sessions:control` to the admitted external user. Save the printed
`OPENGENI_WORKSPACE_ID` in `.env.local`. It does not enable private chats,
configure models, grant admin, or repair revoked memberships. For an existing
mapping, omit onboarding and use the already-admitted user/workspace.

Run in two terminals from this directory:

```sh
npm run server
npm run dev
```

Open `http://127.0.0.1:3104` and select **Sign in to local demo**. Vite forwards
`/api` to the backend on port 4104; the browser only contacts its own origin.
Ask a question, refresh the page, choose the saved conversation, send a follow-up,
and pause/resume it. Status, queued-message notice, reconnect state, errors and
saved-request retry are visible.

For the built app on a single origin:

```sh
npm run build
# Change HOST_ORIGIN in .env.local to http://127.0.0.1:4104 first.
npm start
```

Open `http://127.0.0.1:4104`. Only `/` and built `/assets/*` are served; source,
environment files and arbitrary service paths are not public.

## Authentication and tenancy boundary

The launcher is intentionally **loopback-only** with `HOST_DEMO_AUTH=1` and an
explicit local demo login. It issues an opaque, HttpOnly, SameSite=Strict,
one-hour cookie backed by a server-side map. Browser request bodies cannot select
a tenant/user/workspace. The demo map is ephemeral: restart requires signing in
again, but the upstream conversations remain durable.

For a real host, reuse `createHostHandler` from `app/src/host.ts` in its existing
backend instead of deploying this demo launcher. Supply:

```ts
const handler = createHostHandler(serverOnlyClient, {
  origin: "https://your-host.example",
  authenticate: async (request) => {
    const user = await yourExistingVerifiedSession(request);
    if (!user) return null;
    const tenant = await yourAuthorizedTenantMapping(user);
    return {
      tenantId: tenant.id,
      userId: user.id,
      workspaceId: tenant.openGeniWorkspaceId,
      source: "your-stable-identity-namespace",
      csrf: await yourSessionCsrfToken(user),
    };
  },
});
```

Those placeholder functions belong to the host's existing authentication and
mapping store; they are not SDK functions. Use verified cookie sessions and
server-side tenant membership, never raw actor headers, query IDs, browser
storage, a Personal/default workspace fallback, or the organization key itself
as user authority. Switch storage/UI context when your host changes accounts.

Each request resolves this identity; the packaged proxy pins that workspace,
acts via `asUser(userId, { source })`, and enforces its native route allowlist.
Cookie writes require both the configured exact Origin and `x-host-csrf` from
the authenticated host context. No wildcard CORS. Private sessions enforce
creator visibility; listing is the proxy's default `mine`. For a conversation
bound to a business record, also provide the proxy's `authorizeSession` hook
using your record ownership store.

Creation policy stays on the server: private chat, no sandbox, no tools, no
bundled implementation Skills, Harbor identity, `renderer: "markdown"`, and
`humanInput` from otherwise-minimal capabilities. The browser supplies only
initial text and an idempotency key. Files and browser model selection are off.

## Durable lifecycle and supported UI

- `createSession`: a pending initial message + idempotency key is retained in
  tenant/user-scoped `sessionStorage` before sending. Explicit retries reuse it.
- `sendMessage`: the saved request keeps its `clientEventId` and exact text after
  an uncertain failure or reload. Retry does not invent another ID.
- Reopen: list the current user's sessions, restore the selected ID, replay from
  sequence zero to rebuild the in-memory projection, then continue the SDK's
  stream. Never persist only a cursor while dropping its projection.
- `streamEvents` owns replay, reconnect/backoff, duplicate suppression and gap
  backfill. Selection changes and unmount abort old streams; generation guards
  prevent old-session state/errors replacing the new selection.
- Session read and pending human-input reads reconcile at stream connection and
  lifecycle changes. Unknown additive event types are tolerated, not displayed
  as accidental tool prose. Text deltas reconcile with completed messages and
  terminal output; failure/status are separate from prose.
- Pause is resumable, not terminal cancel. Messages sent while paused queue.
- Approvals fold `session.requiresAction`'s stable `approvals[].id/name/arguments`
  shape; decisions remove old cards and turn settlement clears only that turn's
  approvals. Responses use `sendApprovalDecision` with a stable operation ID.
- Human input supports text, single/multi-select, required fields, Other,
  selection bounds, expiry and optional Skip via `submitHumanInputResponse`.
  The service remains the authority for validation and stale-request conflicts.

This is a deliberately small **escaped text** UI, not a full rich Markdown,
artifact/file/tool timeline or workbench renderer. Vue interpolation never runs
agent HTML (`v-html` is not used). Runtime error copy is host-owned; raw upstream
diagnostic messages are not exposed in the host UI. The sample attaches no
business tools, so approvals need your reviewed tool configuration in a real
host; preview approval events are synthetic, not proof of a hotel booking.

## Verify and preview

```sh
npm test
npm run build
# With npm run dev already listening (no API key/backend needed):
npm run preview:check
```

`app/src/visual-check.ts` renders the **actual** Vue components with clearly
synthetic HTTP/SSE fixtures. It verifies replay, refresh, create/send, approval,
human input, error/retry, pause/resume and mobile layout, then writes desktop,
decision and mobile PNGs into `/workspace/previews` (override with
`VUE_PREVIEW_OUTPUT`). For Chromium outside this sandbox, set
`VUE_CHROMIUM` to an installed executable or run `npx playwright install chromium`.
No production or public host is provisioned. Synthetic checks are separate from
live service/model execution, which needs the deployment prerequisites above.

The standalone npm lock is intentional. The app is one level below the root
Bun workspace glob so a root install cannot silently substitute the unpublished
local SDK source. Run consumer commands from `app`, not root Bun scripts.
Consumer checks use Bun's `.spec.ts` convention and the local `npm test` command;
they are not discovered by the root workspace's `.test.ts`-only CI unit shards.