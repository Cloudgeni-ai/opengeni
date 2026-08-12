# `@opengeni/ogtool`

`ogtool` is the bundled command-line wrapper for one exact OpenGeni execution attempt's Codemode
surface. It uses the same `@opengeni/codemode` client and frozen tool catalog as Bun programs;
it does not rediscover or proxy MCP servers. Stock OpenGeni sandbox images include this exact
package CLI. Custom rigs can run the same release-coherent artifact with Bun.

```sh
bun x -p @opengeni/ogtool@<version> ogtool list
bun x -p @opengeni/ogtool@<version> ogtool call <tool-path> '{"key":"value"}'
bun x -p @opengeni/ogtool@<version> ogtool declarations opengeni-codemode.d.ts
```

Always replace `<version>` with the exact version in the deployment BOM; do not silently track
`latest` in a production image. An embedding host may expose that pinned spec through
`OPENGENI_OGTOOL_PACKAGE_SPEC`.

The CLI reads `OPENGENI_CODEMODE_URL` plus either the bearer in
`OPENGENI_CODEMODE_TOKEN` or its path in `OPENGENI_CODEMODE_TOKEN_FILE`. Managed sandboxes use
the protected file and reread it for every request. Connected Machines receive the direct bearer
only in the exact agent command's child environment; it is not installed machine-wide or written
to disk. `ogtool doctor` reports the selected delivery mode without printing the token.

Commands:

- `ogtool list`
- `ogtool call <tool-path-or-model-name> [json-object]`
- `ogtool declarations [output-file]`
- `ogtool doctor`
- `ogtool --version`

The HTTP client submits a caller-chosen operation id and polls the durable result. A lost response
therefore cannot silently replay a side effect. `@opengeni/ogtool` also re-exports the typed
`@opengeni/codemode` client for application code. Codemode is a projection of the attempt's one
tool authority, not a second tool or credential surface.
