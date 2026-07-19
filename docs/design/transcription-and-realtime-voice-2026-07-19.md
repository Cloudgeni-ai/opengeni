<!-- docs-refs: record -->

> **Point-in-time design record.** Written against the tree at authoring time; paths and names may have moved. Code wins.

# Transcription and realtime voice

- **Date:** 2026-07-19
- **Issue:** OPE-11
- **Status:** Proposed; deterministic prototype implemented, production provider
  validation and rollout not completed
- **Decision owners:** Product, platform, security, and finance must jointly
  approve a production provider and data policy

## Decision

Expose one provider-neutral **voice dictation** control in the normal composer.
The browser may show an ephemeral partial transcript, but only provider-final text
enters the ordinary editable composer draft. Dictation cannot send, queue, steer,
or otherwise start a turn. Once final text is in the draft, the existing composer
owns every subsequent behavior.

Use an OpenAI Realtime WebRTC adapter for the smallest prototype because OpenGeni
already has a direct OpenAI API configuration seam and OpenAI documents a
browser-safe, short-lived client-secret flow. This is an integration-effort
decision, **not** a quality, latency, privacy, or cost winner. Keep the event and
session contracts provider-neutral and require a representative, instrumented
bakeoff before selecting a production default.

The prototype is deliberately narrower than the eventual product:

- direct OpenAI API only; custom base URLs and Azure OpenAI are rejected;
- managed API credential only; no provider choice or BYOK controls in the
  composer;
- `gpt-4o-transcribe`, one browser stream, no diarization, no cross-provider
  fallback, and no OpenGeni raw-audio retention;
- short-lived credential minting requires `sessions:control`, a real durable
  workspace session, and the authoritative default-off workspace policy;
- durable admission conservatively reserves the policy's maximum duration and
  cost before provider access, and every reconnect uses a new grant and peer;
  and
- the adapter is loaded from a separate package subpath only when dictation
  starts, preserving the session-page bundle budget.

## User experience boundary

The default composer gets one compact microphone button. It has stable button
semantics, visible keyboard focus, `aria-pressed`, polite live status, assertive
errors, Escape cancellation, reduced-motion behavior, and a coarse-pointer hit
target. It exposes recording, slow permission, partial, reconnecting,
permission-denied, provider-error, cancelled, and unavailable states without
showing provider, model, fallback, or credential complexity.

Advanced controls belong in workspace settings, not beside the composer:

- default provider and model;
- managed credential versus workspace BYOK;
- allowed region and data-residency policy;
- language/default language detection and diarization;
- raw-audio and transcript retention, training opt-in, and redaction policy;
- usage and cost limits; and
- an optional ordered fallback policy subject to the acceptance rules below.

## Evidence classification

No transcription vendor was called for this record. OpenGeni did not capture a
microphone sample, retain audio, benchmark word error rate, or measure provider
latency. Capability and latency statements in the matrix are vendor-documented
or vendor-claimed unless explicitly labeled as OpenGeni-measured.

OpenGeni-measured evidence is limited to deterministic contract tests, API tests,
bundle size, and local Chromium UI behavior. The browser matrix is documented in
[`evidence/transcription/README.md`](./evidence/transcription/README.md).

## Provider decision matrix

**Pricing: verified 2026-07-19; recheck before rollout.** Prices are public list
prices, may be promotional, regional, plan-specific, or token-based, and exclude
OpenGeni infrastructure and egress. Do not compare token rates with duration
rates without a representative audio corpus.

