---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

Agents in embedding products no longer see or repeat another product's name.

- Bundled Skills have neutral names and ids: `builtin:documents`, `builtin:spreadsheets`, `builtin:presentations`, `builtin:sites`, `builtin:visualize`, `builtin:secrets`, `builtin:schedules`, `builtin:projects`, `builtin:skill-management` and `builtin:video-generation`. The former `builtin:opengeni-*` ids stay accepted in requests and stored selections and resolve to the new ids; the SDK keeps them as the deprecated `LegacyBundledSkillId`. `builtin:opengeni-help` and `builtin:opengeni-client` keep their names because they document the platform itself.
- Agent instructions, Skill descriptions, tool descriptions and the errors and notices agents and people read describe the workspace rather than naming the platform, for example "Insufficient credits." instead of "Insufficient Opengeni credits.".
