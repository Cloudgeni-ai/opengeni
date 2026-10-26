# MCP elicitation

An MCP server can ask the person a question in the middle of a tool call:
confirm this send, pick an account, fill in a missing field. Opengeni shows the
question as an ordinary approval of that same call. The person answers it in
the approval card, possibly hours later, and the call continues where it
stopped. The model never sees the question; it only sees the call's final
result.

This lets a server decide per call what needs a person. Opengeni's own approval
settings work per tool and deliberately never choose an easier policy from
argument text ([tool approvals](tool-approvals.md)). A server that knows its
domain, for example which recipients are safe, can let most calls through and
ask only about the rest.

## Protocol

Opengeni implements form-mode elicitation from MCP revision 2026-07-28, using
its multi round-trip pattern:

1. A model's tool call declares `elicitation: { form: {} }` in that request's
   `io.modelcontextprotocol/clientCapabilities` `_meta`.
2. The server may answer with `resultType: "input_required"`, `inputRequests`
   (one or more `elicitation/create` form requests) and an opaque
   `requestState`.
3. Opengeni pauses the call as an approval and stores the requests and
   `requestState` with the paused call, outside the session event log.
4. When the person approves, Opengeni retries the same `tools/call` with a new
   JSON-RPC id, `inputResponses` (`action: "accept"` and the form content for
   each request) and the byte-exact `requestState`.
5. The server returns the final result or asks again. Each new question is
   another approval of the same call. After 10 questions the call stops with
   an error result.

An `input_required` result without `inputRequests` is retried immediately with
its `requestState`, without asking anyone (at most 10 times in a row).

Declining is a rejected approval: the call does not continue, and the model
receives "The person declined to answer <server>'s question, so this tool call
did not finish." A rejection with a message gives the model the person's words
instead, as for any approval. Opengeni does not send `decline` back to the
server; the specification lets a client never retry. Stopping or replacing the
turn cancels the call the same way any open approval is cancelled.

Approvals do not expire, so the answer can come hours or days later, from an
unattended run as well as a chat. The server decides whether its
`requestState` is still good; it can finish, ask again or return an error.

Only the 2026-07-28 exchange is supported. Connections that negotiate the 2025
protocol never declare elicitation: their server-initiated `elicitation/create`
request needs an open stream that cannot outlive a worker. URL mode, sampling
and roots are not declared either. A compliant server refuses to ask for them
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
integer, boolean, single-select and multi-select fields. Approve with the
answers keyed by request id:

```json
{
  "type": "user.approvalDecision",
  "payload": {
    "approvalId": "call_123",
    "decision": "approve",
    "content": { "confirm": {} }
  }
}
```

The API validates `content` against each schema (required fields, types,
lengths, bounds and choices) and refuses an answer that does not match. A
request without required fields can be approved without `content`, so a plain
confirmation also works from Slack, push and other approval surfaces. Approval
authority is unchanged: whoever may decide the session's approvals may answer.
The recorded decision carries the complete answer, the form's defaults
included. A rejection carries no answer.

The inbox, Slack and push show such a call like any other approval, without
the server's question. Approving from there answers a plain confirmation; a
form with required fields has to be answered in the session (Slack says so,
and the API refuses an incomplete answer with the reason).

The React `ApprovalSurface` shows which server is asking, its message, the
call it belongs to and the form, with the server's defaults filled in. The
person reviews and edits the answers before sending them. `onApprove` receives
the answer as its second argument; an embedder with its own approval UI reads
`approval.elicitation` and sends `content` with the decision.

## Ledger

A connector action's execution record moves from `executing` back to `pending`
when its server asks, so the person's answer is recorded as an approval
decision and the retry executes once under that decision. An Allow call without
a saved rule keeps having no record.

A tool whose policy is Ask is approved before it runs and then answered for
each question its server asks: two decisions for the same call.

## Not supported yet

- URL-mode elicitation, sampling and roots inside `input_required`.
- Elicitation on `prompts/get` and `resources/read`.
- Elicitation for Codemode and other programmatic callers.
- Showing the server's question in the inbox, Slack and push.
