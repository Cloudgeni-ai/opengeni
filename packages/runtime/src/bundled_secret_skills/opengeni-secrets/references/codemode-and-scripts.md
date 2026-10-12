# Codemode and scripts

References resolve once, at the first place that executes them. In a shell
command that is the shell: each reference is spliced into the command as an
environment variable before it runs. Escape a reference with a backslash to
pass it through one layer unresolved: `\{{secret:X}}` becomes the literal
`{{secret:X}}`.

## ogtool call

Inside `exec_command`, write `\{{secret:X}}` in `ogtool call` arguments:

```sh
ogtool call linear.save_issue '{"title": "Rotate key", "token": "\{{secret:Linear/token}}"}'
```

The shell splice removes the backslash and leaves `{{secret:Linear/token}}`;
the tool gateway resolves it when the tool runs, and the Codemode journal
keeps the reference. Without the backslash the shell splices the value into
the arguments and it lands in the Codemode journal.

## Script files

File writes resolve references too. In a Bun or Node script that calls tools
(`tools.x({...})`), write `\{{secret:X}}` in the source so the file keeps the
literal `{{secret:X}}` and the gateway resolves it at call time.

When the script itself needs the value (for example its own HTTP request),
pass it in for that run:

```sh
API_KEY={{secret:Acme API}} bun run sync.ts
```

and read `process.env.API_KEY` in the script.

## Heredocs and quoting

- Unquoted heredocs and double or single quotes all work; the splice quotes
  correctly for you.
- A quoted heredoc (`<<'EOF'`) or PowerShell here-string `@'...'@` receives
  the value literally at dispatch, so it appears in the command text the
  machine runs.
- In nested shells use `V={{secret:X}} bash -c '... "$V" ...'` (see
  `api-keys.md`).
