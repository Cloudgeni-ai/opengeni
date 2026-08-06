# Composer voice input

Native voice input turns browser-captured audio into editable composer text. It is
not a turn-model feature, does not authorize a coding model, and never sends a
message by itself.

## Product contract

- The ordinary composer presents **one microphone control** and **one editable
  draft**. Recording chrome exposes separate **Cancel** and **Stop** actions;
  provider, model, credential, and region choices remain server-private.
- The browser writes five-second `MediaRecorder` chunks and SHA-256 integrity
  metadata to IndexedDB before reporting the audio locally saved. Stop waits for
  pending writes, finalizes automatically, and appends the resulting text to the
  draft. Ordinary Send remains a separate user action.
- New servers and SDK clients use the resumable server path advertised by
  `ClientConfig.voiceInput.resumable`. Older clients or deployments without that
  capability retain the existing one-shot multipart path and its 25 MiB / 600
  second client maximum.
- The resumable default is two hours, 512 MiB total, 8 MiB per browser chunk, and
  24-hour server retention. Contract hard limits permit at most eight hours,
  512 MiB, and 1,000 normalized provider segments.
- Interrupted upload, segmentation, or transcription reuses the same recording
  UUID. Duplicate chunks are accepted only when sequence, size, SHA-256, and
  timing metadata match exactly; conflicting retries fail closed. Retryable API,
  database, storage, and provider failures stay in a bounded automatic recovery
  loop, including after reload, until the user explicitly pauses or discards.
- Provider selection occurs once for the whole server recording before its first
  segment is sent. The private provider id is persisted and every later segment
  or retry remains pinned to it; a possibly-started recording never falls through
  to another vendor.
- Provider results are persisted server-side so another browser carrying the same
  exact authenticated subject can list and resume an unexpired recording. The
  local browser still persists the final transcript before mutating the draft.
  A retry or reload may finish transcription automatically, but its delayed result
  is held as an explicit saved-transcript insertion so it cannot mutate a draft
  whose identity is uncertain.
- Controlled error codes and retryability cross the API. Raw provider detail,
  object keys, credentials, provider ids, audio bytes, and transcript bodies are
  excluded from logs and client capability configuration.

## Trust boundary and data flow

```text
Browser MediaRecorder (5s chunks)
  -> IndexedDB manifest + Blob chunks + timing + SHA-256
  -> POST /v1/workspaces/:workspaceId/transcription-recordings
  -> ordered PUT .../:recordingId/chunks/:chunkNumber
  -> object storage (tenant-derived opaque keys)
  -> POST .../:recordingId/finalize
  -> API ffmpeg: mono 16 kHz PCM WAV segments (bounded to <= 1,000)
  -> POST .../:recordingId/process-next
  -> one recording-wide pinned provider
  -> Postgres segment results + deterministic transcript assembly
  -> { transcriptText, languages } persisted locally before draft mutation
  -> editable composer draft
  -> ordinary user Send
```

Legacy fallback when `voiceInput.resumable` is absent:

```text
IndexedDB chunks
  -> one Blob
  -> OpenGeniClient.transcribeAudio
  -> POST /v1/workspaces/:workspaceId/transcriptions
  -> one server-selected provider
  -> { text, languages }
```

Every resumable route first resolves the normal `sessions:create` access grant.
Persistence binds the immutable recording id to the exact
`(accountId, workspaceId, subjectId)` authority tuple. All four recording tables
use FORCE RLS for both workspace/account visibility and exact subject equality.
The collection route returns at most 50 unexpired, non-discarded recordings for
that subject; possession of a recording UUID alone is not authority.

## Client capability

`GET /v1/config/client` projects only public limits:

```ts
voiceInput: {
  available: boolean;
  maxDurationSeconds: number;
  maxSizeBytes: number;
  acceptedMimeTypes: string[];
  resumable?: {
    maxDurationSeconds: number;
    maxSizeBytes: number;
    maxChunkSizeBytes: number;
    providerSegmentSeconds: number;
  };
}
```

The optional `resumable` member appears only when object storage, ffmpeg, and at
least one transcription provider are ready. Workspace settings store only
`{ voiceInput: { enabled: boolean } }`. Legacy
`settings.transcription.enabled` maps forward for one compatibility release;
new writes use `voiceInput`.

