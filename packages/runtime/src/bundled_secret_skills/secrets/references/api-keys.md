# API keys, CLIs and config files

## Shell commands

Write references straight into the command. Each one becomes an environment
variable of that command only, quoted correctly, so special characters are
safe and you need no extra quoting.

```sh
GITHUB_TOKEN={{secret:GitHub/token}} gh repo list
curl -H "Authorization: Bearer {{secret:OpenAI}}" https://api.openai.com/v1/models
psql "postgres://app:{{secret:Prod DB/password}}@db.internal:5432/app"
```

- Nothing is exported between commands. Repeat the reference in each command,
  or write a file (below).
- Nested shells re-parse expanded values. Use these forms:
  `V={{secret:X}} bash -c 'tool --token "$V"'` and
  `printf %s {{secret:X}} | ssh host 'read -r V; tool --token "$V"'`.
- Windows machines: references work in PowerShell. `cmd.exe` and `fish` are
  not supported; run the command with `powershell` instead.

## Files

File writes (`apply_patch` and other file tools) resolve references, so the
file on disk holds the real value.

- Many variables: write a `.env` file with references, then load it with the
  tool or `set -a; . ./.env; set +a`.
- Config files (`~/.npmrc`, `kubeconfig`, `.netrc`) work the same way.

## secretfile

`{{secretfile:Item}}` (or `{{secretfile:Item/field}}`) becomes the path of a
private temporary file holding the value, deleted when the attempt ends. Use
it in shell commands for key files, large values (about 100 KB or more) and
binary data:

```sh
ssh -i {{secretfile:Deploy key}} deploy@host uptime
gcloud auth activate-service-account --key-file={{secretfile:GCP service account}}
```

## Saving keys you obtain

When a site or CLI shows you a new key once, save it immediately:

```json
{
  "item": "Stripe test key",
  "type": "api_key",
  "saveTo": "user",
  "websites": ["https://dashboard.stripe.com"],
  "fields": [{ "name": "value", "value": "sk_test_..." }]
}
```

Then use `{{secret:Stripe test key}}`. A literal `value` is stored with the
tool call; that is fine for a value you just read. Use `fromReference` to copy
an existing field and `generate` for new passwords.

Use `secret_get` only when a tool cannot take a reference; it needs the
`secrets:read` permission.