| Option | Batch / streaming | Quality, languages, and metadata | Latency evidence | Privacy, region, and compliance | Failure / SDK / cost notes |
|---|---|---|---|---|---|
| **OpenAI Audio + Realtime** | Audio API for files; Realtime transcription streams deltas over WebRTC or WebSocket. | `gpt-4o-transcribe`, mini, and a diarizing model are documented. Audio API support includes diarized output; timestamp support is endpoint/model-specific. The selected Realtime events provide deltas/finals and usage, but the prototype does not claim speaker labels or word timing. | Vendor docs say deltas arrive in real time. **No OpenGeni provider latency was measured.** | API data is not used for training unless the customer opts in. Default abuse-monitoring logs may retain customer content up to 30 days. ZDR/MAM and data residency are eligibility-, project-, region-, model-, and endpoint-specific; system data is outside customer-content residency. Production must verify Realtime/transcription eligibility for the exact project. | Official API docs and browser WebRTC flow are mature enough for a prototype. `gpt-4o-transcribe`: $2.50 input / $10 output per 1M audio tokens; mini: $1.25 / $5. Token-to-minute cost remains unmeasured. |
| **Deepgram Nova-3 / Flux** | Streaming and prerecorded APIs. Flux targets conversational streaming; Nova-3 covers general streaming/prerecorded use. | Vendor claims Nova models support 45+ languages. Automatic language detection, formatting, confidence/timing, and speaker diarization are available by model/option. Validate the exact language and feature combination. | Pricing copy calls Flux “ultra-low latency”; that is a **vendor claim, not an OpenGeni measurement**. | Hosted and enterprise/deployment choices require a plan-specific security, subprocessors, retention, training, residency, BAA/DPA, and regional-processing review before enablement. Do not infer those controls from the product or pricing page. | Mature REST/WebSocket surface and official SDKs. Promotional PAYG streaming list price: Nova-3 mono $0.0048/min, multilingual $0.0058/min, Flux English $0.0065/min; diarization adds $0.0020/min. Recheck promotions. |
| **Azure AI Speech** | Realtime with intermediate results, fast synchronous transcription, and batch transcription. | Broad locale/region tables, language identification, custom speech, timestamps/confidence, and diarization are documented; availability differs by locale, region, endpoint, and SDK. A documented workflow supports diarization of up to 35 speakers, but that is not a guarantee for every mode. | “Real-time” and “faster than real-time” are product descriptions. **No OpenGeni provider latency was measured.** | Microsoft states realtime/fast inputs are processed in server memory and not stored at rest; realtime, fast, pronunciation, and translation customer data is not retained. Batch uses customer-selected storage or Microsoft output storage with deletion/TTL controls. Region and compliance still require exact subscription/SKU review. | Mature Speech SDK, CLI, REST, and enterprise regional surface. Public pricing is dynamically regional and showed no reliable numeric rate in the captured page; five free realtime audio hours/month were advertised. Do not infer a rate from another Azure speech row. Azure Speech was researched only and not called. |
| **AssemblyAI Universal** | Async prerecorded, Sync STT, and realtime streaming APIs. | Pricing page describes Universal-3.5 Pro Realtime across 18 languages with speaker labels and context features; other models span up to 99 languages. Diarization, timing, and confidence vary by model/API. | The pricing page's ~134 ms p50 is a **vendor claim for Sync STT**, not realtime streaming and not an OpenGeni measurement. | Hosted processing needs a plan-specific review of retention, training, subprocessors, region/residency, BAA/DPA, and the exact Trust Center reports. Do not translate a Trust Center badge into endpoint behavior. | WebSocket quickstart and official SDK examples are straightforward. PAYG list price shown for Universal-3.5 Pro Realtime is $0.45/hr; streaming diarization is shown as a $0.12/hr add-on. |
| **Self-hosted Whisper / faster-whisper class** | Whisper is file-oriented. Streaming normally requires chunking/VAD and an additional server/wrapper; it is not a core Whisper or faster-whisper contract. | Multilingual recognition, translation, and language identification are core Whisper tasks. faster-whisper exposes detected-language probability plus segment/word timestamps. Quality varies materially by language, noise, model, quantization, and hardware. Speaker diarization requires another model/tool such as WhisperX/NeMo and must not be attributed to core faster-whisper. | Repository benchmarks are hardware-specific. **No OpenGeni latency, throughput, or quality was measured.** | Best control over audio location and retention when deployed correctly, but OpenGeni becomes responsible for encryption, access, tenancy, deletion, model supply chain, GPU locality, regional placement, incident response, and compliance evidence. | MIT code/model licensing for OpenAI Whisper; faster-whisper uses CTranslate2 and supports CPU/GPU quantization. No per-minute vendor fee, but compute, autoscaling, idle capacity, observability, and operations may dominate. |

