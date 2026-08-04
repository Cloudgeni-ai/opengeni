# Composer voice input

Native voice input turns browser-captured audio into editable composer text. It is
not a turn-model feature, does not authorize a coding model, and does not send a
message by itself.

## Product contract

- The ordinary composer presents **one microphone control** (idle) and **one editable
  draft**. While recording, chrome shows a compact waveform plus separate **Cancel**
  (discard) and **Stop** (transcribe) actions. Provider, model, credential, and region
  choices never appear beside the microphone or in Workspace settings for end users.
- Click microphone → record locally in durable five-second chunks → press stop →
  **automatically** assemble, upload, and transcribe with no extra click → append the
  transcript to the editable draft. Cancel (or Escape) while recording discards without
  uploading.
- The transcript does **not** auto-submit as an agent message. Ordinary Send still
  sends the message.
- Escape during saving or transcription aborts the in-flight work but retains the same
  locally recoverable recording. Recording stops at the configurable
  `ClientConfig.voiceInput.maxDurationSeconds` ceiling (60 seconds by default, up to
  10 minutes) and never uploads audio above the advertised 25 MiB one-shot limit.
- Audio chunks and their manifest are persisted in browser IndexedDB before the UI marks
  them locally saved. Stop assembles those persisted chunks for the existing one-shot API
  upload. A failed or interrupted finalization remains recoverable across reload and Retry
  reuses the same recording. A reload-stable owner ID is protected by a browser-document Web
  Lock, with a BroadcastChannel handshake fallback, so opener-created or duplicated tabs
  cannot reuse the same live owner. Stale captures may be reclaimed, and retained recordings
  are surfaced oldest-first until each is resolved. The provider result is saved locally before
  draft mutation. If handoff confirmation is uncertain after a crash or storage failure, the UI
  exposes an explicit saved-transcript insertion action instead of auto-transcribing or
  auto-appending again. Audio and locally saved transcript results are removed only after
  handoff is durably represented; transient cleanup failures are retried and garbage-collected
  owner-safely. The transcription path does not log audio or write it to server object storage,
  and does not store transcript text server-side.
- Controlled error codes map to local UI copy. Provider names, secrets, and raw upstream
  detail never appear in client config or composer chrome.

## Trust boundary and data flow

```text
Browser MediaRecorder (5s chunks)
  -> IndexedDB recording manifest + Blob chunks
  -> assemble persisted chunks
  -> OpenGeni SDK transcribeAudio (one multipart finalization attempt)
  -> POST /v1/workspaces/:workspaceId/transcriptions
  -> server provider registry (select once before send)
  -> OpenAI gpt-transcribe | Azure deployment transcriptions
     | experimental Codex /backend-api/transcribe
  -> { text, languages } appended to editable composer draft
  -> user edits and invokes ordinary Send
```

Deployment credentials and provider selection stay server-private.
`GET /v1/config/client` projects only:

```ts
voiceInput: {
  available: boolean;
  maxDurationSeconds: number;
  maxSizeBytes: number;
  acceptedMimeTypes: string[];
}
```

Workspace settings store only `{ voiceInput: { enabled: boolean } }`. When unset, voice
input defaults to enabled whenever the deployment has a working provider. Legacy
`settings.transcription.enabled` maps forward for one compatibility release; new writes
use `voiceInput`.

## Canonical implementation

| Concern | Canonical source |
| --- | --- |
| Client capability + workspace toggle + response | `packages/contracts/src/index.ts` |
| Provider registry config | `packages/config/src/index.ts` (`resolveVoiceInputProviderRegistry`) |
| Service port | `packages/core/src/transcription.ts` |
| API providers + route | `apps/api/src/transcription/`, `apps/api/src/routes/transcriptions.ts` |
| SDK binary call | `packages/sdk/src/client.ts` (`transcribeAudio`) |
| React MediaRecorder lifecycle + recovery | `packages/react/src/hooks/use-voice-input.ts`, `packages/react/src/voice-recording-owner.ts`, `packages/react/src/voice-recording-store.ts` |
| Microphone control | `packages/react/src/components/composer-transcription-control.tsx` |
| Workspace toggle UI | `apps/web/src/components/transcription-settings.tsx` |

