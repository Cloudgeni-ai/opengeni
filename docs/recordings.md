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

## Language

A meeting is transcribed in `transcription.language` when the create request
names one, else in the workspace's `settings.recordings.language`; `null`
asks the model to detect it even when the workspace names one. Leave the
language out to use the workspace's. `GET …/recording-models` returns the
workspace's as `language` (null detects), and the React recorder starts on it
unless the host passes `defaultLanguage`. Naming the language matters for
close languages: without it, Norwegian can come back as Danish or Swedish.

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
  `onOpenMeetings` and `onOpenMeeting` to say where those open. A host
  without an `OpenGeniProvider` above its routes passes its SDK `client`,
  and `workspaceId={null}` until it knows the workspace.
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
  transcript, such as the project it belongs to. While this device records
  the meeting (Take notes opens it), the page shows the recording's clock with
  Pause and Stop; after Stop it reads Transcribing. Audio uploads while it
  records, so neither page says Uploading: a meeting still being recorded
  elsewhere reads In progress, and only a lost connection or a refused upload
  is called out. `meetingHereStatus` in `@opengeni/react/recordings` is that
  rule for a host's own pages.
- `MeetingDefaultsView`: the workspace's meeting settings over plain values
  and an `onSave`.
- The smaller pieces they are built from: `RecorderPanel`,
  `MeetingTranscript`, `MeetingPlayer` and `LiveTranscript`.

The pages navigate through callbacks (`onOpen`, `meetingHref`, `onBack`), so
any router works. `@opengeni/react/testing/meetings` has an in-memory
recordings client with meetings in every state, for previews and tests.

On a phone, `@opengeni/react-native/meetings` has the same pieces for React
Native screens:

- `MeetingRecorderProvider`: mount it once above the screens. It keeps one
  recorder going while the person moves around the app and, with the native
  module, while the phone is locked or another app is in front. Audio is
  written to the phone as it is captured and uploaded in the background. Pass
  a `storeScope` per signed-in account, so unsent audio is only ever uploaded
  with that account's credential. A host without an `OpenGeniProvider` above
  its screens passes its SDK `client`, and `workspaceId={null}` until it
  knows the workspace.
- `MeetingsList`: the recorder plus the list. `useMeetingView`: one
  meeting's transcript, player and actions, for a screen of your own.

The SDK client uses the web platform's `crypto` (request ids and upload
checksums), which Hermes doesn't have. Mount the recorder inside
`OpenGeniReactNativeProvider`, or call `installOpenGeniReactNativeEnvironment`
yourself for as long as it is mounted. Otherwise listing and uploading fail
with "Property 'crypto' doesn't exist".

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

It runs on 4 threads unless the worker sets `threads` (fewer on a smaller
machine). More threads finish little sooner but cost much more: a
half-hour meeting takes 47 s and 128 CPU-seconds on 4 threads, and 21 s and
304 CPU-seconds on all 32 threads of a 16-core desktop CPU. Transcription
runs at the same time and takes about as long, so the extra speed rarely
shows.

Memory stays small and nearly flat with length: about 300 MB for a
half-hour meeting on one thread, plus about 70 MB for each further thread,
and about 900 MB for a two-hour meeting on four threads. Each thread embeds
one piece of speech at a time instead of holding every window's speech at
once.

`opengeni-speakers diarize` reads 16 kHz mono f32 audio on stdin or from
`--input` and prints `{turns, speakers}` JSON, each speaker with its total
speech and averaged voice vector. `opengeni-speakers embed --segments FILE`
prints the averaged voice vector of each labelled set of segments.
`cargo run --release --example der -- REF.rttm REF.uem HYP.json` scores
output against a reference.

### One speech-to-text system

Meetings and dictation share one set of speech-to-text providers. Each model
says what it can do (word timings, speakers, live, languages, audio formats)
and who pays for it, its `funding`:

- `workspace_key`: the workspace's own provider key, or its organization's
  (ElevenLabs Scribe).
- `workspace_subscription`: a subscription the workspace connected (ChatGPT
  dictation through Codex, Grok speech to text through Grok). Never debited.
