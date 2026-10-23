# Recordings

A recording is a captured conversation, such as a meeting, an interview or a
site walk. It has one or more audio tracks, immutable transcript versions,
editable speakers and a people directory. The Opengeni app shows recordings
as Meetings; products can present them however they like.

Recording is bot-free: the person's own device captures the audio. Nothing
joins a call.

## Visibility

A recording is either `private` (Only me) or `workspace` (everyone in the
workspace), with the same rules as private and shared chats. New recordings
are `private` unless the workspace sets `settings.recordings.defaultVisibility`,
and a product may always pass `visibility` explicitly. Anyone who can see a
recording may rename it, edit speakers and text, re-run its transcript and
switch the shown version. Only the person who recorded it may upload, finish,
share, unshare or delete it.

## Capture contract

Clients record locally first, so a dropped connection, a reload or a crash
never loses audio.

1. `POST /v1/workspaces/:workspaceId/recordings` with a client-generated
   `recordingId` and its tracks. Repeating the call returns the same recording.
   Track sources are `microphone`, `system` (computer audio), `mixed` and
   `upload`. Audio is Opus in WebM (about 32 kbps per track) or AAC in MP4.
2. While recording, cut each track into chunks (a `MediaRecorder` timeslice
   of a few seconds works well) and keep them on the device until uploaded.
   For each batch of up to 50 chunks, `POST …/recordings/:recordingId/uploads`
   with each chunk's number, size, SHA-256, start time and duration. The
   answer gives a presigned `PUT` URL and headers per chunk, or
   `uploaded: true` when the server already has it.
3. `PUT` each chunk's bytes straight to storage, then
   `POST …/recordings/:recordingId/chunks/complete`. The server checks each
   object and answers which chunks are uploaded and which are still missing.
4. When capture ends, `POST …/recordings/:recordingId/finalize` with every
   track's chunk count. Finishing again is harmless.

Chunk start times are milliseconds from the recording's start. A new capture
session on the same track (after a reload, say) simply continues the chunk
numbering; the worker places each session at its own start time.

## Embedding

Products do not need to implement the capture contract by hand.

`@opengeni/sdk/recordings` is the headless layer for any JavaScript host:

- `OpenGeniRecordingsClient` wraps every recordings route:
  `new OpenGeniRecordingsClient(client).listRecordings(workspaceId)`.
- `RecordingUploader` stores each chunk in a local `RecordingChunkStore`
  before anything else, uploads it straight to storage, confirms it, and
  finalizes once capture stops. It retries through network loss with backoff,
  re-reserves expired or refused URLs, and `resume()` finishes recordings an
  earlier page or app run left behind. A cross-tab Web Lock keeps it from
  finishing a recording another tab is still capturing.
- `createIndexedDbRecordingChunkStore()` is the browser store (it asks the
  browser to persist it); `createMemoryRecordingChunkStore()` is for tests.
  Other hosts implement the small `RecordingChunkStore` interface over their
  own storage, for example a React Native file system.
- `createBrowserRecorder()` captures the microphone and, where the browser
  can share it (Chromium on desktop), a tab's or the system's audio, each as
  its own track, with `MediaRecorder` chunks every 5 seconds, input levels for
  a meter, pause and resume, a screen wake lock on phones and an extra flush
  when the page is hidden.

`@opengeni/react/recordings` builds on it with hooks: `useRecorder` (capture
plus background upload; recovers leftovers on mount), `useRecordings` (list
with paging; polls while any is processing), `useRecording` (one recording
and its versions, with rename, share, re-run, switch version and delete),
`useTranscript` (every segment of a version, with speaker naming, moving a
segment to another speaker and text edits), `useRecordingPeople` and
`useRecordingModels`. The hooks use the provider's SDK client, or an explicit
`recordings` client such as a host proxy that implements only the methods the
mounted hooks call.

## Processing

All processing runs in the background worker. It joins each track's chunks
into one seekable file (kept for playback and re-runs), transcribes each
track and stores transcript version 1.

On a desktop recording, the microphone track is the person recording and the
system track is everyone else, so only the system track needs diarization.
When the chosen model can tell speakers apart, its diarization is used.

Transcription uses the workspace's own provider key, or its organization's.
ElevenLabs Scribe v2 is the first provider. `GET …/recording-models` lists the
models, their capabilities and whether each is available here; a workspace
can set its default in `settings.recordings.transcription`.

## Transcripts, speakers and edits

- `GET …/recordings/:recordingId/transcript?version=&after=` reads segments a
  page at a time, with the version's speakers.
- `POST …/recordings/:recordingId/transcripts` makes a new version over the
  same audio, for example with another model. Versions never change; when a
  new one completes it becomes the shown version, and names carry over to the
  speakers whose speech overlaps.
- `POST …/recordings/:recordingId/transcripts/:versionId/current` switches the
  shown version.
- `PATCH …/recordings/:recordingId/speakers` names speakers (a person from the
  directory, or a plain name) and moves segments between speakers. Giving two
  labels the same person merges them.
- `PATCH …/recordings/:recordingId/segments` corrects segment text; `null`
  restores the original.
- `GET …/recordings/:recordingId/tracks/:trackNumber/audio` returns a
  short-lived link to a track's audio.
- `GET` and `POST /v1/workspaces/:workspaceId/recording-people` read and add
  people in the directory.

## Events

Recording events go out through the existing signed
[workspace and organization webhooks](workspace-integrations.md#webhooks):
`recording.started`, `recording.finished`, `recording.transcript.ready`,
`recording.transcript.failed`, `recording.transcript.current_changed`,
`recording.speakers.updated` and `recording.deleted`. The payload carries ids
and states (plus the product's own `externalRef`), never a title, audio or
transcript text:

```json
{ "id": "…", "type": "recording.transcript.ready", "lane": "workspace", "workspaceId": "…",
  "workspace": { "id": "…", "externalSource": "product:production", "externalId": "tenant-42" },
  "occurredAt": "2026-10-24T09:12:03.120Z",
  "data": { "recordingId": "…", "ownerSubjectId": "…", "visibility": "private",
    "externalRef": "project:42", "state": "ready", "versionId": "…", "previousVersionId": null } }
```

Read the recording through the API for its details.

## Deletion

`DELETE …/recordings/:recordingId` hides the recording at once; the worker
then removes its audio, transcripts and speaker matches.
