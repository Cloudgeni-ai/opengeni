---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
---

A workspace that its organization shares an Opengeni Slack bot with can now add Slack as an automation event source, and the bot's channel events reach that workspace's automations as well as the home workspace's. Delivery follows the live sharing setting: turning sharing off or leaving the workspace out stops new events there. Migration 1530 adds the one lookup each Slack callback makes for this.