- `deployment`: an account the deployment runs (Azure Speech, OpenAI, Azure
  OpenAI). Charged as credits when credit billing is on.

A meeting needs every word placed in time, because speakers, playback and
the transcript's turns are built from word timings. Scribe and
MAI-Transcribe-2 time their own words. Models that return only text (the
subscription models, OpenAI and Azure OpenAI) get theirs from Opengeni's
word aligner, below, where the deployment runs it
(`OPENGENI_RECORDING_WORD_ALIGNMENT=true`, which the stock images set);
without it they serve dictation only, `GET …/recording-models` does not
offer them for meetings and a meeting that names one is refused. Any model
can serve dictation; each provider uses one model for it.

### Opengeni's word aligner

A text-only model hears each track whole, or in the largest overlapping
pieces it accepts, so it keeps the conversation's context. `opengeni-speakers
align` then places the returned words on the same audio (forced alignment):
Meta's Omnilingual ASR CTC 300M model (Apache-2.0, about 1,600 languages, as
exported to int8 ONNX by sherpa-onnx, 365 MB) scores every 20 ms of audio
against its characters, and the transcript's words are laid along the most
likely path. Speakers come from Opengeni's diarizer as for any other model.

Long audio is never aligned in one piece. The model's own quick reading of
the audio is matched word for word against the transcript, and runs of
agreeing words become fixed points that cut the recording into short blocks,
each aligned exactly; a block still too long is cut again at looser
agreement. Speech the transcript left out is skipped rather than forced onto
nearby words. The audio streams through window by window, so memory does
not grow with the recording.

The worker image ships the model as `alignment.onnx` and
`alignment-tokens.txt` (with its license) next to the speaker models,
pinned by checksum.

Measured against ElevenLabs Scribe v2's own word timings, on a 16-core
desktop CPU with 8 threads:

| Audio | Words | Starts within 100 ms | Within 200 ms | Median start error |
| --- | --- | --- | --- | --- |
| English meeting, 5 min | 412 | 91.0% | 92.7% | 20 ms |
| Norwegian read speech, 7 min | 649 | 99.4% | 99.8% | 20 ms |
| English meeting, 36 min, much crosstalk | 7,094 | 76.9% | 82.6% | 24 ms |
| English meeting, 1 h 55 min | 19,618 | 89.9% | 93.3% | 20 ms |

Words spoken over another speaker align worst (63% within 100 ms on the
36-minute meeting, against 89% for the rest), mostly where the transcript
leaves the crosstalk out; their low `score` marks them. Alignment takes
about 0.6 CPU-seconds per second of audio (about 70 CPU-minutes for a
two-hour meeting) and about 0.95 GB of memory whatever the length.

`opengeni-speakers align --words FILE` reads a JSON array of words and 16
kHz mono f32 audio on stdin or from `--input`, and prints each word's
`startMs`, `endMs` and `score` (mean log-probability), with how many were
anchored, spread over a stretch it could not align exactly, or untimed
(symbols with no sound).

`OPENGENI_SPEECH_TO_TEXT_PINNED` (`provider/model`, such as
`azure-speech/MAI-Transcribe-2`) makes one model the only one for every use.
Workspaces cannot pick another, dictation does not fall back to another
provider and the live preview is offered only if that provider has one. Use
it when a deployment must guarantee where audio goes. Boot fails if the
pinned model is not configured.

The recording providers:

- **ElevenLabs Scribe v2** ($0.22 an hour) uses the workspace's own
  ElevenLabs key, or its organization's.
- **Azure Speech with MAI-Transcribe-2** ($0.10 an hour at its launch price)
  uses the deployment's own Azure Speech account. Audio is processed in the
  account's region, so a deployment that must keep audio in the EU uses an
  account there (MAI-Transcribe is offered in North Europe). Set
  `OPENGENI_RECORDING_AZURE_SPEECH_ENDPOINT` to the account's origin, such as
  `https://name.cognitiveservices.azure.com`. It authenticates with
  `OPENGENI_RECORDING_AZURE_SPEECH_API_KEY` when set, otherwise with
  Microsoft Entra ID through the standard `AZURE_TENANT_ID` and
  `AZURE_CLIENT_ID`, plus `AZURE_FEDERATED_TOKEN_FILE` (an AKS workload
  identity sets all three) or `AZURE_CLIENT_SECRET`. The identity needs the
  Cognitive Services User role on the account. The model accepts FLAC, WAV
  and MP3 and up to two hours per request, so the worker sends it 16 kHz mono
  FLAC, in overlapping pieces for longer tracks. Speakers come from
  Opengeni's diarizer, since the model's own diarization fails on recordings
  longer than about a quarter of an hour during its preview.