## Server lifecycle

| State | Meaning |
| --- | --- |
| `uploading` | Manifest exists; the next contiguous chunk number is authoritative. |
| `segmenting` | One generation/owner lease is validating chunks and preparing normalized WAV segments. |
| `ready` | At least one provider segment is pending and no segment call is active. |
| `transcribing` | One attempt lease owns the next segment. |
| `complete` | Every segment completed and transcript/languages were assembled in segment order. |
| `failed` | A typed retryable or terminal assembly/provider failure is persisted. |
| `discarded` | The user discarded the recording or retention expired. |

Finalization verifies the client totals against durable upload truth, reads every
chunk from object storage, and checks exact byte length and SHA-256 before ffmpeg
sees it. Segmentation produces mono 16 kHz PCM WAV output. The segment duration
is the lower of the OpenGeni 50-second target and the selected service's maximum;
recordings that would require more than 1,000 segments fail before ffmpeg starts.
Generation and pre-provider attempt leases become reclaimable after 15 minutes.
Immediately before a provider call, the server refreshes the durable attempt
lease origin and persists an absolute 10-minute server-owned provider deadline.
After that refresh transaction returns, the service computes the remaining time
against the persisted deadline and arms its AbortController for only that
remaining duration; if the deadline has already passed, it refuses to invoke
the provider. Reclaim is therefore impossible until at least five minutes after
that provider deadline, even when object reads, handler setup, or refresh/commit
latency consumed most of the original lease.
Request/network aborts do not cancel this server-owned provider work: the same
recording UUID remains retryable and its objects remain retained. Only explicit
Discard is destructive. Stale callbacks cannot settle a successor generation or
attempt.

Each `process-next` request claims at most one segment. The first claim persists
the recording-wide provider pin. Retryable `network`, `timeout`, `unavailable`,
and `provider` failures retain the same segment, pin, object, and recording UUID.
Successful segment text is stored separately; final assembly sorts by segment
number, trims empty text, joins nonempty segments with a blank line, and preserves
the first occurrence of each nonempty language.

## Retention and cleanup

- Chunk and normalized segment objects are registered in a durable object ledger
  before upload. Object keys include account/workspace/recording lineage and a
  sequence/hash component, but keys never appear in client responses.
- Completion, explicit discard, and non-retryable failure make every remaining
  object immediately cleanup-eligible. The request path attempts deletion and
  settles each object independently; a partial provider outage never marks an
  undeleted object cleaned.
- Abandoned recordings become cleanup-eligible at
  `OPENGENI_VOICE_INPUT_RESUMABLE_RETENTION_SECONDS` (24 hours by default).
  The existing Temporal file-upload reaper claims recording rows before object
  rows with `SKIP LOCKED`, uses reclaimable claim ids/timeouts, deletes one object
  at a time, and settles only successful provider deletes.
- After retention plus the reaper grace window, a bounded security-definer purge
  removes an expired recording only when no uncleaned object remains. That purge
  deletes chunk/segment metadata, the private provider pin, and persisted
  transcript/language results. A metadata purge can never hide an object that
  still requires provider cleanup.
- Server transcript state is only the resumable recovery/result record. It is not
  appended to session history, documents, knowledge, memory, or an agent turn;
  only the user's later ordinary Send can create message truth.

## Provider paths

| Provider | When selected | Notes |
| --- | --- | --- |
| `codex-subscription` | Subscription routing is enabled and the workspace has an active attached Codex credential. | Undocumented ChatGPT `/backend-api/transcribe`; preferred by default when attached. |
| `openai` | A usable ordinary or voice-specific OpenAI key is configured. | `POST /v1/audio/transcriptions`, default model `gpt-transcribe`. |
| `azure-openai` | Azure endpoint, deployment, and key or AD token are configured. | Deployment-scoped `/openai/deployments/{deployment}/audio/transcriptions`. |

Selection uses `OPENGENI_VOICE_INPUT_PROVIDER_ORDER` (default
`codex-subscription,openai,azure-openai`). Template placeholder values are
ignored. The first ready provider wins before any segment is sent, is persisted
on the recording, and remains authoritative until that recording is complete or
discarded.

