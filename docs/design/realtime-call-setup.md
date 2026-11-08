# Realtime call setup

## Evidence and target

The target is roughly one second between Answer (or starting an outgoing call)
and hearing the agent. Three observed incoming calls before this change had the
following critical paths. These are server timestamps from the answered-call,
realtime-mode, connection and physical subscription-request ledgers, not a
measurement of the first audible phoneme on the phone. Values are milliseconds,
rounded independently.

| Stage | A | B | C |
| --- | ---: | ---: | ---: |
| Answer claim to realtime mode creation | 575 | 641 | 330 |
| Mode creation to connection claim | 546 | 116 | 102 |
| Connection claim to provider config request | 164 | 117 | 80 |
| Provider configuration request | 1300 | 920 | 967 |
| Between configuration and call requests | 85 | 146 | 57 |
| Provider call creation request | 2123 | 1567 | 835 |
| Provider response to saved SDP answer | 19 | 36 | 39 |
| Saved SDP to acknowledged provider startup | 900 | 1471 | 657 |
| **Answer claim to startup acknowledgement** | **5711** | **5014** | **3067** |

The HTTP negotiation envelopes for B/C were 2831/2003 ms. Answer HTTP handling
itself was 32/18 ms; catalog HTTP handling was 42/43 ms; begin HTTP handling was
206/192 ms. The gaps include network, device scheduling and uninstrumented
server work: they must not be attributed entirely to the microphone or database.
The observed deployment exposed HTTP logs and Prometheus, not an exported trace
backend. Historical token, history and lease substeps therefore cannot be
separated retrospectively. The new `Realtime setup phase completed` logs report
owner, candidates, lease, history, token, config, pre-dispatch fence, provider
call, and release durations under the request trace ID, with no request content.

## Design

- The native call host resolves the existing client/workspace-scoped catalog
  before a call. Ringing mounts the same call component that Answer will use,
  loading session data, events and control state without presenting an in-app
  call screen or starting/recovering a realtime mode.
- The shared SDK controller can prepare a local peer connection, data channel,
  and a sendrecv audio offer with a null sender track. No microphone permission
  request, capture, server mutation or provider call occurs during preparation.
  Answer attaches the microphone with `replaceTrack` and consumes that exact
  offer. A host without transceivers reuses the peer/channel and creates SDP
  after acquiring audio. Outgoing calls prepare alongside admission/capture.
- Decline, remote settlement, ring timeout, disposal and a hang-up during the
  answer claim release preparation. Late asynchronous work cannot start voice
  after disposal. The successful answer keeps the mounted component and peer.
- Microphone permission/capture stays at Answer, concurrent with admission.
  Prompting before Answer would interrupt ringing and capture before acceptance;
  platform call-audio activation is still owned by the native call adapter.
- The server reads history concurrently with token/config resolution, after
  owner/credential selection. Both branches settle before the operation lease
  releases. The same history/instructions are sent, and a 401 still permits
  exactly one credential refresh. No other call outcome is replayed.
- Successful provider configuration is cached for five minutes in each API
  process, scoped to organization, connection, provider account, client version,
  and FedRAMP mode (and isolated by injected fetch implementation). It is bounded
  to 256 entries. Unknown/network fallbacks are not cached. A positively observed
  unsupported protocol uses the existing pinned fallback and can be cached.
  A rejected call invalidates its entry for the next call. Authority and operation
  leases are always checked live. Pending authenticated fetches are not shared:
  their lease and cancellation belong to the initiating request.

## Why not create the provider call while ringing?

Not in this change. The existing begin operation claims an answered call and
freezes authority; starting it during ring changes session ownership and may
block normal agent work. Provider call creation also commits subscription work
and sends session context before a person accepts. Several ringing phones would
create several provider calls, including declined, timed-out and losing answers.
Closing the local peer does not prove remote creation was cancelled, particularly
when an HTTP outcome is unknown. The implemented provider protocol has no proven
transport-only prepare/hold/release contract for suppressing the opening without
losing or changing model-visible output.

This is a deliberate semantic boundary, not a one-second claim. A cached config
removes one observed 0.92–1.30 second round trip; ring preparation removes the
post-answer catalog/session-loading waterfall and local offer work. Provider
creation alone was 0.84–2.12 seconds, before media connection and actual speech.
Reaching one second reliably needs a verified provider-level held-call contract
(single ownership, explicit release on Answer, terminal cleanup and accounting)
or a faster provider path. Model instructions, initial items, opening behavior
and transcript injection are unchanged here.

## Verification boundaries

Tests cover account/version/TTL isolation, failed config reads, authentication-only
retry, parallel history/token/config work and lease lifetime; native ring/answer/
decline/timeout/remote-settlement/disposal races; local offer consumption, late
preparation cancellation, microphone attachment and resource cleanup.

A real Chromium loopback using the actual SDK preparation/transport created an
offer with zero microphone tracks in 70.4 ms, then connected the data channel
33.9 ms after the test Answer. Replacing the null sender track delivered audio
(1894 outbound bytes in the first 500 ms). This verifies WebRTC mechanics, not
provider latency or physical iOS/Android audio. Production after timings require
the merged server and mobile release; do not substitute loopback timings for
answer-to-audible measurements on a phone.

## Generated-silence preconnection experiment

