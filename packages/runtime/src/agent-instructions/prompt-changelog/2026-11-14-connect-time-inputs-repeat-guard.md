# Connect cards that ask for connect-time inputs, and a repeated-call guard

No system-prompt text changes. One tool-description parameter is added, and
some tool-result and card texts change.

`capability_authorization_request` gains an `inputs` parameter (+128 bytes of
description):

```text
+ When setup.connectInputs lists values the card asks for: those the person already gave, by id. The card shows them filled in.
```

The setup detail for an integration whose connections each need a value first
(today Microsoft Dynamics) no longer tells the agent to collect the address in
chat and call `custom_mcp_setup_request`; the card collects it:

```text
- Each connection is one Dynamics environment. Ask the person for the web address they open Dynamics at (for example https://contoso.crm4.dynamics.com, or https://businesscentral.dynamics.com/<tenant>/<environment> for Business Central; any page of it works). If they don't know it, they can open Dynamics and copy the address bar, or find Environment URL in the Power Platform admin center. Then call custom_mcp_setup_request with name "Microsoft Dynamics" and that address as endpointUrl. Its card signs them in with their Microsoft work account.
+ Each connection is one Dynamics environment. Call capability_authorization_request with capabilityId api:microsoft-dynamics: its card asks the person for the environment address, then signs them in. If they already gave it, also pass it in inputs (endpointUrl) to fill it in.
```

The second and third sentences are generated from the entry's id and declared
inputs (`connectInputsCardDetail`), so any integration that declares
connect-time inputs gets the same wording with its own id, field labels and
input ids. The same text follows "Only for a different environment:" in the
existing details for environments already in the workspace; inputs naming
another environment now get the card even when one is ready.

`capability_authorization_request` used to answer such an entry with
`status: "input_required"`, `cardShown: false` and the detail above. It now
posts the card and answers (labels and the problem come from the declaration):

```text
+ The card was posted. It asks the person for the <labels>, then signs them in; nothing is connected yet. When the person who asked finishes it, you get an update and continue then, so don't ask them to tell you when they're done.
+ What you passed was not filled in: <problem>
```

The second line is added after "nothing is connected yet." only when the agent
passed a value the entry's rule rejects. The existing already-shown wording
("is already in this chat … It was not posted again.") applies unchanged.

Any card result gets this sentence appended when the agent passed `inputs`
that the posted card does not use:

```text
+ The inputs you passed were not used: this card asks for none.
```

Catalog matches for such an entry carry a new `setup.connectInputs` list of
`{id, label}`; no new prose.

Problem texts (shown on the card and returned to the agent; the API returns
them as 422 messages):

```text
+ Enter the <label>.
+ That isn't a Dynamics environment address. Paste the address you open Dynamics at, for example https://contoso.crm4.dynamics.com.
+ That entry doesn't take connection inputs.
```

The Dynamics-specific problem sits in that integration's declaration, next to
its address rule, not in shared code.

Card UI copy (React): one field labelled with the declared label ("Environment
address" for Dynamics, placeholder from the declaration), one button
"Connect" ("Connecting…" while busy), and for a person who can't add
connections:

```text
+ Ask a workspace admin to add <name>. Then you can sign in here.
```

Repeated-call guard: a call the runtime does not run again returns this tool
result (new, 160 bytes):

```text
+ Not run again: this exact call already returned the same result 8 times in a row in this turn. Use that result, change the arguments, or continue with another step.
```

All are general: the inputs parameter, the posted-card message, the empty-field
problem and the card UI are driven by whatever inputs an integration declares,
and the repeated-call notice applies to any tool, model and route. Only the
declaration's own address problem names its integration.
