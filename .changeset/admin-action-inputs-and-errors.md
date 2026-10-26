---
"@opengeni/contracts": minor
"@opengeni/api-router": minor
---

Agents operating Opengeni through the organization MCP actions (and admin access) can now see what each action takes and recover from mistakes. `admin_action_describe` and `opengeni_action_describe` show a `requestSchema` for every action whose route validates its body with a contract (including session events, steering, Skill saves and vault actions) and a new `queryParameters` list. An invalid request answers 400 or 422 with code `validation_failed`, a message that names each bad field, and `details.issues`; invalid query parameters that used to answer 500 or an unnamed error now do the same. Every 410 now has the new error code `gone`, and a retired route also returns `details.replacement`; retired actions are hidden from action search, and describe or call names their replacement. A JSON list too large for one action result keeps as many whole items as fit, with item counts and a hint naming the paging parameters to call again with, instead of being cut mid-item. New contract exports: `SaveWorkspaceSkillRequest`, `ApplyWorkspaceSkillRevisionRequest` and `RemoveWorkspaceSkillRequest`.
