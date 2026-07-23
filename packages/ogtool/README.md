# `@opengeni/ogtool`

`ogtool` is the dependency-free command-line client for the session-bound OpenGeni Toolspace MCP
surface. Stock OpenGeni sandbox images include this exact package CLI. Custom rigs and connected
machines can install the same release-coherent artifact from npm.

```bash
npm exec --yes --package=@opengeni/ogtool@<version> -- ogtool list
npm exec --yes --package=@opengeni/ogtool@<version> -- ogtool call <tool-name> '{"key":"value"}'
```

Always replace `<version>` with the exact version in the deployment BOM; do not silently track
`latest` in a production image. An embedding host may expose that pinned spec through
`OPENGENI_OGTOOL_PACKAGE_SPEC`.

The CLI reads `OPENGENI_TOOLSPACE_URL` and the bearer path in
`OPENGENI_TOOLSPACE_TOKEN_FILE`. The token remains in the protected file and is read anew for
each CLI process, so worker-side token renewal does not require reinstalling or restarting the
CLI. `ogtool doctor` checks local availability without printing the token.

Commands:

- `ogtool list` / `ogtool tools/list`
- `ogtool call <tool-name> [json-object]` / `ogtool tools/call ...`
- `ogtool doctor`
- `ogtool --version`

If the CLI is absent and package installation is unavailable, callers can use MCP Streamable HTTP
directly with the same URL and bearer file. `ogtool` is a convenience client, not a second tool or
credential surface.