## Operator configuration

See `.env.example` for:

- one-shot limits:
  `OPENGENI_VOICE_INPUT_MAX_DURATION_SECONDS`,
  `OPENGENI_VOICE_INPUT_MAX_SIZE_BYTES`;
- resumable enablement, duration/size/chunk limits, and retention:
  `OPENGENI_VOICE_INPUT_RESUMABLE_*`;
- `OPENGENI_VOICE_INPUT_FFMPEG_PATH` (the API image installs ffmpeg; custom
  deployments must provide a compatible executable);
- `OPENGENI_VOICE_INPUT_PROVIDER_ORDER` and provider-specific OpenAI/Azure
  overrides;
- object-storage backend, bucket/container, and server-side credentials.

The resumable capability is hidden rather than degraded to memory-only behavior
when object storage or ffmpeg is unavailable. The one-shot endpoint may remain
available independently when a provider is ready.

## Browser lifecycle requirements

1. Create the local manifest before microphone capture and negotiate MIME type in
   order: `webm/opus`, `mp4`, then `ogg/opus`.
2. Persist every chunk, sequence, timing range, size, codec, and SHA-256 before
   reporting it saved. Storage failure stops capture and fails closed.
3. Use resumable limits only when both the server capability and all resumable SDK
   methods exist; otherwise enforce the legacy one-shot limit.
4. On resumable retry, recreate/reconcile the same server recording, skip only
   already accepted contiguous chunks, finalize with exact durable totals, and
   poll/claim until complete or a typed failure is persisted.
5. Keep a reload-stable owner id behind a document Web Lock or BroadcastChannel
   handshake plus stale heartbeat. Another live tab cannot retry or discard local
   work, but any browser with the same authenticated server subject can discover
   and resume the server manifest through the SDK list/get methods.
6. Persist a successful transcript locally before draft mutation. Persist whether
   recovery is automatic or user-paused and whether handoff may append or requires
   explicit insertion. Any retry/reload forces explicit handoff: recovery may
   continue automatically, but an uncertain result never auto-appends.
7. Fence every permission, recorder-stop, persistence, upload, polling, handoff,
   and cleanup callback by workspace/generation/owner identity. Escape, unmount,
   or workspace replacement cannot restore or settle stale work.
8. Empty or whitespace-only transcripts do not change the draft. Workspace policy
   disablement and missing deployment readiness hide or block the mic without
   exposing provider controls.
9. Retry only idempotent chunk-reservation/completion database transactions on
   PostgreSQL serialization/deadlock failures. Exhausted persistence failures and
   retryable storage failures cross the ordinary typed API error envelope with a
   correlation id; unexpected failures propagate to HTTP failure observability
   rather than being converted into anonymous successful-route 500 responses.

## Canonical implementation

| Concern | Canonical source |
| --- | --- |
| Public contracts and limits | `packages/contracts/src/transcription-recordings.ts`, `packages/contracts/src/index.ts` |
| Runtime configuration | `packages/config/src/index.ts`, `.env.example` |
| Service and segmenter ports | `packages/core/src/transcription.ts` |
| FORCE-RLS schema, leases, provider pin, cleanup ledger, purge | `packages/db/drizzle/0170_resumable_transcription_recordings.sql`, `packages/db/src/transcription-recordings.ts` |
| API routes and ffmpeg adapter | `apps/api/src/routes/transcription-recordings.ts`, `apps/api/src/transcription/segmenter.ts` |
| SDK one-shot and resumable methods | `packages/sdk/src/client.ts`, `packages/sdk/src/types.ts` |
| React capture/recovery/handoff | `packages/react/src/hooks/use-voice-input.ts`, `packages/react/src/voice-recording-owner.ts`, `packages/react/src/voice-recording-store.ts` |
| Global provider-object reaper | `apps/worker/src/activities/file-upload-reaper.ts` |
| Product controls | `packages/react/src/components/composer-transcription-control.tsx`, `apps/web/src/components/transcription-settings.tsx` |

Deprecated host-adapter types remain exported from
`packages/sdk/src/transcription.ts` for one compatibility release.
