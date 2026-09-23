# HTML Sites: direct uploads, reference publication, streamed delivery

Status: upload/publication path implemented and tested locally; not deployed.
Scope: published HTML Sites only. The original audit/plan below is historical.

## Implemented locally

- `artifacts_prepare_upload` returns signed PUT URLs; no caller hashes or sizes.
- Create/publish accepts `uploadId`. Source JSON is optional; HTML-only works.
- `artifacts_get_source` returns signed HTML and optional source download URLs.
- Publication stores immutable copies; reusing an upload URL cannot change a version.
- New versions have null legacy hash fields. No Site content hashing or read-time rehashing.
- Viewing fetches only HTML through a streamed HTTP response, not the source bundle.
  The browser still holds HTML in memory for the existing sandboxed srcDoc frame;
  direct iframe URL delivery below remains a future optimization.
- Local checks: 13 MB HTML with/without source, download round trips, retry,
  overwrite isolation, and browser interaction.

## Original audit and plan

Audited against local base bf4c50eb2 and refreshed origin/main ca2b4e22c;
the principal Site publishing/content files have no intervening changes.

## Decisions from the discussion

- An agent calls a tool for signed HTML/source upload URLs, uploads with any
  ordinary HTTP client, then calls create/publish with the upload reference.
- No required agent-side hashes, byte counts, custom uploader, or SDK wrapper.
- No generic workspace File entries merely to publish a Site.
- Retain original React/TSX/CSS/build files, not just the compiled HTML.
- Remove Site content/source hashing, read-time rehashing and publication
  payload digests. Do not change document/spreadsheet artifact hashes, tool
  catalog digests, provider signing/checksums, or unrelated idempotency systems.
- Preserve immutable versions, retry safety, concurrent-edit detection and
  existing workspace/attempt/tool authority. These do not require content SHA.
- Do not replace 4 MiB with another unexplained small Site ceiling.

## Current implementation

`packages/contracts/src/artifacts.ts` requires inline HTML and accepts an
optional `{entrypoint, files:[{path,content}]}` source bundle. Both have 4 MiB
limits; source has a separate 128-file limit. Version response schemas also
enforce the byte ceilings. Codemode independently allows only 4 MiB arguments.
Thus raising the HTML constant alone does not fix publication.

REST (`apps/api/src/routes/workspace-artifacts.ts`) and MCP registrations
(`apps/api/src/mcp/server.ts`) share some content preparation but duplicate
input definitions. Both need changing, including generated/public SDK types.

`apps/api/src/workspace-artifact-content.ts` encodes and hashes the complete
HTML/source, assigns UUID-plus-hash keys, and writes them to object storage.
If source is omitted, it manufactures an index.html-only source bundle.

`packages/db/src/workspace-artifacts.ts` persists versions/current pointers and
events atomically, fences attempts and requested tools, and uses operation
keys for replay. It additionally compares content/source/request hashes.
Blob writes currently occur inside the publishing database transaction.
Ambiguous commit reconciliation deliberately avoids deleting possibly committed
content; that behavior must survive the refactor.

`workspace_artifact_versions` stores object keys, sizes, mandatory content SHA,
optional source SHA, requested tools and provenance. `workspace_artifact_events`
stores an optional request digest. SQL constraints and SDK response types are
part of the hash dependency. Changing only TypeScript preparation is insufficient.

The content endpoint and `artifacts_get_source` both read HTML AND source,
recompute hashes, validate sizes and return full content. The web route loads
that response alongside metadata, holds it in React state and uses iframe
srcDoc. Even the displayed source-file count requires loading source.

Storage already has signed PUT/GET, object metadata, version-pinned ranges and
streaming create-only writes across S3-compatible, GCS and Azure backends.
Its current immutable bounded adapter is explicitly SHA-addressed: do not use
it unchanged for this SHA-free Site path. The ordinary streaming write contract
also currently requires a sha256 field; make that metadata optional without
weakening callers that explicitly require content-addressed verification.

## Agent-facing contract

One new tool, illustratively `artifacts_prepare_upload`, takes no file metadata.
Workspace and actor come from the authenticated tool context. It returns:

```ts
{
  uploadId,
  html: { putUrl, requiredHeaders },
  source: { putUrl, requiredHeaders },
  expiresAt
}
```

No title or expected version is necessary to issue upload destinations. No
separate completion tool: publishing finalizes the pair. A lost prepare result
may leave an unused upload, which expires; it cannot create a duplicate Site.

The agent builds HTML and writes the existing source JSON format to disk,
PUTs both files, then calls `artifacts_create` with uploadId, title, description,
requestedTools and idempotencyKey. Updating uses `artifacts_publish` with the
same fields plus artifactId and expectedCurrentVersionId. File bytes never
travel through either tool's arguments. A new upload means new content;
reusing an upload means retrying the same content, not editing it in place.

Source is required on the new upload path. Preserve old HTML-only versions;
do not pretend their original React source can be recovered. Source includes
lockfile and build config, excludes node_modules/cache/credentials. Keep the
existing JSON layout: no ZIP extraction system or per-source-file upload API.

## Server-side publication

1. Issue a workspace/actor-scoped upload row with expiry and unique private
   staging destinations for HTML/source. Do not store signed URLs in version
   metadata. The same row records final blob destinations and publication result.
2. On publish, check existing operation replay first. A completed same-target
   operation returns the original result even if the upload has since expired.
3. Authorize the current caller and upload, verify both objects exist, then
   freeze both under server-only UUID-based destinations. Use provider-pinned
   copy where supported, or bounded streaming copy with create-only writes.
   A still-valid staging PUT URL must never address a published blob.
4. Validate the frozen objects, not a mutable staging read: valid UTF-8 HTML,
   valid source JSON, unique traversal-free source paths and an existing
   entrypoint. Record actual sizes and source-file count. No hash comparison.
5. Outside the final DB transaction perform copying/validation. Inside one
   short transaction, recheck live authority, upload status/expiry, requested
   tools and expected current version; link both blobs, write the version/event,
   advance current pointer, and record the consumed upload/result.
6. A racing publication or lost response returns the existing result for the
   same operation. A different target/operation kind conflicts. Do not hash or
   compare megabytes to decide replay. Document first successful request wins
   for metadata; callers need a new key for changed publication intent.

The upload row must retain enough state to recover freezing and clean abandoned
objects. Do not add a second publication workflow engine. Expiry cleanup must
be fenced against final publication, and must never delete a linked version.
Unknown DB commit outcomes are reconciled before deleting any final candidate.
Partial freeze failures may be retried against the same fixed destinations.

## Runtime and source delivery

- Metadata response contains version id, runtime locator, requested tools,
  sizes and source-file count. Ordinary Site viewing must not read source.
- Add a runtime HTML route; change ArtifactSandbox/PublishedHtmlArtifactFrame
  from HTML strings to a runtime URL. The response streams bytes and supplies
  the small bridge bootstrap; published source remains unmodified in storage.
- An iframe cannot add arbitrary API-key headers. The authenticated parent
  obtains a short-lived version-bound runtime ticket when cookies alone are
  insufficient. Do not expose account credentials or put the URL in source.
  Runtime URLs are delivery capabilities only, not tool/SDK authority.
- Preserve document-bound MessagePort ownership, opaque iframe origin,
  cancellation on reload/navigation/stop and full-screen behavior. The runtime
  response itself must remain sandboxed if opened outside its iframe too.
  Simply redirecting to raw HTML on the application origin is not equivalent.
- Stream/compress at the HTTP/storage boundary. Preserve correct content type,
  cache headers and encoding; never compress into a custom JavaScript loader.
- Change source retrieval to metadata plus a source download reference. The
  agent downloads it to the sandbox and restores files there. Keep source
  retrieval separate from runtime retrieval. Existing source-less versions
  can offer their HTML as the limited historical editable source.
- Existing-version source counts can initially be unknown; omit the badge or
  backfill separately. Never load every old bundle just to render the badge.

## Limits and large-file behavior

Separate inline transport limits from stored-version metadata and upload
admission. Leave generic Codemode argument/result caps unchanged.

