# Sources

SPDX license expression for this Skill: `Apache-2.0 AND MIT`.

Every file in this folder was written or modified by OpenGeni. No upstream file
is copied verbatim. Each row below maps a file to the upstream material it was
adapted from, at a pinned commit.

## File map

| File | Upstream repository | Upstream path | Pinned commit | License | Change |
|---|---|---|---|---|---|
| `SKILL.md` | [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | `skills/copy-editing/SKILL.md`, `skills/copy-editing/references/checklist.md` | `5b2c0007766c6a1cf1d53fd8fc73e979e0821022` | MIT | Modified by OpenGeni. The seven editing sweeps were condensed into three passes; the word-level checks were rewritten; marketing-context file lookups, expert panels and related-skill routing were removed. |
| `SKILL.md` | [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | `skills/copywriting/SKILL.md` | `5b2c0007766c6a1cf1d53fd8fc73e979e0821022` | MIT | Modified by OpenGeni. Clarity, specificity and call-to-action principles were rewritten for general prose; page templates and annotations were removed. |
| `SKILL.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `design/skills/ux-copy/SKILL.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. Button, error, empty-state and confirmation patterns were condensed; slash-command usage, connector steps and the output template were removed. |
| `SKILL.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `small-business/shared/voice-profile.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. Reduced to the rule "match a real sample; never guess a personality". The shared profile file was replaced by the user's own style Skill or instructions. |
| `references/tells.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `small-business/skills/outreach-composer/reference/slop_test.md`, `small-business/skills/inbox-manager/reference/reply_drafting.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. The four fast checks and the opener, filler and closer lists were rewritten and generalized beyond outbound email; examples, length tables and business names were removed. |
| `references/tells.md` | [blader/humanizer](https://github.com/blader/humanizer) | `SKILL.md` | `9862685f575c65a8247f90369951df1b3416e3d6` | MIT | Ideas only. The pattern categories informed OpenGeni's own checklist, which is written fresh; no text or examples were copied. |
| `references/tells.md` | Wikipedia, [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) | n/a | n/a | CC BY-SA 4.0 (not used) | Linked as background reading only. No Wikipedia wording is copied. |
| `LICENSE` | n/a | n/a | n/a | Apache-2.0 | Canonical Apache License 2.0 text from apache.org. The knowledge-work-plugins root `LICENSE` carries stray text after the license terms, so the canonical text is shipped instead. |
| `LICENSE-MIT` | marketingskills, humanizer | `LICENSE` | as above | MIT | Upstream copyright and permission notices, reproduced unchanged. |

## Notes

- The Apache-2.0 upstream ships no `NOTICE` file, so there is no NOTICE text
  to reproduce.
- The plain words section in `SKILL.md` adapts the copy-editing word-level
  checks. `skills/copy-editing/references/plain-english-alternatives.md`, which
  reproduces third-party word lists, was not used.
- Upstream names appear only in this file, as attribution. They are not used
  to name or present the Skill.
