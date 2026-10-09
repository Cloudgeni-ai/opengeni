# Visual testing

The web app's UI Verify suite uses Vitest 4 browser mode, Playwright Chromium,
and the production React components, Tailwind styles, and bundled fonts.
`apps/web/vitest.config.ts` owns capture configuration. Tests live in
`apps/web/test/visual/*.visual.tsx`; this suffix keeps them out of Bun's unit suite.
The runner and its dependencies live at the repository root so Vite serves
Bun's hoisted fonts through ordinary URLs. The quickstart's pinned SDK excludes
`/@fs/` resource URLs; tests wait for font loading before archiving the DOM.
The initial coverage is a Button size/variant/disabled/icon gallery in light and
dark themes (two captures). A diff flags the whole theme's gallery; variants
do not have independent baseline approval. Add separate files for other components
or pages as coverage grows.

From the repository root:

```bash
bun install
bunx playwright install --with-deps chromium
bun run test:visual
```

Upload locally from the repository root using the
[UI Verify quickstart](https://uiverify.ai/docs/quickstart-vitest) command, with
`UIVERIFY_API_KEY` exported in your shell:

```bash
npx -y uiverify@1.2.1 upload --static-dir ./uiverify-archive
```

If npm rejects this Bun workspace's existing overrides with `EOVERRIDE`, use
`npx --prefix /tmp -y uiverify@1.2.1 upload --static-dir ./uiverify-archive`.
The prefix isolates npm's CLI installation while preserving the working directory
and git metadata. Archives are generated locally and ignored by git. No CI or
GitHub App is needed for this workflow. Review and accept the initial baseline
yourself in the UI Verify dashboard.

The five UI Verify playbooks are installed under `.agents/skills/` with local
Claude Code symlinks. `CLAUDE.md` links to `AGENTS.md`, so both share the UI-change
rule. Read `making-ui-changes` before UI edits, `economical-visual-tests` when
adding coverage, and `vitest-visual-testing` when authoring deterministic fixtures.
Use `check-visual-changes` to preview edits and `triage-visual-changes` to review
uploaded builds.

The project `.mcp.json` configures the UI Verify HTTP MCP using
`${UIVERIFY_API_KEY}`; no key is committed. Export that variable in the environment
that launches your MCP client, then restart the session or reload the window to
load the new skills and server configuration.
