# Agent calls

An agent can ring a person's phone for a live voice conversation. The phone
shows the platform's own incoming-call screen (CallKit on iOS), including on the
lock screen. Answering joins the chat's existing voice call, which opens by
saying why the agent called, and the conversation lands in that chat.

## Principles

- **Off until the person turns it on, per phone.** Nothing rings until the
  person turns on "Let agents call this iPhone" in the app's settings on that
  phone. A second switch, "Teammates' agents too", lets agents working for other
  members of the workspace call them. Both are off by default.
- **The agent picks a person, never a device.** By default it calls the person
  it works for. Every phone of that person that allows calls rings at once; the
  first to answer takes the call and the others stop ringing.
- **The server decides whether a call may ring**: consent, one ringing call per
  person, rate limits. iOS Focus and Do Not Disturb apply as to any call.
- **One voice path.** An answered agent call is an ordinary chat voice call with
  one extra opening context entry. There is no second voice stack.

## Flow

1. The agent calls `call_user` with a short `reason` (shown on the ring screen
   and in the chat) and optionally a `recipient`: another workspace member by
   email or name, who must have "Teammates' agents too" on.
2. The server checks consent and limits, creates an `agent_calls` row
   (`ringing`, deadline 40 s), appends `session.agentCall.ringing`, and queues
   one ring per eligible phone through the native push outbox:
   - iOS: an APNs VoIP push (`apns-push-type: voip`, topic `<app id>.voip`,
     expiring at the deadline) to the phone's PushKit token. The ring screen
     shows the reason as the caller; the call handle is the chat, so calling
     back from the Phone app's recents opens that chat.
   - Android: not offered in this version; the setting shows on iOS only. The
     dispatcher already sends a high-priority "… is calling" notification for
     an Android device with the rule, as the base for a full-screen ring later.
3. The tool waits while the phone rings, like `session_wait`, and returns the
   outcome directly: `answered`, `declined`, `missed`, or `cancelled` when the
   turn stopped. There is no background sweeper: the waiting tool, or the next
   read of the call, settles a call whose deadline has passed.
4. The app, launched in the background if needed, reports the call to CallKit
   immediately (iOS requires this for every VoIP push) and follows the call's
   state while it rings.
5. Answer: the app claims the call (`POST /v1/workspaces/:ws/agent-calls/:id/answer`).
   The first claim wins; the other phones end with "answered elsewhere". The app
   then starts the chat's realtime voice call. When that voice call starts, the
   server attaches the call this person just answered in this chat and adds a
   context entry telling the voice model it placed the call and why, so it
   greets them and says so.
6. Decline on any phone, the deadline, or the turn stopping ends the ring
   everywhere. The outcome is appended as `session.agentCall.settled`, so the
   chat shows "Called you · Answered / Declined / Missed". A missed call also
   posts a normal notification ("Missed call", with the reason) that opens the
   chat. A declined call needs no notification: the person just declined it.

## Limits

- One ringing call per person at a time.
- At most 3 calls per chat per hour. After a decline, that chat cannot ring the
  same person again for 15 minutes.
- Refusals tell the agent what to do instead (notify the person), never to
  retry.

## Storage

- `native_push_devices`: rules `call` and `call_members` (both off unless the
  person turns them on; `call_members` requires `call`), and `voip_token` for
  iOS PushKit. An iOS phone without a PushKit token cannot take calls.
- `agent_calls`: id, workspace, session, callee and caller, caller label,
  reason, state, phones rung, deadline, answering phone, voice call id,
  timestamps. Workspace row-level security, owner-run functions for push.

## Products embedding Opengeni

`session.agentCall.ringing` and `session.agentCall.settled` carry what a
product needs to ring its own app with its own push credentials. The shared
React Native package provides the CallKit and PushKit side
(`useIncomingAgentCalls`, `useNativeVoipToken`), and the SDK has
`getAgentCall`, `answerAgentCall` and `declineAgentCall`.

## Testing

CallKit and PushKit do not ring in the iOS Simulator. The server state machine,
the push dispatch and the app's handling are unit tested; the full ring is
verified on a real phone through TestFlight.
