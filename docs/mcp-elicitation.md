# MCP elicitation

An MCP server can ask the person a question in the middle of a tool call:
confirm this send, pick an account, or fill in a missing field. Opengeni shows the question as an ordinary approval of that
same call. The person answers it in the approval card, possibly hours later,
and the call continues where it stopped. The model never sees the question; it
only sees the call's final result.

This lets a server decide per call what needs a person. Opengeni's own approval
settings work per tool and deliberately never choose an easier policy from
argument text ([tool approvals](tool-approvals.md)). A server that knows its
domain, for example which recipients are safe, can let most calls through and
ask only about the rest.

## Protocol

Opengeni implements form-mode elicitation from MCP revision 2026-07-28, using
its multi round-trip pattern:

1. A model's tool call declares `elicitation: { form: {} }` in that
   request's `io.modelcontextprotocol/clientCapabilities` `_meta`.
2. The server may answer with `resultType: "input_required"`, `inputRequests`
   (one or more `elicitation/create` requests) and an opaque
   `requestState`.
3. Opengeni pauses the call as an approval and stores the requests and
   `requestState` with the paused call, outside the session event log.
4. When the person answers, Opengeni retries the same `tools/call` with a new
   JSON-RPC id, `inputResponses` and the byte-exact `requestState`. Approving
   sends `action: "accept"` for each request, with the form's content.
   Declining sends `action: "decline"`.
5. The server returns the final result or asks again. Each new question is
   another approval of the same call. After 10 questions the call stops with
   an error result.

An `input_required` result without `inputRequests` is retried immediately with
its `requestState`, without asking anyone (at most 10 times in a row).

Declining is a rejected approval that the server is told about. The retry
carries the decline, so the server can release whatever it was holding (a
parked draft, a reserved slot) and finish the call its own way, typically with
a result such as "Not sent." The model then receives that result followed by
"The person declined <server>'s question." or, when the person wrote a message,
"The person declined <server>'s question and said: <message>". A server may
also answer a decline with another question; that pauses the call again,
within the same 10-question limit. Stopping or replacing the turn cancels the
call the same way any open approval is cancelled; the specification lets a
client simply not retry, so the server is not called then.

### Only forms

URL mode (asking the person to open a web page) is not offered: Opengeni never
declares it, so a compliant server does not ask. A server that asks anyway, or
sends a form outside the restricted schema, gets no answer, and the call ends
with an error result the model can read ("The MCP server asked for input this
client cannot provide (a web page to open), so the tool call did not finish.").

Approvals do not expire, so the answer can come hours or days later, from an
unattended run as well as a chat. The server decides whether its
`requestState` is still good; it can finish, ask again or return an error.

Only the 2026-07-28 exchange is supported. Connections that negotiate the 2025
protocol never declare elicitation: their server-initiated `elicitation/create`
request needs an open stream that cannot outlive a worker. Sampling and roots
are not declared either. A compliant server refuses to ask for them
(`MissingRequiredClientCapability`); a server that asks anyway gets no answer,
and the call ends with an error result the model can read.

Only model calls to third-party MCP servers declare elicitation. Opengeni's own
servers, Codemode, Sites and other programmatic callers do not, so a compliant
server never asks them. Calls a tool's operation recovery journals do not
declare it either, because they must finish in one exchange.

## Approval shape

`session.requiresAction` approvals for such a call carry `elicitation`:

```json
{
  "id": "call_123",
  "name": "send_message",
  "arguments": "{\"to\":\"Sam\",\"text\":\"On my way\"}",
  "elicitation": {
    "server": "Messages",
    "round": 1,
    "requests": [
      {
        "id": "confirm",
        "message": "Send this message to Sam?",
        "requestedSchema": { "type": "object", "properties": {} }
      }
    ]
  }
}
```

`requestedSchema` is the server's restricted form schema: flat string, number,
integer, boolean, single-select and multi-select fields. `round` counts the
questions this call has asked, starting at 1. A server can ask again after an
answer, under the same approval id, so each question has its own round.

Approve with the answers keyed by request id, naming the round you answer:

```json
{
  "type": "user.approvalDecision",
  "payload": {
    "approvalId": "call_123",
    "decision": "approve",
    "elicitationRound": 1,
    "content": { "confirm": {} }
  }
}
```

Approving requires `elicitationRound`, and it must be the current question's
round. The API answers 422 otherwise, so an approval sent for an earlier
question (an old Slack card, a retried request) or by a surface that never
showed the question cannot answer the server's current one. Rejecting needs no
round: declining is always safe to deliver.

The API validates `content` against each schema (required fields, types,
lengths, bounds and choices) and refuses an answer that does not match (422
with the reason). A request without required fields can be approved without
`content`. Approval authority is unchanged: whoever may decide the session's
approvals may answer. The recorded decision carries the round and the complete
answer, the form's defaults included. A rejection carries no answer.

Answers are recorded in the session's events, which the session's people can
see, and sent to the server. They are never added to the model's input: the
model sees only the call's result, plus the person's own message when they
decline.

`mcpElicitationKind(request)` in `@opengeni/contracts` sums up how a person
answers: `confirm` (nothing to fill in) or `form` (fields to fill in).

## Where the person sees the question

Every approval surface shows the server's question itself, not just the tool
name.

| Surface              | Confirmation                                         | Form                                                   |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Session (web, React) | Question, Allow, Decline                             | Question and form, Send answer, Decline                |
| Session (native)     | Question, Allow, Decline                             | Question and native form, Send answer, Decline         |
| Web inbox            | Question as the title, "<server> asks", Allow, Deny  | Answer opens the session on the form; Deny             |
| Native inbox         | Question as the title, "<server> asks", Allow, Deny  | Answer opens the session on the form; Deny             |
| Phone push           | "<server> asks: <question>"; tapping opens the app   | The same text; tapping opens the app                   |
| Slack (private DM)   | Question in the card, Allow, Decline                 | Question in the card, Decline and "Answer in Opengeni" |

Inbox items for such approvals carry `serverQuestion: { server, kind, round }`.
`kind` is `confirm` only when the item's title shows the whole question (one
question, nothing to fill in, at most 200 characters), so Allow on the item
answers exactly what the person read; anything else is `form` and is answered
in the session. Allow sends `elicitationRound: round`. A server that asks again
on the same call reopens its inbox item with the new question, even one the
person had set aside.

