# Setup card results say the chat continues on its own

No system-prompt or tool-description text changes. The result message of
`capability_authorization_request` (for an MCP server or connector
recommendation) and both `setup_requested` messages of
`custom_mcp_setup_request` gain one sentence (+~100 bytes per posted card).

After a person finished a setup card, models sometimes asked them to send a
message such as "connected", although the platform already resumes the chat
when the setup completes. Integration-definition cards already said so; these
results did not, so the model had no fact to rely on. The sentence states that
fact for any integration, model or route:

```text
+ When the person who asked finishes it, you get an update and continue then, so don't ask them to tell you when they're done.
```
