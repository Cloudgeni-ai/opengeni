# Embedded product example

Runnable Connect + Sites host application. Uses the public controller, shared
React components, and existing Site iframe. No OpenGeni API key enters the browser.

From this repository run `bun install`, then copy `.env.example` to `.env.local`
in this directory and configure a **development** organization key and an
explicitly authorized shared workspace. Onboard external ID `demo-user` with
source `embedded-product-demo` through the service-only
`addExternalWorkspaceMember` operation, granting only the needed permissions:
`workspace:read`, `connections:read`, `connections:write`, `artifacts:read`, and
`capabilities:manage` only if this user may install integrations. The service key
also needs the matching ceiling. This example does not automatically grant access.

Set `EMBED_DEMO_LOCAL_AUTH=true` to acknowledge fixed-user local demo mode.
Run `bun run server` and `bun run dev` in two terminals, then open
`http://127.0.0.1:3102`. Both servers bind loopback only. Do not expose this mode
through a public tunnel or production deployment. Replace `authenticate` and
`authorizeMutation` in `server.ts` with your existing host session, tenant mapping,
and CSRF checks before adapting this code for a real product.

The host chooses the exact return URL. OAuth completion is read through pending
attempts/backend polling, not appended query parameters or popup messages. A
blocked popup can be retried with explicit full-redirect mode. The example
does not automatically reconnect/retry uncertain mutations or elevate denied
requests to the service client. Disconnect is local revocation with an observed
version, not upstream consent revocation. Provider secrets and raw diagnostics
are never logged by the handler.

Site archive/rollback controls are hidden in this example. Edit with Geni uses
the shared native authoring helper, checks the selected Site version, and opens
an ordinary actor-scoped session using the user's saved model preference. This
requires sessions:create/read/write and the appropriate Site tool permissions;
it may incur model/compute costs when explicitly clicked. The host session proxy
reuses SDK SSE resume/cancellation and accepts only normal validated user events.
The session panel is lazy-loaded and uses shared streaming, messaging, approval
and structured-input controls, version-checked pause/resume/terminal cancellation,
and the shared queue/composer surfaces. Queue move, edit, steer and delete use
the original typed operations and optimistic versions. Durable drafts preserve
queue checkout, conflict choices, and exact-operation submit recovery; no second
queue or draft engine is introduced. Timeline auth-needed actions open the shared Connect setup for the
exact surviving account, or require explicit account selection if it is absent.
Host-managed credential recovery stays on the host-provided recovery route.
Terminal cancellation requires explicit
confirmation; an unknown result requires refresh before another control action.
Scheduled work supports creating paused interval tasks, pause/resume, confirmed
manual trigger with a stable trigger ID, deletion, and recent-run display. These
use the existing scheduling API and require `scheduled_tasks:manage` for changes
and `scheduled_tasks:run` for viewing/running; they do not change scheduling or
approval semantics. Review a new task before resuming it. Schedule mutations do
not claim optimistic concurrency that the native API does not provide.

The session composer accepts workspace-shared file uploads up to 32 KiB through
the host backend (the SDK handles hashing, signed storage upload, and completion).
Grant `files:upload` and the appropriate file-read/resource permissions explicitly.
Unconfirmed uploads block send until dismissed or resolved. Removing an attachment
does not delete the stored workspace file. Larger/direct-to-storage uploads are
outside this deliberately bounded example route.
No tool bridge is supplied by this example, so displayed Sites do
not receive tool execution authority. This example is not proof of full provider,
native-linking, private/Personal, lifecycle or scheduled-renewal coverage.

Targeted checks: `bun run typecheck`, `bun run build`, and
`bun test src/host-handler.test.ts src/session-control-host.test.ts src/schedules-host.test.ts`.