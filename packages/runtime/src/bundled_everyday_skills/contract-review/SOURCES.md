# Sources

SPDX license expression for this Skill: `Apache-2.0`.

Every file in this folder was written or modified by OpenGeni. No upstream file
is copied verbatim. Each row below maps a file to the upstream material it was
adapted from, at a pinned commit.

## File map

| File | Upstream repository | Upstream path | Pinned commit | License | Change |
|---|---|---|---|---|---|
| `SKILL.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `small-business/skills/contract-review/SKILL.md`, `small-business/skills/contract-review/reference/gotchas.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. Kept: ask which side, read the whole document including schedules, severity tiers, quote exact clauses, flag what is missing, skip boilerplate, match the power dynamic, not-legal-advice close. Removed: mail, file-store and e-signature fetch routes, the HTML artifact, the proprietary document-skill redline export, the closing-offer menu and connector building. Redlines now use OpenGeni's native documents, and only on request. |
| `SKILL.md` | [anthropics/claude-for-legal](https://github.com/anthropics/claude-for-legal) | `commercial-legal/skills/stakeholder-summary/SKILL.md` | `4a6c651889c97cc9140580363c73e0eb17379c2b` | Apache-2.0 | Modified by OpenGeni. The verdict, catch and at-most-three-actions shape under 200 words, and quoting the full conditional sentence. Removed matter workspaces, privilege headers, tracker checks and escalation reconciliation. |
| `SKILL.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `legal/skills/review-contract/SKILL.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. Clause interaction and playbook-or-market-standard rules condensed. Removed the local playbook file, contract-lifecycle routing and the full review template. |
| `references/nda.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `legal/skills/triage-nda/SKILL.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. The screening criteria, market defaults, three classifications and standard positions were condensed and relabelled as Sign, Sign after changes and Don't sign yet for non-lawyers. Removed the playbook file lookup, report template and routing timelines. |
| `references/clauses.md` | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | `small-business/skills/contract-review/SKILL.md`, `legal/skills/review-contract/SKILL.md` | `da38ec1ee89d41e5380e652a97382695003396e7` | Apache-2.0 | Modified by OpenGeni. The eight risk categories and the detailed clause guidance were merged into one normal, flag and ask-for list per clause type. |
| `references/clauses.md` | [anthropics/claude-for-legal](https://github.com/anthropics/claude-for-legal) | `commercial-legal/skills/stakeholder-summary/SKILL.md` | `4a6c651889c97cc9140580363c73e0eb17379c2b` | Apache-2.0 | Modified by OpenGeni. The legal-finding-to-business-translation table was reworded and extended. |
| `LICENSE` | n/a | n/a | n/a | Apache-2.0 | Canonical Apache License 2.0 text from apache.org, byte-identical to the claude-for-legal root `LICENSE` and to `legal/LICENSE` in knowledge-work-plugins. The knowledge-work-plugins root `LICENSE`, which covers `small-business/`, carries stray text after the license terms, so the canonical text is shipped instead. |

## Notes

- Neither upstream repository ships a `NOTICE` file, so there is no NOTICE
  text to reproduce.
- Upstream names appear only in this file, as attribution. They are not used
  to name or present the Skill.
