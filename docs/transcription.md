# Composer transcription capability

Voice transcription is a distinct, provider-agnostic capability for turning host-captured audio
into editable composer text. It is not a turn-model feature, does not authorize a coding model, and
does not send a message by itself.

## Product contract

- The ordinary composer presents **one microphone control** and **one editable draft**. Provider,
  model, credential, region, retention, privacy, fallback, and cost choices do not appear beside the
  microphone; they live only in Workspace settings.
- Partial transcripts are ephemeral UI state. They are cleared on reconnect, cancellation, error,
  close, policy replacement, or component unmount and are never inserted into the message draft.
- Each accepted final is deduplicated by the adapter's stable acceptance ID and appended to the
  draft exactly once. The user can edit or delete it before using the ordinary Send action.
- Escape cancels an active session. Cancellation and policy replacement locally fence late adapter
  callbacks even if remote cleanup fails.
- Transcription is disabled and unaccepted by default. Missing, malformed, or mismatched policy and
  adapter state fails closed.

## Trust boundary and data flow

```text
workspace.settings.transcription
  -> strict policy validation + exact acceptanceId
  -> host selects and injects an exact matching TranscriptionAdapter
  -> host adapter owns microphone/audio transport/provider credentials
  -> partial events render ephemerally beside the composer
  -> accepted final events append once to the editable draft
  -> the user edits and invokes ordinary Send
  -> only then does normal message/session handling begin
```

The workspace policy and adapter descriptor must match on provider, model, credential mode, and
region. The session request also carries the exact accepted policy identity, language, retention,
privacy, cost, target selection, and sequence floor. Changing any accepted policy field revokes the
active session; a new session must bind the new acceptance ID.

This authorization is intentionally separate from workspace turn-model policy and from the model
chosen for an agent turn. A transcription target cannot inherit OPE-35/model-routing permission,
and no audio is routed through coding-model inference. A Codex-subscription transcription adapter
is not included because no stable authorized audio-transcription entitlement has been established.

The policy contains only a workspace connection UUID for a BYOK target, never a credential value.
The current client seam does not resolve that reference itself: an authorized host adapter must use
its own credential broker without exposing secrets to the composer or public event payloads.

## Canonical implementation

| Concern | Canonical source |
| --- | --- |
| Stored workspace schema and PATCH validation | `packages/contracts/src/index.ts` (`WorkspaceTranscriptionPolicy`) |
| Browser-global-free adapter, authorization, event, and session contracts | `packages/sdk/src/transcription.ts` |
| React lifecycle, sequence/generation fences, and final insertion | `packages/react/src/hooks/use-transcription.ts` |
| One accessible microphone control | `packages/react/src/components/composer-transcription-control.tsx` |
| Ordinary composer integration | `packages/react/src/components/chat-composer.tsx` |
| Workspace-only policy editor | `apps/web/src/components/transcription-settings.tsx` |
| Deterministic browser fixture | `packages/react/demo/transcription-harness.tsx` |

`@opengeni/sdk` deliberately references no browser or native microphone API. Web, desktop, native,
and mobile hosts implement the same `TranscriptionAdapter`/`TranscriptionSession` seam and emit the
same ordered lifecycle events. `@opengeni/react` supplies the web composer lifecycle and UI; a
native UI can consume the SDK contract directly.

The OpenGeni web bundle currently injects no production adapter. Its microphone therefore explains
that an approved adapter is required rather than touching a microphone, network, provider, or
credential. The demo/e2e adapter is local deterministic fixture code only.

## Lifecycle requirements for host adapters

1. `start` receives an already-authorized, immutable session request and an event listener.
2. Events use one `localSessionId` and a strictly increasing safe-integer `sequence`, including
   reconnects. Replayed or stale sequences are ignored.
3. Partials are replaceable hints. Finals need a stable `providerAcceptanceId`; replaying a final
   with that ID must not create a second insertion.
4. Recoverable errors enter reconnecting state. Non-recoverable errors and closed sessions are
   terminal and release the stored session handle.
5. `cancel` and `close` must be idempotent. The UI treats cancellation as a local privacy fence even
   when provider cleanup rejects.
6. A fallback is never selected silently. The workspace must accept explicit fallback targets and
   the host must request one exact accepted index.
7. The host adapter is responsible for enforcing provider-specific retention/privacy commitments
   and cost ceilings before and during capture. The generic SDK passes these values through but has
   no provider meter or billing integration of its own.

## Provider research matrix

Research below is limited to the vendors' public documentation, accessed **2026-07-21**. It is an
integration-planning matrix, not an endorsement or a claim of verified runtime behavior.

| Candidate | Documented integration shape | OpenGeni adapter considerations | Current status |
| --- | --- | --- | --- |
| OpenAI speech/transcription | Hosted speech-to-text APIs plus documented realtime transcription; separate data-control and API-pricing documentation | A future host adapter would need an authorized API credential path, exact model binding, documented retention/privacy acceptance, and independent cost enforcement. A coding-model or Codex subscription is not a substitute. | No adapter; no entitlement, provider call, or benchmark verified. |
| Deepgram | Hosted live-streaming audio interface with separate published pricing | A host adapter would own live audio transport, credential brokerage, reconnect ordering, region/privacy review, and usage/cost enforcement. | No adapter or benchmark. |
| Azure Speech | Speech-to-text SDK/service documentation and a separately documented container option | OpenGeni policy permits `azure-speech` only with a workspace BYOK connection. Region and deployment mode must be exact; selecting Azure Speech never authorizes Azure-hosted model inference. | No adapter, container integration, or benchmark. |
| AssemblyAI | Hosted streaming transcription interface with separate published pricing | A host adapter would own streaming transport, credential brokerage, reconnect/dedupe behavior, privacy review, and usage/cost enforcement. | No adapter or benchmark. |
| Self-hosted Whisper-class | Open-source Whisper model/code suitable for operator-owned inference; the upstream repository does not establish an OpenGeni streaming service contract | A host must own model packaging, audio capture, segmentation/streaming strategy, compute, region, observability, and stable acceptance IDs. Self-hosting reduces vendor coupling but does not by itself prove privacy, latency, or cost. | No packaged service or adapter; no hardware benchmark. |

Official references:

- OpenAI: [speech to text](https://platform.openai.com/docs/guides/speech-to-text),
  [realtime transcription](https://platform.openai.com/docs/guides/realtime-transcription),
  [data controls](https://platform.openai.com/docs/guides/your-data), and
  [API pricing](https://openai.com/api/pricing/)
- Deepgram: [live streaming audio](https://developers.deepgram.com/docs/getting-started-with-live-streaming-audio)
  and [pricing](https://deepgram.com/pricing)
- Microsoft: [Azure Speech to text](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-speech-to-text),
  [Speech containers](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-container-howto),
  and [Speech pricing](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/)
- AssemblyAI: [streaming transcription](https://www.assemblyai.com/docs/getting-started/transcribe-streaming-audio)
  and [pricing](https://www.assemblyai.com/pricing)
- OpenAI Whisper: [source repository and model card](https://github.com/openai/whisper)

## Honest runtime gaps

- No production browser, desktop, native, mobile, server, or provider adapter ships today.
- No provider credential has been resolved through this seam, and no paid/provider call was made
  while implementing or testing it.
- Provider accuracy, language coverage, latency, reconnect behavior, region availability, privacy,
  retention, and cost have not been benchmarked or operationally verified.
- Cost policy is carried to an adapter but cannot be metered or enforced without a real adapter and
  provider-specific usage accounting.
- The workspace editor currently accepts one explicit fallback target; the underlying contract can
  represent more, but there is no automatic fallback coordinator.
