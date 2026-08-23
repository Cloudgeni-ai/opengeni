---
"@opengeni/db": minor
---

Slack first-task onboarding hint claim (rolling migration 0326 adds the nullable `slack_bot_user_links.first_task_hint_interaction_id`; no default, no backfill, and the table's FORCE-RLS workspace-isolation posture is unchanged). `claimSlackBotUserLinkFirstTaskHint` durably elects one interaction per Slack identity per installation: it stores the exact `slack_interactions` id that won, so the winner keeps answering `true` across retries, replica races, and delivery replays while every later interaction answers `false` forever. A missing link row claims nothing. `SlackBotUserLink` gains `firstTaskHintInteractionId`, and `saveSlackBotUserLink` deliberately cannot write it, so re-linking the same Slack identity preserves a spent claim.
