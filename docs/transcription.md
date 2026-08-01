# Composer voice input

Native voice input turns browser-captured audio into editable composer text. It is
not a turn-model feature, does not authorize a coding model, and does not send a
message by itself.

## Product contract

- The ordinary composer presents **one microphone control** (idle) and **one editable
  draft**. While recording, chrome shows a compact waveform plus separate **Cancel**
  (discard) and **Stop** (transcribe) actions. Provider, model, credential, and region
  choices never appear beside the microphone or in Workspace settings for end users.
- Click microphone → record locally → press stop → **immediately** upload and
  transcribe with no extra click → append the transcript to the editable draft.
  Cancel (or Escape) discards without uploading.
- The transcript does **not** auto-submit as an agent message. Ordinary Send still
  sends the message.
- Escape cancels or discards an in-flight recording/transcription. Recording hard-stops
  at 60 seconds (`ClientConfig.voiceInput.maxDurationSeconds`).
- Audio exists only in browser memory and the in-flight API request buffer. It is never
  persisted, logged, or written to object storage. Transcript text is returned once to
  the client and is not stored server-side by the transcription path.
- Controlled error codes map to local UI copy. Provider names, secrets, and raw upstream
  detail never appear in client config or composer chrome.

## Trust boundary and data flow

```text
Browser MediaRecorder
  -> OpenGeni SDK transcribeAudio (multipart, no retry)
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
| React MediaRecorder lifecycle | `packages/react/src/hooks/use-voice-input.ts` |
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

1. Browser requests microphone permission, then records with a negotiated MIME type
   (`webm/opus`, then `mp4`, then `ogg/opus`).
2. Stop (user click or 60s hard-stop) finalizes the `MediaRecorder` blob and immediately
   calls `transcribeAudio`.
3. React fences callbacks by generation so late responses after Escape/unmount/replace
   cannot append to the draft.
4. Tracks are stopped on every exit path.
5. Empty/whitespace transcripts do not change the draft.
6. Workspace disablement and missing deployment configuration hide or block the mic
   without inventing provider controls in product UI.
