---
"@opengeni/core": patch
"@opengeni/react": patch
---

**Add an agent** now also offers three ready-made agents: **CVE scanner** (checks dependencies and container images for known vulnerabilities, fixes safe upgrades in one pull request for PR reviewer and reports the rest; suggested weekly and on new pull requests), **Incident responder** (investigates an alert or a Slack report, posts the likely cause and hands a fix to Bug fixer) and **Dependency updater** (one pull request of routine upgrades a week for PR reviewer). The Agents list no longer shows a Slack badge on every shared agent, since every shared agent is in Slack; only Only me agents are marked.
