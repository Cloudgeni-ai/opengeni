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

The CLI reads `OPENGENI_CODEMODE_URL` and the bearer path in
`OPENGENI_CODEMODE_TOKEN_FILE`. The token remains in the protected file and is read anew for
each CLI process, so worker-side token renewal does not require reinstalling or restarting the
CLI. `ogtool doctor` checks local availability without printing the token.

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
