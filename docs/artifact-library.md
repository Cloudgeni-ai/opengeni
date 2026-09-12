# Artifact library

The workspace **Artifacts** page and the session's Artifacts panel are views of
the same durable outputs. Sites are one artifact type, alongside documents,
spreadsheets, presentations, images, and published files. Existing Site and
editable-artifact detail links keep their meaning.

## Discovery, not another content store

`GET /v1/workspaces/:workspaceId/artifact-catalog` projects existing domains into
bounded `ArtifactCatalogItem` summaries. `client.listArtifactCatalog(workspaceId,
options)` is the corresponding SDK entry point. It supports title search (`q`),
`kind`, `status`, `sort` (`updated`, `newest`, or `title`), `limit`, an opaque
`cursor`, and optional `sourceSessionId` filtering. Clients use `nextCursor`, not
offsets or scans of conversation history. Use `kind:id` as the list identity;
native artifact IDs are not replaced by catalog IDs.

Pagination is a live keyset traversal, not a transaction snapshot spanning HTTP
requests. Its initial timestamp excludes later creations; titles and update
times can still change between pages. An edited item may move across the cursor
and appear again or only after a refresh. Clients deduplicate by `kind:id` and
restart the listing when refreshing or changing filters. The cursor is scoped to
the viewer and query and expires after one hour. A bounded scan through denied
candidates can return an empty page with `nextCursor`; that is not the end of the
listing.

The catalog reuses Site records and versions, editable-artifact records and
authority, generated-image correlation, and explicit sandbox-file publication
metadata. File bytes remain in the existing workspace file domain. It does not
index every uploaded attachment, working file, browser screenshot, or temporary
build output. Publishing an output is deliberate; creating a file in a sandbox
alone does not publish it.

Discovery does not authorize content access or change an editable artifact's
session associations. Existing file and artifact read permissions remain
authoritative. Source-session links are exposed only when that session is
readable. Content is loaded through the existing authenticated artifact APIs;
catalog results contain no storage credentials or temporary download URLs.

## Presentation and version semantics

The workspace library offers a preview grid and compact list, type filtering,
title search, sorting, and an archived filter. The session panel uses the same
catalog with a source-session filter. Both open the existing type-specific
viewers. Published files use `/workspaces/:workspaceId/artifacts/files/:artifactId`.

Images load from retained storage, not the compute filesystem. Image publication
results are primary chat output and reuse the retained-image viewer/lightbox.
Agents should still include `![Description](artifact:<artifactId>)` in their
answer when presenting an image. The reference pins the published bytes: changing
or deleting the source file does not change the delivered image. Repeating the
same sandbox path/content publication reuses its identity; changed bytes produce
a distinct immutable output.

Image classification follows the retained file's authoritative content type.
This rolling change preserves the sandbox publisher's existing PNG/JPEG/WebP
format mapping. GIF, AVIF, and SVG are viewable when already retained with a
supported image content type, but binary-typed sandbox publications remain files.
The catalog does not infer a different media type from a filename or rewrite an
immutable publication's metadata.

Library browsing must not execute Site JavaScript, invoke workspace tools, or wake
compute. Images have real image previews. Types without an available static
preview use a clearly identified type/title fallback; those tiles are not
screenshots of the artifact. Existing editable viewers open the current head;
saved Site chat embeds can select an exact version.

Ordinary HTML files remain downloadable files, not executable Site previews.
The existing explicit `opengeni-html` and `opengeni-site` chat blocks continue
through the shared isolated HTML frame and tool bridge. Message-owned inline
HTML is not automatically copied into the library. Publish a Site when that
visualization needs independent discovery and a durable version lifecycle.

## Boundaries and compatibility

- No new image storage provider or second HTML execution path.
- No migration of editable content into a universal artifact table.
- No change to existing Site, editable-artifact, or retained-content API URLs.
- Historical unassociated sandbox files are not recovered by parsing storage
  keys or replaying tool history. Republishing a still-available source file
  establishes its publication metadata.
- Retained content retrieval failures remain explicit; the UI does not silently
  fall back to starting a sandbox.

See [architecture](architecture.md), [artifact engine](artifact-engine.md),
[artifact collaboration](artifact-collaboration.md), and
[inline HTML and chat previews](embedding-authority-internals.md#inline-html-and-chat-previews).