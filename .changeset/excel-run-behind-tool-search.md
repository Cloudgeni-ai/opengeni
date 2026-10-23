---
"@opengeni/runtime": patch
---

`excel_run` is no longer loaded up front in every chat. Agents in chats with no workbook read "here" as an open workbook and probed Excel; in the Excel add-in, each message names the tool, so the agent loads it by exact name.
