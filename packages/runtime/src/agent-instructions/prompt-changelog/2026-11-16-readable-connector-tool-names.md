# Readable connector tool names, reference names, Skill tool lists

No system-prompt sentence changes. Connector tool names, Codemode paths, a
few tool-result texts, the `ogtool` usage text and the bundled
skill-management Skill change.

Connector tools are called by `<namespace>__<tool>`, where the namespace is
the connector's readable name and a 6-hex tag of the connected account
(`orders_3f2a1c__orders_swap_item`), instead of
`mcp_<24 hex>__orders_swap_item` or `account-<64 hex>__…`. A configured
server's namespace is its id when that is a readable slug. The name depends
only on the tool's identity, so it never comes to mean another account's or
connector's tool, and adding or removing an account renames nothing else. The
first-party servers keep `server__tool`. Agent Codemode paths become
`<namespace>.<tool>` instead of `account_<64 hex>.<tool>_<digest>`.

Why: the hash differed per tool, so a model that knew one tool could not
write a sibling's name and spent rounds loading each tool and listing the
Codemode catalog. Size: a connected account's tool name shrinks from 56 to 64 characters to its
tool name plus about 15; the longest measured in a real catalog is 33.

New tool-result texts (a call to a tool's former name runs nothing):

```text
- Tool "<name>" is not currently authorized or available. Search again before retrying.
+ Nothing ran: <former name> is this tool's former name. Call it as <current name>.
+ Nothing ran: "<former name>" is this tool's former name. Call it as "<current name>".
+ Former name of <current name>.
```

The second is `tool_invoke`'s answer, with code `tool_renamed`; the first
line remains for names that are neither current nor former. Removed from
`tool_list` (digests no longer exist):

```text
- namePrefix is one tool's own digest, so this lists every tool of that tool's connection.
```

Codemode name resolution (`ogtool show/call`, the native client, the
`tools` object) answers a miss, an ambiguity, or a call by a tool's own name
alone with:

```text
+ Unknown Codemode tool: <name>. Closest: <path>, <path>.
+ Ambiguous tool: <name> matches <path>, <path>. Use one of these paths.
+ Call a tool by its path, not its own name alone: <path>.
```

`ogtool` usage:

```text
- ogtool show <tool-path-or-model-name>
- ogtool call <tool-path-or-model-name> [json-object | @file | -] [--full] [--save-image <path>]
+ ogtool show <tool-name> [<tool-name>...]
+ ogtool call <tool-name> [json-object | @file | -] [--full] [--save-image <path>]
+ a tool-name is its path (server.tool) or server__tool; show also accepts the tool's own name when only one tool has it, and prints an array when given several names
```

Bundled skill-management Skill:

```text
+ A Skill that uses particular tools can list them in an optional `tools:` list (`server.tool`, or a tool's own name); reading the Skill loads them, so they can be called without a tool search.
```

Why this is general: it applies to every MCP server and Skill, and names no
provider.
