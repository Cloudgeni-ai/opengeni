---
"@opengeni/runtime": minor
"@opengeni/db": minor
"@opengeni/worker-bundle": patch
---

A short personal Skill, such as a saved standing preference ("always answer in Norwegian"), now applies without an extra model round trip. The Skill index shows the complete instructions of a single-file personal Skill whose body is at most 1,024 bytes, up to 4,096 bytes in total, in an `instructions` field on its entry, with one notice line explaining that field. Larger, multi-file, workspace and organization Skills stay descriptors that the agent reads on demand, and an index without such Skills renders byte for byte as before.

`SkillCatalogDescriptor` gains an optional `instructions` field, `formatSkillCatalog` applies the per-entry and total bounds and lists shown-in-full entries first, and `skillInstructionsBody` returns a SKILL.md body without its frontmatter. `listSkillDescriptors` takes an optional `personalSkillMarkdownMaxBytes` that also returns `personalSkillMarkdown` for small single-file personal Skills.
