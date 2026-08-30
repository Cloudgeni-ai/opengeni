# `@opengeni/app-authoring`

Deterministic, traversal-safe authoring utilities for OpenGeni Apps plus the
`og-app` command.

```bash
og-app init ./status-console --name "Status console"
og-app validate ./status-console
og-app pack ./status-console --output ./status-console.ogapp.tar
```

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

This package does not upload, publish, launch, or choose an HTTP/Code Mode
transport.