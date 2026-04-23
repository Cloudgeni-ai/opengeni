# OpenAI Agents SDK: Skills (reference)

Snapshot date: 2026-04-23.

This note records how **skills** fit into the **Python** OpenAI Agents SDK (`openai-agents`, e.g. 0.14.x) and how that differs from other "skills" surfaces, so we can wire them into our `SandboxAgent` later without re-deriving behavior.

## Sandbox agent and capabilities

- **`SandboxAgent`** is a normal `Agent` with a **`default_manifest`** and a **`capabilities`** list. Execution uses **`RunConfig` → `SandboxRunConfig`** (client, session, manifest, etc.).
- **Capabilities** extend the sandbox: they shape the workspace, append instruction fragments, and can register tools. Platform code: `packages/cloud_agent_platform/.../runtime/openai_agents.py` (`build_sandbox_agent`).

Canonical docs:

- [Python sandbox guide](https://openai.github.io/openai-agents-python/sandbox/guide/)
- [OpenAI: Sandbox agents](https://developers.openai.com/api/docs/guides/agents/sandboxes)
- [Python: `Skills` capability reference](https://openai.github.io/openai-agents-python/ref/sandbox/capabilities/skills/)

## The `Skills` capability (Python SDK)

Import pattern:

`from agents.sandbox.capabilities import Skills` (often combined with `Filesystem`, `Shell`, etc.).

**Purpose:** mount agent skills into a **Codex-style auto-discovery root** *inside* the sandbox workspace (default `skills_path`: **`.agents`**, relative to the manifest root).

**Skill shape:** each skill is a **directory** with a **`SKILL.md`** file. The SDK reads **YAML front matter** in `SKILL.md` for **`name`** and **`description`** to build the skill index the model sees in instructions.

The capability adds a **"## Skills"** / "Available skills" block to the agent instructions. If skills are **lazy**, extra guidance tells the model to call **`load_skill`** before reading full files.

## Three ways to supply skills (pick exactly one)

The SDK allows **only one** of: inline **`skills`**, **`from_`**, or **`lazy_from`**.

| Mode | Behavior |
|------|----------|
| **`skills=[Skill(...), ...]`** | Inline skills: `name`, `description`, `content` (e.g. `SKILL.md` as string/bytes or file entry), plus optional `scripts` / `references` / `assets` as directory entries. Best for small, program-defined skills. |
| **`from_=<directory-like entry>`** | E.g. `LocalDir(...)`, `GitRepo(...)`. **Eager:** bundle is staged up front. Good for a fixed repo of skills. Example pattern: [OpenAI: Load skills](https://developers.openai.com/api/docs/guides/agents/sandboxes) |
| **`lazy_from=LocalDirLazySkillSource(...)`** | **Lazy:** index from a host directory (subfolders with `SKILL.md`); materialize **on demand** via the **`load_skill`** tool. Adds that tool; use when many or large skills should not all land in the workspace at once. |

**`load_skill`:** only exposed when `lazy_from` is configured. Without lazy loading, the Skills capability does not add a `load_skill` tool; skills are mounted + described via instructions.

## Contrast with other "skills" APIs (do not conflate)

1. **Responses API + shell tool** — Skills can be uploaded (`POST /v1/skills`) and attached on **`tools[].environment.skills`** for **hosted** or **local shell**. That is **not** the same as attaching **`Skills`** on a Python `SandboxAgent`; it is a different execution path. [Tools & skills](https://developers.openai.com/api/docs/guides/tools-skills), [Cookbook: skills in API](https://developers.openai.com/cookbook/examples/skills_in_api).

2. **Codex CLI/IDE** — Scans repository/user paths (e.g. **`.agents/skills`**). Python **`Skills`** defaults to a **`.agents`** root in the **sandbox** workspace to align with Codex-style discovery, but wiring is through the **sandbox manifest + capability**, not the Codex app. Authoring and `SKILL.md` expectations overlap: [Create a skill (Codex)](https://developers.openai.com/codex/skills/create-skill).

## Integration direction for this repo

- Today, `build_sandbox_agent` uses **`[Filesystem(...), Shell()]`** only. To enable skills, add **`Skills(...)`** with the right mode (`from_` vs `lazy_from` vs inline) and keep **`default_manifest.root`** (currently `"/workspace"`) consistent with where skills are staged.
- **Eager:** `from_=GitRepo` or `LocalDir` for versioned or repo-bundled skills.
- **Lazy:** `LocalDirLazySkillSource` when the index should stay small and skills copy in on demand.

## Related in-repo research

- `skills/openai-agents-sdk-research/references/`, especially sandbox and capability notes (e.g. `sandbox-agents-and-state.md`, `sources-index.md`).
