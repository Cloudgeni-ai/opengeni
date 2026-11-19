# Connect card without workspace administration

No sentence of the `"all"` prompt changes, so this entry has no `diff` block.
`capability_authorization_request` (the Connect card tool) now comes with
`workspaceConnectors` as well as `workspaceAdmin`; `capability_catalog_search`
and `custom_mcp_setup_request` stay with `workspaceAdmin`. An agent with
connectors but without admin was told elsewhere to call the card tool (for
example to connect the person's own computer), searched for it, found nothing
and answered with manual instructions instead of showing the card.

System prompt, only for an agent with `workspaceConnectors` on,
`workspaceAdmin` off and the card tool selected: a short section in the
`admin` module's place (+477 bytes; the GitHub sentence below adds 205 bytes
more when `github_connect_link` and the person's own GitHub are available).
Agents with `workspaceAdmin` keep the existing section byte for byte.

```text
+ # Integration setup
+ When the person must connect something for the task, such as an integration or their own computer, call `capability_authorization_request` with the capability ID that a tool result, notice or its description gives, and a task-specific rationale.
+ Showing the card needs no integration-management permission and grants no access; the person completes setup.
+ Never invent URLs or request credentials in chat.
+ After setup, rediscover tools and verify access.
+ For GitHub, `github_connect_link` reports both identities: 'connect my GitHub' or 'do it as me' means the person's own account (Your GitHub), and 'install the GitHub app' means the workspace's GitHub app.
```

Tool and notice text that named a setup tool now names it only for an agent
that has it (all of it is deferred-tool, tool-result or per-turn notice
text, never the cached system prompt):

```text
capability_authorization_request description, first sentence, without catalog search:
- Show a Connect card in this chat for a suitable capability returned by capability_catalog_search with setup.nextAction.
+ Show a Connect card in this chat for something the person must connect for the task, by the capability ID a tool result or notice names, or one named below.

excel_run description, without the card tool (browser alone):
- When someone works on a spreadsheet and no workbook is connected, offer the Excel add-in: capability_authorization_request with <id> shows its install card.

Accounts-need-reconnecting notice, without both catalog search and the card tool:
- ... To offer the fix, capability_catalog_search lists it under setup.reconnect and capability_authorization_request posts a card that reconnects that same account; a new Connect cannot replace it.
+ ..., and that reconnecting it in Connections fixes it; a new Connect cannot replace it.

Setup refusal from a browser or interaction tool, card not posted:
- post the setup card with capability_authorization_request (capabilityId <id>) if that tool is available, and
+ (with the card tool) post the setup card with capability_authorization_request (capabilityId <id>), and
+ (without it) nothing; the exact next step remains.

Connected Machine ready, without sandboxes_list:
- Machines are connected to this workspace; sandboxes_list shows which are online.
+ Machines are connected to this workspace.

Card errors for several broken accounts or an unknown connectionId:
- Pass the connectionId of the one to reconnect, from setup.reconnect in capability_catalog_search. / Search the catalog again for its setup.reconnect.
+ Pass the connectionId of the one to reconnect: <account> (connectionId <id>); ...
```