The dictation providers in `docs/transcription.md` (OpenAI, Azure OpenAI and
the two subscriptions) share the same registry, credentials and billing. They
return only text, so they serve meetings only where the deployment aligns
words (`OPENGENI_RECORDING_WORD_ALIGNMENT=true`, set in the stock images).

The deployment's meeting default is Azure Speech when its account is
configured, else ElevenLabs; `OPENGENI_RECORDING_TRANSCRIPTION_DEFAULT`
(`provider/model`, such as `elevenlabs/scribe_v2`) picks another. A meeting
runs the deployment's pin, else the model the request or the workspace names
(`settings.recordings.transcription`), else the default when this workspace
can use it, else the first model in the provider order that serves meetings
and that this workspace can use. So a workspace signed in to a ChatGPT or
SuperGrok subscription, or holding its own key, transcribes with it without
picking it. With nothing usable it stays the default, and the transcript
fails saying which provider to connect.
`GET …/recording-models` lists the models, their capabilities, funding and
whether each is available to this workspace, plus the `default` a meeting
would run now, `dictationDefault` and `pinned`.

A deployment-funded meeting transcript is charged in credits once it
completes, at the model's price per hour of audio; workspace keys and
subscriptions are not. Transcripts that are not charged in credits count
toward the usage allowance instead.

### What processing costs

Every transcript attempt is measured stage by stage and published as
Prometheus metrics, labelled by purpose (`meeting` or `dictation`),
provider, model and who pays (`deployment`, `workspace_key`,
`workspace_subscription`):

| Stage | What runs |
| --- | --- |
| `prepare` | Download the chunks and write one seekable file per track (ffmpeg) |
| `convert` | Re-encode a track, or cut it into pieces a model accepts (ffmpeg) |
| `diarize` | Opengeni's speaker models, decoding included |
| `align` | Opengeni's word aligner, for text-only models, decoding included |
| `transcribe` | Waiting on the transcription provider |
| `segment` | Cut a dictation into the voice input's pieces (ffmpeg) |
| `finish` | Store the transcript and settle its charge |

- `opengeni_recording_stage_cpu_seconds_total`,
  `opengeni_recording_stage_wall_seconds_total` and
  `opengeni_recording_stage_memory_byte_seconds_total` count each stage's
  CPU (user plus system, of the programs it runs), time, and peak memory
  times run time. `opengeni_recording_stage_peak_memory_bytes` is the most
  memory a stage held at once, per version.
- `opengeni_recording_audio_seconds_total`,
  `opengeni_recording_provider_cost_usd_total` (list price) and
  `opengeni_recording_credits_total` give the audio and what it cost;
  `opengeni_recording_stored_bytes_total` counts uploaded chunks and
  prepared files.
- `opengeni_recording_transcripts_total` (by outcome and error code),
  `opengeni_recording_queue_seconds`, `opengeni_recording_processing_seconds`,
  `opengeni_recording_transcript_reruns_total`,
  `opengeni_recording_diarization_total`,
  `opengeni_recording_diarizer_fallbacks_total` and
  `opengeni_recording_speakers` show speed and quality next to cost.
  For text-only models, `opengeni_recording_aligned_words_total` counts how
  the aligner placed each word and `opengeni_recording_alignment_score` is
  its mean fit per transcript.