### Recommendation

1. Keep the OpenAI adapter as a bounded prototype and integration reference.
2. Before production default selection, replay an approved, representative,
   consented corpus through at least OpenAI, Deepgram, and AssemblyAI; include
   Azure when a candidate customer needs its region/compliance posture. Measure
   first partial, final-after-end-of-speech, word error rate, cancellation,
   disconnect recovery, language slices, and effective cost.
3. Evaluate self-hosted faster-whisper only when residency/control or sustained
   volume justifies owning GPU operations. Treat its streaming and diarization
   layers as separate dependencies.
4. Block any provider whose exact endpoint cannot satisfy the workspace's
   approved retention, training, residency, and compliance policy.

## Canonical provider contract

The prototype contract is defined in
`packages/react/src/transcription/types.ts`. A provider has an immutable `id`
and creates a session from a request plus an event sink:

```ts
interface TranscriptionProvider {
  readonly id: string;
  createSession(
    request: TranscriptionSessionRequest,
    emit: TranscriptionEventSink,
  ): TranscriptionSession;
}

interface TranscriptionSession {
  readonly id: string;
  readonly providerId: string;
  start(): Promise<void>;
  cancel(reason?: string): Promise<void>;
  close(): Promise<void>;
}
```

The provider-neutral session request carries an OpenGeni-generated local
dictation ID, optional language and diarization, plus explicit privacy intent.
The OpenAI adapter separately receives the existing durable OpenGeni workspace
session UUID that authorization, admission, usage, and settlement bind to. The
two identities must never be substituted for each other. `retainAudio`,
`retainTranscript`, and `trainingAllowed` are required; `region` and
`dataResidency` are optional. These fields express requested policy, not proof
that a provider account or project is eligible for zero-data-retention or
regional processing. An adapter must reject an unsupported privacy request; it
must never silently weaken it.

### Canonical events

All events carry `sessionId`, `providerId`, and an adapter-assigned monotonic
`sequence`. Provider IDs and timestamps are optional because providers do not
offer identical metadata.

| Event | Required meaning |
|---|---|
| `session.ready` | Provider accepted the session; may include provider session identity and expiry. |
| `transcript.partial` | Replaceable display-only text for one segment. Never a draft commit or session event. |
| `transcript.final` | Provider-accepted final for one logical segment. Carries provider acceptance identity and may carry language, confidence, speaker, segment/word timing, and word confidence. |
| `usage` | Provider-native tokens, duration, audio seconds, or currency micros; never manufacture a false common unit. |
| `reconnecting` | Connection is not ready; carries attempt, reason, and optional retry delay. Clear partial text. |
| `error` | Sanitized code/message plus retryability and permission-denied classification. Clear partial text. |
| `closed` | Completed, cancelled, provider-closed, or error terminal signal. Clear partial text. |

Adapters normalize mechanics, not meaning. They must not invent confidence,
speaker identity, cost, or provider acceptance. Higher-level analytics may
convert units only with a versioned rate card and must retain the native usage
record.

## Acceptance identity and idempotent fallback

Three identities have different jobs:

- `segmentId`: provider-local item identity for one attempt;
- `logicalSegmentId`: OpenGeni identity retained across attempts/providers; and
- `providerAcceptanceId`: the provider's acknowledgement of a final result.

The reducer orders partial/final events by `(providerId, attempt, segmentId,
sequence)`, accepts at most one final for each `logicalSegmentId`, records its
provider acceptance identity, and ignores replays or later fallback finals.
Usage events are independently deduplicated by provider event identity.

Fallback is safe only at a proven boundary:

1. Assign the logical segment before attempt zero.
2. A retry may reuse that logical ID only if OpenGeni knows the earlier provider
   did **not** accept/bill the segment, or the provider supplies an idempotency
   mechanism whose behavior is contractually verified.