Use configured storage quota/provider upload limits for the blob path, rather
than a hidden 4 MiB Site rule. The current provider single-PUT abstraction is
5,000,000,000 bytes; this is a transport maximum, not a promise that a 5 GB
browser app is practical. Surface actual deployment limits and useful errors.
Slow/large bundles can warrant a warning, not an invented compatibility failure.

Current DB size columns are signed integers. Widen them if accepting the full
storage maximum; ensure public numeric sizes remain safe integers. Remove size
admission ceilings from historical-version decoders. Reassess the source
128-file restriction separately; do not silently retain it as the next blocker.

Do not replace hashing with whole-object memory buffering. HTML can stream;
source JSON validation needs an explicit bounded-memory parsing approach if
large source bundles are admitted. Measure concurrent publish/view memory.

## Migration and compatibility

1. Add upload lifecycle persistence, nullable legacy hash fields, source counts
   and appropriate size types. Adjust SQL hash constraints; no fabricated hashes.
2. Readers accept old and new versions without rehashing. Historical blob keys
   remain valid; never rename/copy all existing blobs merely to remove SHA names.
3. Add reference publishing to REST/tools/SDK and update the bundled skill.
   Keep inline requests temporarily for old callers, routed into the same
   publication service. Do not maintain two separate publication engines.
4. Ship URL runtime/source delivery and switch the web route. Retire combined
   content and inline authoring from the normal path. Remove compatibility
   APIs only in a deliberate API/SDK cutover, not accidentally during rollout.
5. Stop writing/exposing Site hashes; drop unused legacy columns after old
   writers are drained. Existing history need not be rewritten. Respect the
   repository's coordinated API/worker migration and contract rollout rules.

## Existing local SDK work

There are uncommitted changes exposing site.client/site.workspaceId, a
MessagePort streaming fetch adapter, a sandbox /codemode/sdk route, web host
forwarding and an embed example. Focused transport tests passed earlier;
end-to-end published and sandbox conversations have NOT been proven.

Finish/review that work separately from storage publication. In particular:
close pending streams when the client/document closes; check error/cancellation
paths; verify provider config/workspace streams; verify attempt authorization
without inventing broader agent permissions. The example temporarily excludes
the optional diff highlighter to fit the old limit. Large-Site acceptance must
also test the original approximately 12.9 MB bundle without that workaround.

## Implementation slices and acceptance tests

1. Schema + shared publication/upload service; REST and tools use it.
2. Streaming storage adaptation + expired/unreferenced upload cleanup.
3. Public tool/SDK contracts + precise source-upload/download skill examples.
4. Metadata/runtime/source endpoint split + React iframe URL integration.
5. Finish session SDK bridge, then exercise the complete author/edit/run loop.

Required evidence:

- Original 12.9 MB React bundle and a substantially larger synthetic HTML Site
  upload, publish and render; tool arguments remain small.
- Source with more than 128 files can round-trip if that old cap is removed;
  restored source builds to a functioning Site.
- Missing/partial uploads never publish; wrong scope is rejected; expired
  staging URLs can be replaced by preparing another upload.
- Overwriting/deleting staging after publication cannot change the version.
- Lost publish response, concurrent retries and concurrent editors produce no
  duplicate version or clobbered update. Cleanup preserves uncertain commits.
- Old versions remain viewable/editable/rollbackable with hashes ignored.
- Viewing fetches no source and does not pass large HTML through JSON/srcDoc.
- Runtime bootstrap works on reload, late SDK initialization and full-screen;
  navigation/Stop cancels streams; archived Sites cannot acquire new execution.
- Published conversation uses viewer auth; sandbox preview uses existing agent
  Codemode authority. Exercise real Send, streamed response, draft, queue and
  reconnect, not only HTTP 200 or compilation.
- Object-store integration tests cover configured S3-compatible/GCS/Azure
  semantics; storage hash requirements for non-Site artifacts still pass.

No implementation of this publication refactor has been performed by writing
this plan. Do not report the local demo as verified until the live tests pass.
