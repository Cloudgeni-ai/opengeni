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

`@opengeni/react/meetings` is the ready-made UI on those hooks, the same one
the console uses:

- `MeetingRecorderProvider`: mount it once above the routes, so a recording
  keeps going while the person moves around. In the desktop app it also
  carries out the call notifications ("Record this meeting?"); pass
  `onOpenMeetings` and `onOpenMeeting` to say where those open.
- `MeetingsListPage`: the recorder plus the searchable list. Pass
  `externalRef` to show only the meetings that belong to something of yours,
  such as a project, and to give new recordings started there the same id;
  `notice` for a line shown before every start, such as a reminder to tell
  the people present; `liveTranscript={false}` to not offer the live preview
  even when a live model is connected; `recordingOff` to show why this person
  can't record here instead of the recorder, such as a setting an
  administrator has to turn on, while the meetings stay listed; and
  `header={false}` when the list sits inside a page of your own.
- `MeetingDetailPage`: one meeting, with its player, transcript, speaker
  naming, versions and sharing. `details` adds your own lines beside the
  transcript, such as the project it belongs to.
- `MeetingDefaultsView`: the workspace's meeting settings over plain values
  and an `onSave`.
- The smaller pieces they are built from: `RecorderPanel`,
  `MeetingTranscript`, `MeetingPlayer` and `LiveTranscript`.

The pages navigate through callbacks (`onOpen`, `meetingHref`, `onBack`), so
any router works. `@opengeni/react/testing/meetings` has an in-memory
recordings client with meetings in every state, for previews and tests.

## Live transcript preview

While a meeting is recorded, each track can also be streamed to a live speech
model, so the person recording (and anyone watching the meeting from another
device) can read along. It is a preview: it has no speakers told apart beyond
the tracks, and the recording's transcript replaces it when it is ready. The
recording itself never depends on it; if the preview can't start or drops,
capture and upload carry on unchanged.

`settings.recordings.liveTranscript: true` turns it on by default for the
workspace's recorders; the person recording can still turn it off. It needs a
model with the `live` capability (`GET …/recording-models` lists them; today
ElevenLabs Scribe v2 Realtime at $0.39 an hour of streamed audio, billed by
the provider on top of the transcript itself).

The audio goes straight from the device to the provider, never through
Opengeni, and the workspace's provider key never reaches the device:

1. `POST …/recordings/:id/live-session` with `{ trackNumber }` returns a
   short-lived grant for one track: a `url` holding a single-use token, the
   `protocol` (`elevenlabs.scribe_realtime`), the audio format to send
   (16-bit mono PCM at `audio.sampleRate`) and `expiresAt`. Only the person
   recording can ask, and only while the recording is `capturing`. It answers
   409 `credential_unavailable` when the workspace has no key for the model.
2. The device opens the WebSocket and sends audio in tenths of a second. A
   dropped connection asks for a new grant; up to 15 seconds of audio is held
   meanwhile and sent once it is back.
3. Finished stretches of text are saved with `POST …/live-segments`
   (`{ trackNumber, streamedMilliseconds, segments }`, at most 100 per call).
   A segment number sent again keeps its first copy, and the streamed time
   (only ever raised) prices the track's `live.costUsd`.
4. Other viewers read them with `GET …/live-segments?after=<sequence>`, which
   returns the new segments, the `after` to pass next time, and `ended` once
   the transcript is ready. The saved live text is deleted then.

`createBrowserRecorder({ liveTranscript: true })` and
`useRecorder({ liveTranscript: true })` do all of this and expose the text as
it arrives in `snapshot.live`: per track, its `state` (`connecting`, `live`,
`reconnecting`, `unavailable` or `closed`), the finished `segments` and the
`partial` words still being heard. `createLiveTranscriber` is the same engine
for any other capture source: push 16-bit PCM to it. `useLiveTranscript`
follows a recording from another device.

## Processing

All processing runs in the background worker. It joins each track's chunks
into one seekable file (kept for playback and re-runs), transcribes each
track and stores transcript version 1.