Phone push payloads carry `serverQuestionKind` (`confirm` or `form`) for every
server question, so the lock screen offers no one-tap answer: an approval must
name the question it answers, and a lock-screen action could act on a newer
question than the one the notification showed.

Slack answers confirmations in the card; each Allow button carries the round
it was posted for, so a card for an earlier question cannot answer a later
one. Slack answers forms in Opengeni because a Slack form is a modal that has
to be opened within three seconds of the click, while Slack decisions go
through Opengeni's durable action queue. A Slack card is also posted once per
event and replayed byte for byte, so it shows the question from the event, not
live state. A question too long for one Slack section is answered in Opengeni
too. In a shared channel the card stays generic, as for any approval with
private details.

The React `ApprovalSurface` shows which server is asking, its message, the
call it belongs to and the form, with the server's defaults filled in. The
person reviews and edits the answers before sending them. `onApprove` receives
`{ content, elicitationRound }` as its second argument; an embedder with its
own approval UI reads `approval.elicitation` and sends both with the decision.
The form uses native validation, one fieldset and legend per question, a label
for every field, the field's description as its accessible description, and
marks optional fields.

## Timeouts

Approvals do not expire on their own. In a scheduled run with a human-wait
limit, the limit rejects the waiting approval, and the server receives that as
a decline. Each round has its own limit decision, so a question asked again
after a timeout gets its own.

## Ledger

A connector action with an execution record (an Ask tool, or one with a saved
rule) moves from `executing` back to `pending` each time its server asks, and
its `input_round` goes up by one. Each round gets its own decision, so a
second question, or an answer that arrives in a later worker attempt, records
a new decision instead of colliding with the first. The record keeps the
decision of the current round only; the audit log keeps every round. An Allow
call without a saved rule keeps having no record.

A rejected record moves to `executing` exactly once more, to deliver the
decline to the server (audit outcome `decline_delivery`); the server's answer
then settles it as usual. If the server asks again, the record opens a new
round.

Opengeni's tool policy and the server's questions are two layers. The policy
decides whether the agent may use the tool at all; the server decides, per
call, what needs the person. A tool set to Ask is approved before it runs and
then answered for each question its server asks. Set the tool to Allow to
leave every decision to the server.

## Not supported yet

- URL mode (pages to open).
- Sampling and roots inside `input_required`.
- Elicitation on `prompts/get` and `resources/read`.
- Elicitation for Codemode and other programmatic callers.
