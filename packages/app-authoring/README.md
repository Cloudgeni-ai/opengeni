# `@opengeni/app-authoring`

Deterministic, traversal-safe authoring utilities for OpenGeni Apps plus the
`og-app` command.

```bash
og-app init ./status-console --name "Status console"
og-app validate ./status-console
og-app pack ./status-console --output ./status-console.ogapp.tar
```

Deploy a checked build with an exact resumable deployment id:

```bash
export OPENGENI_BASE_URL=https://app.opengeni.example
export OPENGENI_WORKSPACE_ID=11111111-1111-4111-8111-111111111111
export OPENGENI_SESSION_COOKIE='better-auth.session_token=...'

og-app deploy ./status-console \
  --deployment-id 22222222-2222-4222-8222-222222222222 \
  --typecheck-command 'bun run typecheck' \
  --test-command 'bun test' \
  --build-command 'bun run build' \
  --preview --publish --reason 'Publish tested status console'
```

The deploy journal under `.opengeni/deployments/` contains only target ids,
digests, check receipts, versions, and idempotency state. It never stores the
session cookie, API key, or signed object-storage URLs. Reusing the same
deployment id resumes exact completed steps and rejects source or target drift.
Fresh Apps and tool-policy changes require `OPENGENI_SESSION_COOKIE` so the
control plane can bind the policy to the currently logged-in human. An API key
may deploy only through lifecycle paths its grant is authorized to use.

`pack` emits the control-plane `portable_tar_v1` source format. Entries are
sorted by normalized POSIX path; uid/gid, owner/group names, and mtimes are
fixed; regular-file modes are reduced to `0644` or `0755`; and the archive ends
with the canonical two zero blocks. The same inputs therefore produce the same
bytes on macOS, Linux, Windows, Bun, and Node.

The reader rejects absolute paths, traversal, backslashes, control characters,
duplicates, links, device entries, oversized files/archives, invalid checksums,
and nonzero trailing data. Directory collection never follows symlinks.

`og-app.json` is authoring metadata:

```json
{
  "version": "opengeni.app-source.v1",
  "name": "Status console",
  "slug": "status-console",
  "appVersion": "1.0.0",
  "entryPath": "index.html",
  "description": "A read-only operational status view."
}
```

The package also builds the immutable `opengeni.app-build.v1` file manifest
used by the Apps control plane. A release promotes those already-verified build
bytes; it never accepts another upload.

`og-app init` creates a dependency-free static entry page. Apps that call
OpenGeni tools should add `@opengeni/app-sdk` to their own browser build and
bundle `installOgGlobal` or `connectOgApp`; bare npm package imports are not
served by the isolated App host.

The optional authoring HTTP transport is explicit and credential-injected. It
uses either one API key or one managed human session cookie, keeps signed
uploads credential-free, and never infers ambient product authority.
