---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/runtime": patch
---

A session whose agent starts from `capabilities: "none"` no longer receives the
bundled Opengeni guides (`opengeni-help`, `opengeni-client`, ...) when
`bundledSkillIds` is omitted; an explicit list still opts in exactly, and
`"all"` or legacy configurations keep the bundled defaults. Session create
freezes the empty selection so the record, replay, and children agree.

`command_read` and `command_wait` are now owned by attached compute
(`FIRST_PARTY_MCP_TOOL_CAPABILITIES` reports `"sandbox"`) and are attached, and
listed in `effectiveTools`, only when a managed sandbox or Connected Machine is
attached to the turn. `wait_for_input` and `set_session_title` are unchanged.
New exports: `AgentFirstPartyToolOwner`, `isDerivedAgentToolOwner`,
`AGENT_SANDBOX_MECHANIC_TOOL_NAMES`, `bundledSkillSelectionForAgentConfig`, and
the `sandboxAttached` tool-environment flag.