3. Once any attempt has an acceptance identity, never send the same audio to a
   fallback provider and never accept a competing final.
4. If the connection dies with acceptance uncertain, surface an error rather
   than silently replaying and risking duplicate transcript or spend.
5. With `retainAudio: false`, live cross-provider fallback cannot replay prior
   audio. A future short encrypted retry buffer requires explicit policy,
   bounded lifetime, deletion evidence, user disclosure, and a new security
   review; it is not part of this prototype.

The OpenAI adapter does not wait for a disconnected peer to heal. It disposes
the old channel and peer, settles the old grant as `replaced`, and—up to the
configured retry bound—requests a fresh grant, creates a fresh peer/data
channel, and performs a fresh SDP exchange. One setup deadline covers grant
minting, peer setup, offer creation, SDP fetch/body read, and remote-description
installation. Old-generation listeners/events are fenced, stale partials are
cleared, and provider item IDs are deduplicated by `(attempt, itemId)`; a new
attempt uses a new logical segment identity because no prior audio is replayed.
Exhaustion emits sanitized `webrtc_reconnect_exhausted` and terminates. Cancel,
close, and unmount abort pending setup, bound settlement, stop media tracks,
close transport resources, and terminally settle even a late-minted credential.

## Composer and durable event mapping

- Partial text lives only in hook/reducer memory and an `aria-live` status. It
  is never written as `session_events`, a message, a queue item, or a draft.
- A non-empty accepted final is trimmed and appended through
  `composer.setValue`, preserving the existing draft with exactly one separator.
- The hook deduplicates the commit before calling `setValue` and returns focus to
  the textarea. The transcript is now ordinary editable text.
- Only the existing composer send path can turn that draft into a user message,
  queue operation, or steer action. The transcription provider receives no send
  callback and has no session-control client.
- Cancel, permission denial, reconnect, provider error, unmount, and stale
  session events clear partial text without modifying the draft.

This separation preserves OPE-9 queue semantics and OPE-82 attachment/storage
semantics. Dictation neither creates file attachments nor stores audio.

## Workspace policy, authorization, and durable accounting

`workspaces.settings.transcription` is the one authoritative capability policy.
The shared contract resolves missing, malformed, or `{ enabled: false }` policy
to off. The web route uses that resolver and omits the microphone entirely when
the capability is off; the server independently re-reads the policy before
provider access and again inside serialized database admission.

An enabled policy must declare all of the following:

- provider `openai`, the exact configured project, and the official
  `https://api.openai.com/v1/realtime` endpoint;
- no OpenGeni/provider-request audio retention, no transcript retention, and no
  training, plus explicit zero-data-retention eligibility;
- processing region and data-residency declarations with verifier identity and
  timestamp;
- affirmative security and finance approvals with approver identity and
  timestamp; and
- workspace/subject concurrency, per-subject issuance rate, session-duration,
  monthly-duration, monthly-cost, and conservative reservation-cost limits.

This is a fail-closed declared policy gate, not evidence that provider-side ZDR
or residency is actually enabled. The exact OpenAI project and endpoint still
require provider-side verification before any rollout. The configured project
comes from `OPENGENI_OPENAI_PROJECT_ID` (falling back to
`OPENAI_PROJECT_ID`); the broker sends it as the exact `openai-project` header.

The credential and accounting path is intentionally asymmetric:

1. The browser asks OpenGeni for a client secret using the real durable
   workspace session UUID and a one-use `${localDictationId}:${attempt}` request
   ID. Reconnect attempts therefore cannot reuse issuance idempotency.
2. Workspace-scoped `sessions:control` authorization happens **before** body
   parsing, configuration inspection, database admission, or provider access.
   The session must exist in the same workspace.
3. Canonical usage limits and the stricter of platform/static and workspace
   limits are enforced. Account-row then workspace-row locks serialize sibling
   workspace cost and local concurrency decisions. One live grant per workspace
   session is also protected by a partial unique index.