On a desktop recording, the microphone track is the person recording and the
system track is everyone else, so only the system track needs diarization.
When the chosen model can tell speakers apart, its diarization is used.
Otherwise, or when the request or `settings.recordings.diarizer` says
`ours`, Opengeni tells the speakers apart itself, on the worker's CPU.

### Opengeni's speaker diarization

`apps/worker/speakers` is a small Rust executable, `opengeni-speakers`, that
runs two open ONNX models through ONNX Runtime: pyannote segmentation 3.0
(MIT) finds who speaks when inside 10 second windows, and 3D-Speaker CAM++
trained on VoxCeleb (Apache-2.0) turns each window's speakers into voice
vectors. Vectors are clustered with average linkage at a cosine distance of
0.55, small clusters are folded into the nearest large one, and every frame
takes the speakers its window found. The worker image ships the executable
in `/opt/opengeni/speakers` with both models and their licenses, pinned by
checksum. Elsewhere, set `OPENGENI_RECORDING_SPEAKERS_BINARY_PATH` and
`OPENGENI_RECORDING_SPEAKER_MODELS_DIR`; without them only the model's own
diarization is available.

It runs alongside transcription and only replaces the speakers on the words.
If it fails, the transcript keeps the model's speakers and the worker logs a
warning. The transcript version records `diarization: "ours"` when it was
used.

Measured on seven AMI meetings (headset mix, 2.5 hours, scored with no
collar and overlapping speech included), the diarization error rate is
about 18 percent, which is in the same range as pyannote 3.1. It uses about
3 CPU minutes per hour of audio, so an hour of meeting takes about 30
seconds on 8 cores.

`opengeni-speakers diarize` reads 16 kHz mono f32 audio on stdin or from
`--input` and prints `{turns, speakers}` JSON, each speaker with its total
speech and averaged voice vector. `opengeni-speakers embed --segments FILE`
prints the averaged voice vector of each labelled set of segments.
`cargo run --release --example der -- REF.rttm REF.uem HYP.json` scores
output against a reference.

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

## Recognizing people by voice

Off by default. A workspace admin turns it on with
`settings.recordings.voiceprints: true`. While it is on, the worker runs
Opengeni's own diarizer (when it is installed) for every transcript, whatever
the model, and keeps
each speaker's averaged voice vector with the transcript version. Only
numbers are stored, never extra audio, and the API never returns them.

A person's voice is remembered only after they agree:

- `PUT /v1/workspaces/:workspaceId/recording-people/:personId/voice` with
  `{"consent": "self"}` is a member agreeing for themselves. Members can only
  agree for themselves.
- `{"consent": "attested"}` is someone confirming that a person from outside
  the workspace agreed. The person's `voice` records which kind of agreement
  it was, and when. Agreeing answers 409 `voice_recognition_off` while the setting
  is off.
- `DELETE` on the same path forgets the voice and withdraws the agreement.
  Only a member can forget their own voice; anyone in the workspace can
  forget someone from outside it. Names the voice suggested are removed too.
- Turning the setting off forgets every voice in the workspace.

Agreeing doesn't record anything by itself. A person's voiceprint is learned
from the speakers named as them, in meetings transcribed while the setting
was on, both before and after they agreed. It is the speech-weighted mean of
those speakers' vectors, with each meeting
counting for at most two minutes and speakers with under four seconds of
speech skipped. Renaming a speaker to someone else takes its voice back out.
Voiceprints are kept apart by kind of audio (microphone, call audio from the
computer, and room or uploaded audio) and by speaker model, because vectors
from different models don't compare.

When a transcript finishes, each unnamed speaker is compared with the
remembered voices. A cosine similarity of 0.6 or more names the closest
person, at most once per person, as a `suggested` speaker with the
similarity as `confidence`. People confirm a suggestion by naming the speaker
as that person. `PATCH …/speakers` with `rejectSuggestions: [{label}]` turns
one down, and that person isn't suggested again for a similar voice in that
recording. Measured on AMI meetings, with four people enrolled from one
meeting and matched in three later ones against 23 other voices, all 12
speakers were found. The same person scored 0.85 to 0.97, and nobody else
scored above 0.46.

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
