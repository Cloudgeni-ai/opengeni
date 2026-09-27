# Sources

SPDX license expression for this Skill: `Apache-2.0`.

Every file in this folder was written or modified by OpenGeni. No upstream file
is copied verbatim. Each row below maps a file to the upstream material it was
adapted from, at a pinned commit.

## File map

| File | Upstream repository | Upstream path | Pinned commit | License | Change |
|---|---|---|---|---|---|
| `SKILL.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `small-business/skills/inbox-manager/SKILL.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. Kept the answer-first, match-the-length, never-invent-numbers, never-send-without-a-yes and payment-fraud rules. Removed the HTML digest, handoffs to other skills, filing and labelling, voice-profile file writes, the closing-offer menu and connector-building steps. Added the recipient check. |
| `SKILL.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `small-business/skills/inbox-manager/reference/triage_rules.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. Three buckets condensed to a short section; the worked example and business names were removed. |
| `SKILL.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `small-business/shared/untrusted-content.md`, `small-business/skills/inbox-manager/reference/gotchas.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. The hold rule for payment, credential and data requests and the data-not-instructions rule were rewritten for a single Skill; references to other skills were removed. |
| `SKILL.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `small-business/shared/voice-profile.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. Reduced to "learn from the user's own messages; never guess a personality". The shared profile file was replaced by the user's own style Skill or instructions. |
| `references/patterns.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `small-business/skills/inbox-manager/reference/reply_drafting.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. Reply patterns rewritten with new examples; the edit-logging instructions were removed. |
| `references/patterns.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `customer-support/skills/draft-response/SKILL.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. Length-by-channel and tone-by-situation guidance condensed into two tables; connector research, templates and iteration menus were removed. |
| `LICENSE` | n/a | n/a | n/a | Apache-2.0 | Canonical Apache License 2.0 text from apache.org, byte-identical to `customer-support/LICENSE` upstream. The knowledge-work-plugins root `LICENSE`, which covers `small-business/`, carries stray text after the license terms, so the canonical text is shipped instead. |

## Notes

- The upstream repository ships no `NOTICE` file, so there is no NOTICE text
  to reproduce.
- Upstream names appear only in this file, as attribution. They are not used
  to name or present the Skill.