4. Before any provider call, `transcription_grants` records a conservative
   duration/cost reservation and idempotent usage/audit events. Denials are
   audited. Expired reserved/active grants are reconciled during admission.
5. The broker rejects Azure/custom endpoints and unsupported diarization,
   hashes workspace plus subject into a provider safety identifier, applies a
   10-second provider timeout, and uses the deployment key only server-side.
   OpenAI's response must be a transcription session with a future expiry no
   more than five minutes away. The returned credential is never persisted and
   the browser response is `cache-control: no-store`.
6. Activation, provider-event-idempotent usage reports, and terminal settlement
   bind exact workspace, subject, durable session, grant, and provider-session
   identities. Provider rejection or durable activation failure terminally
   reconciles the row while retaining the conservative reservation.
7. Browser-reported provider duration is observability only: it never refunds
   or reduces the reservation and is never trusted to reopen paid capacity. The
   browser sends microphone audio directly over the documented OpenAI WebRTC
   flow; OpenGeni does not proxy or retain raw audio.

The FORCE-RLS grant ledger stores identities, status, reserved/reported numeric
usage, and timestamps only—never an API key, client secret, raw provider
payload, audio, or transcript. Transcript text is customer content and must not
appear in routine metrics, audit metadata, or errors. Provider egress
allowlisting, managed credential rotation, and a workspace settings UI remain
rollout work.

### Codex subscription entitlement

The connected Codex subscription authorizes coding-model inference through the
Codex product/broker. The official transcription flow is an OpenAI API endpoint
authenticated with an API credential or a short-lived client secret minted by
that API credential. The inspected Codex authentication material does not
publish an audio/transcription entitlement, stable endpoint, billing contract,
or token exchange usable by an application. No audio was routed through a coding
model, and no subscription credential was repurposed as an API credential.

Therefore the prototype requires separately configured provider API
authorization. An interactive subscription login is neither a BYOK mechanism
nor evidence that provider charges are included.

## Future realtime voice sessions

Realtime voice is a later mode, not a larger dictation hook. Reuse provider
session/privacy/usage primitives but introduce an explicit conversation state
machine with stable utterance IDs and these invariants:

- a committed user utterance enters the same canonical conversation exactly
  once, regardless of text or audio transport;
- assistant audio and its text projection share one response identity;
- interruption records the acknowledged playback boundary, cancels generation,
  and retains the exact heard/unheard relationship without deleting canonical
  context;
- tool calls and child-agent work use existing typed session/tool control paths,
  never provider-specific voice messages;
- returning to text preserves finalized user utterances, assistant responses,
  tool results, and child-agent summaries without replaying them; and
- partial recognition and speculative assistant audio remain ephemeral until
  their respective acceptance boundaries.

This keeps voice transport replaceable and prevents a provider reconnect from
duplicating messages, tools, children, billing, or context.

## Rollout

1. **Hardened deterministic prototype:** land provider-neutral contracts,
   reducer, authoritative default-off workspace policy, durable admission and
   conservative accounting, bounded fresh-peer recovery, authorized
   client-secret broker, lazy OpenAI adapter, composer control, database test
   sources, and fixture Chromium evidence. No provider call and no production
   rollout.
2. **Internal managed pilot:** add the admin settings UI and audited approval
   workflow; independently verify provider-side ZDR/residency for the exact
   OpenAI project and endpoint; add provider egress controls and consented real
   browser/provider testing; then validate the reservation rate card against
   actual provider billing. Keep diarization/fallback off.
3. **Measured provider bakeoff:** run the same approved corpus and failure matrix
   across candidates. Publish measured accuracy/latency/cost separately from
   vendor claims, then select per-region defaults.
4. **Workspace settings and adapters:** add managed/BYOK policy, region,
   language, retention, diarization, and only proven-safe ordered fallback.
   Provider/model details remain absent from the composer.
5. **Realtime voice:** design and review the conversation state machine,
   interruption and tool semantics, child-agent handoff, and return-to-text
   continuity as a separate release.

## Validation completed

