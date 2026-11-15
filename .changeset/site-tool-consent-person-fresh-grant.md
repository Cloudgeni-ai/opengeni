---
"@opengeni/api-router": patch
---

A Site's direct call to a tool set to Ask first now shows the in-Site Send/Cancel confirmation for a signed-in person instead of failing with HTTP 500 ("The workspace could not complete the request"). The confirmation prompt (`POST /v1/workspaces/{workspaceId}/tools/site-consent`) reads what the call would do on the viewer's own account under the same request fence as the call, and that fence requires the person's fresh grant, which only the other targeted tool routes passed. The prompt route now passes it too, so Send approves and runs the call once and Cancel runs nothing.
