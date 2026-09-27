# Sources

SPDX license expression for this Skill: `Apache-2.0`.

Every file in this folder was written or modified by OpenGeni. No upstream file
is copied verbatim. Each row below maps a file to the upstream material it was
adapted from, at a pinned commit.

## File map

| File | Upstream repository | Upstream path | Pinned commit | License | Change |
|---|---|---|---|---|---|
| `SKILL.md` | [anthropics/claude-for-legal](https://github.com/anthropics/claude-for-legal) | `product-legal/skills/is-this-a-problem/SKILL.md` | `4a6c651889c97cc9140580363c73e0eb17379c2b` | Apache-2.0 | Modified by OpenGeni. Kept the three-way call (fine, needs a look, hold), one sentence why, the next step, the ask-one-catch-question rule and the trap table. Rewrote the table for non-lawyers and added rows for online content, employment changes and automated decisions. Removed the practice calibration file, matter workspaces, privilege headers, destination checks, routing to other legal plugins and the closing decision tree. Added the jurisdiction and dated-source rules and the not-legal-advice line. |
| `SKILL.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `legal/skills/legal-risk-assessment/SKILL.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. Condensed the outside-counsel engagement criteria into the "When it is a Hold" list. Removed the severity-by-likelihood matrix, memo template and risk register. |
| `LICENSE` | n/a | n/a | n/a | Apache-2.0 | Canonical Apache License 2.0 text from apache.org, byte-identical to the claude-for-legal root `LICENSE` and to `legal/LICENSE` in knowledge-work-plugins. |

## Notes

- Neither upstream repository ships a `NOTICE` file, so there is no NOTICE
  text to reproduce.
- Upstream names appear only in this file, as attribution. They are not used
  to name or present the Skill.