- reducer/provider tests cover stale partials/finals, batched accepted finals,
  final replay, fallback final deduplication, usage identity,
  permission/cancel/error handling, privacy admission before microphone access,
  WebRTC event mapping, fresh-grant/peer/SDP reconnect, generation fencing,
  attempt-scoped provider item identity, bounded setup/reconnect/settlement,
  cleanup, and closure during pending microphone permission or credential mint;
- contract/config tests cover default-off and malformed workspace policy,
  exact provider/project/endpoint/privacy/approval eligibility, settings patch
  validation, project environment precedence, and positive integral static
  transcription caps;
- real-PostgreSQL API/DB/migration test sources cover authorization before
  parsing/provider access; session/policy/config admission; reservation,
  concurrency, rate, duration and cost limits; exact usage/settlement binding;
  idempotency, expiry, audit; account caps across sibling workspaces; dedicated
  schema installation; constraints, RLS, and credential/content-free storage.
  PostgreSQL and Docker were unavailable in this sandbox, so those guarded
  suites were typechecked but were **not executed here**;
- web API tests cover mint/usage/settlement paths and abort propagation, and the
  session page keeps the provider lazy-loaded;
- deterministic Chromium checks cover 360/375/768/1440, light/dark,
  requesting/listening/partial/reconnecting/error/permission/final/cancelled/
  disabled, keyboard focus, Escape, editable final/send, axe, page errors,
  overflow, and local-only network requests.

## Known gaps and non-evidence

- No real provider, credential, microphone, media permission implementation, or
  WebRTC network path was exercised.
- No provider accuracy, language fairness, first-partial latency, final latency,
  reconnect success, or effective cost was measured.
- Automated axe checks are not a human screen-reader usability study.
- The evidence harness uses real shared components but is not a production
  deployment or live production acceptance test.
- Workspace settings UI/approval workflow, BYOK, diarization, redaction,
  provider fallback, provider-side billing reconciliation, and realtime voice
  are designs only. The policy contract, server/UI gate, conservative durable
  reservation, browser usage observation, terminal settlement, and expired-row
  reconciliation are implemented prototype hardening.
- Deepgram and AssemblyAI endpoint-specific retention/training/residency and
  contract compliance remain procurement/security diligence items.
- OpenAI retention/residency eligibility must be verified for the exact Realtime
  transcription project; general API eligibility must not be assumed.
- Azure pricing is regional and was not reduced to a numeric comparison; Azure
  Speech was not invoked and no Azure inference credits were used.

## Official source inventory

Accessed 2026-07-19 unless otherwise noted. Vendor pages can change after this
record; re-open them before rollout.

### OpenAI

- [Speech to text](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [`gpt-4o-transcribe` model and price](https://developers.openai.com/api/docs/models/gpt-4o-transcribe)
- [`gpt-4o-mini-transcribe` model and price](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe)
- [API data controls](https://developers.openai.com/api/docs/guides/your-data)

### Deepgram

- [Models and languages](https://developers.deepgram.com/docs/models-languages-overview)
- [Streaming speech-to-text documentation](https://developers.deepgram.com/docs/streaming)
- [Pricing](https://deepgram.com/pricing)

### AssemblyAI

- [Streaming quickstart](https://assemblyai.com/docs/streaming/getting-started/transcribe-streaming-audio)
- [Pricing and feature matrix](https://www.assemblyai.com/pricing)
- [Trust Center](https://www.assemblyai.com/trust)

### Microsoft Azure AI Speech

- [Speech-to-text overview](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-to-text)
- [Language and locale support](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support)
- [Speech pricing](https://azure.microsoft.com/en-us/pricing/details/speech/)
- [Speech-to-text data privacy and security](https://learn.microsoft.com/en-us/legal/cognitive-services/speech-service/speech-to-text/data-privacy-security)

### Self-hosted Whisper class

- [OpenAI Whisper](https://github.com/openai/whisper)
- [SYSTRAN faster-whisper](https://github.com/SYSTRAN/faster-whisper)

Codex subscription authorization is unsupported for transcription unless OpenAI publishes a stable authorized entitlement/interface.
