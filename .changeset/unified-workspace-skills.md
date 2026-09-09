---
"@opengeni/api-router": patch
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
---

Unify installed and authored workspace Skills behind one versioned text-folder
store and shared editor. Derive names and descriptions from mandatory SKILL.md
frontmatter, provide eager sandbox-free reading with exact requested paths, and
expose lazy search, install, save, checkout, and publish tools under workspace
Learning policy. Preserve workspace customizations on source updates and let
embedding hosts narrow bundled guidance independently of lazy tool discovery.

Migration 0432 is a maintenance cutover: drain old runtimes and use the
parser-backed migration runner. Preserve historical snapshots and archive legacy
configuration before conversion; invalid or pinned headerless configuration
requires explicit repair before migration. See docs/skills-lifecycle.md for the
deployment procedure and compatibility boundaries.