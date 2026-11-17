---
"@opengeni/runtime": patch
"@opengeni/tool-gateway": patch
"@opengeni/codemode": patch
---

A tool call whose arguments do not match the tool's input schema no longer asks anyone to approve it. Connector and other approval-gated tool calls are now checked against the schema before the approval check, so the model gets the usual "not called, correct the arguments" error at once instead of a person getting an Ask card for a call that could never run. When string-encoded arguments are repaired, the approval card and its action fingerprint now show the repaired arguments, which are the ones the call runs with. The tool gateway gains `admitModelArguments`, which runs the same argument check as a model call without calling the tool.
