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

- `ogtool list` — a bounded page of callable paths and short descriptions, one tool per line
- `ogtool list --json` — compact JSON with `catalogDigest`, `total`, `offset`, `nextOffset`, and `tools: [{path, description}]`
- `ogtool list [--json] [--query <substring>] [--limit <1..100>] [--offset <integer>]`
- `ogtool list --full` — the previous full catalog JSON, including identity and schemas
- `ogtool show <tool-path-or-model-name>` — one tool's details and schemas as JSON
- `ogtool call <tool-path-or-model-name> [json-object]`
- `ogtool declarations [output-file]`
- `ogtool doctor`
- `ogtool --version`

Start with `list`, then use `show docs.search` before constructing a call. Compact
descriptions collapse whitespace and use at most 160 Unicode code points, including
an ellipsis when shortened; a missing/empty description falls back to the title.
Text mode displays C0, C1, and DEL control characters as literal `\uNNNN` escapes
so descriptions and title fallbacks cannot execute terminal control sequences.
The byte budget includes this escape expansion. This is text-only presentation:
catalog content, query matching, and explicit JSON/full/schema output remain unchanged.
Catalog order and callable paths are preserved. Compact output contains no identities,
schemas, approval annotations, or attempt IDs. JSON includes the frozen catalog digest
so a machine caller can detect a changed catalog between pages.

Compact pages default to at most 50 tools; `--limit` accepts 1 through 100. The complete
stdout page, including JSON escaping, metadata, text continuation hints, and final
newline, is at most 16 KiB. The CLI drops trailing entries until it fits, never
truncates a callable path, and fails clearly if even one entry cannot fit. The
catalog's maximum valid callable path fits this bound.

`--query` is a literal, case-sensitive substring match against the callable path or
full whitespace-normalized description (title fallback), including text beyond the
displayed summary. An empty query matches all tools. `total` counts filtered matches;
`--offset` is a nonnegative safe integer within that filtered order, not the unfiltered
catalog. Follow the returned `nextOffset` rather than adding your requested limit:
the byte cap may return fewer tools. Keep the query unchanged and verify the JSON
`catalogDigest` is unchanged when walking pages. `nextOffset: null` means finished.
Empty/no-match/past-end pages return no tools and no next offset; text still prints
the total/offset footer. Both `--flag value` and `--flag=value` are supported.

`--full` rejects `--json`, `--query`, `--limit`, and `--offset`, including explicitly
supplied defaults. Unknown/duplicate flags and extra arguments are errors.
`show` accepts the same exact path/model-name/identity aliases as `call`
and rejects unknown or ambiguous names. Its JSON output (including the final newline)
is limited to 64 KiB; oversized details fail without partial output or schema
truncation. Use `list --full` redirected to a file, or `declarations <output-file>`,
for larger schemas. Existing scripts parsing the old `list` JSON must use `list --full`.

The Connected Machine fallback, `"$OPENGENI_CODEMODE_NATIVE_CLIENT" codemode`,
supports the same `list`, `list --json`, `list --full`, and `show` discovery behavior.
It does not provide the JavaScript CLI's `declarations` command.

The HTTP client submits a caller-chosen operation id and polls the durable result. A lost response
therefore cannot silently replay a side effect. `@opengeni/ogtool` also re-exports the typed
`@opengeni/codemode` client for application code. Codemode is a projection of the attempt's one
tool authority, not a second tool or credential surface. Aborting the CLI/client wait stops only
local observation; it does not cancel a journaled server operation, which must be reconciled by the
same operation id or settled by the owning attempt lifecycle.