- The live preview counts `opengeni_recording_live_sessions_total`,
  `opengeni_recording_live_audio_seconds_total` and
  `opengeni_recording_live_cost_usd_total`. The browser streams to the
  provider itself, so it costs the servers almost nothing.

Each attempt also logs one `recording processed` line with the same
breakdown, to look at a single recording. The **Opengeni · Meetings &
Transcription** Grafana dashboard prices it all per audio hour, with CPU,
memory and storage at rates you set to your cloud's prices.

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

## Notes

A meeting has two Markdown documents beside its transcript. The `notepad` is
what people jot down while it is recorded. The `notes` are the written-up
summary, decisions and action items, by a person or by an agent afterwards
(an automation that runs when `recording.transcript.ready` arrives is the
usual way). Anyone who can see the meeting can read and replace both, as with
its title and speakers; deleting the meeting deletes them.

- `GET …/recordings/:recordingId/notes` returns the notes saved so far, each
  with its `revision`, `updatedAt` and who saved it (`updatedBy.sessionId` is
  the chat whose agent saved it).
- `PUT …/recordings/:recordingId/notes/:kind` (`notepad` or `notes`) with
  `{ "body": "…", "expectedRevision": 3 }` replaces it, up to 256 KiB. With
  `expectedRevision` (0 when nothing was saved yet) a newer save made first
  returns 409 with `details.code: "notes_changed"` instead of being
  overwritten. Saving the same text again changes nothing.

Saving the `notes` is a `recording.notes.updated` event; the notepad, which
saves as people type, is not.

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
`recording.speakers.updated`, `recording.notes.updated` and
`recording.deleted`. The payload carries ids and states (plus the product's
own `externalRef`), never a title, audio, transcript or note text:

```json
{ "id": "…", "type": "recording.transcript.ready", "lane": "workspace", "workspaceId": "…",
  "workspace": { "id": "…", "externalSource": "product:production", "externalId": "tenant-42" },
  "occurredAt": "2026-10-24T09:12:03.120Z",
  "data": { "recordingId": "…", "ownerSubjectId": "…", "visibility": "private",
    "externalRef": "project:42", "state": "ready", "versionId": "…", "previousVersionId": null } }
```

Read the recording through the API for its details.

## Dictation

Composer dictation (the microphone button in a message box) is a recording
too, with `purpose: "dictation"`. It uses the same local-first capture and
upload as a meeting, so a closed tab, a killed phone app, a dropped
connection or a failed transcription never loses what was said.

A dictation differs from a meeting in a few ways:

- It has exactly one `microphone` track and is always private. Sharing it
  answers 409 `dictation_private`.
- It is transcribed with the workspace's voice input (its provider choice and
  the voice input setting), not `settings.recordings.transcription`. Creating
  one answers 403 with `details.code: "policy_blocked"` when voice input is
  off, and 503 when no voice input provider is available.
- It is billed like voice input: each piece is charged against the
  dictating person's usage, and a refused charge fails the transcript with
  that code (for example `insufficient_credits`).
- It sends no webhook events, never appears in Meetings or in
  `meetings_search`, and gets no live preview (409 `not_a_meeting`).
- The worker deletes it a day after it is heard. Clients normally delete it
  sooner, as soon as its text is in the draft.

`GET …/recordings?purpose=dictation` lists the caller's own dictations that
are still kept, newest first. A client that opens a composer uses it to
offer the text of a dictation an earlier page, tab or device left behind.

`useVoiceInput` (in `@opengeni/react/recordings`, used by the web composer)
and `useNativeDictation` (in `@opengeni/react-native/recordings`) do all of
this. Taking the text deletes the dictation first and inserts the text only
if that delete succeeded or couldn't reach the server, so two tabs never
insert the same speech twice. Cancel or Escape keeps anything longer than
three seconds to insert later. A client without the recordings API (only
`transcribeAudio`) records in memory and sends one request, as before.

Dictation recordings replace the older `transcription-recordings` routes,
which are deprecated and kept for older clients until their sunset.

## Deletion

`DELETE …/recordings/:recordingId` hides the recording at once; the worker
then removes its audio, transcripts and speaker matches.
