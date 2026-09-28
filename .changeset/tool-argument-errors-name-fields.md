---
"@opengeni/tool-gateway": patch
"@opengeni/runtime": patch
"@opengeni/api-router": patch
---

Make rejected tool arguments actionable. When a call does not match the tool's advertised input schema, the gateway error now names each missing, mistyped, or unexpected property (for example `missing required property "context"`), reports up to eight problems plus a count of the rest, and never quotes argument values. `ToolGatewayInputValidationError` gains `issues`, `omittedIssueCount`, and `summary`. The accept/reject decision still stops at the first error; the all-errors pass runs only after a rejection and only for arguments up to 64 KiB serialized.

A model MCP call rejected this way now reads "The tool was not called because its arguments do not match the tool's input schema: ... Correct the named properties and call the tool again." instead of "Please try again", so the model fixes the arguments rather than resending the same call. Other thrown MCP failures keep the existing wording. The workspace tool HTTP call and approval routes return the same summary on their `422` (`code: "validation_failed"`, `details.code: "invalid_tool_arguments"` with `issues` and `omittedIssueCount`); the previous body carried only the bare code as its message.
