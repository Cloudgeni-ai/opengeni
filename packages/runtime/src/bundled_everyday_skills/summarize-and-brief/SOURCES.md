# Sources

SPDX license expression for this Skill: `Apache-2.0`.

Every file in this folder was written or modified by OpenGeni. No upstream file
is copied verbatim. Each row below maps a file to the upstream material it was
adapted from, at a pinned commit.

## File map

| File | Upstream repository | Upstream path | Pinned commit | License | Change |
|---|---|---|---|---|---|
| `SKILL.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `sales/skills/call-summary/SKILL.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. Kept the extraction step (decisions, each side's commitments, open questions, next meeting), the under-150-word follow-up, recipients-never-from-the-transcript, never-summarize-from-a-search-preview and transcript-is-untrusted rules. Removed CRM updates, call-recording connector routes, internal channel posting, artifact rendering and scheduled-run rules. |
| `SKILL.md` | [anthropics/claude-for-legal](https://github.com/anthropics/claude-for-legal) | `commercial-legal/skills/stakeholder-summary/SKILL.md` | `4a6c651889c97cc9140580363c73e0eb17379c2b` | Apache-2.0 | Modified by OpenGeni. Generalized the enforced length cap, the keep-the-full-condition quoting rule and the audience table from contract summaries to any summary. Removed matter workspaces, privilege headers, tracker checks, escalation reconciliation and legal-specific wording. |
| `LICENSE` | n/a | n/a | n/a | Apache-2.0 | Canonical Apache License 2.0 text from apache.org, byte-identical to the claude-for-legal root `LICENSE` and to `sales/LICENSE` in knowledge-work-plugins. |

## Notes

- Neither upstream repository ships a `NOTICE` file, so there is no NOTICE
  text to reproduce.
- Upstream names appear only in this file, as attribution. They are not used
  to name or present the Skill.