A subsequent real-provider experiment attached an entirely generated zero-gain
audio track before negotiation, held the connection for 20,001 ms, and replaced
that track at the simulated Answer. It did not acquire a hardware microphone.
No opening/context append was sent during the hold; the remote track was disabled.
No turn, input transcript, or output transcript event arrived during the hold;
only session-start and usage events arrived. This WebRTC protocol emits neither
response.created nor output_audio.delta even when speaking, so their absence is
not the proof. The remote-track gate prevented playback independently; it does
not by itself prove the provider emitted no audio RTP packets.

After Answer, the unchanged opening append was sent in 12 ms and acknowledged
105.5 ms later. The first output transcript arrived 1,030 ms after the append;
first nonzero decoded RTP audio energy arrived after 1,701.1 ms (1,713.1 ms after
Answer). A later generated known microphone phrase produced an input transcript
in 1,669.3 ms. This is one successful provider sample, not a phone latency claim.
The fresh connection's setup took 6.76 seconds before the hold, illustrating why
moving connection establishment off the post-answer path can matter even when
generation itself takes over a second. The diagnostic call was ended and archived.

This establishes a transport gate in Chromium, not a native implementation.
The installed react-native-webrtc version has no JavaScript generated-audio-track
API. Its native factory accepts a custom RTCAudioDevice on iOS or AudioDeviceModule
on Android, but those replace a shared audio-device implementation and need native
implementation and device validation. Muting a getUserMedia track is not equivalent:
it would still acquire a microphone before Answer. The preconnection prototype
must remain unshipped until a genuinely generated silent-input path works on both
native platforms and its answer, timeout, cancellation and ownership cleanup are
verified. Local SDP preparation remains independent of that prerequisite.

### Null-track hold bisection

To distinguish track delivery from provider response behavior, seven fresh calls
tested a null sender during connection establishment, then attached the same
generated audio source at simulated Answer. The unchanged opening append was
followed by a known spoken phrase ten seconds later. RTP statistics were sampled
every 50 ms; a zero-second hold means attachment immediately after activation,
not before negotiation. Each completed diagnostic call was ended and archived.

| Null-track hold | Attach to first outbound RTP | Opening to first decoded audio, before user phrase | Phrase to input transcript |
| --- | ---: | --- | ---: |
| 0 seconds | 54 ms | 1253 ms | 1592 ms |
| 2 seconds | 33 ms | None in 10 seconds | 1309 ms |
| 5 seconds | 108 ms | None in 10 seconds | 1360 ms |
| 10 seconds | 90 ms | None in 10 seconds | 1608 ms |
| 20 seconds | 117 ms | None in 10 seconds | 1514 ms |
| 20 seconds; wait for RTP before append | 96 ms | None in 10 seconds | 1445 ms |

Every non-rotation opening was acknowledged in 52–93 ms. All nonzero-hold,
non-rotation calls started a turn only after the spoken phrase and then produced
audio. The RTP-gated variant waited
for six outbound packets plus another 200 ms before appending; this did not restore
the opening. A previous equivalent seven-packet experiment had the same outcome.
No turn or input/output transcript appeared during any hold, and outbound packet
counts remained zero until attachment.

The late microphone is therefore not broken: every non-rotation sample transmitted
the known phrase successfully. The observed change in autonomous opening behavior
lies between zero and two seconds without early RTP; this is an experimental bound,
not an established provider timeout or a documented protocol guarantee. The
generated-silence hold above avoids it, but has no existing cross-platform native
implementation. A full 20–30 second null-track ringing gate is not supported by
these results, so provider preconnection remains unshipped.

The broker and upstream Codex client expose call creation, not an existing-call
SDP-update operation. As a separate control, a fresh offer after a 20-second hold
was submitted through supported rotation. Creating that replacement provider call
took another 2338 ms after Answer. Reusing the peer in that experiment produced no
append acknowledgment, audio or input transcript. It is neither proof of in-place
renegotiation support nor a latency solution; production rotation uses a separate
replacement transport. No new model event, instruction or rendered text was added.

### Real-provider controls

Bounded Chromium tests through the real broker used a fresh idle chat, the
unchanged rendered opening, and a synthetic silent microphone (no spoken user
input before the opening). The provider returned audio over RTP; it did not emit
`response.created` or `output_audio.delta` on this WebRTC data channel. First
decoded nonzero RTP audio energy, sampled every 50 ms, is the observable onset,
not a physical speaker measurement.

| Control | Append receipt | Append to first decoded audio |
| --- | ---: | ---: |
| Track attached before creating SDP | 69.5 ms | 1120.4 ms |
| Prepared null-track SDP, replaceTrack **before** provider negotiation | 65.7 ms | 1041.6 ms |
| Same prepared-offer path, followed by a known microphone phrase | 70.4 ms | 1042.5 ms |

The last control also emitted `input_transcript.added` 1761.5 ms after the
synthetic phrase began, with 1070 outbound and 874 inbound audio RTP packets.
Thus local preparation and subsequent microphone attachment before negotiation
work in both directions with this provider, not just browser loopback. The
provider-creation-to-data-channel gap was 201–284 ms in these controls.

A different experiment created the provider connection **before** attaching any
track and held it for 20 seconds. It emitted no speech during the hold. Attaching
a silent track afterward and sending the same opening produced a 71.4 ms append
receipt but no audio within 16 seconds. This does not establish a supported
held-call release contract. Do not equate that speculative path with the tested
local-only preparation above, or ship it on the strength of loopback tests.

These controls show that an opening append can trigger speech without spoken
user input; they do not explain every historical long-history call or establish
a latency percentile. The observed 1.04–1.12 second post-append delay is outside
the catalog, admission and initial provider-creation chain. No new response
trigger or model-visible text is introduced by this change.
