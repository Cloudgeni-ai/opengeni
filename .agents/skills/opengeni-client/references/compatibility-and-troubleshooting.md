# Verify compatibility and recover setup problems

## Product documentation without repository access

Fetch https://docs.opengeni.ai/llms.txt for the official documentation index.
Read the relevant Markdown page, especially
https://docs.opengeni.ai/embed-manually.md,
https://docs.opengeni.ai/reference/authentication.md, and
https://docs.opengeni.ai/reference/sdk.md. An ordinary customer integration
does not require a clone of OpenGeni. If a fetch fails, report that source as
unavailable and inspect the installed package and authorized service instead.

Documentation availability and deployed feature availability are separate.
Inspect the installed package exports/types and `/v1/config/client`; verify the
chosen contract against the intended deployment before implementing against it.

To check the full Skill's HTTP Markdown export from a repository checkout:

```bash
bun scripts/check-client-skill-markdown-export.ts
```

This opt-in network check compares the published `.md` sections with the local
generated mirror, including nested code fences. A mismatch may mean the docs
deployment has not caught up with the checkout; it is not evidence of a runtime
API failure. Use `--url` and `--expected` to check another deployment or a known
matching mirror. The local HTTP regression tests run without external services.

## CommonJS hosts

The SDK is ESM-only. In an existing `.cjs` host, use dynamic `import()` inside
an async initializer; `require("@opengeni/sdk")` is not the supported loading
path. Do not change the entire project's module type just to load the SDK.

```js
// opengeni.cjs — callers await createOpenGeniClient().
async function createOpenGeniClient() {
  const { OpenGeniClient } = await import("@opengeni/sdk");
  return new OpenGeniClient({
    baseUrl: process.env.OPENGENI_API_BASE_URL,
    apiKey: process.env.OPENGENI_API_KEY,
  });
}

module.exports = { createOpenGeniClient };
```

Keep this initialization on the server: never send the API key to a browser.

## Host errors and uncertain actions

Keep SDK/provider details server-only and return friendly host-branded notices,
not `error.message`, `error.body`, raw stack traces or a provider's product name.
Put configuration, dynamic SDK import/initialization, identity resolution,
upstream calls and local persistence inside the route's error boundary, not only
the final call. Log a redacted diagnostic with a non-secret correlation ID on
the server; never copy an SDK exception into the browser response or DOM.

Branding applies to UI-owned labels/notices, not legitimate source quotations,
code, or user/assistant transcript content; do not rewrite those to hide names.
Check the installed SDK/React error-copy API separately: changing conversation
labels does not itself prove that upstream error messages are remapped. Host
safe-copy guidance alone does not change a package's default error behavior.

For an approval route, distinguish an accepted decision from completed tool
execution. If the call returns a decision event and local mapping/receipt save
then fails, the decision may already be durable. `outcomeUnknown: true` also
means acceptance may have occurred. Neither case justifies "the article is
unchanged", a fresh approval ID or a blind replay. Keep the original session,
approval ID and persisted `clientEventId`; reread ordered events and the
authorized provider record to reconcile. Only retry the exact original request
under the installed endpoint's supported idempotency contract after reconciliation.
For stale/no-pending approval conflicts, refresh current state instead of
recreating a pending card or exposing the raw upstream error.

```js
function assistantFailureNotice(error, { decisionAccepted = false } = {}) {
  if (decisionAccepted || error?.outcomeUnknown === true) {
    return {
      state: "reconciling",
      message: "The action may have been accepted. Check its status before trying again.",
    };
  }
  if (error?.status === 409) {
    return { state: "refresh", message: "This request has changed. Refresh before deciding." };
  }
  return { state: "failed", message: "The assistant is unavailable. Please try again later." };
}
```

This helper is for the host's approval-action error boundary, not a replacement
for authentication/authorization responses. Set `decisionAccepted = true`
immediately after `await sendApprovalDecision(...)`, before any local save.
Disable repeat actions while `state === "reconciling"`; render only this safe
notice and use the existing host status/error conventions. Apply the same
safe-copy boundary to polling, configuration and generic SDK failures. Test
stale approval, an unknown mutation outcome, accepted-decision/local-save failure,
SDK initialization failure and late errors after an identity switch.

## Decide what is being replaced

| Customer dependency | Evidence needed |
| --- | --- |
| Existing Vercel `useChat` frontend | Compatible UI message stream and the product's authenticated handler routes |
| Server-side AI SDK `streamText` or provider constructor | Actual provider/request features in use; a UI stream adapter alone is insufficient |
| OpenAI-shaped chat client | Supported subset of Chat Completions or Responses in the installed handler |
| Embeddings and retrieval | Independently supported embedding contract; keep the existing provider when only generation is migrated |
| Conversation history | Stable conversation identity, authorization, one-time imported history, later durable session history |
| Account setup | Correct credential type, authorized organization/workspace, required onboarding/configuration, and actual usable endpoint |
| Per-request monetary cost | Reply schema and billing semantics, not model-picker categories |

The `@opengeni/sdk/chat` adapters run in the customer's backend and talk to the
OpenGeni session API. They do not establish `/responses`, `/chat/completions`,
or `/embeddings` on the OpenGeni service base URL. Do not invent methods such as
`sessions.createResponse`. Generic OpenAI-compatible client documentation proves
client behavior, not OpenGeni server support.

Resolve a missing central compatibility fact before replacing production wiring.
If evidence is unavailable, continue independent work and describe any scaffold
as unvalidated. A caveat must constrain implementation when the unknown decides
whether the whole solution can work.

If the user says they will change secrets and wants account configuration,
answer that narrower request first. Inspect authorized setup tools/configuration,
perform in-scope actions, and state the exact human step if administration is
unavailable. Do not ask the customer to provide OpenGeni's own API specification.

## Cost reporting

The current `ChatReply`, Vercel UI stream, and OpenAI response extension have no
first-class monetary cost field. Check the installed version before answering.
`getBillingUsage` is a separate accounting route requiring `billing:read` and
appropriate access. Its bounded usage list is not a complete per-turn accounting
interface, and a normal integration credential must not be assumed to hold billing
authority. Do not promise that it adds fields to an AI SDK response.

Accounting must distinguish OpenGeni credit charge, estimated provider expense,
and external subscription/provider billing. A zero OpenGeni charge is not a zero
provider expense. Multiple model responses may contribute to a single turn.
State unknown telemetry as unknown, not zero. Use installed schemas or a verified
response as evidence; neither model availability nor a missing CLI answers this.

## Discovery and development preflight

Recover ranked tool-search misses using authorized inventory and exact-name
disclosure. Inspect the reviewed capability catalog where relevant. `skill_read`
does not need a sandbox; a missing `ogtool` should not block reading product
guidance. Keep command errors visible instead of treating suppressed errors as
proof that no capability exists.

For GitHub, distinguish App configuration, workspace binding, repository access,
and session attachment using the available GitHub tools. Confirm the real
repository root before patching. A missing optional notes file should not
short-circuit the rest of discovery.

Before coding, read the package manager declaration, lockfile, runtime-version
files (including `mise.toml` when present), tests, and CI. Probe the selected
compute for the required versions. Repair missing tools inside the authorized
disposable sandbox, then rerun the intended checks. A Connected Machine's
system-wide configuration has separate user ownership.

An install is successful only when its exit/result and a version or execution
probe establish success. Rerun the intended test after repair. If blocked,
report the attempted repair and exact missing requirement, rather than handing
back an avoidable package installation. Never substitute a whitespace check for
unit, type, or integration tests. Report code written, committed, tested,
integration verified, and published as distinct facts within the requested scope.
