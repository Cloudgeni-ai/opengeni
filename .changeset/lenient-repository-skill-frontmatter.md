---
"@opengeni/contracts": minor
"@opengeni/runtime": patch
---

Repository skills with hand-written SKILL.md headers that are not strict YAML (for example an unquoted `: ` in the description, tab indentation, or a description that starts with `[`, `` ` `` or `@`) are no longer skipped. When strict YAML fails, `parseLenientSkillFrontmatter` recovers the `name` and `description` lines, and the worker logs the parser code and key names (never values). A header without exactly one usable `name:` line is still skipped, and each entry in the "Skipped repository skills" notice now carries a `reason`. `parseSkillFrontmatter` now throws `SkillFrontmatterError` (same messages, plus a bounded `reason`). Managed and inline Skill admission stay strict.
