# Session SDK inside an Opengeni Site

Uses the normal React provider, timeline and durable composer with
`createOpenGeniSiteClient().client`. No API URLs or credentials in browser code.
The visible chat fixture exercises a console-frame deferred start. For a
published-host chat, create on the first user message with `initialMessage`
and then mount the conversation with its returned ID; do not resend that message.

Chat UI is optional. `inline-action.ts` demonstrates arbitrary app-authored
prompts and streaming results with no buttons, templates or history UI. Give it
the application's prompt/context, a retry-stable action ID and viewer-private
handle storage. Render or validate the returned text in the application's own
UI; handle `pending`, `cancelled` and rejected model failures explicitly.
`site.ai.result(sessionId, { turnId })` resumes observation without new work.
An observation abort does not cancel execution. Native permissions, approvals,
model access, subscriptions and outsider limits remain in effect.

New execution is private per viewer and omitted from the workspace sidebar.
Organization policy can explicitly disallow it; there is no shared fallback.
Private chats do not make separately shared artifacts or Site Data private.

From this directory: `bun run dev` inside a live agent sandbox (existing
Codemode environment required), or `bun run build` and publish `dist/index.html`
with the retained source. The build excludes the optional Pierre highlighter;
React uses its existing plain-diff fallback instead of embedding all languages.

For a local no-auth development stack, `bun publish-local.ts <local-api-url>`
publishes the demo into its first workspace. This is a test helper, not a
production publisher. The normal publishing flow uses the artifact tools.