Deprecated host-adapter types remain exported from `packages/sdk/src/transcription.ts`
for one release and will be removed afterward.

## Provider paths

| Provider | When selected | Notes |
| --- | --- | --- |
| `codex-subscription` | `OPENGENI_CODEX_SUBSCRIPTION_ENABLED=true` and a workspace has an active attached Codex credential | Undocumented ChatGPT `/backend-api/transcribe`; preferred by default when attached; skipped at selection time when no workspace credential |
| `openai` | usable `OPENGENI_OPENAI_API_KEY` (or voice-specific key; template placeholders like `your-key` are ignored) and OpenAI path enabled | `POST /v1/audio/transcriptions`, default model `gpt-transcribe` |
| `azure-openai` | Azure endpoint + deployment + key/AD token configured | Deployment-scoped `/openai/deployments/{deployment}/audio/transcriptions` |

Selection uses `OPENGENI_VOICE_INPUT_PROVIDER_ORDER` (default
`codex-subscription,openai,azure-openai`). The first ready provider wins **before**
audio is sent. When Codex subscription routing is enabled, Codex is preferred over
OpenAI/Azure even if API keys exist; workspaces without an attached subscription
credential fall through to OpenAI/Azure. Operators can put `openai` or
`azure-openai` first explicitly, or omit `codex-subscription` from the order to
disable Codex voice while keeping subscription model routing. The same clip is
never retried across vendors after an upstream request may have started.

## Operator configuration

See `.env.example` for:

- `OPENGENI_VOICE_INPUT_MAX_DURATION_SECONDS` / `OPENGENI_VOICE_INPUT_MAX_SIZE_BYTES`
- `OPENGENI_VOICE_INPUT_PROVIDER_ORDER`
- `OPENGENI_VOICE_INPUT_OPENAI_*` / `OPENGENI_VOICE_INPUT_AZURE_*`
- `OPENGENI_CODEX_SUBSCRIPTION_ENABLED` (includes Codex in the voice registry)
- `OPENGENI_VOICE_INPUT_CODEX_EXPERIMENTAL` (legacy; no longer required for inclusion)

Supported paths reuse ordinary OpenAI/Azure turn credentials when voice-specific
overrides are unset. Codex transcription requires subscription routing enabled and
an active workspace Codex credential at selection/request time.

## Lifecycle requirements

1. Browser creates a recording manifest before starting microphone capture, negotiates a
   MIME type (`webm/opus`, then `mp4`, then `ogg/opus`), and asks `MediaRecorder` for a
   chunk every five seconds.
2. Each chunk is written to IndexedDB with its sequence, timing, codec, size, and SHA-256
   integrity metadata before the UI reports that audio as locally saved. A storage failure
   stops capture and fails closed instead of continuing with memory-only audio.
3. Stop (user click or the configured duration ceiling) waits for pending chunk writes,
   marks capture stopped, assembles the persisted chunks in order, and calls
   `transcribeAudio` through the existing one-shot multipart endpoint.
4. Upload/provider errors and aborts retain the recording. Mount/reload recovery claims the
   oldest available manifest, Retry reuses it without reopening the microphone, explicit
   discard advances to the next retained recording, and a document-held owner lock/handshake
   plus manifest heartbeats prevents cross-tab retry/discard until the owner releases or becomes
   stale.
5. A successful provider result is persisted as `transcript-ready` before draft mutation.
   Handoff is then marked durably before local cleanup. A reload never auto-retranscribes or
   auto-appends `transcript-ready` data; it offers an explicit insertion action with copy that
   tells the user to check the draft first.
6. React associates an abort controller before every finalization await and fences callbacks
   before and after recorder-stop persistence, storage enumeration, upload, result persistence,
   and handoff. Late work after Escape/unmount/workspace replacement cannot restore a stale
   recording, upload, or append, and every acquired microphone track is stopped when setup or
   capture exits. A failed post-handoff delete is retried immediately; later mounts owner-safely
   garbage-collect any handed-off manifest and its audio chunks.
7. Empty/whitespace transcripts do not change the draft. Workspace disablement and
   missing deployment configuration hide or block the mic without inventing provider
   controls in product UI.
