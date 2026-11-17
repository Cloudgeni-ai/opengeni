---
"@opengeni/sdk": minor
---

Agents can run code in the Excel add-in again (`excel_run`). The add-in's task pane page now allows `'unsafe-eval'`, which the add-in kit needs to run the agent's Office.js code; the console and the add-in's other pages keep the strict policy. `@opengeni/sdk/office` exports `OFFICE_RUN_SCRIPT_SOURCES`, the script sources a product's own pane page must allow. In the pane, Excel for Mac's add-in info button no longer covers the header's buttons, and the workspace picker groups workspaces under their organization.
