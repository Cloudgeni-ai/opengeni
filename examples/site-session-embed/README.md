# Session SDK inside an OpenGeni Site

Uses the normal React provider, timeline and durable composer with
`createOpenGeniSiteClient().client`. No API URLs or credentials in browser code.

From this directory: `bun run dev` inside a live agent sandbox (existing
Codemode environment required), or `bun run build` and publish `dist/index.html`
with the retained source. The build excludes the optional Pierre highlighter;
React uses its existing plain-diff fallback instead of embedding all languages.

For a local no-auth development stack, `bun publish-local.ts <local-api-url>`
publishes the demo into its first workspace. This is a test helper, not a
production publisher. The normal publishing flow uses the artifact tools.
